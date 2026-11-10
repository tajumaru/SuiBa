#!/usr/bin/env bash
# Runner-only watchdog for the paper-check monitor's schedule. GitHub's
# scheduler is best-effort: on 2026-11-09 it dropped the monitor for ~5h
# and on 2026-11-10 for ~4h45m, and a silent monitor means late anomaly
# detection. This script only reads the monitor workflow's own run
# history through the Actions API and, when that stream has been silent
# past the threshold, re-fires the monitor once by workflow_dispatch.
# It holds no host credentials, opens no Issues, and every failure mode
# exits 0 doing nothing: a broken watchdog must never page anyone.
set +x
set -Eeuo pipefail
umask 077

note() { printf 'paper-monitor-watchdog: %s\n' "$*"; }
# Fixed bound: the monitor's nominal cadence is ~10 minutes (six offset
# crons an hour), so 45 silent minutes means four-plus consecutive slots
# were dropped or delayed -- the observed outage pattern, never healthy
# jitter. The worst-case detection delay is this bound plus the
# watchdog's own 20-minute cadence.
threshold_seconds=2700
workflow_file=suiba-paper-monitor.yml

repository=${PAPER_MONITOR_WATCHDOG_REPOSITORY:-}
[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { note 'repository unset or malformed; doing nothing'; exit 0; }
[[ -n ${GH_TOKEN:-} ]] || { note 'GH_TOKEN missing; doing nothing'; exit 0; }

if ! raw=$(gh api "repos/${repository}/actions/workflows/${workflow_file}/runs?per_page=20" 2>/dev/null); then
  note 'monitor run history unreadable; doing nothing'
  exit 0
fi

if ! summary=$(printf '%s' "$raw" | python3 -c '
import json, sys
from datetime import datetime

def epoch(value):
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except Exception:
        return 0

try:
    runs = json.load(sys.stdin)["workflow_runs"]
except Exception:
    runs = None
if not isinstance(runs, list):
    print("invalid")
else:
    active = sum(1 for run in runs if run.get("status") in ("in_progress", "queued"))
    latest_any = max((epoch(run.get("created_at", "")) for run in runs), default=0)
    latest_scheduled = max((epoch(run.get("created_at", "")) for run in runs if run.get("event") == "schedule"), default=0)
    print(active, latest_any, latest_scheduled)
'); then
  note 'monitor run history unparseable; doing nothing'
  exit 0
fi
[[ $summary != invalid ]] || { note 'monitor run history unparseable; doing nothing'; exit 0; }
read -r active latest_any latest_scheduled <<< "$summary"

now=$(date -u +%s)
cutoff=$((now - threshold_seconds))
if (( active > 0 )); then
  note "monitor already has ${active} queued or running run(s); doing nothing"
  exit 0
fi
if (( latest_scheduled > cutoff )); then
  note 'monitor schedule fired within the threshold; doing nothing'
  exit 0
fi
# The scheduled stream is silent, but a manual or watchdog dispatch
# already refreshed the monitor within the threshold: do not stack
# another one. This also caps the re-fire cadence at roughly the
# threshold plus the watchdog's own cadence while the scheduler stays
# dead, instead of dispatching on every watchdog slot.
if (( latest_any > cutoff )); then
  note 'monitor was dispatched within the threshold; doing nothing'
  exit 0
fi
if ! gh workflow run "$workflow_file" --repo "$repository" --ref main -f confirmation=CHECK-PAPER-MONITOR >/dev/null 2>&1; then
  note 'monitor dispatch failed; doing nothing'
  exit 0
fi
note "monitor silent past ${threshold_seconds}s; dispatched one CHECK-PAPER-MONITOR run"
