import importlib.util
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "scripts/release_setup_warning.py"
SPEC = importlib.util.spec_from_file_location("release_setup_warning", SCRIPT)
CHECK = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(CHECK)


class ReleaseSetupWarningTest(unittest.TestCase):
    def run_check(self, baseline, changed):
        output = io.StringIO()
        with tempfile.NamedTemporaryFile() as summary, redirect_stdout(output), \
             patch.object(CHECK, "previous_successful_sha", return_value=baseline), \
             patch.object(CHECK, "changed_paths", return_value=set(changed)), \
             patch.dict(CHECK.os.environ, {"GITHUB_STEP_SUMMARY": summary.name}):
            self.assertEqual(CHECK.main(), 0)
            summary.seek(0)
            return output.getvalue(), summary.read().decode()

    def test_reads_distributed_paths_from_both_setup_pin_tables(self):
        pins = CHECK.pinned_paths()
        self.assertIn("sui-ai-trading-bot/deploy/paper-check/controller.py", pins)
        self.assertIn("sui-ai-trading-bot/deploy/broker/broker.py", pins)
        self.assertIn("sui-ai-trading-bot/docker/compose.vps.yaml", pins)
        self.assertIn("sui-ai-trading-bot/docker/compose.vps-prod.yaml", pins)

    def test_warns_for_files_from_each_setup_pin_list(self):
        changed = {
            "sui-ai-trading-bot/deploy/paper-check/controller.py",
            "sui-ai-trading-bot/deploy/broker/broker.py",
        }
        annotation, summary = self.run_check("a" * 40, changed)
        self.assertIn("::warning", annotation)
        self.assertIn("STOP→setup→START の短い窓がもう1回必要", annotation)
        for path in changed:
            self.assertIn(path, annotation)
            self.assertIn(path, summary)

    def test_stays_quiet_when_no_pinned_file_changed(self):
        annotation, summary = self.run_check("a" * 40, {"sui-ai-trading-bot/README.md"})
        self.assertEqual(annotation, "")
        self.assertEqual(summary, "")

    def test_stays_quiet_when_baseline_is_unavailable(self):
        annotation, summary = self.run_check(None, {"sui-ai-trading-bot/deploy/paper-check/controller.py"})
        self.assertEqual(annotation, "")
        self.assertEqual(summary, "")

    def test_internal_failure_is_also_advisory(self):
        output = io.StringIO()
        with redirect_stdout(output), patch.object(
            CHECK, "previous_successful_sha", side_effect=OSError("offline")
        ):
            self.assertEqual(CHECK.main(), 0)
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
