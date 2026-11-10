#!/usr/bin/env python3
"""Contract tests for setup-ci-approval.sh and the policy composes.

The broker deploys with whichever compose the host setup last
installed as the policy compose. The two variants (validation /
production) differ only in the PAPER_CHECK_MODE session token, and
the setup script carries a sha256 pin for each. These tests lock:
both pins match the files they name, the variants carry no other
difference, and an unknown variant argument is rejected before the
script does anything else (docs/PROD_START_TOKEN_FIX_DESIGN_JA.md).
"""
import hashlib
import os
import re
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "..")
SCRIPT = os.path.join(HERE, "setup-ci-approval.sh")
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


if __name__ == "__main__":
    unittest.main()
