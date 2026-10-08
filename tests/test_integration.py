import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "configurator/tests"))
from support import config, IDENTITY
from test_editing import Model, owner
from configurator.common import atomic, Rejected
from configurator.core import Core
from coordinator_admin.integration import ID, read_token
from coordinator_admin.client import CoordinatorError
from test_client import IDENTITY as PLUGIN_IDENTITY, CONTROLLER, PROBE


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.token = self.root / "coordinator-token.json"
        atomic(self.token, {"token": "synthetic-backend-only-coordinator-token"})
        self.cfg = config(self.root, [{"id": "test", "name": "Example gateway", "identity": IDENTITY,
                                     "endpoint": "http://127.0.0.1:1", "key": "unused-synthetic-key"}])
        self.cfg["coordinator"] = {
            "base_url": "http://127.0.0.1:27773", "token_file": str(self.token),
            "instance_id": PLUGIN_IDENTITY["instanceId"],
            "scopes": [{"gateway": "test", "identity": IDENTITY, "alarm": 1,
                        "controller": "example-garage"}],
        }
        self.model = Model()
        self.client_patch = patch("coordinator_admin.integration.CoordinatorClient")
        self.client_type = self.client_patch.start()
        self.addCleanup(self.client_patch.stop)
        self.client = self.client_type.return_value
        self.client.identity.return_value = copy.deepcopy(PLUGIN_IDENTITY)
        self.client.controllers.return_value = [copy.deepcopy(CONTROLLER)]
        self.core = Core(self.cfg, self.model.factory)

    def request(self, route="connection", body=None, method="GET", asset=False):
        return self.core.dispatch("extension_request", {
            "id": ID, "route": route, "body": body or {}, "method": method, "asset": asset,
        })

    def test_startup_registers_controller_without_contacting_devices(self):
        self.client.identity.assert_not_called()
        self.client.controllers.assert_not_called()
        self.assertEqual(self.model.writes, [])
        extension = self.core.dispatch("setup", {})["extensions"][0]
        self.assertEqual(extension["page"], "/extensions/homebridge-coordinator/index.html")
        self.assertIn("ext-" + ID, self.core.transactions.participants)

    def test_fresh_connection_uses_backend_credential_and_never_exposes_it(self):
        value = self.request()
        self.assertTrue(value["connected"])
        self.assertFalse(value["management_ready"])
        self.assertEqual(value["controllers"], [CONTROLLER])
        for secret in ("synthetic-backend-only-coordinator-token", "27773", str(self.token), PLUGIN_IDENTITY["instanceId"]):
            self.assertNotIn(secret, json.dumps(value))
        atomic(self.token, {"token": "replacement-synthetic-token-with-32-characters"})
        self.request()
        self.assertEqual(self.client_type.call_args.args[1], "replacement-synthetic-token-with-32-characters")

    def test_failed_connection_clears_previously_successful_inventory(self):
        self.assertTrue(self.request()["connected"])
        self.client.identity.side_effect = CoordinatorError("coordinator_identity_mismatch")
        result = self.request()
        self.assertFalse(result["connected"])
        self.assertEqual(result["controllers"], [])
        self.assertEqual(result["reason"], "coordinator_identity_mismatch")
        # The authenticated page stays available while the plugin is down.
        html = self.request("index.html", asset=True)
        self.assertIn("Garage door and bolt", html["content"])

    def test_missing_configured_controller_is_not_a_ready_connection(self):
        self.client.controllers.return_value = []
        result = self.request()
        self.assertFalse(result["connected"])
        self.assertEqual(result["reason"], "coordinator_controller_not_found")

    def test_gateway_writes_and_keypad_cannot_bypass_missing_coordinator_operations(self):
        backups = self.root / "backups"; backups.mkdir(mode=0o700)
        self.cfg.update(schema=2, access_mode="manage", backup_root=str(backups))
        core = Core(self.cfg, self.model.factory)
        for operation, body in [("save_user", dict(owner(), alarm=1, backup_acknowledged=True)),
                                ("keypad_send", {"mode": "disarm", "code": "1234"})]:
            with self.subTest(operation=operation), self.assertRaisesRegex(Rejected, "coordinator_management_not_implemented"):
                core.dispatch("gateway_request", {"gateway": "test", "alarm": 1,
                                                   "operation": operation, "body": body})
        self.assertEqual(self.model.writes, [])
        peer = core.extensions.peers[ID]
        self.assertFalse(peer.recovery_ready({}))
        with self.assertRaises(Rejected):
            peer.pause({})

    def test_scope_identity_and_duplicate_delivery_are_rejected(self):
        bad = copy.deepcopy(self.cfg)
        bad["coordinator"]["scopes"][0]["identity"] = "F" * 16
        with self.assertRaisesRegex(Rejected, "coordinator_scope_invalid"):
            Core(bad, self.model.factory)
        bad = copy.deepcopy(self.cfg)
        bad["coordinator"]["scopes"] *= 2
        with self.assertRaisesRegex(Rejected, "coordinator_scope_conflict"):
            Core(bad, self.model.factory)

    def test_regular_accounts_cannot_open_or_change_controller_configuration(self):
        rows = [{"id": "a" * 32, "username": "Owner", "role": "admin", "enabled": True,
                 "salt": "00" * 16, "password_hash": "00" * 64},
                {"id": "b" * 32, "username": "Helper", "role": "regular", "enabled": True,
                 "salt": "00" * 16, "password_hash": "00" * 64}]
        self.core.dispatch("web_auth_change", {"expected_revision": None, "accounts": rows})
        request = {"account_id": "b" * 32, "revision": 1, "operation": "extension_request",
                   "body": {"id": ID, "route": "connection", "body": {}, "method": "GET", "asset": False}}
        with self.assertRaisesRegex(Rejected, "forbidden"):
            self.core.dispatch("authenticated_request", request)
        setup = self.core.dispatch("authenticated_request", dict(request, operation="setup", body={}))
        self.assertEqual(setup["extensions"], [])

    def test_private_credential_modes_links_and_duplicate_json(self):
        self.assertEqual(read_token(self.token), "synthetic-backend-only-coordinator-token")
        self.token.chmod(0o644)
        with self.assertRaisesRegex(Rejected, "coordinator_token_file_invalid"):
            read_token(self.token)
        self.token.chmod(0o600)
        link = self.root / "linked.json"; link.symlink_to(self.token)
        with self.assertRaisesRegex(Rejected, "coordinator_token_file_invalid"):
            read_token(link)
        self.token.write_text('{"token":"one","token":"two"}')
        with self.assertRaisesRegex(Rejected, "coordinator_token_file_invalid"):
            read_token(self.token)

    def test_explicit_read_only_probe_does_not_enable_gateway_writes_or_require_manage_mode(self):
        self.client.probe.return_value = copy.deepcopy(PROBE)
        self.assertEqual(self.cfg["access_mode"], "observe")
        value = self.request("probe", {"controller": "example-garage"}, "POST")
        self.assertEqual(value, {"available": True, "probe": PROBE})
        self.client.probe.assert_called_once_with("example-garage")
        self.assertEqual(self.model.writes, [])
        with self.assertRaisesRegex(Rejected, "coordinator_management_not_implemented"):
            self.core.extensions.guard()

    def test_probe_transport_failure_discards_result_and_never_retries(self):
        self.client.probe.side_effect = CoordinatorError("coordinator_unavailable_or_invalid")
        value = self.request("probe", {"controller": "example-garage"}, "POST")
        self.assertEqual(value, {"available": False, "reason": "coordinator_unavailable_or_invalid"})
        self.client.probe.assert_called_once()
        self.assertEqual(self.model.writes, [])


if __name__ == "__main__":
    unittest.main()
