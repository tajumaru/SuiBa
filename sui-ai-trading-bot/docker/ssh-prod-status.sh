#!/usr/bin/env bash
# Runner-only production observation: no host writes or recovery commands.
# Two identities may read, each through its own host entrypoint: the CI
# identity (suiba-deploy) through suiba-paper-check, and the read-only
# monitoring identity (suiba-observe) through suiba-paper-observe — the
# host confines that identity with the authorized_keys forced command,
# the sudoers rule, and the controller's caller scope check. Any other
# user is refused.
set +x
set -Eeuo pipefail
umask 077
fail() { echo 'PRODUCTION_SSH_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
case $VPS_USER in
  suiba-deploy) remote='sudo -n -- /usr/local/sbin/suiba-paper-check' ;;
  suiba-observe) remote='sudo -n -- /usr/local/sbin/suiba-paper-observe' ;;
  *) fail ;;
esac
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-prod-status.XXXXXXXX")
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
[[ -n ${PRODUCTION_REPORT_FILE:-} ]] || fail
prod_read=0
if printf '%s' '{"operation":"prod-status"}' |
    timeout 30s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" "$remote" 2>"$errors" |
    head -c 65537 >"$result"; then
  prod_read=1
fi
python3 "$(dirname "$0")/production-status.py" "$result" "$prod_read" "$PRODUCTION_REPORT_FILE"
