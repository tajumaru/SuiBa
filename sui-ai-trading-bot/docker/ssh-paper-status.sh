#!/usr/bin/env bash
# Read-only status through the existing fixed controller wrapper.
set +x
set -Eeuo pipefail
umask 077
fail() { echo 'PAPER_STATUS_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-paper-status.XXXXXXXX")
key="$folder/key"
hosts="$folder/known_hosts"
result="$folder/result"
errors="$folder/errors"
cleanup() { rm -f "$key" "$hosts" "$result" "$errors"; rmdir "$folder"; }
trap cleanup EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$hosts"
unset VPS_SSH_KEY VPS_KNOWN_HOSTS
# No public/private key, fingerprint, hostname or username is printed to logs.
timeout 10s ssh-keygen -y -f "$key" </dev/null >/dev/null 2>"$errors" || fail
lookup="$VPS_HOST"
if (( port != 22 )); then lookup="[$VPS_HOST]:$port"; fi
ssh-keygen -F "$lookup" -f "$hosts" >/dev/null 2>"$errors" || fail
opts=(-F /dev/null -i "$key" -p "$port" -T
  -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no
  -o PreferredAuthentications=publickey -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$hosts" -o GlobalKnownHostsFile=/dev/null
  -o UpdateHostKeys=no -o HostKeyAlgorithms=ssh-ed25519
  -o ClearAllForwardings=yes -o RequestTTY=no -o LogLevel=ERROR
  -o ConnectTimeout=10 -o ConnectionAttempts=1
  -o ServerAliveInterval=5 -o ServerAliveCountMax=2)
# Only fixed read-only operations are sent. Never echo the remote response.
case "${PAPER_STATUS_CONFIRMATION:-CHECK-PAPER-STATUS}" in
  CHECK-PAPER-STATUS) operation=status ;;
  CHECK-PAPER-DIAGNOSTICS) operation=diagnose ;;
  *) fail ;;
esac
printf '{"operation":"%s"}\n' "$operation" |
  timeout 100s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" 'sudo -n -- /usr/local/sbin/suiba-paper-check' >"$result" 2>"$errors" || fail
python3 - "$result" "$operation" >>"${GITHUB_STEP_SUMMARY:?}" <<'PYCODE'
import json
import sys
from pathlib import Path

try:
    with Path(sys.argv[1]).open("rb") as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError()
    payload = json.loads(raw)
    run = payload["run"]
    state = run["status"]
    if state not in ("in_progress", "finishing", "completed", "failed_requires_review"):
        raise ValueError()
    stop = payload["stop"]
    status = "no receipt"
    if stop is not None:
        if stop["id"] != run["id"]:
            raise ValueError()
        status = stop["status"]
        if status not in ("stopping_state_unknown", "worker_stopped_pending_controller_exit",
                          "clean_stopped", "failed_state_unknown"):
            raise ValueError()
    fault = payload["requires_review"]
    if type(fault) is not bool:
        raise ValueError()
    details = None
    if sys.argv[2] == "diagnose":
        details = payload["diagnostics"]
        stages = (None, "maintenance-release", "worker-start", "worker-readiness",
                  "deployment-state", "pair-selection", "market-summary",
                  "market-freshness", "arm", "paper-start", "monitoring", "normal-stop")
        if details["stage"] not in stages:
            raise ValueError()
        if details["maintenance"] is not True or details["backup_verified"] is not True:
            raise ValueError()
        if type(details["oom_killed"]) is not bool or type(details["exit_code"]) is not int:
            raise ValueError()
        for key in ("healthcheck_exit", "http_status"):
            if details[key] is not None and type(details[key]) is not int:
                raise ValueError()
        for pair in ("SUI_USDC", "WAL_USDC"):
            for key in ("starts", "orders", "fills"):
                if type(details["deltas"][pair][key]) is not int:
                    raise ValueError()
except (OSError, ValueError, KeyError, TypeError):
    sys.exit("PAPER_STATUS_INVALID")
print("### SuiBa PAPER verification")
print(f"- Run: `{state}`")
print(f"- Stop receipt: `{status}`")
print(f"- Manual review needed: {'yes' if fault or state == 'failed_requires_review' else 'no'}")
if details is not None:
    print(f"- Container exit code: {details['exit_code']}, OOM killed: {details['oom_killed']}")
    print(f"- Last healthcheck exit code: {details['healthcheck_exit']}")
    print("- Maintenance: enabled; backup SHA-256 verified; SQLite copies passed integrity checks")
    print(f"- Failed stage: {details['stage'] or 'not recorded'}, HTTP status: {details['http_status']}")
    readiness = details.get("readiness")
    if isinstance(readiness, dict):
        health = readiness.get("health")
        if health in ("starting", "healthy", "unhealthy", "unknown"):
            print(f"- Docker health during readiness: {health}")
        checks = ("connectivity", "apiAccess", "emergencyClear", "runtimeClear", "suiHealthy", "suiFresh", "ledger")
        blocked = [key for key in checks if readiness.get(key) is False]
        if blocked:
            print("- Readiness checks blocking start: " + ", ".join(blocked))
    for pair in ("SUI_USDC", "WAL_USDC"):
        delta = details["deltas"][pair]
        print(f"- {pair} difference: starts={delta['starts']:+d}, orders={delta['orders']:+d}, fills={delta['fills']:+d}")
PYCODE
