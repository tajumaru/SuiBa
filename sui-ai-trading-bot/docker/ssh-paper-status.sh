#!/usr/bin/env bash
# Read-only status through the existing fixed controller wrapper.
set +x
set -Eeuo pipefail
umask 077
fail() { echo 'PAPER_STATUS_FAILED (connection or response details withheld)' >&2; exit 1; }
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail
[[ ${VPS_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || fail
[[ $VPS_USER == suiba-deploy ]] || fail
[[ ${VPS_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail
port=$((10#$VPS_PORT))
(( port >= 1 && port <= 65535 )) || fail
[[ -n ${VPS_SSH_KEY:-} && -n ${VPS_KNOWN_HOSTS:-} ]] || fail
[[ -d ${RUNNER_TEMP:-} ]] || fail
folder=$(mktemp -d "$RUNNER_TEMP/suiba-paper-status.XXXXXXXX")
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
# Only fixed read-only operations are sent. Never echo the remote response.
case "${PAPER_STATUS_CONFIRMATION:-CHECK-PAPER-STATUS}" in
  CHECK-PAPER-STATUS) operation=status ;;
  CHECK-PAPER-DIAGNOSTICS) operation=diagnose ;;
  *) fail ;;
esac
printf '{"operation":"%s"}\n' "$operation" |
  timeout 100s ssh "${opts[@]}" "$VPS_USER@$VPS_HOST" 'sudo -n -- /usr/local/sbin/suiba-paper-check' >"$result" 2>"$errors" || fail
# Only the fully validated renderer output is copied to logs. Never tee raw JSON,
# SSH stderr, environment, token, or key. Codex can read logs without screenshots.
python3 - "$result" "$operation" <<'PYCODE' | tee -a "${GITHUB_STEP_SUMMARY:?}"
import json
import sys
from pathlib import Path

try:
    with Path(sys.argv[1]).open("rb") as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError()
    payload = json.loads(raw)
    run = payload["run"]
    state = run["status"]
    if state not in ("in_progress", "finishing", "completed", "failed_requires_review"):
        raise ValueError()
    stop = payload["stop"]
    status = "no receipt"
    if stop is not None:
        if stop["id"] != run["id"]:
            raise ValueError()
        status = stop["status"]
        if status not in ("stopping_state_unknown", "worker_stopped_pending_controller_exit",
                          "clean_stopped", "failed_state_unknown"):
            raise ValueError()
    fault = payload["requires_review"]
    if type(fault) is not bool:
        raise ValueError()
    details = None
    if sys.argv[2] == "diagnose":
        details = payload["diagnostics"]
        stages = (None, "maintenance-release", "worker-start", "worker-readiness",
                  "deployment-state", "pair-selection", "market-summary",
                  "market-freshness", "arm", "paper-start", "monitoring", "normal-stop")
        if details["stage"] not in stages:
            raise ValueError()
        if details["maintenance"] is not True:
            raise ValueError()
        if type(details["oom_killed"]) is not bool or type(details["exit_code"]) is not int:
            raise ValueError()
        for key in ("healthcheck_exit", "http_status"):
            if details[key] is not None and type(details[key]) is not int:
                raise ValueError()
        # A run that ended before its backup stage reports
        # backup_verified=False with deltas=None; anything else must
        # carry the full integer difference map.
        if details["backup_verified"] is True:
            for pair in ("SUI_USDC", "WAL_USDC"):
                for key in ("starts", "orders", "fills"):
                    if type(details["deltas"][pair][key]) is not int:
                        raise ValueError()
        elif details["backup_verified"] is False:
            if details["deltas"] is not None:
                raise ValueError()
        else:
            raise ValueError()
        import re
        stop_errors = stop.get("errors", [])
        if type(stop_errors) is not list or len(stop_errors) > 8 or any(
                type(code) is not str or not re.fullmatch(r"[A-Z][A-Z_]{2,47}", code)
                for code in stop_errors):
            raise ValueError()
        preflight = details.get("preflight")
        if preflight is not None:
            if preflight["check"] not in ("storage", "ledger", "container", "admission"):
                raise ValueError()
            if type(preflight["error"]) is not str or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", preflight["error"]):
                raise ValueError()
            detail = preflight.get("detail")
            if detail is not None and (preflight["check"] != "container" or detail not in (
                    "inspect", "state", "restart_user", "env", "ports", "memory", "label", "transaction", "image")):
                raise ValueError()
        market = details.get("market")
        if market is not None:
            if type(market) is not dict or set(market) != {"source", "lastSuccessAt", "reason"}:
                raise ValueError()
            for key in ("source", "reason"):
                if market[key] is not None and (type(market[key]) is not str or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", market[key])):
                    raise ValueError()
            if market["lastSuccessAt"] is not None and type(market["lastSuccessAt"]) not in (int, float):
                raise ValueError()
        if "clean_lifecycle" in details and type(details["clean_lifecycle"]) is not bool:
            raise ValueError()
        runtime = details.get("runtime")
        if runtime is not None:
            allowed_errors = {None, "API_CANCELLED", "CANDLE_GAP", "STALE_CANDLES", "INVALID_CANDLE",
                "PRICE_OUTLIER", "SUI_READ_FAILED", "UPSTREAM_HTTP_429", "CONSECUTIVE_API_ERRORS",
                "PAPER_RECOVERY_EXHAUSTED", "PAPER_RECONCILIATION_FAILED", "VALIDATION_RECORD_FAILED",
                "MARKET_DATA_STALLED", "DATABASE_UNAVAILABLE", "OTHER_RUNTIME_ERROR"}
            for pair in ("SUI_USDC", "WAL_USDC"):
                value = runtime[pair]
                if type(value["running"]) is not bool or type(value["emergency"]) is not bool:
                    raise ValueError()
                if value["error"] not in allowed_errors or value["before_error"] not in allowed_errors:
                    raise ValueError()
            if details.get("selected_pair") not in ("SUI_USDC", "WAL_USDC", "UNKNOWN"):
                raise ValueError()
        host = details.get("host")
        if host is not None:
            import re
            for key in ("restart_disabled", "paper", "fault_marker", "timer_active", "timer_elapsed",
                        "timer_next_scheduled", "timer_job_pending"):
                if type(host[key]) is not bool:
                    raise ValueError()
            if type(host["sequence"]) is not int or not re.fullmatch(r"[a-f0-9]{40}", host["sha"]):
                raise ValueError()
            if host["ledger_status"] not in ("in_progress", "prepared_stopped", "failed_stopped", "failed_state_unknown", "unknown"):
                raise ValueError()
            if host["paper_gate"] not in ("completed", "in_progress", "unknown"):
                raise ValueError()
            if host["container_status"] not in ("created", "exited"):
                raise ValueError()
            container_checks = host.get("container_checks")
            if container_checks is not None:
                for key in ("state", "restart_user", "env", "ports", "memory", "label", "image"):
                    if type(container_checks[key]) is not bool:
                        raise ValueError()
            for key in ("controller_sha256", "broker_sha256"):
                if not re.fullmatch(r"[a-f0-9]{64}", host[key]):
                    raise ValueError()
            failure = host.get("broker_failure")
            if failure is not None:
                stages = ("consume-approval", "maintenance", "stop-containers", "verify-stopped",
                    "verify-databases", "create-backup-volume", "backup", "persist-backup",
                    "create-container", "verify-created", "complete")
                codes = ("DOCKER_TIMEOUT", "DOCKER_OUTPUT_TOO_LARGE", "DOCKER_OPERATION_FAILED",
                    "UNCLEAN_CONTAINER_STOP", "CONTAINER_IDENTITY", "STOP_UNCONFIRMED", "BACKUP_EMPTY",
                    "CREATED_CONTAINER_MISSING", "CREATED_CONTAINER_RUNNING", "INTERRUPTED", "INPUT_TIMEOUT",
                    "DIRECTORY_OWNER_MODE", "FILE_OWNER_MODE", "TRUSTED_FILE_TOO_LARGE",
                    "UNEXPECTED_REJECTION", "OS_ERROR", "PROCESS_TIMEOUT", "UNEXPECTED_EXCEPTION")
                if (not isinstance(failure, dict) or set(failure) != {"version", "stage", "code", "process"}
                    or type(failure["version"]) is not int or failure["version"] != 1
                    or failure["stage"] not in stages or failure["code"] not in codes):
                    raise ValueError()
                process = failure["process"]
                if process is not None:
                    if (not isinstance(process, dict) or set(process) !=
                        {"phase", "exit_code", "stdout_bytes", "stderr_bytes"}
                        or process["phase"] not in ("drain", "wait")):
                        raise ValueError()
                    if process["exit_code"] is not None and (type(process["exit_code"]) is not int
                        or not -255 <= process["exit_code"] <= 255):
                        raise ValueError()
                    for key, limit in (("stdout_bytes", 8*1024**3+65536), ("stderr_bytes", 1024**2+65536)):
                        if type(process[key]) is not int or not 0 <= process[key] <= limit:
                            raise ValueError()

except (OSError, ValueError, KeyError, TypeError):
    sys.exit("PAPER_STATUS_INVALID")
print("### SuiBa PAPER verification")
print(f"- Run: `{state}`")
duration = run.get("duration")
if duration is not None:
    if duration not in ("30m", "6h", "24h"):
        raise ValueError()
    print(f"- Duration: `{duration}`")
print(f"- Stop receipt: `{status}`")
print(f"- Manual review needed: {'yes' if fault or state == 'failed_requires_review' else 'no'}")
if details is not None:
    print(f"- Container exit code: {details['exit_code']}, OOM killed: {details['oom_killed']}")
    print(f"- Last healthcheck exit code: {details['healthcheck_exit']}")
    if details["backup_verified"]:
        print("- Maintenance: enabled; backup SHA-256 verified; SQLite copies passed integrity checks")
    else:
        print("- Maintenance: enabled; backup: not taken (run ended before its backup stage)")
    print(f"- Failed stage: {details['stage'] or 'not recorded'}, HTTP status: {details['http_status']}")
    stop_errors = stop.get("errors") or []
    if stop_errors:
        print(f"- Stop errors: {', '.join(stop_errors)}")
    preflight = details.get("preflight")
    if preflight is not None:
        line = f"- Preflight failure: check={preflight['check']}, error={preflight['error']}"
        if preflight.get("detail") is not None:
            line += f", detail={preflight['detail']}"
        print(line)
    readiness = details.get("readiness")
    if isinstance(readiness, dict):
        health = readiness.get("health")
        if health in ("starting", "healthy", "unhealthy", "unknown"):
            print(f"- Docker health during readiness: {health}")
        checks = ("connectivity", "apiAccess", "emergencyClear", "runtimeClear", "suiHealthy", "suiFresh", "ledger")
        blocked = [key for key in checks if readiness.get(key) is False]
        if blocked:
            print("- Readiness checks blocking start: " + ", ".join(blocked))
    market = details.get("market")
    if isinstance(market, dict):
        print(f"- Market at failure: source={market['source']}, lastSuccessAt={market['lastSuccessAt']}, reason={market['reason']}")
    stale_reset = details.get("stale_reset")
    if isinstance(stale_reset, dict):
        print(f"- Stale reset at readiness: sent, result={'ok' if stale_reset.get('ok') else 'failed'}")
    evidence = details.get("evidence")
    if isinstance(evidence, dict):
        timing = evidence.get("timing")
        if isinstance(timing, dict) and timing.get("dur") is not None:
            print(f"- Last fetch in SUI database: duration={timing['dur']}ms")
        events = evidence.get("events")
        if isinstance(events, list) and events:
            rendered = ", ".join(f"{e['k']}/{e['c']}" for e in events[:6]
                                 if isinstance(e, dict) and "k" in e and "c" in e)
            if rendered:
                print(f"- Recent operation events (SUI, newest first): {rendered}")
    if "clean_lifecycle" in details:
        print(f"- Clean PAPER lifecycle receipt: {details['clean_lifecycle']}")
    runtime = details.get("runtime")
    if runtime is not None:
        print("- All four database copies passed integrity checks")
        print(f"- Selected pair: {details['selected_pair']}")
        for pair in ("SUI_USDC", "WAL_USDC"):
            value = runtime[pair]
            print(f"- {pair} runtime: running={value['running']}, emergency={value['emergency']}, "
                  f"error={value['error']}, before-run error={value['before_error']}")
    host = details.get("host")
    if host is not None:
        print(f"- Container: {host['container_status']}, restart disabled={host['restart_disabled']}, PAPER={host['paper']}")
        container_checks = host.get("container_checks")
        if container_checks is not None:
            rendered = ", ".join(f"{key}={'ok' if container_checks[key] else 'NG'}"
                                 for key in ("state", "restart_user", "env", "ports", "memory", "label", "image"))
            print(f"- Container checks: {rendered}")
        print(f"- Deployment ledger: {host['ledger_status']}, sequence={host['sequence']}, SHA={host['sha']}")
        print(f"- Deployment PAPER gate: {host['paper_gate']}, fault marker={host['fault_marker']}")
        print(f"- Cutoff timer: active={host['timer_active']}, elapsed={host['timer_elapsed']}, "
              f"next scheduled={host['timer_next_scheduled']}, job pending={host['timer_job_pending']}")
        print(f"- Installed controller SHA-256: {host['controller_sha256']}")
        print(f"- Installed broker SHA-256: {host['broker_sha256']}")
        failure = host.get("broker_failure")
        if failure is not None:
            print(f"- Broker failure: stage={failure['stage']}, code={failure['code']}")
            process = failure["process"]
            if process is not None:
                print(f"- Broker CLI observation: phase={process['phase']}, exit={process['exit_code']}, "
                      f"stdout bytes={process['stdout_bytes']}, stderr bytes={process['stderr_bytes']}")
    if details["deltas"] is not None:
        for pair in ("SUI_USDC", "WAL_USDC"):
            delta = details["deltas"][pair]
            print(f"- {pair} difference: starts={delta['starts']:+d}, orders={delta['orders']:+d}, fills={delta['fills']:+d}")
    else:
        print("- Activity difference: unavailable (no pre-run backup to compare against)")
PYCODE
