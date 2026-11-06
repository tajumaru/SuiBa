#!/usr/bin/env bash
# Approve the retry of one PAPER run that was admitted and then
# stopped cleanly, through the existing fixed controller wrapper.
# The controller re-runs its full diagnose and refuses before
# writing anything unless the stop receipt is clean_stopped with
# no fault evidence; preflight deaths (failed_state_unknown) are
# refused here and stay with the reconcile workflow.
set +x
set -Eeuo pipefail
umask 077
fail() { echo 'PAPER_RETRY_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${PAPER_RETRY_CONFIRMATION:-} == RETRY-PAPER ]] || fail
request='{"operation":"approve-retry"}'
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-paper-retry.XXXXXXXX")
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
printf '%s\n' "$request" |
  timeout 300s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" 'sudo -n -- /usr/local/sbin/suiba-paper-check' >"$result" 2>"$errors" || fail
python3 - "$result" <<'PYEOF' | tee -a "${GITHUB_STEP_SUMMARY:?}" || fail
import json, re, sys
try:
    payload = json.load(open(sys.argv[1], encoding="utf-8"))
    if set(payload) != {"approved"}:
        raise ValueError()
    if not re.fullmatch(r"[0-9a-f]{32}", payload["approved"]):
        raise ValueError()
except Exception:
    raise SystemExit(1)
print("### SuiBa PAPER retry approval")
print(f"- Retry approved for run: `{payload['approved']}`")
PYEOF
