#!/usr/bin/python3
"""Actions client for the fixed, signed stopped-release wrapper."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def require(value):
    if not value:
        raise RuntimeError("RELEASE_INPUT_INVALID")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def main():
    try:
        sha = os.environ["RELEASE_SHA"]
        run = os.environ["RELEASE_RUN"]
        require(re.fullmatch(r"[a-f0-9]{40}", sha) and re.fullmatch(r"[1-9][0-9]{0,19}", run))
        archive = Path("release/image.tar.gz")
        with archive.open("rb") as f:
            archive_hash = hashlib.file_digest(f, "sha256").hexdigest()
        require(archive_hash == Path("release/image.tar.gz.sha256").read_text().split()[0])
        image = Path("release/image-id.txt").read_text().strip()
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", image))
        spec = importlib.util.spec_from_file_location("image_verifier", Path("deploy/broker/broker.py"))
        broker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(broker)
        config, manifests = broker.archive_identity(archive, image, sha)
        require(config == image)
        require(archive_hash == os.environ["EXPECTED_ARCHIVE"] and image == os.environ["EXPECTED_IMAGE"])
        host = os.environ["VPS_HOST"]
        user = os.environ["VPS_USER"]
        port = os.environ["VPS_PORT"]
        require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", host) and user == "suiba-deploy")
        require(re.fullmatch(r"[0-9]{1,5}", port) and 1 <= int(port) <= 65535)
        require(all(os.environ.get(k) for k in ("VPS_SSH_KEY", "VPS_KNOWN_HOSTS", "VPS_RELEASE_APPROVAL_KEY")))
        with tempfile.TemporaryDirectory(prefix="stopped-release-", dir=os.environ["RUNNER_TEMP"]) as tmp:
            folder = Path(tmp)
            for name, variable in (("ssh", "VPS_SSH_KEY"), ("hosts", "VPS_KNOWN_HOSTS"),
                                   ("signing", "VPS_RELEASE_APPROVAL_KEY")):
                fd = os.open(folder/name, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as out:
                    out.write(os.environ.pop(variable) + "\n")
            opts = [
                "/usr/bin/ssh", "-F", "/dev/null", "-T", "-i", str(folder/"ssh"), "-p", port,
                "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
                "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
                "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile="+str(folder/"hosts"),
                "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no",
                "-o", "HostKeyAlgorithms=ssh-ed25519", "-o", "ClearAllForwardings=yes",
                "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1",
                user+"@"+host, "sudo -n -- /usr/local/sbin/suiba-stopped-release",
            ]
            env = {"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/tmp")}
            def remote(value, timeout):
                with tempfile.TemporaryFile() as out:
                    p = subprocess.run(opts, input=canonical(value), stdout=out, stderr=subprocess.DEVNULL,
                                       env=env, timeout=timeout)
                    require(p.returncode == 0)
                    out.seek(0)
                    data = out.read(8193)
                require(len(data) <= 8192)
                return json.loads(data)
            plan = remote({"operation": "plan"}, 30)
            require(set(plan) == {"sequence", "paper_run"} and type(plan["sequence"]) is int and plan["sequence"] > 0)
            approval = {"sha": sha, "operation": "deploy", "archive_sha256": archive_hash, "image_id": image,
                        "sequence": plan["sequence"], "expires": int(time.time())+1800,
                        "repository": "tajumaru/SuiBa", "ref": "refs/heads/main", "ci_run": int(run)}
            payload = {"version": 1, "paper_run": plan["paper_run"], "approval": approval}
            message = folder/"payload"
            message.write_bytes(canonical(payload))
            signature = folder/"signature"
            subprocess.run([
                "/usr/bin/openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(folder/"signing"),
                "-in", str(message), "-out", str(signature),
            ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=True, env=env, timeout=10)
            signed = signature.read_bytes()
            require(len(signed) == 64)
            result = remote({"operation": "apply", "payload": payload,
                             "signature": base64.b64encode(signed).decode()}, 840)
            require(set(result) == {"status", "sha", "sequence", "backup_sha256", "maintenance", "pair"})
            require(result["status"] == "prepared_stopped" and result["sha"] == sha and
                    result["sequence"] == plan["sequence"] and result["maintenance"] is True and
                    result["pair"] == "SUI_USDC" and re.fullmatch(r"[a-f0-9]{64}", result["backup_sha256"]))
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write("## Stopped PAPER release verified\n\n")
                for key in ("status", "sha", "sequence", "backup_sha256", "maintenance", "pair"):
                    summary.write("- "+key+" = "+str(result[key])+"\n")
        print("STOPPED_RELEASE_VERIFIED")
    except BaseException:
        # Hide SSH details, key parse errors, remote replies and raw exception strings.
        print("STOPPED_RELEASE_FAILED_REQUIRES_REVIEW", file=__import__("sys").stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
