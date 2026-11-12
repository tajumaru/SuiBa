#!/usr/bin/env python3
"""Contract tests for setup-ci-approval.sh and the policy composes.

The broker deploys with whichever compose the host setup last
installed as the policy compose. The two variants (validation /
production) differ only in the PAPER_CHECK_MODE session token, and
the setup script carries a sha256 pin for each. These tests lock:
both pins match the files they name, the variants carry no other
difference, and an unknown variant argument is rejected before the
script does anything else (docs/PROD_START_TOKEN_FIX_DESIGN_JA.md).

The mode-change guard is exercised end to end against a rewritten
copy of the script whose downloads are file:// URLs of the real
repository files (so the untouched pins still verify) and whose
host paths point into a temporary sandbox: a re-run must never
silently swap an installed compose's PAPER_CHECK_MODE.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "..")
SCRIPT = os.path.join(HERE, "setup-ci-approval.sh")
BROKER = os.path.join(HERE, "broker.py")
PAPER_COMPOSE = os.path.join(APP, "docker", "compose.vps.yaml")
PROD_COMPOSE = os.path.join(APP, "docker", "compose.vps-prod.yaml")


def sha256(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def script_pin(name):
    with open(SCRIPT, encoding="utf-8") as fh:
        source = fh.read()
    match = re.search(rf"^{name}='([0-9a-f]{{64}})'", source, re.MULTILINE)
    if match is None:
        raise AssertionError(f"{name} pin not found in the setup script")
    return match.group(1)


def normalized_compose(path):
    """Compose content lines with comment-only lines dropped and the
    session token replaced by a placeholder, so the two variants
    compare equal exactly when nothing else differs."""
    lines = []
    with open(path, encoding="utf-8") as fh:
        for line in fh.read().splitlines():
            if line.lstrip().startswith("#"):
                continue
            lines.append(re.sub(r"(PAPER_CHECK_MODE:)\s*\S+",
                                r"\1 <TOKEN>", line))
    return lines


class ComposePinTests(unittest.TestCase):
    def test_paper_compose_pin_matches_file(self):
        self.assertEqual(script_pin("COMPOSE_SHA256"),
                         sha256(PAPER_COMPOSE))

    def test_prod_compose_pin_matches_file(self):
        self.assertEqual(script_pin("COMPOSE_PROD_SHA256"),
                         sha256(PROD_COMPOSE))

    def test_variants_differ_only_in_comments_and_token(self):
        self.assertEqual(normalized_compose(PAPER_COMPOSE),
                         normalized_compose(PROD_COMPOSE))

    def test_prod_compose_uses_the_production_token(self):
        with open(PROD_COMPOSE, encoding="utf-8") as fh:
            self.assertIn("PAPER_CHECK_MODE: sui-prod", fh.read())


class VariantArgumentTests(unittest.TestCase):
    def test_unknown_variant_is_rejected(self):
        result = subprocess.run(
            ["bash", SCRIPT, "bogus-variant"],
            capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SETUP_FAILED", result.stderr)


class ModeChangeGuardTests(unittest.TestCase):
    """Run the setup script (rewritten into a sandbox) and check the
    PAPER_CHECK_MODE guard around the policy compose install."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="setup-guard-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        root = os.path.join(self.tmp, "root")
        self.policy_dir = os.path.join(root, "etc", "suiba-deploy")
        self.shared = os.path.join(root, "opt", "suiba", "shared")
        self.libexec = os.path.join(root, "usr", "local", "libexec")
        for folder in (self.policy_dir, self.shared, self.libexec):
            os.makedirs(folder)
        self.policy = os.path.join(self.policy_dir, "policy.json")
        with open(self.policy, "w", encoding="utf-8") as fh:
            json.dump({"approval_source": "file",
                       "compose_sha256": "0" * 64,
                       "helper_image": "sha256:" + "0" * 64}, fh)
        with open(os.path.join(self.shared, "runtime.env"), "w",
                  encoding="utf-8") as fh:
            fh.write("MARKET_DATA_PROVIDER=deepbook\n"
                     "DEEPBOOK_RECONSTRUCT_CANDLES=off\n"
                     "SUI_GRPC_URL=https://fullnode.mainnet.sui.io:443\n")
        with open(os.path.join(self.shared, "admin-token"), "w",
                  encoding="utf-8") as fh:
            fh.write("ab" * 32)
        self.compose_target = os.path.join(self.policy_dir, "compose.yaml")
        self.broker_target = os.path.join(
            self.libexec, "suiba-deploy-broker.py")
        self.script_copy = os.path.join(self.tmp, "setup-ci-approval.sh")
        with open(self.script_copy, "w", encoding="utf-8") as fh:
            fh.write(self._sandboxed_script(root))

    def _sandboxed_script(self, root):
        with open(SCRIPT, encoding="utf-8") as fh:
            source = fh.read()
        overrides = {
            "BROKER_URL": "file://" + BROKER,
            "COMPOSE_URL": "file://" + PAPER_COMPOSE,
            "COMPOSE_PROD_URL": "file://" + PROD_COMPOSE,
            "BROKER_TARGET": self.broker_target,
            "COMPOSE_TARGET": self.compose_target,
            "POLICY": self.policy,
            "SHARED": self.shared,
        }
        for name, value in overrides.items():
            source, count = re.subn(
                rf"^{name}='[^']*'$", lambda _: f"{name}='{value}'",
                source, count=1, flags=re.MULTILINE)
            if count != 1:
                raise AssertionError(f"{name} assignment not rewritten")
        return source

    def install_compose(self, source_path):
        shutil.copyfile(source_path, self.compose_target)

    def run_setup(self, variant=None, allow_mode_change=False):
        command = []
        if os.geteuid() != 0 and shutil.which("sudo"):
            command += ["sudo", "-n"]
        if allow_mode_change:
            command += ["env", "SUIBA_SETUP_ALLOW_MODE_CHANGE=1"]
        command += ["bash", self.script_copy]
        if variant is not None:
            command.append(variant)
        env = dict(os.environ)
        env.pop("SUIBA_SETUP_ALLOW_MODE_CHANGE", None)
        return subprocess.run(command, capture_output=True, text=True,
                              encoding="utf-8", errors="replace",
                              timeout=120, env=env)

    @staticmethod
    def read_bytes(path):
        with open(path, "rb") as fh:
            return fh.read()

    def test_first_install_proceeds(self):
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read_bytes(self.compose_target),
                         self.read_bytes(PAPER_COMPOSE))
        self.assertIn("実効 PAPER_CHECK_MODE: sui-30m", result.stdout)

    def test_same_mode_reinstall_proceeds_without_optin(self):
        self.install_compose(PAPER_COMPOSE)
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read_bytes(self.compose_target),
                         self.read_bytes(PAPER_COMPOSE))

    def test_mode_change_without_optin_refuses_and_leaves_files(self):
        # The 2026-11-12 incident: prod compose installed, bare
        # re-run would swap in the paper compose.
        self.install_compose(PROD_COMPOSE)
        policy_before = self.read_bytes(self.policy)
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SETUP_FAILED", result.stderr)
        self.assertIn("sui-prod", result.stderr)
        self.assertIn("sui-30m", result.stderr)
        self.assertIn("SUIBA_SETUP_ALLOW_MODE_CHANGE=1", result.stderr)
        self.assertEqual(self.read_bytes(self.compose_target),
                         self.read_bytes(PROD_COMPOSE))
        self.assertEqual(self.read_bytes(self.policy), policy_before)
        self.assertFalse(os.path.exists(self.broker_target))

    def test_prod_variant_without_optin_refuses_on_paper_host(self):
        self.install_compose(PAPER_COMPOSE)
        result = self.run_setup(variant="prod")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SETUP_FAILED", result.stderr)
        self.assertEqual(self.read_bytes(self.compose_target),
                         self.read_bytes(PAPER_COMPOSE))

    def test_mode_change_with_optin_proceeds(self):
        self.install_compose(PROD_COMPOSE)
        result = self.run_setup(allow_mode_change=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SUIBA_SETUP_ALLOW_MODE_CHANGE=1", result.stdout)
        self.assertEqual(self.read_bytes(self.compose_target),
                         self.read_bytes(PAPER_COMPOSE))
        self.assertIn("実効 PAPER_CHECK_MODE: sui-30m", result.stdout)


if __name__ == "__main__":
    unittest.main()
