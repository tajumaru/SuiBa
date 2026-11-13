#!/usr/bin/env bash
# Roll production back to a previous release through the deploy
# broker's rollback operation. The rollback job rebuilt the target
# release's archive from its commit (the deploy path's package step,
# unchanged); this wrapper transfers that archive to the broker's
# incoming directory and sends exactly one fixed-shape rollback
# request. Every value it forwards is validated against a strict
# shape first, the broker re-verifies the archive digest, the image
# identity and the approval freshness host-side, and the answer must
# be the single fixed line for the requested SHA. The broker creates
# the old container STOPPED (prepared_stopped) after a fresh backup
# of the current databases; starting it stays with START-PROD.
# Production must already be stopped (STOP-PROD): the broker state
# lock is held for the whole of a running session, exactly as with
# DEPLOY-PAPER, so a rollback against a live session is refused
# before any mutation.
set +x
set -Eeuo pipefail
umask 077
fail() { python3 "$(dirname "${BASH_SOURCE[0]}")/paper-fixed-reason.py" "${errors:-/dev/null}" >&2 || true; echo 'PROD_ROLLBACK_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${PROD_ROLLBACK_CONFIRMATION:-} == ROLLBACK-PROD ]] || fail
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ ${ROLLBACK_SHA:-} =~ ^[0-9a-f]{40}$ ]] || fail
[[ ${ARCHIVE_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || fail
[[ ${ROLLBACK_CI_RUN:-} =~ ^[0-9]+$ ]] || fail
(( 10#$ROLLBACK_CI_RUN > 0 )) || fail
[[ -f ${ROLLBACK_ARCHIVE_FILE:-} && ! -L ${ROLLBACK_ARCHIVE_FILE:-} ]] || fail
[[ -f ${ROLLBACK_IMAGE_FILE:-} && ! -L ${ROLLBACK_IMAGE_FILE:-} ]] || fail
image_id=$(tr -d '[:space:]' < "$ROLLBACK_IMAGE_FILE") || fail
[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-prod-rollback.XXXXXXXX")
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
scp_opts=(-F /dev/null -i "$key" -P "$port"
  -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no
  -o PreferredAuthentications=publickey -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$hosts" -o GlobalKnownHostsFile=/dev/null
  -o UpdateHostKeys=no -o HostKeyAlgorithms=ssh-ed25519
  -o ClearAllForwardings=yes -o LogLevel=ERROR
  -o ConnectTimeout=10 -o ConnectionAttempts=1
  -o ServerAliveInterval=5 -o ServerAliveCountMax=2)
target="$VPS_USER@$VPS_HOST"
# Unprivileged upload only, to the one incoming directory the broker
# reads for this SHA. No candidate script, Compose or env is executed.
timeout 60s ssh "${opts[@]}" "$target" "umask 077; mkdir -p /var/lib/suiba-incoming/$ROLLBACK_SHA" </dev/null >/dev/null 2>"$errors" || fail
timeout 900s scp "${scp_opts[@]}" "$ROLLBACK_ARCHIVE_FILE" "$target:/var/lib/suiba-incoming/$ROLLBACK_SHA/image.tar.gz" >/dev/null 2>"$errors" || fail
# The broker has no CLI arguments and only creates a STOPPED
# container. Its policy selects the approval source; in CI mode this
# request carries the digests the package step produced for this
# run, and the broker re-verifies them against the transferred bytes.
printf '{"operation":"rollback","sha":"%s","archive_sha256":"%s","image_id":"%s","ci_run":%s}\n' "$ROLLBACK_SHA" "$ARCHIVE_SHA256" "$image_id" "$ROLLBACK_CI_RUN" |
  timeout 900s ssh "${opts[@]}" "$target" 'sudo -n -- /usr/local/sbin/suiba-deploy' >"$result" 2>"$errors" || fail
# The broker answers with exactly one fixed JSON line naming the
# requested SHA. Anything else is withheld and reported as a
# failure, never echoed to logs.
[[ $(cat "$result") == "{\"status\": \"prepared_stopped\", \"sha\": \"$ROLLBACK_SHA\"}" ]] || fail
{
  echo '### SuiBa production rollback'
  echo "- Rollback: \`prepared_stopped\`"
  echo "- SHA: \`$ROLLBACK_SHA\`"
} | tee -a "${GITHUB_STEP_SUMMARY:?}"
