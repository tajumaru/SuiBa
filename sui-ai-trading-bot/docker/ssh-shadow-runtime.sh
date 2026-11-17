#!/usr/bin/env bash
# Approval-gated stdin-only transfer to the fixed host helper.
set +x
set -Eeuo pipefail
umask 077
fail() { echo 'SHADOW_RUNTIME_FAILED (details withheld)' >&2; exit 1; }
[[ ${SHADOW_RUNTIME_CONFIRMATION:-} == UPDATE-SHADOW-RUNTIME ]] || fail
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-shadow-runtime.XXXXXXXX")
key="$folder/key"
hosts="$folder/known_hosts"
errors="$folder/errors"
cleanup() { rm -f "$key" "$hosts" "$errors"; rmdir "$folder"; }
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
[[ ${SUIBA_SHADOW_ENABLED:-} == true || ${SUIBA_SHADOW_ENABLED:-} == false ]] || fail
[[ ${SUIBA_SHADOW_API_KEY:-} =~ ^[A-Za-z0-9_-]{1,4096}$ ]] || fail
# The secret exists only in the process environment and the encrypted stdin stream.
# Discard all remote output, including failures; never retain it in runner files.
python3 -c 'import json,os; print(json.dumps({k:os.environ[k] for k in ("SUIBA_SHADOW_ENABLED", "SUIBA_SHADOW_API_KEY")}))' |
  timeout 60s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" 'sudo -n -- /usr/local/sbin/suiba-shadow-runtime' >/dev/null 2>/dev/null || fail
unset SUIBA_SHADOW_API_KEY SUIBA_SHADOW_ENABLED
echo 'SHADOW_RUNTIME_UPDATED (restart is a separate operation)'
