#!/usr/bin/env bash
# Runner-only production observation: no host writes or recovery commands.
set +x
set -Eeuo pipefail
umask 077
fail() { echo 'PRODUCTION_SSH_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-prod-status.XXXXXXXX")
key="$folder/key"
hosts="$folder/known_hosts"
result="$folder/result"
watchdog="$folder/watchdog"
errors="$folder/errors"
cleanup() { rm -f "$key" "$hosts" "$result" "$watchdog" "$errors"; rmdir "$folder"; }
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
[[ -n ${PRODUCTION_REPORT_FILE:-} ]] || fail
prod_read=0
watch_read=0
if printf '%s' '{"operation":"prod-status"}' |
    timeout 30s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" 'sudo -n -- /usr/local/sbin/suiba-paper-check' 2>"$errors" |
    head -c 65537 >"$result"; then
  prod_read=1
fi
# This fixed non-privileged read never widens sudo rights. On current hosts the
# root:600 record is private; that is honestly WATCHDOG_UNAVAILABLE, not healthy.
if timeout 30s ssh "${opts[@]}" -n "$VPS_USER@$VPS_HOST" 'cat /var/lib/suiba-watchdog/status.json' 2>"$errors" |
    head -c 65537 >"$watchdog"; then
  watch_read=1
fi
python3 "$(dirname "$0")/production-status.py" "$result" "$watchdog" "$prod_read" "$watch_read" "$PRODUCTION_REPORT_FILE"
