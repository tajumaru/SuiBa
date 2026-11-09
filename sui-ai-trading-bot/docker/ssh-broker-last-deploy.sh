#!/usr/bin/env bash
# Read-only read of the broker's public result mirror for a failed
# deploy. The broker publishes every deploy outcome to
# /opt/suiba/last-deploy.json (world-readable by design, carrying
# only whitelisted fields), so this names the public result code in
# the same job instead of waiting for a separate diagnostics run.
# The remote command is fixed below; no caller input reaches it.
set +x
set -Eeuo pipefail
umask 077
fail() { echo 'BROKER_LAST_DEPLOY_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-broker-last-deploy.XXXXXXXX")
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
# Only this one fixed path is read; the file is world-readable, so no
# sudo is involved. Never echo the remote response: only the fully
# validated one-line rendering below reaches the log.
read_ok=0
if timeout 30s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" 'cat /opt/suiba/last-deploy.json' </dev/null 2>"$errors" |
    head -c 4097 >"$result"; then
  read_ok=1
fi
[[ $read_ok == 1 ]] || fail
python3 - "$result" <<'PYCODE' || fail
import json
import re
import sys
from pathlib import Path

try:
    raw = Path(sys.argv[1]).read_bytes()
    if len(raw) > 4096:
        raise ValueError()
    payload = json.loads(raw)
    if type(payload) is not dict or set(payload) != {"version", "status", "code", "sha", "at"}:
        raise ValueError()
    if type(payload["version"]) is not int or payload["version"] != 1:
        raise ValueError()
    if payload["status"] not in ("prepared_stopped", "failed"):
        raise ValueError()
    code = payload["code"]
    if code is not None and (type(code) is not str or not re.fullmatch(r"[A-Z][A-Z_]{2,47}", code)):
        raise ValueError()
    sha = payload["sha"]
    if sha is not None and (type(sha) is not str or not re.fullmatch(r"[a-f0-9]{40}", sha)):
        raise ValueError()
    if type(payload["at"]) is not int or payload["at"] <= 0:
        raise ValueError()
except (OSError, ValueError, TypeError):
    sys.exit(1)
print(f"Broker last deploy: status={payload['status']}, code={code or 'none'}, "
      f"SHA={sha or 'none'}, at={payload['at']}")
PYCODE
