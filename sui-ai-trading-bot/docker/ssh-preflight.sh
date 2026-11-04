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
current_target=$(readlink /opt/suiba/current || true)
current_name=none
current_mtime=0
if [ -n "$current_target" ] && [ -d "$current_target" ]; then
  current_name=${current_target##*/}
  current_mtime=$(stat -c %Y "$current_target")
fi
releases_count=$(ls /opt/suiba/releases | wc -l)
releases_count=$((releases_count))
backups_count=$(ls /opt/suiba/backups | wc -l)
backups_count=$((backups_count))
newest_backup=$(ls -t /opt/suiba/backups | head -n 1)
newest_backup_mtime=0
if [ -n "$newest_backup" ]; then
  newest_backup_mtime=$(stat -c %Y "/opt/suiba/backups/$newest_backup")
fi
uptime_seconds=$(awk '{print int($1)}' /proc/uptime)
load1=$(awk '{print $1}' /proc/loadavg)
deploy_wrapper=0
if [ -e /usr/local/sbin/suiba-deploy ]; then deploy_wrapper=1; fi
paper_check_wrapper=0
if [ -e /usr/local/sbin/suiba-paper-check ]; then paper_check_wrapper=1; fi
runtime_env=0
if [ -e /opt/suiba/shared/runtime.env ]; then runtime_env=1; fi
admin_token=0
if [ -e /opt/suiba/shared/admin-token ]; then admin_token=1; fi
incoming_exists=0
incoming_count=0
if [ -d /var/lib/suiba-incoming ]; then
  incoming_exists=1
  incoming_count=$(ls /var/lib/suiba-incoming | wc -l)
  incoming_count=$((incoming_count))
fi
printf '%s\n' SSH_PREFLIGHT_OK "$(id -un)" "$client" "$compose" "$engine_package" "$mem_total" "$mem_available" "$disk_available" "$current_name" "$current_mtime" "$releases_count" "$backups_count" "$newest_backup_mtime" "$uptime_seconds" "$load1" "$deploy_wrapper" "$paper_check_wrapper" "$runtime_env" "$admin_token" "$incoming_exists" "$incoming_count"
REMOTE
)
timeout 45s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" "$remote" >"$result" 2>"$errors" || fail
mapfile -t reply < "$result"
[[ ${#reply[@]} == 21 && ${reply[0]} == SSH_PREFLIGHT_OK && ${reply[1]} == "$VPS_USER" ]] || fail
[[ ${reply[2]} =~ ^[0-9]+\.[0-9]+\.[0-9]+([.+~-][a-zA-Z0-9.-]+)?$ ]] || fail
[[ ${reply[3]} =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.+~-][a-zA-Z0-9.-]+)?$ ]] || fail
[[ ${reply[4]} =~ ^[0-9][a-zA-Z0-9.+:~_-]*$ ]] || fail
for index in 5 6 7; do
  [[ ${reply[index]} =~ ^[0-9]{1,15}$ ]] || fail
  (( 10#${reply[index]} > 0 )) || fail
done
# Deployed-release and host-state fields (appended after the original
# eight lines so their positions and validation stay unchanged).
[[ ${reply[8]} =~ ^(none|[0-9a-f]{7,64})$ ]] || fail
[[ ${reply[9]} =~ ^[0-9]{1,15}$ ]] || fail
if [[ ${reply[8]} == none ]]; then
  (( 10#${reply[9]} == 0 )) || fail
else
  (( 10#${reply[9]} > 0 )) || fail
fi
for index in 10 11 12; do
  [[ ${reply[index]} =~ ^[0-9]{1,15}$ ]] || fail
done
if (( 10#${reply[11]} > 0 )); then
  (( 10#${reply[12]} > 0 )) || fail
fi
[[ ${reply[13]} =~ ^[0-9]{1,15}$ ]] || fail
(( 10#${reply[13]} > 0 )) || fail
[[ ${reply[14]} =~ ^[0-9]+\.[0-9]{1,2}$ ]] || fail
# Host deployment prerequisites: existence flags only (0/1). File
# contents, sizes and permissions are never read.
for index in 15 16 17 18 19; do
  [[ ${reply[index]} =~ ^[01]$ ]] || fail
done
[[ ${reply[20]} =~ ^[0-9]{1,10}$ ]] || fail
echo 'SSH_PREFLIGHT_OK: expected non-root user and fixed read-only checks passed; no deployment or Worker startup'
# Only validated non-secret version/resource fields are released to the log.
printf 'DockerCLI=%s Compose=%s EnginePackage=%s (running Engine version not checked)\n' "${reply[2]}" "${reply[3]}" "${reply[4]}"
printf 'MemoryTotalKiB=%s MemoryAvailableKiB=%s DiskAvailableKiB=%s\n' "${reply[5]}" "${reply[6]}" "${reply[7]}"
printf 'CurrentRelease=%s ReleaseModifiedEpoch=%s Releases=%s\n' "${reply[8]}" "${reply[9]}" "${reply[10]}"
printf 'Backups=%s NewestBackupEpoch=%s UptimeSeconds=%s Load1=%s\n' "${reply[11]}" "${reply[12]}" "${reply[13]}" "${reply[14]}"
printf 'PrereqDeployWrapper=%s PrereqPaperCheckWrapper=%s PrereqRuntimeEnv=%s PrereqAdminToken=%s IncomingExists=%s IncomingEntries=%s\n' "${reply[15]}" "${reply[16]}" "${reply[17]}" "${reply[18]}" "${reply[19]}" "${reply[20]}"
