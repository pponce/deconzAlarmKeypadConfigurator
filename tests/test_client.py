import copy
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from coordinator_admin import CoordinatorClient, CoordinatorError


INSTANCE = "00000000-0000-4000-8000-000000000001"
TOKEN = "synthetic-test-token-with-no-device-access"
IDENTITY = {
    "apiVersion": 1, "instanceId": INSTANCE, "pluginVersion": "0.1.0-dev.1",
    "mode": "development", "capabilities": {
        "inventory": True, "settingsWrite": False, "motion": False,
        "maintenance": False, "keypad": False,
    },
}
CONTROLLER = {
    "id": "example-garage", "name": "Example garage", "doorBackend": "tailwind",
    "boltBackend": "deconz", "exposeBoltLock": True,
    "feedback": {"closing": "sensor", "opening": "timed", "bolt": "relay"},
    "status": {"phase": "not-commissioned", "door": "unknown", "bolt": "unknown",
               "actuationEnabled": False},
}
PROBE = {"controllerId": "example-garage", "checkedAt": "2026-10-06T12:00:00.000Z",
         "door": {"state": "closed", "feedback": "closed-sensor", "blocked": False, "error": None},
         "bolt": {"state": "locked", "feedback": "relay", "error": None},
         "limitations": [], "compatible": True, "actuationEnabled": False}
ROUTING = {"controllerId": "example-garage", "builtins": {"homekit": "primary", "virtualKeypad": "primary"},
           "motorPaths": [{"id": "primary", "name": "Primary opener", "type": "tailwind", "interruption": "disabled"},
                          {"id": "wall-relay", "name": "Opener relay", "type": "pulse-relay", "interruption": "stop-opening-reverse-closing"}],
           "inputs": [{"id": "button", "name": "Another brand of button", "enabled": True,
                       "source": {"type": "homebridge", "kind": "button"}, "trigger": 0, "action": "toggle",
                       "motorPath": "wall-relay", "busyBehavior": "interrupt", "rearmSeconds": 1.5, "timing": {}}],
           "runtimeEnabled": False}


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.overrides = {}
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                test.requests.append((self.path, self.headers.get("Authorization")))
                if self.path in test.overrides:
                    status, body, content_type = test.overrides[self.path]
                elif self.headers.get("Authorization") != "Bearer " + TOKEN:
                    status, body, content_type = 401, b"private-server-error", "text/plain"
                else:
                    values = {
                        "/v1/identity": IDENTITY,
                        "/v1/controllers": {"apiVersion": 1, "instanceId": INSTANCE,
                                            "controllers": [CONTROLLER]},
                        "/v1/controllers/example-garage": {
                            "apiVersion": 1, "instanceId": INSTANCE, "controller": CONTROLLER},
                    }
                    status, body, content_type = 200, json.dumps(values[self.path]).encode(), "application/json"
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                if status == 302:
                    self.send_header("Location", "http://example.invalid/private-target")
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                test.requests.append((self.path, self.headers.get("Authorization")))
                if self.path in test.overrides:
                    status, raw, content_type = test.overrides[self.path]
                else:
                    status = 200 if body == {"instanceId": INSTANCE} else 409
                    raw = json.dumps({"apiVersion": 1, "instanceId": INSTANCE, "probe": PROBE}).encode()
                    content_type = "application/json"
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.client = CoordinatorClient(self.url, TOKEN, INSTANCE)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def assert_code(self, code, function):
        with self.assertRaises(CoordinatorError) as caught:
            function()
        self.assertEqual(str(caught.exception), code)

    def override_json(self, path, value):
        self.overrides[path] = 200, json.dumps(value).encode(), "application/json"

    def test_authenticated_inventory_and_single_controller(self):
        self.assertEqual(self.client.identity(), IDENTITY)
        self.assertEqual(self.client.controllers(), [CONTROLLER])
        self.assertEqual(self.client.controller("example-garage"), CONTROLLER)
        self.assertTrue(all(auth == "Bearer " + TOKEN for _, auth in self.requests))

    def test_unimplemented_capabilities_fail_instead_of_claiming_success(self):
        for capability in ("settingsWrite", "motion", "maintenance", "keypad"):
            with self.subTest(capability=capability):
                self.assert_code("coordinator_capability_unavailable",
                                 lambda: self.client.require_capability(capability))
        self.assert_code("unknown_coordinator_capability",
                         lambda: self.client.require_capability("other"))

    def test_authentication_failure_does_not_disclose_response(self):
        client = CoordinatorClient(self.url, "wrong-token-that-is-at-least-32-characters", INSTANCE)
        self.assert_code("coordinator_authentication_failed", client.identity)

    def test_rejects_redirect_without_following_it(self):
        self.overrides["/v1/identity"] = 302, b"private-location", "text/plain"
        self.assert_code("coordinator_redirect_rejected", self.client.identity)
        self.assertEqual(len(self.requests), 1)

    def test_bounded_response_and_invalid_json(self):
        cases = [
            (b"x" * (64 * 1024 + 1), "application/json", "coordinator_response_too_large"),
            (b"private-invalid-body", "text/html", "coordinator_response_invalid"),
            (b"private-invalid-body", "application/json", "coordinator_unavailable_or_invalid"),
            (b'{"apiVersion":1,"apiVersion":1}', "application/json", "coordinator_unavailable_or_invalid"),
            (b'{"apiVersion":NaN}', "application/json", "coordinator_unavailable_or_invalid"),
        ]
        for body, content_type, code in cases:
            with self.subTest(code=code, size=len(body)):
                self.overrides["/v1/identity"] = 200, body, content_type
                self.assert_code(code, self.client.identity)

    def test_protocol_and_pinned_identity_are_checked(self):
        for field, value, code in [
            ("apiVersion", 2, "coordinator_api_incompatible"),
            ("apiVersion", True, "coordinator_api_incompatible"),
            ("instanceId", "00000000-0000-4000-8000-000000000002", "coordinator_identity_mismatch"),
            ("capabilities", {"inventory": True}, "coordinator_response_invalid"),
        ]:
            with self.subTest(field=field, value=value):
                identity = copy.deepcopy(IDENTITY)
                identity[field] = value
                self.override_json("/v1/identity", identity)
                self.assert_code(code, self.client.identity)

    def test_inventory_response_must_match_identity_not_just_handshake(self):
        self.override_json("/v1/controllers", {
            "apiVersion": 1, "instanceId": "00000000-0000-4000-8000-000000000002",
            "controllers": [CONTROLLER],
        })
        self.assert_code("coordinator_identity_mismatch", self.client.controllers)

    def test_rejects_duplicate_controllers_and_unknown_operational_status(self):
        self.override_json("/v1/controllers", {
            "apiVersion": 1, "instanceId": INSTANCE, "controllers": [CONTROLLER, CONTROLLER],
        })
        self.assert_code("coordinator_response_invalid", self.client.controllers)
        controller = copy.deepcopy(CONTROLLER)
        controller["status"]["actuationEnabled"] = True
        self.override_json("/v1/controllers", {
            "apiVersion": 1, "instanceId": INSTANCE, "controllers": [controller],
        })
        self.assert_code("coordinator_operational_status_unsupported", self.client.controllers)

    def test_single_controller_cannot_return_different_identity(self):
        controller = copy.deepcopy(CONTROLLER)
        controller["id"] = "another-garage"
        self.override_json("/v1/controllers/example-garage", {
            "apiVersion": 1, "instanceId": INSTANCE, "controller": controller,
        })
        self.assert_code("coordinator_controller_mismatch",
                         lambda: self.client.controller("example-garage"))

    def test_invalid_inputs_never_open_a_connection(self):
        with patch("http.client.HTTPConnection") as connection:
            for url in ("https://127.0.0.1:1234", "http://example.invalid:1234",
                        "http://localhost:1234", "http://127.0.0.1",
                        "http://secret@127.0.0.1:1234", self.url + "/path",
                        self.url + "?token=private", "http://127.0.0.1:bad"):
                with self.subTest(url=url):
                    self.assert_code("invalid_coordinator_endpoint",
                                     lambda: CoordinatorClient(url, TOKEN, INSTANCE))
            self.assert_code("invalid_coordinator_token",
                             lambda: CoordinatorClient(self.url, TOKEN + "\n", INSTANCE))
            self.assert_code("invalid_coordinator_identity",
                             lambda: CoordinatorClient(self.url, TOKEN, "any"))
            self.assert_code("invalid_timeout",
                             lambda: CoordinatorClient(self.url, TOKEN, INSTANCE, timeout=0))
            self.assert_code("invalid_controller_id",
                             lambda: self.client.controller("../identity"))
            connection.assert_not_called()

    def test_connection_failures_do_not_expose_exception_details(self):
        with patch("http.client.HTTPConnection.request", side_effect=OSError("private-token-details")):
            self.assert_code("coordinator_unavailable_or_invalid", self.client.identity)

    def enable_diagnostics(self):
        identity = copy.deepcopy(IDENTITY)
        identity["capabilities"]["diagnostics"] = True
        self.override_json("/v1/identity", identity)

    def test_probe_requires_advertised_capability_and_pins_instance(self):
        self.assert_code("coordinator_capability_unavailable", lambda: self.client.probe("example-garage"))
        self.enable_diagnostics()
        self.assertEqual(self.client.probe("example-garage"), PROBE)
        self.override_json("/v1/controllers/example-garage/probe", {
            "apiVersion": 1, "instanceId": "00000000-0000-4000-8000-000000000002", "probe": PROBE})
        self.assert_code("coordinator_identity_mismatch", lambda: self.client.probe("example-garage"))

    def test_probe_rejects_false_success_physical_position_claims_and_private_errors(self):
        self.enable_diagnostics()
        cases = []
        for key, value in [("controllerId", "another-garage"), ("actuationEnabled", True),
                           ("checkedAt", "2026-99-99T12:00:00.000Z"), ("compatible", False)]:
            row = copy.deepcopy(PROBE); row[key] = value; cases.append(row)
        for kind, key, value in [("bolt", "feedback", "position"), ("door", "state", "open"),
                                  ("bolt", "error", "private-credential"), ("door", "blocked", True)]:
            row = copy.deepcopy(PROBE); row[kind][key] = value; cases.append(row)
        for row in cases:
            with self.subTest(row=row):
                self.override_json("/v1/controllers/example-garage/probe", {
                    "apiVersion": 1, "instanceId": INSTANCE, "probe": row})
                self.assert_code("coordinator_probe_invalid", lambda: self.client.probe("example-garage"))

    def test_valid_probe_failure_replaces_success_with_unknown(self):
        self.enable_diagnostics()
        row = copy.deepcopy(PROBE)
        row["bolt"] = {"state": "unknown", "feedback": "unavailable", "error": "bolt_unreachable"}
        row["compatible"] = False
        self.override_json("/v1/controllers/example-garage/probe", {
            "apiVersion": 1, "instanceId": INSTANCE, "probe": row})
        self.assertEqual(self.client.probe("example-garage"), row)

    def routing_response(self, row=ROUTING):
        identity = copy.deepcopy(IDENTITY)
        identity["capabilities"]["routingInventory"] = True
        self.override_json("/v1/identity", identity)
        self.override_json("/v1/controllers/example-garage/routing", {
            "apiVersion": 1, "instanceId": INSTANCE, "routing": row})

    def test_routing_requires_capability_and_preserves_primary_builtin_assignments(self):
        self.assert_code("coordinator_capability_unavailable", lambda: self.client.routing("example-garage"))
        self.routing_response()
        self.assertEqual(self.client.routing("example-garage"), ROUTING)

    def test_relay_keypad_interruption_is_supported_but_primary_is_rejected(self):
        row = copy.deepcopy(ROUTING)
        row["inputs"][0].update(source={"type": "deconz", "kind": "keypad"}, action="keypad", trigger="native-outcome")
        self.routing_response(row)
        self.assertEqual(self.client.routing("example-garage"), row)
        row["inputs"][0]["motorPath"] = "primary"
        self.routing_response(row)
        self.assert_code("coordinator_routing_invalid", lambda: self.client.routing("example-garage"))

    def test_routing_rejects_unavailable_paths_false_runtime_claims_and_private_mapping_fields(self):
        cases = []
        for field, value in [("controllerId", "another-garage"), ("runtimeEnabled", True),
                             ("builtins", {"homekit": "wall-relay", "virtualKeypad": "primary"})]:
            row = copy.deepcopy(ROUTING); row[field] = value; cases.append(row)
        for field, value in [("motorPath", "missing"), ("busyBehavior", "queue"), ("trigger", True),
                             ("source", {"type": "homebridge", "kind": "button", "credentialRef": "private"}),
                             ("timing", {"openingSeconds": -1})]:
            row = copy.deepcopy(ROUTING); row["inputs"][0][field] = value; cases.append(row)
        row = copy.deepcopy(ROUTING); row["inputs"][0]["motorPath"] = "primary"; cases.append(row)
        for row in cases:
            with self.subTest(row=row):
                self.routing_response(row)
                self.assert_code("coordinator_routing_invalid", lambda: self.client.routing("example-garage"))


if __name__ == "__main__":
    unittest.main()


class ConnectionCatalogTest(unittest.TestCase):
    def test_settings_accept_legacy_and_preserve_optional_shared_connections(self):
        client = CoordinatorClient("http://127.0.0.1:27773", TOKEN, INSTANCE)
        connection = {"id": "example-tailwind", "name": "Driveway Tailwind", "type": "tailwind",
                      "baseUrl": "http://192.0.2.10", "credentialRef": "tailwind-key", "doorCount": 2}
        for catalog in (None, [], [connection]):
            settings = {"revision": 1, "configuration": {"managementPort": 27773, "controllers": []}}
            if catalog is not None:
                settings["configuration"]["connections"] = catalog
            with patch.object(client, "require_capability"), patch.object(client, "operation", return_value=settings):
                self.assertEqual(client.settings(), settings)
        for bad in ([{**connection, "secret": "forbidden"}], [{**connection, "doorCount": 4}],
                    [{**connection, "baseUrl": "http://user:secret@example.invalid"}], [connection, connection]):
            settings["configuration"]["connections"] = bad
            with patch.object(client, "require_capability"), patch.object(client, "operation", return_value=settings):
                with self.assertRaisesRegex(CoordinatorError, "coordinator_settings_invalid"):
                    client.settings()
