#!/bin/sh
set -eu
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
export PATH=/opt/suiba/runtime/bin:/usr/bin:/bin
if [ "$(/usr/bin/id -un)" != suiba ]; then
    echo MUST_RUN_AS_SUIBA >&2
    exit 1
fi
case "${1-}" in
    prepare|activate|unlock|rollback|cancel|status) ;;
    *) echo INVALID_RELEASE_COMMAND >&2; exit 1 ;;
esac
export MODE=PAPER DOTENV_CONFIG_PATH=/dev/null DOTENV_CONFIG_QUIET=true
cd /opt/suiba/manager
# The control implementation is pinned independently of the mutable current link.
/opt/suiba/runtime/bin/node --input-type=module -e '
import { readFileSync } from "node:fs";
import { verifyLinuxRelease } from "/opt/suiba/tools/apps/worker/src/linux-release-artifact.ts";
const manifest = JSON.parse(readFileSync("release.json", "utf8"));
verifyLinuxRelease(process.cwd(), manifest.sha, true);
'
exec /opt/suiba/runtime/bin/node --import ./scripts/enforce-node-version.mjs --import tsx scripts/linux-paper-release.ts "$@"
