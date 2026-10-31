#!/usr/bin/env bash
# Connection check only: no remote writes, sudo, Docker daemon calls or deployment.
set +x
set -Eeuo pipefail
umask 077
fail() { echo 'SSH_CHECK_FAILED (connection details intentionally withheld)' >&2; exit 1; }
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER != root && $VPS_USER != ubuntu ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-ssh-check.XXXXXXXX")
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
opts=(-F /dev/null -i "$key" -p "$port" -T -n
  -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no
  -o PreferredAuthentications=publickey -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$hosts" -o GlobalKnownHostsFile=/dev/null
  -o UpdateHostKeys=no -o HostKeyAlgorithms=ssh-ed25519
  -o ClearAllForwardings=yes -o RequestTTY=no -o LogLevel=ERROR
  -o ConnectTimeout=10 -o ConnectionAttempts=1
  -o ServerAliveInterval=5 -o ServerAliveCountMax=2)
# Static command, no workflow/user-provided remote script. CLI versions do NOT
# contact the Docker daemon. Directory tests do not write or inspect file contents.
# Quoted heredoc: expand only on the remote host. No untrusted command interpolation.
remote=$(cat <<'REMOTE'
set -eu
test "$(id -u)" -ne 0
test -d /opt/suiba/releases
test -w /opt/suiba/releases
test -d /opt/suiba/shared
test -d /opt/suiba/backups
client=$(docker --version)
client=${client#Docker version }
client=${client%%,*}
compose=$(docker compose version --short)
engine_package=$(dpkg-query -W -f='${Version}' docker-ce)
mem_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
mem_available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
disk_available=$(df -Pk /opt/suiba/releases | awk 'NR==2 {print $4}')
printf '%s\n' SSH_PREFLIGHT_OK "$(id -un)" "$client" "$compose" "$engine_package" "$mem_total" "$mem_available" "$disk_available"
REMOTE
)
timeout 45s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" "$remote" >"$result" 2>"$errors" || fail
mapfile -t reply < "$result"
[[ ${#reply[@]} == 8 && ${reply[0]} == SSH_PREFLIGHT_OK && ${reply[1]} == "$VPS_USER" ]] || fail
[[ ${reply[2]} =~ ^[0-9]+\.[0-9]+\.[0-9]+([.+~-][a-zA-Z0-9.-]+)?$ ]] || fail
[[ ${reply[3]} =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.+~-][a-zA-Z0-9.-]+)?$ ]] || fail
[[ ${reply[4]} =~ ^[0-9][a-zA-Z0-9.+:~_-]*$ ]] || fail
for index in 5 6 7; do
  [[ ${reply[index]} =~ ^[0-9]{1,15}$ ]] || fail
  (( 10#${reply[index]} > 0 )) || fail
done
echo 'SSH_PREFLIGHT_OK: expected non-root user and fixed read-only checks passed; no deployment or Worker startup'
# Only validated non-secret version/resource fields are released to the log.
printf 'DockerCLI=%s Compose=%s EnginePackage=%s (running Engine version not checked)\n' "${reply[2]}" "${reply[3]}" "${reply[4]}"
printf 'MemoryTotalKiB=%s MemoryAvailableKiB=%s DiskAvailableKiB=%s\n' "${reply[5]}" "${reply[6]}" "${reply[7]}"
