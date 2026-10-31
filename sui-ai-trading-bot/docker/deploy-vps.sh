#!/usr/bin/env bash
# Fixed layout; never build on the 2GB host. Leave failures stopped for inspection.
set -Eeuo pipefail
umask 077
sha=${1:?commit SHA required}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || exit 2
cd "/opt/suiba/releases/$sha"
exec 9>/opt/suiba/shared/deploy.lock
flock -n 9 || { echo 'Another deployment holds the lock'; exit 1; }
test -s /opt/suiba/shared/runtime.env
test -s /opt/suiba/shared/admin-token
export SUIBA_IMAGE="suiba:$sha"
dc() { docker compose -f compose.vps.yaml "$@"; }
sha256sum --check image.tar.gz.sha256
docker load -i image.tar.gz
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$SUIBA_IMAGE")" = "$sha"
dc config --quiet
fail_stopped() {
  local failure=$?
  trap - ERR HUP INT TERM
  set +e
  # Independent of Compose/env parsing; disable restarts even if the gate failed.
  local ids cid
  if ! ids=$(docker ps -aq --filter label=com.docker.compose.project=suiba-vps --filter label=com.docker.compose.service=bot); then
    echo 'CRITICAL: Docker unavailable; worker state unknown, immediate operator action required.' >&2
  fi
  for cid in $ids; do
    docker update --restart=no "$cid" >/dev/null
    docker stop --timeout 40 "$cid" >/dev/null || docker kill "$cid" >/dev/null
    if [[ $(docker inspect --format '{{.State.Running}}' "$cid") != false ]]; then
      echo 'CRITICAL: unable to confirm service stopped; immediate operator action required.' >&2
    fi
  done
  echo 'Deployment failed; restart disabled and stop requested. Inspect before retry.' >&2
  (( failure != 0 )) || failure=1
  exit "$failure"
}
# Install BEFORE any maintenance/volume/backup operation can fail.
trap fail_stopped ERR HUP INT TERM
# External volumes must already exist. Missing data must never create a fresh ledger.
docker volume inspect suiba-vps-data suiba-vps-reports >/dev/null
mkdir -p /opt/suiba/backups
# Persist maintenance before stopping, preventing concurrent UI start commands.
docker run --rm --network none --read-only --cap-drop ALL \
  --user 1000:1000 --memory 256m --memory-swap 256m --pids-limit 64 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000 \
  -v suiba-vps-data:/app/data "$SUIBA_IMAGE" node --import tsx docker/vps-data.mjs maintenance
dc stop --timeout 40 bot
cid=$(dc ps -aq bot)
if [[ -n $cid ]]; then
  test "$(docker inspect --format '{{.State.Running}}' "$cid")" = false
  test "$(docker inspect --format '{{.State.OOMKilled}}' "$cid")" = false
  test "$(docker inspect --format '{{.State.ExitCode}}' "$cid")" = 0
fi
# Cold backup includes both pairs, WAL/SHM, selection, charts and lifecycle files.
backup="/opt/suiba/backups/$(date -u +%Y%m%dT%H%M%SZ)-$sha-$$.tar"
scratch="suiba-vps-backup-$sha-$$"
cleanup() { docker volume rm "$scratch" >/dev/null || true; }
trap cleanup EXIT
docker volume create "$scratch" >/dev/null
docker run --rm --network none --read-only --cap-drop ALL \
  --user 1000:1000 --memory 512m --memory-swap 512m --pids-limit 64 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000 \
  -v suiba-vps-data:/app/data -v "$scratch:/app/reports" \
  "$SUIBA_IMAGE" node --import tsx docker/vps-data.mjs backup > "$backup.partial"
test -s "$backup.partial"
mv -n "$backup.partial" "$backup"
sha256sum "$backup" > "$backup.sha256"
sync -f "$backup"
sync -f "$backup.sha256"
# Maintenance remains latched across releases until an operator explicitly clears it.
dc up -d --no-build --wait --wait-timeout 180 bot
ln -sfn "/opt/suiba/releases/$sha" /opt/suiba/current
echo 'Release healthy; PAPER execution remains maintenance-blocked.'
