#!/usr/bin/env python3
"""Contract tests for the one-approval deploy (workflow task 7):
the plan helper's branching and the workflow's shape."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
spec = importlib.util.spec_from_file_location(
    "deploy_plan", os.path.join(HERE, "paper-deploy-cycle-plan.py"))
plan_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan_mod)


def diagnostics(state="completed", active=False, elapsed=False, fault=False):
    return "\n".join([
        "### SuiBa PAPER verification",
        f"- Run: `{state}`",
        f"- Deployment PAPER gate: {state}, fault marker={fault}",
        f"- Cutoff timer: active={active}, elapsed={elapsed}, "
        "next scheduled=False, job pending=False",
    ])


class PlanTests(unittest.TestCase):
    def test_completed_clean_state_needs_nothing(self):
        self.assertEqual(plan_mod.plan(diagnostics()),
                         {"release_cutoff": False, "approve_deploy": False})

    def test_failed_with_elapsed_timer_needs_both(self):
        self.assertEqual(
            plan_mod.plan(diagnostics(state="failed_requires_review",
                                      elapsed=True, fault=True)),
            {"release_cutoff": True, "approve_deploy": True})

    def test_failed_without_timer_needs_approve_only(self):
        self.assertEqual(
            plan_mod.plan(diagnostics(state="failed_requires_review", fault=True)),
            {"release_cutoff": False, "approve_deploy": True})

    def test_completed_with_armed_timer_needs_release_only(self):
        self.assertEqual(plan_mod.plan(diagnostics(active=True)),
                         {"release_cutoff": True, "approve_deploy": False})

    def test_failed_without_fault_marker_is_a_clean_failure(self):
        # A run that stops on a worker runtime error during monitoring
        # and finalizes cleanly is failed_requires_review with no
        # reconciliation latch. That state is consistent (no abort),
        # but the session marker stays in_progress over the failed
        # predecessor, so the broker still demands a deploy permit:
        # approve_deploy is needed for every failed predecessor.
        self.assertEqual(
            plan_mod.plan(diagnostics(state="failed_requires_review",
                                      active=True)),
            {"release_cutoff": True, "approve_deploy": True})
        self.assertEqual(
            plan_mod.plan(diagnostics(state="failed_requires_review")),
            {"release_cutoff": False, "approve_deploy": True})

    def test_live_run_aborts(self):
        with self.assertRaises(ValueError):
            plan_mod.plan(diagnostics(state="in_progress"))

    def test_finishing_run_aborts(self):
        with self.assertRaises(ValueError):
            plan_mod.plan(diagnostics(state="finishing"))

    def test_unreadable_state_aborts(self):
        with self.assertRaises(ValueError):
            plan_mod.plan("### SuiBa PAPER verification\n- Run: `completed`\n")

    def test_fault_marker_without_failed_state_aborts(self):
        with self.assertRaises(ValueError):
            plan_mod.plan(diagnostics(fault=True))


class WorkflowShapeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, ".github", "workflows",
                               "suiba-paper-deploy-cycle.yml")) as fh:
            cls.source = fh.read()

    def test_single_job_under_one_environment(self):
        self.assertEqual(self.source.count("environment: sakura-vps"), 1)
        self.assertIn("DEPLOY-CYCLE-PAPER", self.source)
        self.assertIn("SUIBA_PAPER_DEPLOY_CYCLE_ENABLED", self.source)
        self.assertIn("group: suiba-vps-deployment", self.source)

    def test_step_order(self):
        names = ["Read the host state (diagnostics)",
                 "Plan the preparatory operations",
                 "Release a leftover cutoff timer",
                 "Approve the deploy over a failed predecessor",
                 "Build on runner, never on VPS",
                 "Transfer and deploy with pinned SSH host identity",
                 "Diagnose a failed deploy (same approval)"]
        positions = [self.source.index(f"name: {n}") for n in names]
        self.assertEqual(positions, sorted(positions))

    def test_conditional_preparatory_steps(self):
        self.assertIn("if: steps.plan.outputs.release_cutoff == 'true'", self.source)
        self.assertIn("if: steps.plan.outputs.approve_deploy == 'true'", self.source)
        self.assertIn("PAPER_RECOVER_SHA: ${{ github.sha }}", self.source)

    def test_broker_request_binds_this_run(self):
        self.assertIn('"ci_run":%s', self.source)
        self.assertIn('"${{ github.run_id }}"', self.source)


if __name__ == "__main__":
    unittest.main()
