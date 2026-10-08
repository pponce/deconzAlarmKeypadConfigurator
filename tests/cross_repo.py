"""Local integration check against the actual sibling Node API; no hardware."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coordinator_admin import CoordinatorClient, CoordinatorError


INSTANCE = "00000000-0000-4000-8000-000000000001"
TOKEN = "synthetic-cross-repository-token-no-device-access"


class CrossRepositoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.coordinator = Path(sys.argv[1]).resolve()
        cls.process = subprocess.Popen(
            ["node", str(cls.coordinator / "scripts/serve-fixture.mjs")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={**os.environ, "COORDINATOR_TEST_TOKEN": TOKEN, "COORDINATOR_MANAGED_FIXTURE": getattr(cls,"managed","0")},
        )
        cls.addClassCleanup(cls.stop_process)
        lines = queue.Queue()
        threading.Thread(target=lambda: lines.put(cls.process.stdout.readline()), daemon=True).start()
        port = json.loads(lines.get(timeout=10))["port"]
        cls.url = "http://127.0.0.1:" + str(port)
        cls.client = CoordinatorClient(cls.url, TOKEN, INSTANCE)

    @classmethod
    def stop_process(cls):
        if cls.process.stdin and not cls.process.stdin.closed:
            cls.process.stdin.close()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)
        cls.process.stdout.close()
        cls.process.stderr.close()

    def test_api_contract_copies_are_identical(self):
        admin = Path(__file__).resolve().parents[1]
        self.assertEqual((admin / "docs/api-v1.md").read_bytes(),
                         (self.coordinator / "docs/api-v1.md").read_bytes())

    def test_real_server_inventory_and_identity(self):
        self.assertEqual(self.client.identity()["mode"], "observation")
        controllers = self.client.controllers()
        self.assertEqual(len(controllers), 1)
        self.assertEqual(self.client.controller(controllers[0]["id"]), controllers[0])
        self.assertFalse(controllers[0]["status"]["actuationEnabled"])

    def test_real_server_rejects_wrong_token(self):
        with self.assertRaises(CoordinatorError) as caught:
            CoordinatorClient(self.url, "wrong-synthetic-token-with-32-characters", INSTANCE).identity()
        self.assertEqual(caught.exception.code, "coordinator_authentication_failed")

    def test_client_rejects_other_instance(self):
        with self.assertRaises(CoordinatorError) as caught:
            CoordinatorClient(self.url, TOKEN, "00000000-0000-4000-8000-000000000002").identity()
        self.assertEqual(caught.exception.code, "coordinator_identity_mismatch")

    def test_no_motion_or_maintenance_advertised(self):
        for name in ("settingsWrite", "motion", "maintenance", "keypad"):
            with self.subTest(capability=name), self.assertRaises(CoordinatorError) as caught:
                self.client.require_capability(name)
            self.assertEqual(caught.exception.code, "coordinator_capability_unavailable")

    def test_actual_drivers_and_protocol_return_read_only_device_evidence(self):
        result = self.client.probe("example-garage")
        self.assertTrue(result["compatible"])
        self.assertFalse(result["actuationEnabled"])
        self.assertEqual(result["door"]["state"], "closed")
        self.assertEqual(result["bolt"]["feedback"], "relay")

    def test_actual_routing_metadata_keeps_builtins_primary_and_physical_inputs_on_relay(self):
        routing = self.client.routing("example-garage")
        self.assertEqual(routing["builtins"], {"homekit": "primary", "virtualKeypad": "primary"})
        self.assertEqual(routing["motorPaths"][0]["type"], "tailwind")
        self.assertEqual(len(routing["inputs"]), 3)
        self.assertTrue(all(row["motorPath"] == "wall-relay" for row in routing["inputs"]))
        self.assertFalse(routing["runtimeEnabled"])
        for secret in ("example.invalid", "credentialRef", "uniqueId", "bridgeId"):
            self.assertNotIn(secret, json.dumps(routing))

    def test_actual_admin_adapter_uses_real_coordinator(self):
        import tempfile
        from configurator.core import Core
        from configurator.common import atomic, Rejected
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "configurator/tests"))
        from support import config
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            credential = root / "token.json"
            atomic(credential, {"token": TOKEN})
            cfg = config(root)
            cfg["coordinator"] = {"base_url": self.url, "token_file": str(credential),
                                  "instance_id": INSTANCE, "scopes": []}
            core = Core(cfg)
            value = core.dispatch("extension_request", {
                "id": "homebridge-coordinator", "route": "connection",
                "method": "GET", "body": {}, "asset": False,
            })
            self.assertTrue(value["connected"])
            self.assertFalse(value["management_ready"])
            self.assertEqual(value["controllers"], self.client.controllers())
            self.assertEqual(value["routing"], [self.client.routing("example-garage")])
            self.assertNotIn(TOKEN, json.dumps(value))
            result = core.dispatch("extension_request", {
                "id": "homebridge-coordinator", "route": "probe", "method": "POST",
                "body": {"controller": "example-garage"}, "asset": False,
            })
            self.assertTrue(result["available"])
            self.assertTrue(result["probe"]["compatible"])
            self.assertFalse(result["probe"]["actuationEnabled"])
            with self.assertRaisesRegex(Rejected, "coordinator_management_not_implemented"):
                core.extensions.guard()


class ManagedCrossRepositoryTest(CrossRepositoryTest):
    managed = "1"
    # Retain transport/identity/contract tests; replace observation-only assertions.
    def test_real_server_inventory_and_identity(self):
        self.assertEqual(self.client.identity()["mode"], "managed")
        self.assertEqual(self.client.controllers()[0]["id"], "example-garage")

    def test_no_motion_or_maintenance_advertised(self):
        for name in ("settingsWrite","motion","maintenance","keypad"):
            self.client.require_capability(name)

    def test_actual_routing_metadata_keeps_builtins_primary_and_physical_inputs_on_relay(self):
        self.assertEqual(self.client.routing("example-garage")["builtins"], {"homekit":"primary","virtualKeypad":"primary"})

    def test_actual_admin_adapter_uses_real_coordinator(self):
        import tempfile
        import time
        import uuid
        from coordinator_admin.integration import CoordinatorPeer
        from configurator.common import atomic
        with tempfile.TemporaryDirectory() as folder:
            token = Path(folder) / "token.json"
            atomic(token, {"token":TOKEN})
            peer = CoordinatorPeer({"base_url":self.url,"token_file":str(token),"instance_id":INSTANCE,
                "scopes":[{"gateway":"test","identity":"0011223344556677","alarm":1,"controller":"example-garage"}]})
            def route(name,body=None):
                return peer.call("route",{"name":name,"body":body or {}})
            self.assertTrue(peer.connection()["management_ready"])
            settings=route("settings")
            self.assertEqual({row["type"] for row in settings["configuration"]["connections"]}, {"tailwind", "deconz"})
            settings["configuration"]["connections"][0]["name"] = "Admin-preserved connection"
            review=route("review-settings",settings)
            self.assertEqual(review["configuration"]["connections"], settings["configuration"]["connections"])
            self.assertEqual(route("apply-settings",{"token":review["token"]})["revision"],settings["revision"]+1)
            enabled=route("commission",{"controller":"example-garage","revision":settings["revision"]+1,"previousControllerStopped":True,"physicalSetupReviewed":True,"recover":True})
            self.assertTrue(enabled["actuationEnabled"])
            receipt=peer.call("keypad_begin",{"gateway":"test","identity":"0011223344556677","alarm":1})
            result=peer.call("keypad_after",{"token":receipt["token"],"outcome":"accepted","mode":"disarm","elapsed":.1})
            self.assertIn("Open requested",result["note"])
            def wait(phase):
                end=time.monotonic()+4
                while time.monotonic()<end:
                    state=self.client.status("example-garage")["state"]
                    if state["phase"]==phase and not state["busy"]:return
                    time.sleep(.02)
                self.fail("coordinator operation did not complete")
            wait("open")
            state=self.client.status("example-garage")
            request={"controller":"example-garage","command":"close","bootId":state["bootId"],"requestId":str(uuid.uuid4()),"issuedAt":time.time()*1000}
            self.assertTrue(route("command",request)["accepted"])
            self.assertTrue(route("command",request)["duplicate"])
            wait("closed")
            tx={"id":"synthetic-maintenance","gateway":"test","maintenance_participants":[]}
            for action in ("preflight","pause","pause","verify","resume","complete","complete"):
                self.assertTrue(peer.call("maintenance_"+action,tx))
            self.assertTrue(peer.guard())
            self.assertTrue(route("activity")["events"])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 tests/cross_repo.py /path/to/coordinator-repo")
    unittest.main(argv=[sys.argv[0]], verbosity=2)
