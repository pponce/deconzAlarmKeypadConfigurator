"""Bounded, authenticated inventory and explicit read-only device probes."""
import http.client
import json
import re
import datetime
import math
import socket
import threading
from urllib.parse import urlsplit

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
ID = re.compile(r"[a-z][a-z0-9-]{0,47}\Z")
MAX_RESPONSE = 512 * 1024
PROBE_ERRORS = frozenset({
    "credentials_unavailable", "credential_reference_missing", "backend_not_implemented",
    "tailwind_credential_invalid", "door_read_failed", "door_response_invalid",
    "bolt_credential_invalid", "bolt_identity_configuration_required", "bolt_read_failed",
    "bolt_gateway_identity_mismatch", "bolt_resource_identity_mismatch", "bolt_unreachable", "bolt_response_invalid",
    "device_probe_failed",
})
PROBE_LIMITATIONS = frozenset({"tailwind_open_requires_estimate", "tailwind_closed_sensor_available",
                               "deconz_relay_is_not_position", "door_blocked", "bolt_extended_with_door_not_closed"})


class CoordinatorError(Exception):
    """Only fixed error codes; never include server bodies or connection secrets."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise CoordinatorError(code)


def _json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_json_key")
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError("invalid_json_constant")

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


class CoordinatorClient:
    def __init__(self, base_url, token, expected_instance_id, timeout=3.0):
        try:
            url = urlsplit(base_url)
            port = url.port
        except (ValueError, TypeError):
            raise CoordinatorError("invalid_coordinator_endpoint") from None
        require(url.scheme == "http" and url.hostname == "127.0.0.1" and
                url.path in ("", "/") and not url.username and not url.password and
                not url.query and not url.fragment and isinstance(port, int) and
                1 <= port <= 65535, "invalid_coordinator_endpoint")
        require(isinstance(token, str) and 32 <= len(token) <= 256 and
                all(33 <= ord(c) <= 126 for c in token), "invalid_coordinator_token")
        require(isinstance(expected_instance_id, str) and UUID.fullmatch(expected_instance_id),
                "invalid_coordinator_identity")
        require(type(timeout) in (int, float) and 0 < timeout <= 30, "invalid_timeout")
        self._port = port
        self._token = token
        self._instance_id = expected_instance_id
        self._timeout = timeout

    def _get(self, path, *, body=None, timeout=None):
        connection = http.client.HTTPConnection("127.0.0.1", self._port, timeout=timeout or self._timeout)
        timer = None
        try:
            encoded = None if body is None else json.dumps(body, allow_nan=False).encode()
            require(encoded is None or len(encoded) <= 262144, "coordinator_request_too_large")
            connection.connect()
            connected_socket = connection.sock
            def expire():
                try: connected_socket.shutdown(socket.SHUT_RDWR)
                except OSError: pass
            timer = threading.Timer(timeout or self._timeout, expire)
            timer.daemon = True
            timer.start()
            connection.request("GET" if body is None else "POST", path,
                               body=encoded,
                               headers={"Authorization": "Bearer " + self._token, "Accept": "application/json",
                                        **({"Content-Type": "application/json"} if body is not None else {})})
            response = connection.getresponse()
            if response.status == 401:
                raise CoordinatorError("coordinator_authentication_failed")
            if 300 <= response.status < 400:
                raise CoordinatorError("coordinator_redirect_rejected")
            require(response.status in (200, 202), "coordinator_request_failed")
            require(response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() == "application/json",
                    "coordinator_response_invalid")
            limit = MAX_RESPONSE if path.startswith("/v1/settings") else 64 * 1024
            raw = response.read(limit + 1)
            require(len(raw) <= limit, "coordinator_response_too_large")
            value = _json(raw)
            require(isinstance(value, dict), "coordinator_response_invalid")
            require(type(value.get("apiVersion")) is int and value["apiVersion"] == 1,
                    "coordinator_api_incompatible")
            require(value.get("instanceId") == self._instance_id, "coordinator_identity_mismatch")
            return value
        except CoordinatorError:
            raise
        except (OSError, http.client.HTTPException, ValueError, TypeError, RecursionError):
            raise CoordinatorError("coordinator_unavailable_or_invalid") from None
        finally:
            if timer is not None: timer.cancel()
            connection.close()

    def identity(self):
        value = self._get("/v1/identity")
        require(set(value) == {"apiVersion", "instanceId", "pluginVersion", "mode", "capabilities"},
                "coordinator_response_invalid")
        require(isinstance(value["pluginVersion"], str) and
                re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?", value["pluginVersion"]),
                "coordinator_response_invalid")
        require(value["mode"] in ("development", "observation", "active", "maintenance", "managed"),
                "coordinator_response_invalid")
        capabilities = value["capabilities"]
        require(isinstance(capabilities, dict) and
                {"inventory", "settingsWrite", "motion", "maintenance", "keypad"} <= set(capabilities) <=
                {"inventory", "diagnostics", "routingInventory", "settingsWrite", "motion", "maintenance", "keypad"} and
                all(type(v) is bool for v in capabilities.values()) and capabilities["inventory"],
                "coordinator_response_invalid")
        return value

    def require_capability(self, name):
        require(name in ("inventory", "diagnostics", "routingInventory", "settingsWrite", "motion", "maintenance", "keypad"),
                "unknown_coordinator_capability")
        require(self.identity()["capabilities"].get(name, False), "coordinator_capability_unavailable")

    @staticmethod
    def _controller(value):
        require(isinstance(value, dict) and set(value) == {
            "id", "name", "doorBackend", "boltBackend", "exposeBoltLock", "feedback", "status"},
            "coordinator_response_invalid")
        require(isinstance(value["id"], str) and ID.fullmatch(value["id"]), "coordinator_response_invalid")
        require(isinstance(value["name"], str) and 0 < len(value["name"]) <= 64 and
                not any(ord(c) < 32 for c in value["name"]), "coordinator_response_invalid")
        require(value["doorBackend"] in ("tailwind", "homebridge") and
                value["boltBackend"] in ("deconz", "homebridge") and
                type(value["exposeBoltLock"]) is bool, "coordinator_response_invalid")
        feedback = value["feedback"]
        require(isinstance(feedback, dict) and set(feedback) == {"closing", "opening", "bolt"} and
                feedback["closing"] in ("sensor", "timed") and
                feedback["opening"] in ("sensor", "timed") and
                feedback["bolt"] in ("position", "relay", "timed"), "coordinator_response_invalid")
        if isinstance(value["status"], dict) and "controllerId" in value["status"]:
            CoordinatorClient._status(value["status"], value["id"])
        else:
            require(value["status"] == {"phase": "not-commissioned", "door": "unknown",
                                       "bolt": "unknown", "actuationEnabled": False} and
                    type(value["status"]["actuationEnabled"]) is bool,
                    "coordinator_operational_status_unsupported")
        return value

    def controllers(self):
        self.require_capability("inventory")
        value = self._get("/v1/controllers")
        require(set(value) == {"apiVersion", "instanceId", "controllers"} and
                isinstance(value["controllers"], list) and len(value["controllers"]) <= 32,
                "coordinator_response_invalid")
        result = [self._controller(item) for item in value["controllers"]]
        require(len({item["id"] for item in result}) == len(result), "coordinator_response_invalid")
        return result

    def controller(self, controller_id):
        require(isinstance(controller_id, str) and ID.fullmatch(controller_id), "invalid_controller_id")
        self.require_capability("inventory")
        value = self._get("/v1/controllers/" + controller_id)
        require(set(value) == {"apiVersion", "instanceId", "controller"}, "coordinator_response_invalid")
        result = self._controller(value["controller"])
        require(result["id"] == controller_id, "coordinator_controller_mismatch")
        return result

    def probe(self, controller_id):
        require(isinstance(controller_id, str) and ID.fullmatch(controller_id), "invalid_controller_id")
        self.require_capability("diagnostics")
        value = self._get("/v1/controllers/" + controller_id + "/probe",
                          body={"instanceId": self._instance_id}, timeout=max(12.0, self._timeout))
        require(set(value) == {"apiVersion", "instanceId", "probe"}, "coordinator_response_invalid")
        result = value["probe"]
        require(isinstance(result, dict) and set(result) == {
            "controllerId", "checkedAt", "door", "bolt", "limitations", "compatible", "actuationEnabled"} and
            result["controllerId"] == controller_id and result["actuationEnabled"] is False and
            type(result["compatible"]) is bool, "coordinator_probe_invalid")
        try:
            stamp = result["checkedAt"]
            require(isinstance(stamp, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", stamp), "coordinator_probe_invalid")
            datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            raise CoordinatorError("coordinator_probe_invalid") from None
        for kind in ("door", "bolt"):
            row = result[kind]
            fields = {"state", "feedback", "error"} | ({"blocked"} if kind == "door" else set())
            states = ("closed", "not-closed") if kind == "door" else ("locked", "unlocked")
            evidence = {"closed-sensor"} if kind == "door" else {"relay"}
            if row.get("error") is None and (row.get("state") not in states or row.get("feedback") not in evidence):
                backend = self.controller(controller_id)["doorBackend" if kind == "door" else "boltBackend"]
                if backend == "homebridge":
                    states = ("closed", "not-closed", "open", "opening", "closing") if kind == "door" else states
                    evidence = {"closed-sensor", "command"} if kind == "door" else {"relay", "position"}
            require(isinstance(row, dict) and set(row) == fields, "coordinator_probe_invalid")
            if row["error"] is None:
                require(row["state"] in states and row["feedback"] in evidence and
                        (kind != "door" or type(row["blocked"]) is bool), "coordinator_probe_invalid")
            else:
                require(isinstance(row["error"], str) and row["error"] in PROBE_ERRORS and
                        row["state"] == "unknown" and row["feedback"] == "unavailable" and
                        (kind != "door" or row["blocked"] is None), "coordinator_probe_invalid")
        limitations = result["limitations"]
        require(isinstance(limitations, list) and len(limitations) <= len(PROBE_LIMITATIONS) and
                all(isinstance(x, str) and x in PROBE_LIMITATIONS for x in limitations) and
                len(set(limitations)) == len(limitations), "coordinator_probe_invalid")
        require(result["compatible"] == (result["door"]["error"] is None and result["bolt"]["error"] is None and not limitations),
                "coordinator_probe_invalid")
        require(result["door"]["blocked"] is not True or "door_blocked" in limitations, "coordinator_probe_invalid")
        require(not (result["door"]["state"] == "not-closed" and result["bolt"]["state"] == "locked") or
                "bolt_extended_with_door_not_closed" in limitations, "coordinator_probe_invalid")
        return result

    def routing(self, controller_id):
        require(isinstance(controller_id, str) and ID.fullmatch(controller_id), "invalid_controller_id")
        capabilities = self.identity()["capabilities"]
        require(capabilities.get("routingInventory", False), "coordinator_capability_unavailable")
        value = self._get("/v1/controllers/" + controller_id + "/routing")
        require(set(value) == {"apiVersion", "instanceId", "routing"}, "coordinator_response_invalid")
        result = value["routing"]
        require(isinstance(result, dict) and set(result) == {"controllerId", "builtins", "motorPaths", "inputs", "runtimeEnabled"} and
                result["controllerId"] == controller_id and type(result["runtimeEnabled"]) is bool and (not result["runtimeEnabled"] or capabilities["motion"]) and
                result["builtins"] == {"homekit": "primary", "virtualKeypad": "primary"}, "coordinator_routing_invalid")

        def named(row):
            return (isinstance(row.get("id"), str) and ID.fullmatch(row["id"]) and
                    isinstance(row.get("name"), str) and 0 < len(row["name"]) <= 64 and
                    not any(ord(c) < 32 for c in row["name"]))

        paths = result["motorPaths"]
        require(isinstance(paths, list) and 1 <= len(paths) <= 5, "coordinator_routing_invalid")
        mapped = {}
        for row in paths:
            require(isinstance(row, dict) and set(row) == {"id", "name", "type", "interruption"} and named(row) and
                    row["id"] not in mapped and row["interruption"] in ("disabled", "stop-opening-reverse-closing") and
                    (row["type"] in ("tailwind", "homebridge") and row["interruption"] == "disabled" if row["id"] == "primary"
                     else row["type"] == "pulse-relay"), "coordinator_routing_invalid")
            mapped[row["id"]] = row
        require("primary" in mapped, "coordinator_routing_invalid")
        inputs = result["inputs"]
        require(isinstance(inputs, list) and len(inputs) <= 32, "coordinator_routing_invalid")
        seen = {"homekit", "virtual-keypad"}
        for row in inputs:
            require(isinstance(row, dict) and set(row) == {"id", "name", "enabled", "source", "action", "trigger", "motorPath", "busyBehavior", "rearmSeconds", "timing"} and
                    named(row) and row["id"] not in seen and type(row["enabled"]) is bool and
                    isinstance(row["motorPath"], str) and row["motorPath"] in mapped and
                    row["busyBehavior"] in ("drop", "interrupt"), "coordinator_routing_invalid")
            seen.add(row["id"])
            source = row["source"]
            require(isinstance(source, dict) and set(source) == {"type", "kind"} and
                    (source["type"], source["kind"]) in (("deconz", "button"), ("deconz", "keypad"),
                                                           ("homebridge", "button"), ("homebridge", "switch")), "coordinator_routing_invalid")
            kind = source["kind"]
            if kind == "keypad":
                require(row["trigger"] == "native-outcome" and row["action"] == "keypad", "coordinator_routing_invalid")
            else:
                require(row["action"] in ("open", "close", "toggle"), "coordinator_routing_invalid")
                if kind == "button":
                    require(type(row["trigger"]) is int and 0 <= row["trigger"] <= (2 if source["type"] == "homebridge" else 65535), "coordinator_routing_invalid")
                else:
                    require(row["trigger"] in ("on", "off", "either"), "coordinator_routing_invalid")
            if row["busyBehavior"] == "interrupt":
                require(row["action"] in ("toggle", "keypad") and mapped[row["motorPath"]]["interruption"] == "stop-opening-reverse-closing", "coordinator_routing_invalid")
            require(type(row["rearmSeconds"]) in (int, float) and math.isfinite(row["rearmSeconds"]) and 0 <= row["rearmSeconds"] <= 10, "coordinator_routing_invalid")
            timing = row["timing"]
            require(isinstance(timing, dict) and set(timing) <= {"openRetractSettleSeconds", "closeRetractSettleSeconds", "openingSeconds", "closingSeconds"}, "coordinator_routing_invalid")
            for key, seconds in timing.items():
                require(type(seconds) in (int, float) and math.isfinite(seconds) and
                        (0 <= seconds <= 120 if "Retract" in key else 1 <= seconds <= 300), "coordinator_routing_invalid")
        return result

    @staticmethod
    def _status(value, controller_id):
        require(isinstance(value, dict) and set(value) == {"controllerId", "bootId", "commissioned", "actuationEnabled", "held", "inputStates", "state", "revision"} and
                value["controllerId"] == controller_id and isinstance(value["bootId"], str) and UUID.fullmatch(value["bootId"]) and
                type(value["commissioned"]) is bool and type(value["actuationEnabled"]) is bool and
                type(value["revision"]) is int and value["revision"] > 0, "coordinator_status_invalid")
        code = lambda v: v is None or isinstance(v, str) and re.fullmatch(r"[a-z][a-z0-9_-]{0,80}", v)
        require(code(value["held"]) and isinstance(value["inputStates"], dict) and len(value["inputStates"]) <= 32 and
                all(ID.fullmatch(k) and code(v) for k, v in value["inputStates"].items()), "coordinator_status_invalid")
        state = value["state"]
        require(isinstance(state, dict) and {"phase", "door", "bolt", "busy", "fault"} <= set(state) <=
                {"phase", "door", "bolt", "busy", "fault", "target", "openEstimated", "closeEstimated", "externalUnlockOverride", "unavailable", "obstruction"},
                "coordinator_status_invalid")
        require(state["phase"] in ("starting", "not-commissioned", "unavailable", "fault", "position-unknown", "closed", "open", "unbolting", "bolting", "opening", "closing", "stopped-estimated") and
                state["door"] in ("unknown", "closed", "open", "not-closed", "opening", "closing") and state["bolt"] in ("unknown", "locked", "unlocked") and
                type(state["busy"]) is bool and code(state["fault"]) and code(state.get("unavailable")), "coordinator_status_invalid")
        for key in ("openEstimated", "closeEstimated", "externalUnlockOverride", "obstruction"):
            require(key not in state or type(state[key]) is bool, "coordinator_status_invalid")
        require(state.get("target") in (None, "open", "closed"), "coordinator_status_invalid")
        return value

    def status(self, controller_id):
        require(isinstance(controller_id, str) and ID.fullmatch(controller_id), "invalid_controller_id")
        value = self._get("/v1/controllers/" + controller_id + "/state")
        require(set(value) == {"apiVersion", "instanceId", "status"}, "coordinator_response_invalid")
        return self._status(value["status"], controller_id)

    def operation(self, path, field, body=None, timeout=30):
        value = self._get(path, body=None if body is None else {"instanceId": self._instance_id, **body}, timeout=timeout)
        require(set(value) == {"apiVersion", "instanceId", field}, "coordinator_response_invalid")
        return value[field]

    def settings(self):
        self.require_capability("settingsWrite")
        value = self.operation("/v1/settings", "settings")
        require(isinstance(value, dict) and set(value) == {"revision", "configuration"} and type(value["revision"]) is int and
                value["revision"] > 0 and isinstance(value["configuration"], dict) and
                {"managementPort", "controllers"} <= set(value["configuration"]) <= {"managementPort", "controllers", "connections"} and
                isinstance(value["configuration"]["controllers"], list) and len(value["configuration"]["controllers"]) <= 32,
                "coordinator_settings_invalid")
        if "connections" in value["configuration"]:
            catalog = value["configuration"]["connections"]
            require(isinstance(catalog, list) and len(catalog) <= 128, "coordinator_settings_invalid")
            ids = set()
            for row in catalog:
                require(isinstance(row, dict) and {"id", "name", "type", "baseUrl", "credentialRef"} <= set(row) <=
                        {"id", "name", "type", "baseUrl", "credentialRef", "doorCount"}, "coordinator_settings_invalid")
                require(isinstance(row["id"], str) and ID.fullmatch(row["id"]) and row["id"] not in ids and
                        isinstance(row["name"], str) and 0 < len(row["name"]) <= 64 and
                        row["type"] in ("deconz", "tailwind", "homebridge") and
                        isinstance(row["credentialRef"], str) and ID.fullmatch(row["credentialRef"]) and
                        isinstance(row["baseUrl"], str) and len(row["baseUrl"]) <= 512, "coordinator_settings_invalid")
                ids.add(row["id"])
                try:
                    url = urlsplit(row["baseUrl"])
                    require(url.scheme in ("http", "https") and url.hostname and not url.username and not url.password and
                            url.path in ("", "/") and not url.query and not url.fragment, "coordinator_settings_invalid")
                except ValueError:
                    raise CoordinatorError("coordinator_settings_invalid") from None
                count = row.get("doorCount")
                require((row["type"] == "tailwind" and (count is None or type(count) is int and 1 <= count <= 3)) or
                        (row["type"] != "tailwind" and "doorCount" not in row), "coordinator_settings_invalid")
        return value

    def guard(self):
        self.require_capability("maintenance")
        require(self.operation("/v1/guard", "ready") is True, "coordinator_held")
        return True

    def maintenance(self, action, transaction_id, *, physical_check=False, gateway=None):
        require(action in ("preflight", "pause", "verify", "resume", "complete"), "coordinator_request_invalid")
        require(self.operation("/v1/maintenance/" + action, "acknowledged", {"transactionId": transaction_id, "physicalCheck": physical_check, "gateway": gateway}) is True,
                "coordinator_maintenance_not_acknowledged")
        return True
