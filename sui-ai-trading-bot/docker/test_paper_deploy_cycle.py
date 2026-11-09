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


class PlanSemanticsFixtureTests(unittest.TestCase):
    """Fixture matrix pinning the planner semantics settled on
    2026-11-09 (docs/DECISIONS_JA.md, the two 2026-11-09 planner
    sections). Two wrong assumptions in a row reached the field that
    day: first the planner aborted a consistent failed-without-latch
    state, then approve_deploy was narrowed to failed-with-latch and
    the broker refused the deploy for a missing permit (PR #135,
    corrected by PR #136). These cases exist so the next narrowing
    fails here, in CI, instead of during a deploy:

    - approve_deploy == (state == failed_requires_review), with or
      without the fault latch. The latch gates reconciliation
      server-side (controller approve_deploy / broker); the planner
      only sequences and never refuses a failed predecessor itself.
    - release_cutoff == the cutoff timer is armed (active or
      elapsed). A merely scheduled next timer does not arm it.
    - The planner aborts only on a live predecessor
      (RUN_STILL_ACTIVE), a latch set over a non-failed state
      (STATE_INCONSISTENT), or unreadable diagnostics
      (STATE_UNREADABLE).
    """

    def assert_plan(self, text, release_cutoff, approve_deploy):
        self.assertEqual(plan_mod.plan(text),
                         {"release_cutoff": release_cutoff,
                          "approve_deploy": approve_deploy})

    def assert_aborts(self, text, code):
        with self.assertRaises(ValueError) as caught:
            plan_mod.plan(text)
        self.assertTrue(
            str(caught.exception).startswith(code + ":"),
            f"expected abort {code}, got: {caught.exception}")

    # -- completed predecessor -------------------------------------

    def test_completed_predecessor_plans_nothing(self):
        self.assert_plan(diagnostics(), False, False)

    def test_completed_with_active_timer_releases_cutoff_only(self):
        self.assert_plan(diagnostics(active=True), True, False)

    def test_completed_with_elapsed_timer_releases_cutoff_only(self):
        self.assert_plan(diagnostics(elapsed=True), True, False)

    def test_completed_with_only_a_future_timer_plans_nothing(self):
        # "next scheduled" / "job pending" describe a timer that will
        # exist later; only active or elapsed mean a leftover timer
        # is armed now and would block quiescent-gated operations.
        text = diagnostics().replace(
            "next scheduled=False, job pending=False",
            "next scheduled=True, job pending=True")
        self.assert_plan(text, False, False)

    # -- failed predecessor, no latch (the clean-failure main case) -

    def test_failed_without_latch_approves_deploy(self):
        self.assert_plan(diagnostics(state="failed_requires_review"),
                         False, True)

    def test_failed_without_latch_active_timer_plans_both(self):
        self.assert_plan(
            diagnostics(state="failed_requires_review", active=True),
            True, True)

    def test_failed_without_latch_elapsed_timer_plans_both(self):
        self.assert_plan(
            diagnostics(state="failed_requires_review", elapsed=True),
            True, True)

    # -- failed predecessor with the latch set ----------------------
    # The plan still sequences approve_deploy; the refusal for this
    # case happens server-side (controller requires no
    # requires_review, the broker answers
    # PAPER_CHECK_RECONCILIATION_REQUIRED), never in the planner.

    def test_failed_with_latch_still_approves_deploy(self):
        self.assert_plan(
            diagnostics(state="failed_requires_review", fault=True),
            False, True)

    def test_failed_with_latch_armed_timer_plans_both(self):
        self.assert_plan(
            diagnostics(state="failed_requires_review",
                        active=True, fault=True),
            True, True)

    def test_failed_with_latch_elapsed_timer_plans_both(self):
        self.assert_plan(
            diagnostics(state="failed_requires_review",
                        elapsed=True, fault=True),
            True, True)

    # -- aborts ------------------------------------------------------

    def test_in_progress_aborts_run_still_active(self):
        self.assert_aborts(diagnostics(state="in_progress"),
                           "RUN_STILL_ACTIVE")

    def test_finishing_aborts_run_still_active(self):
        self.assert_aborts(diagnostics(state="finishing"),
                           "RUN_STILL_ACTIVE")

    def test_latch_over_completed_aborts_state_inconsistent(self):
        self.assert_aborts(diagnostics(fault=True), "STATE_INCONSISTENT")

    def test_latch_over_live_state_aborts_run_still_active(self):
        # Both abort rules match here; the live check comes first —
        # a deploy must never start over a live run, latch or not.
        self.assert_aborts(
            diagnostics(state="in_progress", fault=True),
            "RUN_STILL_ACTIVE")

    def test_empty_diagnostics_aborts_state_unreadable(self):
        self.assert_aborts("", "STATE_UNREADABLE")

    def test_missing_run_line_aborts_state_unreadable(self):
        text = "\n".join([
            "### SuiBa PAPER verification",
            "- Deployment PAPER gate: completed, fault marker=False",
            "- Cutoff timer: active=False, elapsed=False, "
            "next scheduled=False, job pending=False",
        ])
        self.assert_aborts(text, "STATE_UNREADABLE")

    def test_missing_gate_line_aborts_state_unreadable(self):
        text = "\n".join([
            "### SuiBa PAPER verification",
            "- Run: `completed`",
            "- Cutoff timer: active=False, elapsed=False, "
            "next scheduled=False, job pending=False",
        ])
        self.assert_aborts(text, "STATE_UNREADABLE")

    def test_missing_cutoff_line_aborts_state_unreadable(self):
        text = "\n".join([
            "### SuiBa PAPER verification",
            "- Run: `completed`",
            "- Deployment PAPER gate: completed, fault marker=False",
        ])
        self.assert_aborts(text, "STATE_UNREADABLE")


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
