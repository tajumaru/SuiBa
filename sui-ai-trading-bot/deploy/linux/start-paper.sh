#!/bin/sh
set -eu
# Root-owned launcher. EnvironmentFile holds non-secret configuration only.
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
export PATH=/opt/suiba/runtime/bin:/usr/bin:/bin
if [ "$(/usr/bin/id -un)" != suiba ]; then
    echo MUST_RUN_AS_SUIBA >&2
    exit 1
fi
export MODE=PAPER HOST=127.0.0.1 PORT=3100
export REQUIRE_EXISTING_DATABASE=1 DATABASE_PATH=/var/lib/suiba/bot.sqlite
export ADMIN_TOKEN_FILE=/etc/suiba/admin-token
export DOTENV_CONFIG_PATH=/dev/null DOTENV_CONFIG_QUIET=true
export VALIDATION_REPORT_DIR=/var/lib/suiba/validation
cd /var/lib/suiba-release/current
# Verify using a separately installed, reviewed root-owned helper BEFORE loading
# the release's tsx/worker code. Node 24 strips this helper's erasable TS types.
SUIBA_BUILD_SHA=$(/opt/suiba/runtime/bin/node --input-type=module -e '
import { readFileSync, realpathSync } from "node:fs";
import { verifyLinuxRelease } from "/opt/suiba/tools/apps/worker/src/linux-release-artifact.ts";
const manifest = JSON.parse(readFileSync("release.json", "utf8"));
if (!/^[a-f0-9]{40}$/.test(manifest.sha) || realpathSync(".") !== "/opt/suiba/releases/" + manifest.sha) throw Error("INVALID_CURRENT_RELEASE");
verifyLinuxRelease(process.cwd(), manifest.sha, true);
process.stdout.write(manifest.sha);
')
export SUIBA_BUILD_SHA
exec /opt/suiba/runtime/bin/node --import ./scripts/enforce-node-version.mjs --import tsx apps/worker/src/index.ts
