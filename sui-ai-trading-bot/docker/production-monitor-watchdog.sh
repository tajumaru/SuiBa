#!/usr/bin/env bash
# Runner-only watchdog. Four missed ten-minute monitor slots plus five
# minutes of scheduler jitter is the same threshold as the paper watchdog.
set +x
set -Eeuo pipefail
umask 077

workflow_file=suiba-production-monitor.yml
threshold_seconds=2700
repository=${PROD_MONITOR_WATCHDOG_REPOSITORY:-}
[[ ${SUIBA_PROD_MONITOR_ENABLED:-} == true ]] || exit 0
[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && -n ${GH_TOKEN:-} ]] || exit 0
endpoint="repos/${repository}/actions/workflows/${workflow_file}/runs"

# Each filtered request needs only its newest run. Check the count and
# first record together so malformed or incomplete responses fail closed.
lookup() {
  gh api "$endpoint?$1=$2&per_page=1" 2>/dev/null | python3 -c '
import json, sys
from datetime import datetime, timezone

field, expected = sys.argv[1:]
data = json.load(sys.stdin)
count, runs = data["total_count"], data["workflow_runs"]
if type(count) is not int or count < 0 or not isinstance(runs, list) or len(runs) != min(count, 1):
    sys.exit(1)
if not count:
    print(0)
elif field == "status":
    if runs[0]["status"] != expected:
        sys.exit(1)
    print(count)
else:
    run = runs[0]
    if run["event"] != expected or run["status"] != "completed":
        sys.exit(1)
    created = datetime.strptime(run["created_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    if created.timestamp() <= 0:
        sys.exit(1)
    print(int(created.timestamp()))
' "$1" "$2" 2>/dev/null
}

# Status-filtered queries also find older active runs outside the newest
# history page. Repeat immediately before dispatch to narrow the race.
idle() {
  local status count
  for status in in_progress queued waiting pending requested; do
    count=$(lookup status "$status") || return 1
    [[ $count == 0 ]] || return 1
  done
}
idle || exit 0
scheduled=$(lookup event schedule) || exit 0
dispatched=$(lookup event workflow_dispatch) || exit 0
(( scheduled || dispatched )) || exit 0
now=$(date -u +%s) || exit 0
cutoff=$((now - threshold_seconds))
(( scheduled <= cutoff && dispatched <= cutoff )) || exit 0

idle || exit 0
gh workflow run "$workflow_file" --repo "$repository" --ref main \
  -f confirmation=CHECK-PROD-MONITOR >/dev/null 2>&1 || exit 0
printf '%s\n' 'production-monitor-watchdog: dispatched one recovery run'
