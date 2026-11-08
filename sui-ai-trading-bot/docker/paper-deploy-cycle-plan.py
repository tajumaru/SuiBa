#!/usr/bin/env python3
"""Plan a one-approval deploy from CHECK-PAPER-DIAGNOSTICS output.

Reads the rendered diagnostics (the same text the owner reads) and
decides, explicitly, which preparatory controller operations the deploy
needs:

- release_cutoff: a cutoff timer from a finished run is still armed
  (active or elapsed) and would block quiescent-gated operations.
- approve_deploy: the predecessor run latched failed_requires_review,
  so the broker will refuse the deploy without a deploy permit.

Anything unreadable or inconsistent aborts the plan (exit 1 with the
reason on stderr): a one-approval deploy must never guess its way past
host state. The controller re-verifies every operation server-side;
this plan only sequences them.

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
    if failed and not fault_marker:
        raise ValueError("STATE_INCONSISTENT: run is failed_requires_review "
                         "but no fault marker is set; inspect before deploying")
    return {"release_cutoff": timer_armed, "approve_deploy": failed}


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
