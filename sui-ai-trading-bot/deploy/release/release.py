#!/usr/bin/python3
"""Fixed, signed, stopped-only release admission. Never starts a Worker."""
import base64
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import signal
import stat
import subprocess
import sys
import tempfile
import time

BROKER = Path("/usr/local/libexec/suiba-deploy-broker.py")
CONTROLLER = Path("/usr/local/libexec/suiba-paper-check.py")
PUBLIC_KEY = Path("/etc/suiba-deploy/release-approval.pub")
MAX_REQUEST = 8192


def require(value):
    if not value:
        raise RuntimeError("RELEASE_REJECTED")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def load_module(name, path, broker=None):
    if broker:
        broker.read_trusted(path)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Release:
    def __init__(self, broker, controller):
        self.b = broker
        self.controller = controller

    @contextlib.contextmanager
    def locked(self):
        path = self.b.STATE / "release.lock"
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        with self.b.regular(path) as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    @contextlib.contextmanager
    def admission_locked(self):
        with self.b.regular(self.b.STATE / "lock") as fd:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.controller.locked("stop"), self.controller.locked("mutation"):
                yield

    def context(self):
        ctl = self.controller
        state = self.b.decode(self.b.read_trusted(self.b.STATE / "ledger.json"))
        require(state["status"] == "prepared_stopped" and type(state["sequence"]) is int)
        ctl.quiescent()
        container = ctl.inspect()
        require(not container["State"]["Running"] and container["State"]["Pid"] == 0)
        require(container["State"]["Status"] in ("created", "exited"))
        require(container["State"]["ExitCode"] == 0 and not container["State"]["OOMKilled"])
        require(container["HostConfig"]["RestartPolicy"]["Name"] == "no")
        run = None
        if ctl.record.exists():
            record = ctl.current()
            require(ctl.exited(record) and not ctl.faults(record))
            require(record["status"] in ("failed_requires_review", "completed"))
            stop = self.b.decode(self.b.read_trusted(ctl.folder(record) / "stop.json"))
            require(stop["id"] == record["id"] and stop["status"] == "clean_stopped" and stop["errors"] == [])
            run = record["id"]
        require(not os.path.lexists(ctl.state / "abort-inhibit.json"))
        return {"sequence": state["sequence"] + 1, "paper_run": run}

    def retire_elapsed_timer(self):
        # Automatic retirement is limited to an elapsed timer with no pending cutoff.
        ctl = self.controller
        i = ctl.inspect()
        require(not i["State"]["Running"] and i["State"]["Pid"] == 0)
        for unit in (ctl_module.SERVICE, ctl_module.CUTOFF):
            raw = self.system_state(unit)
            require(raw["ActiveState"] in ("inactive", "failed") and raw["Job"] in ("", "0"))
        timer = self.system_state(ctl_module.TIMER)
        require(timer["Job"] in ("", "0"))
        if timer["ActiveState"] == "active":
            require(timer["SubState"] == "elapsed" and
                    timer["NextElapseUSecMonotonic"] in ("", "0") and
                    timer["NextElapseUSecRealtime"] in ("", "0", "n/a"))
            ctl.system("stop", ctl_module.TIMER)
        ctl.quiescent()

    @staticmethod
    def system_state(unit):
        raw = subprocess.check_output([
            "/usr/bin/systemctl", "show", unit, "-p", "ActiveState", "-p", "SubState",
            "-p", "Job", "-p", "NextElapseUSecMonotonic", "-p", "NextElapseUSecRealtime",
        ], env={"PATH": "/usr/bin:/bin"}, timeout=10)
        return dict(line.split("=", 1) for line in raw.decode().splitlines() if "=" in line)

    def verify_signature(self, payload, signature):
        require(isinstance(signature, str) and len(signature) <= 128)
        signature = base64.b64decode(signature, validate=True)
        require(len(signature) == 64)
        key = self.b.read_trusted(PUBLIC_KEY)
        with tempfile.TemporaryDirectory(prefix="release-signature-", dir=self.b.STATE) as tmp:
            folder = Path(tmp)
            for name, data in (("public.pem", key), ("payload", canonical(payload)), ("signature", signature)):
                fd = os.open(folder / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as out:
                    out.write(data)
            env = {"PATH": "/usr/bin:/bin"}
            der = self.b.bounded_process([
                "/usr/bin/openssl", "pkey", "-pubin", "-in", str(folder / "public.pem"), "-outform", "DER",
            ], env, timeout=10)
            require(len(der) == 44 and der[:12] == bytes.fromhex("302a300506032b6570032100"))
            result = subprocess.run([
                "/usr/bin/openssl", "pkeyutl", "-verify", "-pubin", "-rawin",
                "-inkey", str(folder / "public.pem"), "-in", str(folder / "payload"),
                "-sigfile", str(folder / "signature"),
            ], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=10)
            require(result.returncode == 0)

    def validate(self, payload):
        require(isinstance(payload, dict) and set(payload) == {"version", "paper_run", "approval"})
        require(type(payload["version"]) is int and payload["version"] == 1)
        run_id = payload["paper_run"]
        require(run_id is None or isinstance(run_id, str) and
                len(run_id) == 32 and all(c in "0123456789abcdef" for c in run_id))
        a = payload["approval"]
        require(isinstance(a, dict) and set(a) == {
            "sha", "operation", "archive_sha256", "image_id", "sequence", "expires",
            "repository", "ref", "ci_run"})
        require(isinstance(a["sha"], str) and self.b.SHA.fullmatch(a["sha"]))
        require(isinstance(a["archive_sha256"], str) and self.b.HEX.fullmatch(a["archive_sha256"]))
        require(isinstance(a["image_id"], str) and self.b.DIGEST.fullmatch(a["image_id"]))
        require(a["operation"] == "deploy" and a["repository"] == "tajumaru/SuiBa" and a["ref"] == "refs/heads/main")
        require(type(a["sequence"]) is int and a["sequence"] > 0 and
                type(a["ci_run"]) is int and a["ci_run"] > 0 and type(a["expires"]) is int)
        require(time.time() < a["expires"] <= time.time() + 3600)
        return a

    def apply(self, payload, signature, uid):
        a = self.validate(payload)
        self.verify_signature(payload, signature)
        with self.locked():
            with self.admission_locked():
                # Recheck root-owned context after signature verification.
                context = self.context()
                require(context == {"sequence": a["sequence"], "paper_run": payload["paper_run"]})
                path = self.b.POLICY / "approvals" / (a["sha"] + ".json")
                require(not os.path.lexists(path))
                # Never overwrite an approval or retry a partially admitted operation.
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as out:
                    out.write(canonical(a))
                    out.flush()
                    os.fsync(out.fileno())
                with self.b.directory(path.parent) as parent:
                    os.fsync(parent)
            if payload["paper_run"] is not None:
                old = self.controller.current(payload["paper_run"])
                if old["status"] == "failed_requires_review":
                    self.controller.approve_deploy(payload["paper_run"], a["sha"])
            record = self.b.Broker().execute({"operation": "deploy", "sha": a["sha"]}, uid)
            with self.admission_locked():
                return self.verify_stopped(record)

    def verify_stopped(self, record):
        require(record["status"] == "prepared_stopped")
        transaction = record["transaction"]
        require(len(transaction) == 32 and all(c in "0123456789abcdef" for c in transaction))
        folder = self.b.STATE / transaction
        require(self.b.decode(self.b.read_trusted(folder / "receipt.json")) == record)
        backup = self.b.decode(self.b.read_trusted(folder / "backup.json"))
        require(backup["file"] == transaction + ".tar" and record["backup"] == backup["file"])
        with self.b.regular(self.b.BACKUPS / backup["file"]) as fd:
            with os.fdopen(os.dup(fd), "rb") as stream:
                require(hashlib.file_digest(stream, "sha256").hexdigest() == backup["sha256"])
        i = self.controller.inspect()
        require(i["State"]["Status"] == "created" and not i["State"]["Running"] and i["State"]["Pid"] == 0)
        require(i["HostConfig"]["RestartPolicy"]["Name"] == "no")
        env = dict(v.split("=", 1) for v in i["Config"]["Env"])
        require(env.get("MODE") == "PAPER" and env.get("TRADING_PAIR") == "SUI_USDC")
        require(i["Config"]["Labels"].get("org.opencontainers.image.revision") == record["sha"])
        frozen = self.b.decode(self.b.read_trusted(folder / "compose.json"))
        require(i["Config"]["Image"] == frozen["services"]["bot"]["image"])
        helper, image = self.controller.helper()
        helper.helper(image, "verify")
        self.controller.verify_sui()
        return {"status": "prepared_stopped", "sha": record["sha"], "sequence": record["sequence"],
                "backup_sha256": backup["sha256"], "maintenance": True, "pair": "SUI_USDC"}

    def plan(self):
        with self.locked(), self.admission_locked():
            self.retire_elapsed_timer()
            return self.context()


def main():
    os.umask(0o077)
    try:
        require(os.geteuid() == 0 and len(sys.argv) == 1)
        account = pwd.getpwnam("suiba-deploy")
        require(os.environ.get("SUDO_USER") == account.pw_name and
                os.environ.get("SUDO_UID") == str(account.pw_uid))
        # Validate trusted module ancestors before importing any privileged code.
        current = BROKER.parent
        while current != Path("/"):
            st = current.lstat()
            require(current.is_dir() and not current.is_symlink() and st.st_uid == 0 and not st.st_mode & 0o022)
            current = current.parent
        st = BROKER.lstat()
        require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022 and st.st_nlink == 1)
        b = load_module("release_broker", BROKER)
        b.read_trusted(Path(__file__))
        global ctl_module
        ctl_module = load_module("release_controller", CONTROLLER, b)
        release = Release(b, ctl_module.Controller(b))
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, lambda *_: (_ for _ in ()).throw(RuntimeError("INTERRUPTED")))
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(RuntimeError("INPUT_TIMEOUT")))
        signal.alarm(5)
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        require(len(raw) <= MAX_REQUEST)
        request = b.decode(raw)
        signal.alarm(0)
        require(isinstance(request, dict))
        if request == {"operation": "plan"}:
            result = release.plan()
        else:
            require(set(request) == {"operation", "payload", "signature"} and request["operation"] == "apply")
            result = release.apply(request["payload"], request["signature"], account.pw_uid)
        print(json.dumps(result))
        return 0
    except BaseException:
        print("STOPPED_RELEASE_FAILED_REQUIRES_REVIEW", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
