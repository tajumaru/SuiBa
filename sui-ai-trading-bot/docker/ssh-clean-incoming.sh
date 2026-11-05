#!/usr/bin/env bash
# Remove stale release uploads from /var/lib/suiba-incoming through the
# existing unprivileged SSH account. The remote side only removes an
# entry when it is unmistakably a finished upload:
#   - the directory name is a 40-char lowercase hex release sha,
#   - it is a real directory (no symlink) owned by the SSH user,
#   - it contains only regular files named image.tar.gz or
#     .image.partial.* (the two names the transfer paths create),
#   - nothing inside was modified within the last hour, so an upload
#     or a broker read in progress is never raced.
# Anything else is reported as skipped, never deleted.
set +x
set -Eeuo pipefail
umask 077
fail() { echo 'INCOMING_CLEANUP_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${CLEANUP_CONFIRMATION:-} == CLEAN-INCOMING ]] || fail
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-clean-incoming.XXXXXXXX")
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
# Fixed remote program, executed as the unprivileged deploy user (no
# sudo). It prints exactly one JSON object; only the validated
# rendering below reaches the logs.
remote=$(cat <<'REMOTE'
set -eu
base=/var/lib/suiba-incoming
threshold=$(( $(date +%s) - 3600 ))
if [ -L "$base" ] || [ ! -d "$base" ]; then
  printf '{"removed":[],"skipped":[]}\n'
  exit 0
fi
removed=""
skipped=""
sep_r=""
sep_s=""
skip() {
  skipped="$skipped$sep_s{\"name\":\"$1\",\"reason\":\"$2\"}"
  sep_s=","
}
for path in "$base"/*; do
  [ -e "$path" ] || [ -L "$path" ] || continue
  name=${path##*/}
  display=$name
  case "$name" in
    *[!0-9a-zA-Z._-]*|'') display="invalid-name" ;;
  esac
  if [ ${#name} -ne 40 ]; then skip "$display" name; continue; fi
  case "$name" in
    *[!0-9a-f]*) skip "$display" name; continue ;;
  esac
  if [ -L "$path" ] || [ ! -d "$path" ]; then skip "$display" not_directory; continue; fi
  bad=0
  newest=0
  seen=0
  for entry in "$path"/* "$path"/.[!.]* "$path"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    seen=1
    if [ -L "$entry" ] || [ ! -f "$entry" ]; then bad=1; break; fi
    case "${entry##*/}" in
      image.tar.gz|.image.partial.*) ;;
      *) bad=1; break ;;
    esac
    m=$(stat -c %Y "$entry")
    if [ "$m" -gt "$newest" ]; then newest=$m; fi
  done
  if [ "$bad" -eq 1 ]; then skip "$display" contents; continue; fi
  if [ "$seen" -eq 0 ]; then newest=$(stat -c %Y "$path"); fi
  if [ "$newest" -gt "$threshold" ]; then skip "$display" recent; continue; fi
  set -- $(du -sb "$path")
  bytes=$1
  rm -rf -- "$path"
  removed="$removed$sep_r{\"name\":\"$name\",\"bytes\":$bytes}"
  sep_r=","
done
printf '{"removed":[%s],"skipped":[%s]}\n' "$removed" "$skipped"
REMOTE
)
timeout 120s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" "$remote" >"$result" 2>"$errors" || fail
# Only the fully validated renderer output is copied to logs. Never tee
# raw JSON, SSH stderr, environment, token, or key.
python3 - "$result" <<'PYCODE' | tee -a "${GITHUB_STEP_SUMMARY:?}"
import json
import re
import sys
from pathlib import Path

try:
    with Path(sys.argv[1]).open("rb") as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError()
    payload = json.loads(raw)
    if not isinstance(payload, dict) or set(payload) != {"removed", "skipped"}:
        raise ValueError()
    removed = payload["removed"]
    skipped = payload["skipped"]
    if not isinstance(removed, list) or not isinstance(skipped, list):
        raise ValueError()
    if len(removed) > 1000 or len(skipped) > 1000:
        raise ValueError()
    for entry in removed:
        if not isinstance(entry, dict) or set(entry) != {"name", "bytes"}:
            raise ValueError()
        if not re.fullmatch(r"[0-9a-f]{40}", entry["name"]):
            raise ValueError()
        if type(entry["bytes"]) is not int or entry["bytes"] < 0:
            raise ValueError()
    for entry in skipped:
        if not isinstance(entry, dict) or set(entry) != {"name", "reason"}:
            raise ValueError()
        if not re.fullmatch(r"[0-9a-zA-Z._-]{1,64}", entry["name"]):
            raise ValueError()
        if entry["reason"] not in ("name", "not_directory", "contents", "recent"):
            raise ValueError()
except (OSError, ValueError, KeyError, TypeError):
    sys.exit("INCOMING_CLEANUP_INVALID")
total = sum(entry["bytes"] for entry in removed)
print("### SuiBa VPS incoming cleanup")
print(f"- Removed: {len(removed)} entries, {total} bytes freed")
for entry in removed:
    print(f"  - `{entry['name']}` ({entry['bytes']} bytes)")
print(f"- Skipped: {len(skipped)} entries")
for entry in skipped:
    print(f"  - `{entry['name']}` ({entry['reason']})")
PYCODE
