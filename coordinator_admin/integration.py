"""Application-owned adapter to the coordinator; no legacy controller process."""
import copy
import json
import os
from pathlib import Path
import re
import stat

from configurator.common import Rejected, require
from configurator.extensions import Peer
from .client import CoordinatorClient, CoordinatorError

ID = "homebridge-coordinator"
VERSION = "0.5.0"
ASSETS = {"index.html": "text/html", "app.js": "text/javascript", "style.css": "text/css", "editor.js": "text/javascript", "editor.css": "text/css"}


def validate_connection(value, gateways):
    require(isinstance(value, dict) and set(value) == {
        "base_url", "token_file", "instance_id", "scopes"}, "coordinator_configuration_invalid")
    try:
        # Constructor validates only; it never opens a network connection.
        CoordinatorClient(value["base_url"], "validation-placeholder-not-a-secret", value["instance_id"])
    except CoordinatorError as error:
        raise Rejected(error.code) from None
    require(isinstance(value["token_file"], str) and Path(value["token_file"]).is_absolute(),
            "coordinator_token_path_invalid")
    require(isinstance(value["scopes"], list) and len(value["scopes"]) <= 32,
            "coordinator_scope_invalid")
    registered = {row["id"]: row["identity"] for row in gateways}
    seen = set()
    for scope in value["scopes"]:
        require(isinstance(scope, dict) and set(scope) == {"gateway", "identity", "alarm", "controller"},
                "coordinator_scope_invalid")
        require(isinstance(scope["gateway"], str) and scope["gateway"] in registered and
                registered[scope["gateway"]] == scope["identity"] and
                type(scope["alarm"]) is int and 1 <= scope["alarm"] <= 255 and
                isinstance(scope["controller"], str) and
                re.fullmatch(r"[a-z][a-z0-9-]{0,47}", scope["controller"]), "coordinator_scope_invalid")
        key = (scope["gateway"], scope["alarm"])
        require(key not in seen, "coordinator_scope_conflict")
        seen.add(key)
    return value


def read_token(path):
    """Read only a regular, owner-private credential file, without following links."""
    try:
        path = Path(path)
        require(path.is_absolute() and path.resolve() == path, "coordinator_token_file_invalid")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            meta = os.fstat(fd)
            require(stat.S_ISREG(meta.st_mode) and meta.st_uid == os.geteuid() and
                    not meta.st_mode & 0o077 and meta.st_nlink == 1 and meta.st_size <= 1024,
                    "coordinator_token_file_invalid")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                raw = stream.read(1025)
        finally:
            os.close(fd)
        require(len(raw) <= 1024, "coordinator_token_file_invalid")
        def unique(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError("duplicate_key")
                result[key] = value
            return result
        value = json.loads(raw, object_pairs_hook=unique)
        require(isinstance(value, dict) and set(value) == {"token"}, "coordinator_token_file_invalid")
        return value["token"]
    except Rejected:
        raise
    except (OSError, ValueError, TypeError):
        raise Rejected("coordinator_token_file_invalid") from None


class CoordinatorPeer(Peer):
    def __init__(self, configuration, core=None):
        self.configuration = copy.deepcopy(configuration)
        self.core = core
        manifest = {
            "schema": 1, "id": ID, "version": VERSION, "api_version": 1,
            "name": "Controller", "permissions": ["maintenance", "keypad"],
            "scopes": [{k: row[k] for k in ("gateway", "identity", "alarm")}
                       for row in configuration["scopes"]],
            "routes": {"connection": "GET", "probe": "POST_READ", "settings": "GET", "activity": "GET", "maintenance": "GET",
                       "review-settings": "POST", "apply-settings": "POST", "cancel-settings": "POST_READ", "command": "POST", "commission": "POST_RECOVERY",
                       "prepare-maintenance": "POST", "confirm-bolt": "POST_RECOVERY", "confirm-still": "POST_RECOVERY"}, "assets": ASSETS,
        }
        super().__init__(manifest, self._dispatch)

    def _client(self):
        cfg = self.configuration
        return CoordinatorClient(cfg["base_url"], read_token(cfg["token_file"]), cfg["instance_id"])

    def connection(self):
        """A failed probe must not hide the page or preserve an old successful status."""
        try:
            client = self._client()
            identity = client.identity()
            controllers = client.controllers()
            routing = ([client.routing(row["id"]) for row in controllers]
                       if identity["capabilities"].get("routingInventory", False) else [])
            require(all(scope["controller"] in {row["id"] for row in controllers}
                        for scope in self.configuration["scopes"]), "coordinator_controller_not_found")
            return {"connected": True, "management_ready": all(identity["capabilities"][key] for key in ("settingsWrite", "motion", "maintenance", "keypad")),
                    "plugin": {k: identity[k] for k in ("pluginVersion", "mode", "capabilities")},
                    "controllers": controllers, "routing": routing, "reason": None if identity["capabilities"]["motion"] else "coordinator_management_not_implemented"}
        except (CoordinatorError, Rejected) as error:
            return {"connected": False, "management_ready": False,
                    "controllers": [], "routing": [], "reason": str(error)}

    def reconcile_completed_maintenance(self, client):
        tx = client.operation("/v1/maintenance", "maintenance")
        # A process can stop after the generic transaction's durable COMPLETE
        # record but before delivering the final completion acknowledgement.
        # Finish only that proven local transaction; never repeat its gateway write.
        if self.core is not None and isinstance(tx, dict) and tx.get("stage") == "verified" and tx.get("gateway") in self.core.registrations:
            local = self.core.transactions.load(tx["gateway"])
            if local and local.get("stage") == "complete" and local.get("id") == tx.get("id") and local.get("participants", {}).get("ext-" + ID) == 1:
                client.maintenance("complete", tx["id"], physical_check=bool(tx.get("physicalCheck")), gateway=tx["gateway"])
                return None
        return tx

    def maintenance_status(self):
        tx = self.reconcile_completed_maintenance(self._client())
        require(tx is None or isinstance(tx, dict) and isinstance(tx.get("stage"), str), "coordinator_maintenance_invalid")
        value = {"stage": tx["stage"] if tx else "none", **({k: tx[k] for k in ("id", "gateway", "token") if k in tx} if tx else {})}
        value["flow"] = {"version": 1, "name": "Garage coordinator",
            "preparation": {"title": "Prepare the garage", "message": "Keep the door closed, the bolt locked and the doorway clear. Leave garage controls unused during maintenance.",
                "checks": [{"name": "confirmed_closed", "label": "The garage is physically closed, the bolt is locked and the doorway is clear."}], "action": "prepare-maintenance"},
            "confirmation": None, "can_continue": not tx or tx["stage"] in ("paused", "bolt-confirmed", "verified"), "blocked": False}
        if tx and tx["stage"] == "awaiting-bolt":
            value["flow"]["confirmation"] = {"title": "Check the bolt", "message": "The coordinator remains paused. With the door closed, use the direct device control (for example the deCONZ output control) to check retraction and extension. The coordinator’s Lock tile is paused, then leave the bolt locked.",
                "checks": [{"name": "bolt_tested", "label": "I checked physical retraction and extension."}, {"name": "still", "label": "The door is closed, bolt locked and controls unused."}], "action": "confirm-bolt"}
        elif tx and tx["stage"] == "awaiting-still":
            value["flow"]["confirmation"] = {"title": "Confirm the garage stayed still", "message": "Device checks passed. Movement remains paused until maintenance completes. Confirm the door and bolt stayed still.",
                "checks": [{"name": "still", "label": "The door and bolt stayed still and remain closed and locked."}], "action": "confirm-still"}
        return value

    def _dispatch(self, manifest, operation, body):
        if operation == "handshake":
            require(not body, "coordinator_request_invalid")
            return {"schema": 1, "id": ID, "version": VERSION, "api_version": 1}
        if operation == "asset":
            require(set(body) == {"name"} and body["name"] in ASSETS, "coordinator_asset_invalid")
            return (Path(__file__).parent / "static" / body["name"]).read_text()
        if operation == "guard":
            return self.guard()
        if operation == "route" and body == {"name": "connection", "body": {}}:
            return self.connection()
        client = self._client()
        if operation == "route":
            require(set(body) == {"name", "body"} and isinstance(body["body"], dict), "coordinator_request_invalid")
            name, payload = body["name"], body["body"]
            if name == "connection":
                require(not payload, "coordinator_request_invalid")
                return self.connection()
            if name == "probe":
                require(set(payload) == {"controller"}, "coordinator_request_invalid")
                try:
                    return {"available": True, "probe": client.probe(payload["controller"])}
                except CoordinatorError as error:
                    return {"available": False, "reason": error.code}
            if name == "settings":
                require(not payload, "coordinator_request_invalid")
                return client.settings()
            if name == "activity":
                require(not payload, "coordinator_request_invalid")
                return {"events": client.operation("/v1/activity", "events")}
            if name == "maintenance":
                require(not payload, "coordinator_request_invalid")
                return self.maintenance_status()
            if name == "review-settings":
                require(set(payload) == {"configuration", "revision"}, "coordinator_request_invalid")
                return client.operation("/v1/settings/review", "review", payload)
            if name == "cancel-settings":
                require(set(payload) == {"token"}, "coordinator_request_invalid")
                return client.operation("/v1/settings/cancel", "review", payload)
            if name == "apply-settings":
                require(set(payload) == {"token"}, "coordinator_request_invalid")
                return client.operation("/v1/settings/apply", "settings", payload)
            if name in ("command", "commission"):
                controller = payload.get("controller")
                require(isinstance(controller, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,47}", controller), "coordinator_request_invalid")
                forwarded = {k: v for k, v in payload.items() if k != "controller"}
                expected = {"command", "requestId", "issuedAt", "bootId"} if name == "command" else {"revision", "previousControllerStopped", "physicalSetupReviewed", "recover"}
                require(set(forwarded) == expected, "coordinator_request_invalid")
                return client.operation("/v1/controllers/" + controller + ("/commands" if name == "command" else "/commission"),
                                        "operation" if name == "command" else "status", forwarded)
            if name == "prepare-maintenance":
                require(set(payload) == {"gateway", "confirmed_closed"} and payload["confirmed_closed"] is True and
                        payload["gateway"] in {s["gateway"] for s in self.configuration["scopes"]}, "physical_confirmation_required")
                return client.operation("/v1/maintenance/prepare", "result", {"gateway": payload["gateway"], "confirmedClosed": True})
            if name in ("confirm-bolt", "confirm-still"):
                require(set(payload) == ({"token", "bolt_tested", "still"} if name == "confirm-bolt" else {"token", "still"}) and
                        payload["still"] is True and (name != "confirm-bolt" or payload["bolt_tested"] is True), "physical_confirmation_required")
                require(client.operation("/v1/maintenance/confirm", "acknowledged", {"kind": "bolt" if name == "confirm-bolt" else "still", "token": payload["token"], "confirmed": True}) is True,
                        "coordinator_maintenance_not_acknowledged")
                return self.maintenance_status()
            raise Rejected("coordinator_route_unavailable")
        if operation == "keypad_begin":
            selected = [s for s in self.configuration["scopes"] if {k: s[k] for k in ("gateway", "identity", "alarm")} == body]
            require(len(selected) == 1, "coordinator_scope_invalid")
            scope = selected[0]
            return client.operation("/v1/controllers/" + scope["controller"] + "/keypad-begin", "receipt",
                                    {"gatewayId": scope["identity"], "alarmId": scope["alarm"]})
        if operation == "keypad_after":
            require(set(body) == {"token", "outcome", "mode", "elapsed"}, "coordinator_request_invalid")
            return client.operation("/v1/keypad-after", "result", body)
        if operation == "maintenance_recovery_ready":
            tx = client.operation("/v1/maintenance", "maintenance")
            return tx is None or tx.get("id") == body.get("id") and tx.get("stage") in ("paused", "bolt-confirmed", "verified")
        if operation.startswith("maintenance_"):
            action = operation[len("maintenance_"):]
            require(action in ("preflight", "pause", "verify", "resume", "complete"), "coordinator_request_invalid")
            return client.maintenance(action, body.get("id", "preflight"),
                                      physical_check="homebridge" in body.get("maintenance_participants", []), gateway=body.get("gateway"))
        raise Rejected("coordinator_operation_unavailable")

    def guard(self):
        client = self._client()
        require(client.identity()["capabilities"]["maintenance"] is True, "coordinator_management_not_implemented")
        self.reconcile_completed_maintenance(client)
        require(client.guard() is True, "coordinator_held")
        return True
