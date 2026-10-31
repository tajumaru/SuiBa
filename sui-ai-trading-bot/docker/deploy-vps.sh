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
# External volumes must already exist. Missing data must never create a fresh ledger.
docker volume inspect suiba-vps-data suiba-vps-reports >/dev/null
mkdir -p /opt/suiba/backups
# Persist maintenance before stopping, preventing concurrent UI start commands.
docker run --rm --network none --read-only --cap-drop ALL \
  -v suiba-vps-data:/app/data "$SUIBA_IMAGE" node --input-type=module -e \
  "import {writeFileSync} from 'node:fs'; writeFileSync('/app/data/bot.sqlite.maintenance','deployment');"
fail_stopped() {
  dc stop --timeout 40 bot || true
  echo 'Deployment failed; service stopped and maintenance retained. Inspect before retry.' >&2
}
trap fail_stopped ERR
dc stop --timeout 40 bot
cid=$(dc ps -aq bot)
if [[ -n $cid ]]; then
  test "$(docker inspect --format '{{.State.ExitCode}}' "$cid")" = 0
fi
# Cold backup includes both pairs, WAL/SHM, selection, charts and lifecycle files.
backup="/opt/suiba/backups/$(date -u +%Y%m%dT%H%M%SZ)-$sha.tar"
docker run --rm --network none --read-only --cap-drop ALL \
  -v suiba-vps-data:/source:ro --entrypoint tar "$SUIBA_IMAGE" -C /source -cf - . > "$backup"
test -s "$backup"
# Maintenance remains latched across releases until an operator explicitly clears it.
dc up -d --no-build --wait --wait-timeout 180 bot
ln -sfn "/opt/suiba/releases/$sha" /opt/suiba/current
echo 'Release healthy; PAPER execution remains maintenance-blocked.'
