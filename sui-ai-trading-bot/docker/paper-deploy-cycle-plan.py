#!/usr/bin/env python3
"""Plan a one-approval deploy from CHECK-PAPER-DIAGNOSTICS output.

Reads the rendered diagnostics (the same text the owner reads) and
decides, explicitly, which preparatory controller operations the deploy
needs:

- release_cutoff: a cutoff timer from a finished run is still armed
  (active or elapsed) and would block quiescent-gated operations.
- approve_deploy: the predecessor run ended failed_requires_review.
  The session marker (paper-check.json) stays in_progress over a
  failed predecessor, and in that state the broker requires a deploy
  permit (paper-deploy-<sha>.json, binding the digests of run.json,
  stop.json and the approval) before it accepts a deploy.
  approve_deploy is the controller op that materializes that permit,
  so every failed predecessor needs it, regardless of the fault
  marker — a clean monitoring failure with no marker is the main
  case, not an exception.

A run that stops on a worker runtime error during monitoring and
finalizes cleanly also ends as failed_requires_review but carries no
fault marker (STATE/paper-check-failed.json) — that is a correct,
consistent state, not a contradiction. The marker is a separate
gate, not the permit trigger: controller.fault writes it (with a
per-run fault-*.json) for failures that need manual reconciliation,
and while it exists the broker refuses every deploy, permit or not
(PAPER_CHECK_RECONCILIATION_REQUIRED). approve_deploy itself also
refuses server-side in that case, because it requires a clean stop
and no requires_review. A failed run carrying the marker therefore
belongs to the reconcile path; this plan still sequences
approve_deploy for any failed state, and the server side is what
refuses.

A fault marker without a failed state remains inconsistent and aborts,
as does anything unreadable: a one-approval deploy must never guess its
way past host state. The controller re-verifies every operation
server-side; this plan only sequences them.

Usage: paper-deploy-cycle-plan.py <diagnostics.txt>
Prints {"release_cutoff": bool, "approve_deploy": bool} as JSON.
"""
import json
import re
import sys

LIVE_STATES = {"in_progress", "finishing"}


def plan(text):
    run = re.search(r"^- Run: `([^`]*)`", text, re.M)
    cutoff = re.search(
        r"^- Cutoff timer: active=(True|False), elapsed=(True|False)", text, re.M)
    gate = re.search(r"^- Deployment PAPER gate: ([^,]*), fault marker=(True|False)",
                     text, re.M)
    if run is None or cutoff is None or gate is None:
        raise ValueError("STATE_UNREADABLE: diagnostics is missing the run, "
                         "cutoff, or gate line")
    state = run.group(1)
    timer_armed = cutoff.group(1) == "True" or cutoff.group(2) == "True"
    fault_marker = gate.group(2) == "True"
    if state in LIVE_STATES:
        raise ValueError(f"RUN_STILL_ACTIVE: predecessor run is {state}; "
                         "a deploy must not start over a live run")
    failed = state == "failed_requires_review"
    if fault_marker and not failed:
        raise ValueError("STATE_INCONSISTENT: fault marker is set but the "
                         f"run state is {state}; inspect before deploying")
    # approve_deploy covers every failed predecessor: with the session
    # marker still in_progress, the broker demands a deploy permit
    # before accepting a deploy, and approve_deploy materializes it.
    # The fault marker neither adds nor removes that need; it gates
    # reconciliation server-side instead.
    return {"release_cutoff": timer_armed,
            "approve_deploy": failed}


def main(argv):
    with open(argv[1], encoding="utf-8") as fh:
        text = fh.read()
    try:
        result = plan(text)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
