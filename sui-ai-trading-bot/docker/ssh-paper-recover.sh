#!/usr/bin/env bash
# Run one post-run recovery operation through the fixed controller
# wrapper: disarm leftover cutoff timers (release-cutoff), withdraw
# an unused retry approval (revoke-retry), approve a deploy over
# a cleanly stopped failed run (approve-deploy), or heal a run
# wedged by a definitively refused operation (heal-run). The
# controller re-checks its own evidence for each operation and
# refuses before changing anything when the state does not match.
set +x
set -Eeuo pipefail
umask 077
fail() { python3 "$(dirname "${BASH_SOURCE[0]}")/paper-fixed-reason.py" "${errors:-/dev/null}" >&2 || true; echo 'PAPER_RECOVER_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${PAPER_RECOVER_CONFIRMATION:-} == RECOVER-PAPER ]] || fail
case ${PAPER_RECOVER_MODE:-} in
  release-cutoff) request='{"operation":"release-cutoff"}' ;;
  revoke-retry) request='{"operation":"revoke-retry"}' ;;
  heal-run) request='{"operation":"heal-run"}' ;;
  approve-deploy)
    [[ ${PAPER_RECOVER_SHA:-} =~ ^[0-9a-f]{40}$ ]] || fail
    request="{\"operation\":\"approve-deploy\",\"sha\":\"$PAPER_RECOVER_SHA\"}" ;;
  *) fail ;;
esac
export PAPER_RECOVER_MODE
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-paper-recover.XXXXXXXX")
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
import json, os, re, sys
try:
    payload = json.load(open(sys.argv[1], encoding="utf-8"))
    mode = os.environ["PAPER_RECOVER_MODE"]
    if mode == "release-cutoff":
        if set(payload) != {"released", "run"}:
            raise ValueError()
        if not re.fullmatch(r"[0-9a-f]{32}", payload["run"]):
            raise ValueError()
        if not isinstance(payload["released"], list) or len(payload["released"]) > 3:
            raise ValueError()
        for unit in payload["released"]:
            if not re.fullmatch(r"suiba-paper-check-cutoff(-(2h|6h|24h))?\.timer", unit):
                raise ValueError()
        lines = [f"- Run: `{payload['run']}`",
                 "- Released timers: " + (", ".join(f"`{u}`" for u in payload["released"]) or "none were armed")]
    elif mode == "revoke-retry":
        if set(payload) != {"revoked"} or not re.fullmatch(r"[0-9a-f]{32}", payload["revoked"]):
            raise ValueError()
        lines = [f"- Retry approval withdrawn for run: `{payload['revoked']}`"]
    elif mode == "heal-run":
        if set(payload) != {"healed", "backup"} or not re.fullmatch(r"[0-9a-f]{32}", payload["healed"]):
            raise ValueError()
        if not re.fullmatch(r"heal-[0-9]{14}", payload["backup"]):
            raise ValueError()
        lines = [f"- Healed run: `{payload['healed']}`",
                 f"- Original evidence preserved in backup: `{payload['backup']}`"]
    else:
        if set(payload) != {"deploy_approved"} or not re.fullmatch(r"[0-9a-f]{40}", payload["deploy_approved"]):
            raise ValueError()
        lines = [f"- Deploy approved for sha: `{payload['deploy_approved']}`"]
except Exception:
    raise SystemExit(1)
print("### SuiBa PAPER recovery")
for line in lines:
    print(line)
PYEOF
