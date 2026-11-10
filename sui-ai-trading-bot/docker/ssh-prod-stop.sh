#!/usr/bin/env bash
# Stop the production PAPER session through the existing fixed
# controller wrapper. The wrapper sends exactly one fixed request; it
# accepts no command, path, or image from here.
set +x
set -Eeuo pipefail
umask 077
fail() { python3 "$(dirname "${BASH_SOURCE[0]}")/paper-fixed-reason.py" "${errors:-/dev/null}" >&2 || true; echo 'PROD_STOP_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${PROD_STOP_CONFIRMATION:-} == STOP-PROD ]] || fail
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-prod-stop.XXXXXXXX")
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
printf '%s\n' '{"operation":"prod-stop"}' |
  timeout 300s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" 'sudo -n -- /usr/local/sbin/suiba-paper-check' >"$result" 2>"$errors" || fail
# The controller answers with exactly one fixed JSON line: an explicit
# stop completes the session, and a stop with no session is reported
# as not_started. Anything else is withheld and reported as a
# failure, never echoed to logs.
response=$(cat "$result")
case "$response" in
  '{"status": "completed"}') outcome=completed ;;
  '{"status": "not_started"}') outcome=not_started ;;
  *) fail ;;
esac
{
  echo '### SuiBa production stop'
  echo "- Stop: \`$outcome\`"
} | tee -a "${GITHUB_STEP_SUMMARY:?}"
