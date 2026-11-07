#!/usr/bin/env bash
# Start one PAPER validation run through the existing fixed controller
# wrapper. The only variable content is the run length, restricted to
# the controller's fixed set (30m / 6h / 24h); the wrapper accepts no
# command, path, or image from here.
set +x
set -Eeuo pipefail
umask 077
fail() { python3 "$(dirname "${BASH_SOURCE[0]}")/paper-fixed-reason.py" "${errors:-/dev/null}" >&2 || true; echo 'PAPER_START_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${PAPER_START_CONFIRMATION:-} == START-PAPER ]] || fail
case "${PAPER_START_DURATION:-}" in
  30m|6h|24h) duration=$PAPER_START_DURATION ;;
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
folder=$(mktemp -d "$RUNNER_TEMP/suiba-paper-start.XXXXXXXX")
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
printf '{"operation":"start","duration":"%s"}\n' "$duration" |
  timeout 60s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" 'sudo -n -- /usr/local/sbin/suiba-paper-check' >"$result" 2>"$errors" || fail
# The controller answers with exactly one fixed line. Anything else is
# withheld and reported as a failure, never echoed to logs.
[[ $(cat "$result") == PAPER_CHECK_REQUEST_ACCEPTED ]] || fail
{
  echo '### SuiBa PAPER check start'
  echo "- Start: \`accepted\`"
  echo "- Duration: \`$duration\`"
} | tee -a "${GITHUB_STEP_SUMMARY:?}"
