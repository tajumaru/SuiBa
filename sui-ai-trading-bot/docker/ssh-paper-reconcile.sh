#!/usr/bin/env bash
# Reconcile one preflight-dead PAPER run through the existing fixed
# controller wrapper. The controller re-checks every piece of
# evidence and refuses before mutating anything when one mismatches;
# this script only selects the ending (retry of the current release,
# or a fresh deploy of one pinned sha).
set +x
set -Eeuo pipefail
umask 077
fail() { echo 'PAPER_RECONCILE_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${PAPER_RECONCILE_CONFIRMATION:-} == RECONCILE-PAPER ]] || fail
case "${PAPER_RECONCILE_MODE:-}" in
  retry) request='{"operation":"reconcile","mode":"retry"}' ;;
  deploy)
    [[ ${PAPER_RECONCILE_SHA:-} =~ ^[0-9a-f]{40}$ ]] || fail
    request="{\"operation\":\"reconcile\",\"mode\":\"deploy\",\"sha\":\"$PAPER_RECONCILE_SHA\"}" ;;
  *) fail ;;
esac
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-paper-reconcile.XXXXXXXX")
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
mode=$PAPER_RECONCILE_MODE python3 - "$result" <<'PYEOF' | tee -a "${GITHUB_STEP_SUMMARY:?}" || fail
import json, os, re, sys
try:
    payload = json.load(open(sys.argv[1], encoding="utf-8"))
    if set(payload) != {"reconciled", "mode", "backup"}:
        raise ValueError()
    if payload["reconciled"] is not True or payload["mode"] != os.environ["mode"]:
        raise ValueError()
    if not re.fullmatch(r"reconcile-[0-9]{14}", payload["backup"]):
        raise ValueError()
except Exception:
    raise SystemExit(1)
print("### SuiBa PAPER reconcile")
print("- Reconciled: `yes`")
print(f"- Mode: `{payload['mode']}`")
print(f"- Evidence backup: `{payload['backup']}`")
PYEOF
