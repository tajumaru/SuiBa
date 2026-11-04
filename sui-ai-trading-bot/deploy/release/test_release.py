import base64
import contextlib
import copy
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tarfile
import shutil
import time
import types
import unittest
from unittest.mock import patch

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

r = load("release", "/usr/local/libexec/suiba-stopped-release.py")
b = load("broker", "/usr/local/libexec/suiba-deploy-broker.py")
c = load("controller", "/usr/local/libexec/suiba-paper-check.py")

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/var/lib")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state, self.policy, self.paper = [self.root/name for name in ("state", "policy", "paper")]
        for path in (self.state, self.policy, self.paper, self.policy/"approvals"):
            path.mkdir(mode=0o700)
        for name in ("release.lock", "lock"):
            (self.state/name).touch(mode=0o600)
        b.STATE, b.POLICY = self.state, self.policy
        self.run_id = "b"*32
        self.events = []
        self.record = {"id": self.run_id, "status": "failed_requires_review"}
        self.folder = self.paper/self.run_id
        self.folder.mkdir(mode=0o700)
        b.atomic(self.folder/"stop.json", {"id": self.run_id, "status": "clean_stopped", "errors": []})
        ctl = types.SimpleNamespace(
            state=self.paper, record=self.paper/"run.json",
            quiescent=lambda: None, current=lambda *args: self.record,
            exited=lambda record: True, faults=lambda record: False,
            folder=lambda record: self.folder,
            inspect=lambda: {"State": {"Status": "exited", "Running": False, "Pid": 0,
                                      "ExitCode": 0, "OOMKilled": False},
                             "HostConfig": {"RestartPolicy": {"Name": "no"}}},
            approve_deploy=lambda *args: self.events.append("recover"),
            locked=lambda *args: contextlib.nullcontext())
        ctl.record.touch()
        self.ctl = ctl
        b.atomic(self.state/"ledger.json", {"sequence": 4, "status": "prepared_stopped"})
        self.release = r.Release(b, ctl)
        self.key = self.root/"private.pem"
        self.public = self.root/"public.pem"
        subprocess.run(["openssl","genpkey","-algorithm","ED25519","-out",str(self.key)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["openssl","pkey","-in",str(self.key),"-pubout","-out",str(self.public)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.key_patch = patch.object(r, "PUBLIC_KEY", self.public)
        self.key_patch.start()
        self.addCleanup(self.key_patch.stop)
        self.payload = {"version": 1, "paper_run": self.run_id, "approval": {
            "sha": "a"*40, "operation": "deploy", "archive_sha256": "c"*64,
            "image_id": "sha256:"+"d"*64, "sequence": 5, "expires": int(time.time())+1800,
            "repository": "tajumaru/SuiBa", "ref": "refs/heads/main", "ci_run": 123}}
        self.result = {"status": "prepared_stopped", "sha": "a"*40}

    def sign(self, payload):
        source = self.root/"message"
        signature = self.root/"signature"
        source.write_bytes(r.canonical(payload))
        subprocess.run(["openssl","pkeyutl","-sign","-rawin","-inkey",str(self.key),
                        "-in",str(source),"-out",str(signature)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return base64.b64encode(signature.read_bytes()).decode()

    def apply(self, payload, signature=None):
        def execute(req, uid):
            self.events.append("deploy")
            self.assertEqual(req, {"operation": "deploy", "sha": payload["approval"]["sha"]})
            return self.result
        with patch.object(b, "Broker", return_value=types.SimpleNamespace(execute=execute)),              patch.object(self.release, "verify_stopped", side_effect=lambda record: self.events.append("verify") or record):
            return self.release.apply(payload, signature or self.sign(payload), 1001)

    def test_signed_admission_reuses_recovery_deploy_and_verify_once(self):
        self.assertEqual(self.apply(self.payload), self.result)
        self.assertEqual(self.events, ["recover", "deploy", "verify"])
        self.assertEqual(b.decode(b.read_trusted(self.policy/"approvals"/("a"*40+".json"))),
                         self.payload["approval"])
        with self.assertRaises(Exception):
            self.apply(self.payload)
        self.assertEqual(self.events, ["recover", "deploy", "verify"])

    def test_signature_payload_expiry_scope_and_context_rejected(self):
        for mutation in ("digest", "sha", "sequence", "run", "expired", "future", "ref", "operation", "extra"):
            with self.subTest(mutation=mutation):
                payload = copy.deepcopy(self.payload)
                signature = self.sign(payload)
                if mutation in ("digest", "sha"):
                    key = "archive_sha256" if mutation == "digest" else "sha"
                    payload["approval"][key] = "e"*(64 if mutation == "digest" else 40)
                elif mutation == "sequence":
                    payload["approval"]["sequence"] = 6
                elif mutation == "run":
                    payload["paper_run"] = "e"*32
                elif mutation == "expired":
                    payload["approval"]["expires"] = int(time.time())-1
                elif mutation == "future":
                    payload["approval"]["expires"] = int(time.time())+7200
                elif mutation == "ref":
                    payload["approval"]["ref"] = "refs/heads/other"
                elif mutation == "operation":
                    payload["approval"]["operation"] = "start"
                else:
                    payload["command"] = "arbitrary"
                # A valid signature cannot relax schema, expiry or host context checks.
                if mutation not in ("digest", "sha"):
                    signature = self.sign(payload)
                with self.assertRaises(Exception):
                    self.apply(payload, signature)
                self.assertFalse(self.events)
                self.assertFalse(list((self.policy/"approvals").iterdir()))

    def test_foreign_key_and_malformed_signatures_rejected(self):
        signature = self.sign(self.payload)
        data = bytearray(base64.b64decode(signature))
        data[0] ^= 1
        for value in ("", "!", base64.b64encode(b"x").decode(), base64.b64encode(data).decode()):
            with self.subTest(signature=value[:4]), self.assertRaises(Exception):
                self.release.verify_signature(self.payload, value)

    def test_unknown_state_running_worker_fault_or_expired_controller_rejected(self):
        for field in ("running", "restart", "fault", "controller", "stop"):
            with self.subTest(field=field):
                with contextlib.ExitStack() as stack:
                    if field == "running":
                        i = self.ctl.inspect()
                        i["State"]["Running"] = True
                        stack.enter_context(patch.object(self.ctl, "inspect", return_value=i))
                    elif field == "restart":
                        i = self.ctl.inspect()
                        i["HostConfig"]["RestartPolicy"]["Name"] = "always"
                        stack.enter_context(patch.object(self.ctl, "inspect", return_value=i))
                    elif field == "fault":
                        stack.enter_context(patch.object(self.ctl, "faults", return_value=True))
                    elif field == "controller":
                        stack.enter_context(patch.object(self.ctl, "exited", return_value=False))
                    else:
                        b.atomic(self.folder/"stop.json", {"id": self.run_id, "status": "failed_state_unknown", "errors": []})
                    with self.assertRaises(Exception):
                        self.apply(self.payload)
                    self.assertFalse(self.events)
                    self.assertFalse(list((self.policy/"approvals").iterdir()))

    def test_partial_failure_preserves_approval_and_refuses_automatic_retry(self):
        with patch.object(self.ctl, "approve_deploy", side_effect=RuntimeError("fixture")):
            with self.assertRaises(Exception):
                self.apply(self.payload)
        self.assertTrue((self.policy/"approvals"/("a"*40+".json")).exists())
        with self.assertRaises(Exception):
            self.apply(self.payload)
        self.assertFalse(self.events)

    def test_concurrent_stop_or_deploy_lock_refuses_admission(self):
        with b.regular(self.state/"lock") as fd:
            b.fcntl.flock(fd, b.fcntl.LOCK_EX|b.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.apply(self.payload)
        self.assertFalse(self.events)

    def test_elapsed_timer_only_retires_without_future_schedule(self):
        r.ctl_module = c
        states = {
            c.SERVICE: {"ActiveState": "failed", "Job": ""},
            c.CUTOFF: {"ActiveState": "inactive", "Job": ""},
            c.TIMER: {"ActiveState": "active", "SubState": "elapsed", "Job": "",
                      "NextElapseUSecMonotonic": "0", "NextElapseUSecRealtime": "0"}}
        self.ctl.system = lambda *args: self.events.append(args)
        with patch.object(self.release, "system_state", side_effect=lambda unit: states[unit]):
            self.release.retire_elapsed_timer()
            self.assertEqual(self.events, [("stop", c.TIMER)])
            self.events.clear()
            states[c.TIMER]["NextElapseUSecMonotonic"] = "12345"
            with self.assertRaises(Exception):
                self.release.retire_elapsed_timer()
            self.assertFalse(self.events)

    def test_final_receipt_container_backup_and_database_checks(self):
        transaction = "f"*32
        folder = self.state/transaction
        folder.mkdir(mode=0o700)
        backups = self.root/"backups"
        backups.mkdir(mode=0o700)
        content = b"verified cold backup fixture"
        archive = backups/(transaction+".tar")
        archive.write_bytes(content)
        record = {"status": "prepared_stopped", "transaction": transaction, "sha": "a"*40,
                  "sequence": 5, "backup": archive.name}
        b.atomic(folder/"receipt.json", record)
        b.atomic(folder/"backup.json", {"file": archive.name, "sha256": hashlib.sha256(content).hexdigest()})
        b.atomic(folder/"compose.json", {"services": {"bot": {"image": "sha256:"+"e"*64}}})
        i = {"State": {"Status": "created", "Running": False, "Pid": 0},
             "HostConfig": {"RestartPolicy": {"Name": "no"}},
             "Config": {"Image": "sha256:"+"e"*64, "Env": ["MODE=PAPER", "TRADING_PAIR=SUI_USDC"],
                        "Labels": {"org.opencontainers.image.revision": "a"*40}}}
        calls = []
        self.ctl.helper = lambda: (types.SimpleNamespace(helper=lambda *args: calls.append(args)), "fixed-helper")
        self.ctl.verify_sui = lambda: calls.append("sui")
        with patch.object(b, "BACKUPS", backups), patch.object(self.ctl, "inspect", return_value=i):
            report = self.release.verify_stopped(record)
            self.assertEqual(report["status"], "prepared_stopped")
            self.assertEqual(calls, [("fixed-helper", "verify"), "sui"])
            i["State"]["Running"] = True
            with self.assertRaises(Exception):
                self.release.verify_stopped(record)
            i["State"]["Running"] = False
            i["Config"]["Env"] = ["MODE=PAPER", "TRADING_PAIR=WAL_USDC"]
            with self.assertRaises(Exception):
                self.release.verify_stopped(record)
            i["Config"]["Env"] = ["MODE=PAPER", "TRADING_PAIR=SUI_USDC"]
            with patch.object(self.ctl, "verify_sui", side_effect=RuntimeError("fixture DB selection failure")):
                with self.assertRaises(Exception):
                    self.release.verify_stopped(record)
            archive.write_bytes(b"tampered")
            with self.assertRaises(Exception):
                self.release.verify_stopped(record)

    def test_ssh_wrapper_has_no_arguments_or_general_sudo(self):
        for args in (
            ["sudo","-n","/bin/sh","-c","true"],
            ["sudo","-n","/usr/local/sbin/suiba-stopped-release","extra"]):
            p = subprocess.run(["runuser","-u","suiba-deploy","--",*args],
                               input=b"", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
            self.assertNotEqual(p.returncode, 0)
        p = subprocess.run(["runuser","-u","suiba-deploy","--","sudo","-n",
                            "/usr/local/sbin/suiba-stopped-release"],
                           input=b'{"operation":"start"}', stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        self.assertNotEqual(p.returncode, 0)
        self.assertNotIn(b"Traceback", p.stderr)

class ClientTests(unittest.TestCase):
    def test_fixed_client_pins_artifact_and_never_prints_credentials(self):
        client = load("client", "/client/ssh-stopped-release.py")
        for failure in (None, "archive", "ssh"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(dir="/var/lib") as tmp:
                root = Path(tmp)
                for folder in (root/"release", root/"deploy", root/"deploy/broker"):
                    folder.mkdir(mode=0o700)
                shutil.copyfile("/usr/local/libexec/suiba-deploy-broker.py", root/"deploy/broker/broker.py")
                sha = "a"*40
                config = r.canonical({"os": "linux", "architecture": "amd64", "rootfs": {"diff_ids": []},
                                      "config": {"User": "node", "Env": ["MODE=PAPER"],
                                                 "Labels": {"org.opencontainers.image.revision": sha}}})
                digest = hashlib.sha256(config).hexdigest()
                members = {digest+".json": config,
                           "manifest.json": json.dumps([{"Config": digest+".json", "Layers": []}]).encode()}
                archive = root/"release/image.tar.gz"
                with tarfile.open(archive, "w:gz") as tar:
                    for name, data in members.items():
                        info = tarfile.TarInfo(name)
                        info.size = len(data)
                        tar.addfile(info, io.BytesIO(data))
                archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
                (root/"release/image.tar.gz.sha256").write_text(archive_hash+"  image.tar.gz")
                (root/"release/image-id.txt").write_text("sha256:"+digest)
                private = root/"private.pem"
                subprocess.run(["openssl","genpkey","-algorithm","ED25519","-out",str(private)],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                settings = {"RELEASE_SHA": sha, "RELEASE_RUN": "123", "EXPECTED_IMAGE": "sha256:"+digest,
                            "EXPECTED_ARCHIVE": "0"*64 if failure == "archive" else archive_hash,
                            "VPS_HOST": "example.test", "VPS_PORT": "22", "VPS_USER": "suiba-deploy",
                            "VPS_SSH_KEY": "secret-fixture-ssh", "VPS_KNOWN_HOSTS": "fixture-host",
                            "VPS_RELEASE_APPROVAL_KEY": private.read_text(), "RUNNER_TEMP": str(root),
                            "GITHUB_STEP_SUMMARY": str(root/"summary")}
                events = []
                original = subprocess.run
                def run(argv, **kwargs):
                    if argv[0] != "/usr/bin/ssh":
                        return original(argv, **kwargs)
                    self.assertNotIn("VPS_RELEASE_APPROVAL_KEY", kwargs["env"])
                    self.assertEqual(argv[-1], "sudo -n -- /usr/local/sbin/suiba-stopped-release")
                    request = json.loads(kwargs["input"])
                    events.append(request["operation"])
                    if failure == "ssh":
                        return types.SimpleNamespace(returncode=1)
                    if request["operation"] == "plan":
                        response = {"sequence": 5, "paper_run": "b"*32}
                    else:
                        self.assertEqual(request["payload"]["approval"]["archive_sha256"], archive_hash)
                        self.assertEqual(len(base64.b64decode(request["signature"])), 64)
                        response = {"status": "prepared_stopped", "sha": sha, "sequence": 5,
                                    "backup_sha256": "c"*64, "maintenance": True, "pair": "SUI_USDC"}
                    kwargs["stdout"].write(json.dumps(response).encode())
                    return types.SimpleNamespace(returncode=0)
                stdout, stderr = io.StringIO(), io.StringIO()
                previous = Path.cwd()
                try:
                    os.chdir(root)
                    with patch.dict(os.environ, settings), patch.object(client.subprocess,"run",side_effect=run), \
                         contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                        result = client.main()
                finally:
                    os.chdir(previous)
                self.assertEqual(result, 0 if failure is None else 1)
                self.assertNotIn("secret-fixture-ssh", stdout.getvalue()+stderr.getvalue())
                self.assertNotIn("PRIVATE KEY", stdout.getvalue()+stderr.getvalue())
                self.assertEqual(events, ["plan", "apply"] if failure is None else [] if failure == "archive" else ["plan"])
                self.assertFalse(list(root.glob("stopped-release-*")))

if __name__ == "__main__":
    unittest.main(verbosity=2)
