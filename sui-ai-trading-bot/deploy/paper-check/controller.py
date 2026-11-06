#!/usr/bin/python3
"""Fixed root-owned PAPER test supervisor. Install only after independent review.

No image/path/duration/command is accepted from SSH. No token is returned.
The stop entrypoint deliberately does not acquire the run/deploy lock.

Root-only recovery: approve-deploy RUN_ID RELEASE_SHA. Requires an inactive
cutoff and an existing independent release approval. Preserves failed history;
issues one permission consumed by the broker before the next deployment attempt.
"""
import contextlib
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import urllib.error
import uuid

STATE = Path('/var/lib/suiba-paper-check')
BROKER = Path('/usr/local/libexec/suiba-deploy-broker.py')
CONTAINER = 'suiba-vps-bot-1'
TIMER = 'suiba-paper-check-cutoff.timer'
SERVICE = 'suiba-paper-check.service'
CUTOFF = 'suiba-paper-check-cutoff.service'
# Fixed validation lengths, chosen per run through the start request.
# The Worker's PAPER_CHECK_MODE token stays 'sui-30m': it names the lease
# family, not the length. The length lives only here, in the record's
# cutoff and in the per-length cutoff timer, so a started run can never
# be extended by the container, the Worker, or a later request.
DURATIONS = {'30m': 1800, '6h': 21600, '24h': 86400}
# Program files (this controller, the broker) are read whole for
# integrity checks. The broker's read_trusted default of 64 KiB
# is sized for state files; this controller passed it at the
# production-ops stage (84 KiB by the monitor stage), after
# which every entry point refused to run on the host while
# module-level tests stayed green. Program reads pass this
# maximum explicitly, and a test keeps the file below it.
PROGRAM_READ_MAXIMUM = 262144
RECONCILE_BACKUPS = Path('/root')
PREFLIGHT_CHECKS = ('storage', 'ledger', 'container', 'admission')
# Sub-labels for the container preflight segment, recorded as the
# preflight evidence's detail. A 2026-11-06 death there recorded
# only check=container while every diagnose sub-check passed
# afterwards, leaving the exact require unknown.
CONTAINER_CHECKS = ('inspect', 'state', 'restart_user', 'env', 'ports', 'memory', 'label', 'transaction', 'image')
# The deployed container's env chooses which deterministic market
# provider a run validates (switching providers is a deploy-time
# compose change). 'auto' is refused: its summary source can flip
# mid-run, which the freshness checks cannot attribute.
MARKET_SOURCES = {'geckoterminal': 'GeckoTerminal', 'deepbook': 'DeepBook'}


def cutoff_timer(duration):
    if duration == '30m':
        return TIMER
    return TIMER.removesuffix('.timer')+'-'+duration+'.timer'


def cutoff_timers():
    return tuple(cutoff_timer(name) for name in DURATIONS)


POLICY = Path('/etc/suiba-paper-check/policy.json')
PROD_POLICY = Path('/etc/suiba-paper-check/prod-policy.json')
PROD_SERVICE = 'suiba-prod.service'
WATCHDOG_RECORD = Path('/var/lib/suiba-watchdog/status.json')
WATCHDOG_REASONS = frozenset((
    'REVIEW_REQUIRED', 'RUN_FAILED', 'CONTROLLER_NOT_RUNNING',
    'CONTROLLER_UNEXPECTED', 'PROD_SERVICE_INACTIVE', 'CUTOFF_NOT_QUIET',
    'STARTUP_STALLED', 'WORKER_UNREACHABLE', 'WORKER_STATE_INVALID',
    'TRADING_STOPPED', 'DATABASE_UNHEALTHY', 'LEDGER_UNHEALTHY',
    'NOT_PAPER', 'MAINTENANCE_ENABLED', 'PROGRESS_STALE',
    'MARKET_STALE', 'CONTAINER_UNAVAILABLE', 'CONTAINER_OOM',
    'RESTART_POLICY_OR_COUNT', 'CONTAINER_STOPPED', 'CONTAINER_UNHEALTHY',
    'UNEXPECTED_CONTAINER_RUNNING', 'UNCLEAN_CONTAINER_EXIT', 'LIFECYCLE_UNCONFIRMED',
    'LATCH_UNCONFIRMED', 'STOPPED_WITHOUT_LATCH', 'HOST_MEMORY_LOW_OR_UNKNOWN',
    'HOST_DISK_LOW_OR_UNKNOWN', 'BACKUP_UNCONFIRMED', 'STATUS_UNAVAILABLE',
    'STATUS_INVALID',
))
DIAGNOSTIC_STAGES = (
    'maintenance-release', 'worker-start', 'worker-readiness', 'deployment-state',
    'pair-selection', 'market-summary', 'market-freshness', 'arm', 'paper-start',
    'monitoring', 'normal-stop',
)
DIAGNOSTIC_LIMIT = 128 * 1024**2
DIAGNOSTIC_DATABASES = ('bot.sqlite', 'bot.sqlite.WAL_USDC.sqlite')
DIAGNOSTIC_EXTRA_DATABASES = ('bot.sqlite.instance.sqlite', 'bot.sqlite.pairs.sqlite')
RUNTIME_ERROR_CODES = (
    'API_CANCELLED', 'CANDLE_GAP', 'STALE_CANDLES', 'INVALID_CANDLE', 'PRICE_OUTLIER',
    'SUI_READ_FAILED', 'UPSTREAM_HTTP_429', 'CONSECUTIVE_API_ERRORS',
    'PAPER_RECOVERY_EXHAUSTED', 'PAPER_RECONCILIATION_FAILED', 'VALIDATION_RECORD_FAILED',
    'MARKET_DATA_STALLED', 'DATABASE_UNAVAILABLE', 'OTHER_RUNTIME_ERROR',
)
DIAGNOSTIC_FILES = frozenset(
    name + suffix for name in DIAGNOSTIC_DATABASES + DIAGNOSTIC_EXTRA_DATABASES
    for suffix in ('', '-wal', '-shm', '-journal')
)


def require(value):
    if not value:
        raise RuntimeError('PAPER_CHECK_REJECTED')


# Query only temporary copies inside the existing pinned, offline helper image.
DIAGNOSTIC_QUERY = """
const { DatabaseSync } = require("node:sqlite");
const result = {}, runtime = {};
const allowedErrors = new Set(RUNTIME_ERROR_ALLOWLIST);
function safeError(value) {
  return value == null ? null : allowedErrors.has(value) ? value : "OTHER_RUNTIME_ERROR";
}
for (const name of ["bot.sqlite", "bot.sqlite.WAL_USDC.sqlite"]) {
  const counts = [], states = [];
  for (const folder of ["before", "after"]) {
    const db = new DatabaseSync("/audit/" + folder + "/" + name, { readOnly: true });
    try {
      db.exec("PRAGMA trusted_schema=OFF");
      const integrity = db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" ||
          db.prepare("PRAGMA foreign_key_check").get()) throw Error("integrity");
      const row = db.prepare("SELECT json FROM bot_runtime_state WHERE key='runtime'").get();
      const state = JSON.parse(row.json);
      if (typeof state.running !== "boolean" || typeof state.emergency !== "boolean") throw Error("runtime");
      states.push({running: state.running, emergency: state.emergency, error: safeError(state.error)});
      counts.push([
        db.prepare("SELECT count(*) n FROM operation_events WHERE json_extract(json,'$.code')='MANUAL_START'").get().n,
        db.prepare("SELECT count(*) n FROM paper_orders").get().n,
        db.prepare("SELECT count(*) n FROM paper_trades").get().n,
      ]);
    } finally {
      db.close();
    }
  }
  result[name] = counts[1].map((value, index) => value - counts[0][index]);
  runtime[name] = {...states[1], before_error: states[0].error};
}
let selectedPair = "UNKNOWN";
for (const name of ["bot.sqlite.instance.sqlite", "bot.sqlite.pairs.sqlite"]) {
  const db = new DatabaseSync("/audit/after/" + name, {readOnly: true});
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" ||
        db.prepare("PRAGMA foreign_key_check").get()) throw Error("integrity");
    if (name === "bot.sqlite.pairs.sqlite") {
      const row = db.prepare("SELECT json FROM bot_runtime_state WHERE key='selected_pair'").get();
      const pair = JSON.parse(row.json);
      selectedPair = ["SUI_USDC", "WAL_USDC"].includes(pair) ? pair : "UNKNOWN";
      const state = JSON.parse(db.prepare("SELECT json FROM bot_runtime_state WHERE key='runtime'").get().json);
      if (state.running !== false) throw Error("selection runtime");
    }
  } finally { db.close(); }
}
console.log(JSON.stringify({deltas: result, runtime, selected_pair: selectedPair}));
""".replace('RUNTIME_ERROR_ALLOWLIST', json.dumps(RUNTIME_ERROR_CODES))


class Controller:
    session_mode = 'sui-30m'

    def session_cutoff(self, record):
        return record['cutoff']

    def note_stage(self, stage):
        pass

    def arm_request(self, record):
        return {'expiresAt': record['cutoff'], 'issuedAt': int(time.time()*1000)}

    def arm_expiry(self, record):
        return record['cutoff']

    def __init__(self, broker, state=STATE):
        self.b = broker
        self.state = Path(state)
        with broker.directory(self.state):
            pass
        self.docker = broker.Docker(self.state)
        self.record = self.state/'run.json'

    @contextlib.contextmanager
    def locked(self, name, wait=0):
        import stat
        fd = os.open(self.state/(name+'.lock'), os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600)
        try:
            st = os.fstat(fd)
            require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and
                    st.st_uid == getattr(os, 'geteuid', lambda: 0)() and not st.st_mode & 0o077)
            deadline = time.monotonic()+wait
            while True:
                try:
                    if os.name == 'nt':
                        import msvcrt
                        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
                    break
                except (BlockingIOError, OSError):
                    require(time.monotonic() < deadline)
                    time.sleep(.05)
            yield
        finally:
            os.close(fd)

    def current(self, expected=None):
        record = self.b.decode(self.b.read_trusted(self.record))
        value = record['id']
        require(isinstance(value, str) and len(value) == 32 and all(c in '0123456789abcdef' for c in value))
        identity = record['controller']
        require(set(identity) == {'pid', 'start', 'boot'} and type(identity['pid']) is int and identity['pid'] > 1 and
                isinstance(identity['start'], str) and identity['start'].isdecimal() and
                isinstance(identity['boot'], str) and str(uuid.UUID(identity['boot'])) == identity['boot'])
        require(expected is None or value == expected)
        return record

    def folder(self, record):
        path = self.state/record['id']
        with self.b.directory(path): pass
        return path

    def record_preflight(self, record, check, error, detail=None):
        # Best-effort evidence for a pre-admission death: the check
        # name and the exception class only. The message can carry
        # paths or payloads and is never recorded. The container
        # segment also records which of its requires died (detail).
        evidence = {'id': record['id'], 'check': check, 'error': type(error).__name__}
        if detail is not None:
            evidence['detail'] = detail
        with contextlib.suppress(Exception):
            self.b.atomic(self.folder(record)/'preflight.json', evidence)

    def fault(self, record, code):
        # Separate sticky admission fence: even a fault arriving after the last
        # completion check must never be erased by publishing "completed".
        self.b.atomic(self.b.STATE/'paper-check-failed.json', {'id': record['id'], 'status': 'manual_reconciliation_required'})
        self.b.atomic(self.folder(record)/('fault-'+uuid.uuid4().hex+'.json'), {'id': record['id'], 'error': code})

    def faults(self, record):
        return os.path.lexists(self.b.STATE/'paper-check-failed.json') or any(self.folder(record).glob('fault-*.json'))

    def intent(self, record, source):
        path = self.folder(record)/'stop-request.json'
        try:
            fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            require(self.b.decode(self.b.read_trusted(path))['id'] == record['id'])
            return
        with os.fdopen(fd, 'wb') as out:
            out.write(json.dumps({'id': record['id'], 'source': source}).encode())
            out.flush()
            os.fsync(out.fileno())
        if os.name != 'nt':
            with self.b.directory(path.parent) as parent: os.fsync(parent)

    def guard(self, operation, action):
        # Admission journal and action share the same mutex as stop acceptance.
        # If interrupted, pending is retained: a killed CLI is not a cancellation.
        record = self.current(self.run_id)
        with self.locked('mutation', wait=2):
            record = self.current(self.run_id)
            require(record['status'] == 'in_progress' and not self.faults(record))
            require(not (self.state/'abort-inhibit.json').exists())
            require(not (self.folder(record)/'stop-request.json').exists())
            require(time.time()*1000 < self.session_cutoff(record))
            self.b.atomic(self.folder(record)/'mutation.json', {'id': self.run_id, 'pending': operation})
            result = action()
            self.b.atomic(self.folder(record)/'mutation.json', {'id': self.run_id, 'pending': None})
            return result

    def accept_stop(self, record, source):
        try:
            with self.locked('mutation'):
                self.intent(record, source)
        except Exception:
            self.intent(record, source)
            self.fault(record, 'MUTATION_IN_FLIGHT')

    @staticmethod
    def identity(pid):
        value = Path('/proc/'+str(pid)+'/stat').read_text().split(') ', 1)[1].split()
        return {'pid': pid, 'start': value[19], 'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}, value[0]

    def exited(self, record):
        try:
            identity, state = self.identity(record['controller']['pid'])
            return identity != record['controller'] or state == 'Z'
        except FileNotFoundError:
            return True

    def terminate(self, record):
        if self.exited(record): return True
        # pidfd binds the signal to this process, even if a PID is recycled.
        fd = os.pidfd_open(record['controller']['pid'])
        try:
            require(not self.exited(record))
            signal.pidfd_send_signal(fd, signal.SIGTERM)
            deadline = time.monotonic()+10
            while not self.exited(record) and time.monotonic() < deadline: time.sleep(.1)
            require(self.exited(record))
            return True
        finally:
            os.close(fd)

    def quiescent(self):
        # Starting a new run must not repoint state while an old cutoff/job lives.
        for unit in (*cutoff_timers(), CUTOFF):
            try:
                raw = subprocess.check_output(['/usr/bin/systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'Job'],
                                              timeout=5, env={'PATH': '/usr/bin:/bin'}, stderr=subprocess.DEVNULL).decode()
            except subprocess.CalledProcessError:
                # A cutoff timer that is not installed cannot be armed or
                # hold a job. The cutoff service itself stays strict: if
                # systemctl cannot report on it, nothing here is quiescent.
                if unit == CUTOFF:
                    raise
                continue
            values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
            require(values.get('ActiveState') in ('inactive', 'failed') and values.get('Job') in ('', '0'))

    def system(self, *args):
        subprocess.run(['/usr/bin/systemctl', *args], check=True, timeout=20,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin'}, cwd='/')

    def inspect(self):
        values = self.b.decode(self.docker.call(['inspect', CONTAINER], timeout=10))
        require(len(values) == 1)
        return values[0]

    def diagnose(self):
        # Same lock order as run(). Refuse an active run or deployment.
        with self.b.regular(self.b.STATE/'lock') as lock:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.locked('stop'), self.locked('mutation'):
                return self.diagnose_locked()

    def diagnose_locked(self):
        record = self.current()
        require(record['status'] in ('completed', 'failed_requires_review') and self.exited(record))
        i = self.inspect()
        state = i['State']
        require(state['Status'] in ('created', 'exited') and not state['Running'] and state['Pid'] == 0)
        require(not self.docker.call(['ps', '-q', '--filter', 'volume='+self.b.DATA], timeout=10))
        volume = self.b.decode(self.docker.call(['volume', 'inspect', self.b.DATA], timeout=10))
        require(len(volume) == 1 and volume[0]['Driver'] == 'local' and volume[0]['Name'] == self.b.DATA)
        source = Path(volume[0]['Mountpoint'])
        require(source.is_absolute() and source.is_dir() and source.resolve() == source)
        latch = (source/'bot.sqlite.maintenance').lstat()
        maintenance = stat.S_ISREG(latch.st_mode) and latch.st_uid == 1000 and latch.st_nlink == 1
        require(maintenance)
        fd = os.open(source/'bot.sqlite.lifecycle.json', os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            metadata = os.fstat(fd)
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and metadata.st_uid == 1000)
            raw_lifecycle = os.read(fd, 4097)
            require(len(raw_lifecycle) <= 4096)
            lifecycle = self.b.decode(raw_lifecycle)
        finally:
            os.close(fd)
        clean_lifecycle = lifecycle.get('mode') == 'PAPER' and lifecycle.get('state') == 'clean'
        stop = self.b.decode(self.b.read_trusted(self.folder(record)/'stop.json'))
        require(stop['id'] == record['id'])
        stop_errors = stop.get('errors', [])
        require(type(stop_errors) is list and len(stop_errors) <= 8 and all(
            type(code) is str and re.fullmatch(r'[A-Z][A-Z_]{2,47}', code) for code in stop_errors))
        report = self.diagnostic_backup(record, source)
        health = state.get('Health', {}).get('Log', [])
        failure_path = self.folder(record)/'failure.json'
        stage, http, readiness, market = None, None, None, None
        if failure_path.exists():
            failure = self.b.decode(self.b.read_trusted(failure_path))
            require(failure['id'] == record['id'] and failure['stage'] in DIAGNOSTIC_STAGES)
            stage = failure['stage']
            readiness = failure.get('readiness')
            http = failure.get('http_status')
            require(http is None or type(http) is int and 100 <= http <= 599)
            market = failure.get('market')
            if market is not None:
                require(type(market) is dict and set(market) == {'source', 'lastSuccessAt', 'reason'})
                require(market['source'] is None or type(market['source']) is str and
                        re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', market['source']))
                require(market['lastSuccessAt'] is None or type(market['lastSuccessAt']) in (int, float))
                require(market['reason'] is None or type(market['reason']) is str and
                        re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', market['reason']))
        preflight = None
        preflight_path = self.folder(record)/'preflight.json'
        if preflight_path.exists():
            value = self.b.decode(self.b.read_trusted(preflight_path))
            require(value['id'] == record['id'] and value['check'] in PREFLIGHT_CHECKS and
                    type(value['error']) is str and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', value['error']))
            detail = value.get('detail')
            require(detail is None or (value['check'] == 'container' and detail in CONTAINER_CHECKS))
            preflight = {'check': value['check'], 'error': value['error'], 'detail': detail}
        return {
            'run': {'id': record['id'], 'status': record['status'], 'duration': record.get('duration', '30m')},
            'stop': {'id': stop['id'], 'status': stop['status'], 'errors': stop_errors},
            'requires_review': self.faults(record),
            'diagnostics': {
                'exit_code': state['ExitCode'], 'oom_killed': state['OOMKilled'],
                'healthcheck_exit': health[-1]['ExitCode'] if health else None,
                'maintenance': maintenance, 'stage': stage, 'http_status': http, 'preflight': preflight,
                'backup_verified': report is not None,
                'deltas': report['deltas'] if report is not None else None, 'readiness': readiness,
                'market': market,
                'runtime': report['runtime'] if report is not None else None,
                'selected_pair': report['selected_pair'] if report is not None else None,
                'clean_lifecycle': clean_lifecycle,
                'host': self.diagnostic_host(i),
            },
        }

    def diagnostic_host(self, container):
        ledger = self.b.decode(self.b.read_trusted(self.b.STATE/'ledger.json'))
        require(type(ledger['sequence']) is int and self.b.SHA.fullmatch(ledger['sha']))
        failure = ledger.get('failure')
        if failure is not None:
            self.b.validate_failure_diagnostic(failure)
        known_states = ('in_progress', 'prepared_stopped', 'failed_stopped', 'failed_state_unknown')
        gate = self.b.decode(self.b.read_trusted(self.b.STATE/'paper-check.json'))
        timer = {'active': False, 'elapsed': False, 'next': False, 'job': False}
        for unit in cutoff_timers():
            try:
                raw = subprocess.check_output(['/usr/bin/systemctl', 'show', unit,
                    '-p', 'ActiveState', '-p', 'SubState', '-p', 'NextElapseUSecMonotonic',
                    '-p', 'NextElapseUSecRealtime', '-p', 'Job'],
                    timeout=10, env={'PATH': '/usr/bin:/bin'}, stderr=subprocess.DEVNULL).decode()
            except subprocess.CalledProcessError:
                continue  # A timer that is not installed cannot be armed.
            values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
            timer['active'] |= values.get('ActiveState') == 'active'
            timer['elapsed'] |= values.get('SubState') == 'elapsed'
            timer['next'] |= any(values.get(key) not in (None, '', '0', 'n/a', 'infinity')
                for key in ('NextElapseUSecMonotonic', 'NextElapseUSecRealtime'))
            timer['job'] |= values.get('Job') not in ('', '0')
        env = dict(value.split('=', 1) for value in container['Config']['Env'])
        # Per-item verdicts for the same checks run() gates admission
        # on, as booleans only: when a run dies at check=container,
        # this names the exact item without exposing any values.
        # Each item fails closed on its own errors so a malformed
        # field degrades one verdict instead of the whole diagnosis.
        def safe(fn):
            try:
                return bool(fn())
            except Exception:
                return False
        labels = container.get('Config', {}).get('Labels') or {}
        frozen_image = None
        transaction = ledger.get('transaction')
        if type(transaction) is str and len(transaction) == 32 and all(c in '0123456789abcdef' for c in transaction):
            with contextlib.suppress(Exception):
                frozen_image = self.b.decode(self.b.read_trusted(
                    self.b.STATE/transaction/'compose.json'))['services']['bot']['image']
        container_checks = {
            'state': safe(lambda: container['State']['Status'] in ('created', 'exited') and not container['State']['Running']
                          and container['State']['ExitCode'] == 0 and not container['State']['OOMKilled']),
            'restart_user': safe(lambda: container['HostConfig']['RestartPolicy']['Name'] == 'no' and container['Config']['User'] == '1000:1000'),
            'env': safe(lambda: env.get('MODE') == 'PAPER' and env.get('TRADING_PAIR') == 'SUI_USDC'
                        and env.get('PAPER_CHECK_MODE') == 'sui-30m' and env.get('MARKET_DATA_PROVIDER') in MARKET_SOURCES),
            'ports': safe(lambda: container['HostConfig']['PortBindings'] == {'3100/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3100'}]}),
            'memory': safe(lambda: container['HostConfig']['Memory'] == container['HostConfig']['MemorySwap'] == 1024**3),
            'label': safe(lambda: self.b.SHA.fullmatch(ledger['sha']) and labels.get('org.opencontainers.image.revision') == ledger['sha']),
            'image': safe(lambda: frozen_image is not None and container['Config']['Image'] == frozen_image),
        }
        return {
            'ledger_status': ledger['status'] if ledger['status'] in known_states else 'unknown',
            'broker_failure': failure,
            'sequence': ledger['sequence'], 'sha': ledger['sha'],
            'paper_gate': gate.get('status') if gate.get('status') in ('completed', 'in_progress') else 'unknown',
            'fault_marker': os.path.lexists(self.b.STATE/'paper-check-failed.json'),
            'container_status': container['State']['Status'],
            'container_checks': container_checks,
            'restart_disabled': container['HostConfig']['RestartPolicy']['Name'] == 'no',
            'paper': env.get('MODE') == 'PAPER',
            'timer_active': timer['active'],
            'timer_elapsed': timer['elapsed'],
            'timer_next_scheduled': timer['next'],
            'timer_job_pending': timer['job'],
            # The version hashes read whole program files; the
            # read_trusted default cap (64 KiB) is for state files
            # and the controller outgrew it in 2026-11, which made
            # diagnose itself fail with TRUSTED_FILE_TOO_LARGE.
            'controller_sha256': hashlib.sha256(self.b.read_trusted(Path(__file__), maximum=PROGRAM_READ_MAXIMUM)).hexdigest(),
            'broker_sha256': hashlib.sha256(self.b.read_trusted(Path(self.b.__file__), maximum=PROGRAM_READ_MAXIMUM)).hexdigest(),
        }

    def approve_deploy(self, run_id, sha):
        require(isinstance(run_id, str) and re.fullmatch(r'[a-f0-9]{32}', run_id))
        require(isinstance(sha, str) and self.b.SHA.fullmatch(sha))
        with self.b.regular(self.b.STATE/'lock') as lock:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.locked('stop'), self.locked('mutation'):
                self.quiescent()
                report = self.diagnose_locked()
                record = self.current(run_id)
                require(record['status'] == 'failed_requires_review')
                require(report['stop']['status'] == 'clean_stopped' and not report['requires_review'])
                require(report['diagnostics']['exit_code'] == 0 and not report['diagnostics']['oom_killed'])
                require(not (self.state/'abort-inhibit.json').exists())
                marker = self.b.decode(self.b.read_trusted(self.b.STATE/'paper-check.json'))
                require(marker == {'status': 'in_progress'})
                approval_path = self.b.POLICY/'approvals'/(sha+'.json')
                policy = self.b.decode(self.b.read_trusted(self.b.POLICY/'policy.json'))
                if policy.get('approval_source') == 'ci' and not os.path.lexists(approval_path):
                    # In CI mode the deploy's approval is the GitHub
                    # Environment approval bound to the CI run; no
                    # local approval file is ever placed. Materialize
                    # the minimal record the permit chain binds (sha,
                    # operation, expiry) so a reviewed deploy can be
                    # permitted. The one-hour window bounds how long
                    # the permit stays consumable.
                    self.b.atomic(approval_path, {'sha': sha, 'operation': 'deploy',
                                                  'expires': int(time.time()) + 3600})
                approval_bytes = self.b.read_trusted(approval_path)
                approval = self.b.decode(approval_bytes)
                require(approval['sha'] == sha and approval['operation'] == 'deploy')
                require(type(approval['expires']) is int and approval['expires'] > time.time())
                folder = self.folder(record)
                require(not os.path.lexists(folder/'retry-approved.json'))
                helper, image = self.helper()
                helper.helper(image, 'verify')
                self.verify_sui()
                permit = self.b.STATE/('paper-deploy-'+sha+'.json')
                consumed = permit.with_suffix('.consumed.json')
                require(not os.path.lexists(permit) and not os.path.lexists(consumed))
                self.b.atomic(folder/'reviewed-for-deploy.json', record)
                value = {
                    'id': run_id, 'sha': sha,
                    'approval_sha256': hashlib.sha256(approval_bytes).hexdigest(),
                    'run_sha256': hashlib.sha256(self.b.read_trusted(self.record)).hexdigest(),
                    'stop_sha256': hashlib.sha256(self.b.read_trusted(folder/'stop.json')).hexdigest(),
                }
                # Exclusive creation keeps the approval single-use even across crashes.
                fd = os.open(permit, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as out:
                    out.write(json.dumps(value).encode())
                    out.flush()
                    os.fsync(out.fileno())
                with self.b.directory(self.b.STATE) as directory_fd:
                    os.fsync(directory_fd)

    def approve_retry(self, run_id):
        # The root CLI's approval, shared with the approve-retry
        # request op: only a run that was admitted and then stopped
        # cleanly (stop receipt clean_stopped, no fault evidence,
        # diagnose fully readable) may be retried. Preflight deaths
        # end in failed_state_unknown instead and stay with the
        # reconcile path; this method refuses them through the
        # stop-receipt check.
        report = self.diagnose()
        run = report['run']
        require(run['id'] == run_id and run['status'] == 'failed_requires_review')
        require(report['stop']['status'] == 'clean_stopped' and not report['requires_review'])
        folder = self.folder(run)
        with self.locked('stop'), self.locked('mutation'):
            require(self.current()['id'] == run['id'])
            require(not os.path.lexists(folder/'retry-consumed.json'))
            require(not os.path.lexists(folder/'retry-approved.json'))
            self.b.atomic(folder/'retry-approved.json', {'id': run['id']})
        return {'approved': run['id']}

    def revoke_retry(self):
        # Withdraw an unused retry approval so the same run can be
        # reviewed for a deploy instead: the two approvals are
        # exclusive (approve_deploy refuses while a retry permit
        # exists). Only the current run's own unconsumed permit can
        # be withdrawn; a consumed one means a start already used it
        # and there is nothing left to withdraw.
        record = self.current()
        require(record['status'] == 'failed_requires_review')
        folder = self.folder(record)
        with self.locked('stop'), self.locked('mutation'):
            require(self.current()['id'] == record['id'])
            require(not os.path.lexists(folder/'retry-consumed.json'))
            permit = folder/'retry-approved.json'
            require(self.b.decode(self.b.read_trusted(permit)) == {'id': record['id']})
            permit.unlink()
        return {'revoked': record['id']}

    def release_cutoff(self):
        # A run that ends early leaves its cutoff timer armed as a
        # backstop, and the timer then blocks every quiescent-gated
        # approval until it fires (up to the full run length away).
        # Once the record is terminal and the services are out, the
        # timer has nothing left to stop, so it may be disarmed
        # early. Refuse while anything could still be live.
        record = self.current()
        require(record['status'] in ('completed', 'failed_requires_review'))
        require(self.exited(record))
        for unit in (SERVICE, CUTOFF):
            raw = subprocess.check_output(['/usr/bin/systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'Job'],
                                          timeout=5, env={'PATH': '/usr/bin:/bin'}, stderr=subprocess.DEVNULL).decode()
            values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
            require(values.get('ActiveState') in ('inactive', 'failed') and values.get('Job') in ('', '0'))
        released = []
        for unit in cutoff_timers():
            try:
                raw = subprocess.check_output(['/usr/bin/systemctl', 'show', unit, '-p', 'ActiveState'],
                                              timeout=5, env={'PATH': '/usr/bin:/bin'}, stderr=subprocess.DEVNULL).decode()
            except subprocess.CalledProcessError:
                continue  # A timer that is not installed cannot be armed.
            values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
            if values.get('ActiveState') == 'active':
                self.system('stop', unit)
                released.append(unit)
        return {'released': released, 'run': record['id']}

    def reconcile_preflight(self, mode, sha=None):
        # The reconcile-preflight.sh procedure as a controller
        # operation, so recovery runs through the approval-gated
        # workflows instead of a host terminal. The scope is the
        # same: only a run that died before admission with
        # PREFLIGHT_INCOMPLETE and every piece of evidence in its
        # expected place. Any mismatch refuses before any mutation.
        require(mode in ('retry', 'deploy'))
        if mode == 'deploy':
            require(type(sha) is str and self.b.SHA.fullmatch(sha))
        record = self.current()
        require(record['status'] == 'failed_requires_review')
        folder = self.folder(record)
        stop = self.b.decode(self.b.read_trusted(folder/'stop.json'))
        require(stop['id'] == record['id'] and stop['status'] == 'failed_state_unknown'
                and stop['errors'] == ['PREFLIGHT_INCOMPLETE'])
        state = self.inspect()['State']
        require(state['StartedAt'] == '0001-01-01T00:00:00Z' and not state['Running'] and state['ExitCode'] == 0)
        ledger = self.b.decode(self.b.read_trusted(self.b.STATE/'ledger.json'))
        require(ledger['status'] == 'prepared_stopped')
        volume = self.b.decode(self.docker.call(['volume', 'inspect', self.b.DATA], timeout=10))
        require(len(volume) == 1 and volume[0]['Name'] == self.b.DATA)
        require((Path(volume[0]['Mountpoint'])/'bot.sqlite.maintenance').is_file())
        raw = subprocess.check_output(['/usr/bin/systemctl', 'show', SERVICE, '-p', 'ActiveState', '-p', 'Job'],
                                      timeout=5, env={'PATH': '/usr/bin:/bin'}, stderr=subprocess.DEVNULL).decode()
        values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        require(values.get('ActiveState') in ('inactive', 'failed') and values.get('Job') in ('', '0'))
        self.quiescent()
        broker_latch = self.b.STATE/'paper-check-failed.json'
        require(os.path.lexists(broker_latch))
        # Evidence complete. Preserve it, move the fault markers
        # aside and heal the stop receipts to the clean state the
        # approval paths require.
        backup = RECONCILE_BACKUPS/('reconcile-' + time.strftime('%Y%m%d%H%M%S'))
        backup.mkdir(mode=0o700)
        shutil.copy2(self.record, backup/'run.json')
        shutil.copy2(folder/'stop.json', backup/'stop.json')
        if (self.state/'stop.json').exists():
            shutil.copy2(self.state/'stop.json', backup/'stop-root.json')
        os.replace(broker_latch, backup/'paper-check-failed.json')
        for fault in sorted(folder.glob('fault-*.json')):
            os.replace(fault, backup/fault.name)
        self.receipt(record, 'clean_stopped', [])
        if mode == 'deploy':
            self.approve_deploy(record['id'], sha)
            return {'reconciled': True, 'mode': 'deploy', 'backup': backup.name}
        report = self.diagnose()
        require(report['stop']['status'] == 'clean_stopped' and not report['requires_review'])
        with self.locked('stop'), self.locked('mutation'):
            require(self.current()['id'] == record['id'])
            require(not os.path.lexists(folder/'retry-consumed.json'))
            require(not os.path.lexists(folder/'retry-approved.json'))
            self.b.atomic(folder/'retry-approved.json', {'id': record['id']})
        return {'reconciled': True, 'mode': 'retry', 'backup': backup.name}

    def diagnostic_backup(self, record, source):
        backup = record.get('backup')
        if backup is None:
            # The run ended before its backup stage, so there is no
            # pre-run snapshot to verify or diff against. Report that
            # honestly (the caller maps None to backup_verified=False)
            # instead of failing the whole diagnosis with a KeyError.
            return None
        require(re.fullmatch(r'paper-check-[0-9a-f]{32}\.tar', backup['file']))
        require(self.b.HEX.fullmatch(backup['sha256']))
        deadline = time.monotonic()+45
        with tempfile.TemporaryDirectory(prefix='suiba-diagnostics-', dir=self.state) as tmp:
            before, after = Path(tmp)/'before', Path(tmp)/'after'
            before.mkdir()
            after.mkdir()
            with self.b.regular(self.b.BACKUPS/backup['file']) as fd:
                require(0 < os.fstat(fd).st_size <= DIAGNOSTIC_LIMIT)
                with os.fdopen(os.dup(fd), 'rb') as stream:
                    require(hashlib.file_digest(stream, 'sha256').hexdigest() == backup['sha256'])
                    stream.seek(0)
                    with tarfile.open(fileobj=stream, mode='r:') as archive:
                        for index, member in enumerate(archive):
                            require(index < 4096 and time.monotonic() < deadline)
                            name = member.name.removeprefix('./')
                            if name in DIAGNOSTIC_FILES:
                                require(member.isfile() and 0 <= member.size <= DIAGNOSTIC_LIMIT)
                                with archive.extractfile(member) as data, (before/name).open('xb') as out:
                                    shutil.copyfileobj(data, out)
            total = 0
            for name in sorted(DIAGNOSTIC_FILES):
                require(time.monotonic() < deadline)
                try:
                    fd = os.open(source/name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                except FileNotFoundError:
                    continue
                with os.fdopen(fd, 'rb') as data:
                    info = os.fstat(data.fileno())
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 1000)
                    total += info.st_size
                    require(total <= DIAGNOSTIC_LIMIT)
                    with (after/name).open('xb') as out:
                        shutil.copyfileobj(data, out)
            for directory in (before, after):
                directory.chmod(0o700)
                for path in directory.iterdir():
                    os.chown(path, 1000, 1000)
                os.chown(directory, 1000, 1000)
            os.chown(tmp, 1000, 1000)
            _, image = self.helper()
            name = 'suiba-paper-diagnostic-'+uuid.uuid4().hex
            try:
                raw = self.docker.call([
                    'run', '--rm', '--name', name, '--pull', 'never', '--network', 'none',
                    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                    '--user', '1000:1000', '--memory', '128m', '--memory-swap', '128m',
                    '--pids-limit', '32', '--mount', 'type=bind,src='+tmp+',dst=/audit',
                    '--entrypoint', '/usr/local/bin/node', image, '-e', DIAGNOSTIC_QUERY,
                ], timeout=15)
            except Exception:
                with contextlib.suppress(Exception):
                    self.docker.call(['rm', '-f', name], timeout=5)
                raise
            require(len(raw) <= 4096)
            audit = self.b.decode(raw)
            counts = audit['deltas']
            result = {}
            for pair, name in zip(('SUI_USDC', 'WAL_USDC'), DIAGNOSTIC_DATABASES):
                values = counts[name]
                require(len(values) == 3 and all(type(v) is int for v in values))
                state = audit['runtime'][name]
                require(set(state) == {'running', 'emergency', 'error', 'before_error'})
                require(type(state['running']) is bool and type(state['emergency']) is bool)
                require(all(state[key] is None or state[key] in RUNTIME_ERROR_CODES for key in ('error', 'before_error')))
                result[pair] = dict(zip(('starts', 'orders', 'fills'), values))
            require(audit['selected_pair'] in ('SUI_USDC', 'WAL_USDC', 'UNKNOWN'))
            return {'deltas': result, 'runtime': {pair: audit['runtime'][name]
                    for pair, name in zip(('SUI_USDC', 'WAL_USDC'), DIAGNOSTIC_DATABASES)},
                    'selected_pair': audit['selected_pair']}

    def api(self, method, path, value=None):
        require(path in ('/api/deployment', '/api/pairs', '/api/control', '/api/paper-check/arm', '/api/dashboard/summary'))
        # Credentials stay in the root process and request header, never argv/logs.
        with self.b.regular(self.b.TOKEN, 1000) as fd:
            token = os.read(fd, 1024).decode().strip()
        require(len(token) == 64)
        req = urllib.request.Request('http://127.0.0.1:3100'+path,
              data=json.dumps(value).encode() if value is not None else None,
              headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'}, method=method)
        # Ignore proxy environment; do not follow redirects with credentials.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(req, timeout=5) as response:
            require(response.status == 200)
            raw = response.read(1048577)
            require(len(raw) <= 1048576)
            return self.b.decode(raw)

    def helper(self):
        policy = self.b.decode(self.b.read_trusted(self.b.POLICY/'policy.json'))
        require(self.b.DIGEST.fullmatch(policy['helper_image']))
        helper = self.b.Broker(docker=self.docker)
        helper.transaction_id = uuid.uuid4().hex
        helper.helper_unknown = False
        return helper, policy['helper_image']

    def maintenance(self, enabled):
        if enabled:
            self.retire_release_helper()
            helper, image = self.helper()
            helper.helper(image, 'maintenance')
        else:
            # Exactly one fixed offline latch. No generic shell or path argument.
            helper, image = self.helper()
            name = 'suiba-paper-unlatch-'+uuid.uuid4().hex
            # Persist BEFORE Docker mutation. Create is separate from start:
            # a delayed create cannot execute code after cleanup.
            self.b.atomic(self.state/'release-helper.json', {'id': self.current()['id'], 'name': name, 'retired': False})
            try:
                self.docker.call(['create', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--user', '1000:1000',
                '--memory', '128m', '--memory-swap', '128m', '--pids-limit', '32',
                '-v', self.b.DATA+':/app/data', '--entrypoint', '/usr/local/bin/node', image,
                '-e', 'const f=require("fs"),p="/app/data/bot.sqlite.maintenance";const s=f.lstatSync(p);if(!s.isFile()||s.nlink!==1)throw Error("UNSAFE_LATCH");f.unlinkSync(p);const d=f.openSync("/app/data","r");f.fsyncSync(d);f.closeSync(d)'], timeout=20)
                self.docker.call(['start', '-a', name], timeout=20)
                state = self.b.decode(self.docker.call(['inspect', name], timeout=10))[0]['State']
                require(not state['Running'] and state['ExitCode'] == 0 and not state['OOMKilled'])
            finally:
                self.retire_release_helper()

    def retire_release_helper(self):
        path = self.state/'release-helper.json'
        if not path.exists():
            return
        record = self.b.decode(self.b.read_trusted(path))
        name = record['name']
        require(isinstance(name, str) and name.startswith('suiba-paper-unlatch-') and
                len(name) == len('suiba-paper-unlatch-')+32 and
                all(c in '0123456789abcdef' for c in name[-32:]))
        if record.get('retired') is True:
            return
        require(record['id'] == self.current()['id'])
        # A successful deletion, not just CLI termination, is required.
        self.docker.call(['rm', '-f', name], timeout=10)
        require(not self.docker.call(['ps', '-aq', '--no-trunc', '--filter', 'name=^/'+name+'$'], timeout=10))
        self.b.atomic(path, {'id': record['id'], 'name': name, 'retired': True})

    def verify_sui(self):
        helper, image = self.helper()
        # Fixed read-only SQL; existing verify still checks all DBs/clean receipt.
        self.docker.call(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--memory', '128m',
            '--memory-swap', '128m', '--pids-limit', '32', '-v', self.b.DATA+':/app/data',
            '--entrypoint', '/usr/local/bin/node', image, '-e',
            'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/app/data/bot.sqlite.pairs.sqlite",{readOnly:true});try{const r=d.prepare("SELECT json FROM bot_runtime_state WHERE key=?").get("selected_pair");if(!r||JSON.parse(r.json)!=="SUI_USDC")throw Error("SUI_SELECTION_REQUIRED")}finally{d.close()}'], timeout=20)

    def wait_ready(self, cutoff):
        self.readiness = {}
        deadline = time.monotonic()+60
        while True:
            require(time.monotonic() < deadline and time.time()*1000 < cutoff)
            i = self.inspect()
            require(i['State']['Running'] and not i['State']['OOMKilled'] and i['RestartCount'] == 0)
            health = i['State'].get('Health', {}).get('Status')
            self.readiness = {'health': health if health in ('starting', 'healthy', 'unhealthy') else 'unknown'}
            require(health in ('starting', 'healthy'))
            if health == 'healthy':
                try:
                    d = self.api('GET', '/api/deployment')
                    checks = d.get('readiness')
                    if isinstance(checks, dict):
                        self.readiness.update({key: checks[key] for key in (
                            'connectivity', 'apiAccess', 'emergencyClear', 'runtimeClear',
                            'suiHealthy', 'suiFresh', 'ledger') if type(checks.get(key)) is bool})
                    if d.get('startReady') is True:
                        return d
                except urllib.error.URLError as error:
                    if isinstance(error, urllib.error.HTTPError) or not isinstance(error.reason, ConnectionRefusedError):
                        raise
            time.sleep(1)

    def wait_market_fresh(self, market, cutoff):
        # The first GeckoTerminal success after a cold worker start
        # can land seconds after readiness opens, so the previous
        # single-shot check raced it: two runs stopped cleanly at
        # this stage on 2026-11-06 with no success recorded yet
        # (lastSuccessAt still None). Poll on the monitoring cadence
        # for up to two minutes; a feed still stale after that is a
        # real failure, not a race. A None lastSuccessAt means "no
        # success yet" and keeps waiting instead of erroring.
        deadline = time.monotonic()+120
        while True:
            self.note_market(market)
            last = market['lastSuccessAt']
            if market['source'] == getattr(self, 'expected_source', 'GeckoTerminal') and type(last) in (int, float) and 0 <= time.time()*1000-last <= 90000:
                return
            require(time.monotonic() < deadline and time.time()*1000 < cutoff)
            time.sleep(5)
            market = self.api('GET', '/api/dashboard/summary')['summary']['marketData']

    def note_market(self, market):
        # Whitelisted failure evidence, mirroring how wait_ready
        # filters readiness: if a freshness check later fails, the
        # failure record shows what the controller last saw — the
        # provider, the last success time and a code-shaped reason —
        # so "never fetched" and "fetch failing" are distinguishable
        # from one diagnostics report. Anything else is dropped.
        reason = market.get('reason')
        source = market.get('source')
        last = market.get('lastSuccessAt')
        self.market = {
            'source': source if type(source) is str and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', source) else None,
            'lastSuccessAt': last if type(last) in (int, float) else None,
            'reason': reason if type(reason) is str and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', reason) else None,
        }

    def backup(self):
        helper, image = self.helper()
        helper.helper(image, 'maintenance')
        helper.helper(image, 'verify')
        scratch = 'suiba-paper-check-'+uuid.uuid4().hex
        self.docker.call(['volume', 'create', scratch])
        path = self.b.BACKUPS/('paper-check-'+uuid.uuid4().hex+'.tar')
        try:
            with open(path, 'xb') as out:
                os.chmod(path, 0o600)
                helper.helper(image, 'backup', scratch, out)
                out.flush()
                os.fsync(out.fileno())
            require(path.stat().st_size > 0)
            digest = hashlib.sha256()
            with open(path, 'rb') as src:
                for block in iter(lambda: src.read(1048576), b''):
                    digest.update(block)
            return {'file': path.name, 'sha256': digest.hexdigest()}
        finally:
            # Only this run's new disposable rehearsal volume, never DB/backup.
            with contextlib.suppress(Exception):
                self.docker.call(['volume', 'rm', scratch])

    def stop(self, own=False, expected=None, source='external'):
        if not self.record.exists(): return True
        record = self.current(expected)
        if record['status'] == 'completed': return not self.faults(record)
        expected = record['id']
        try:
            with self.locked('stop', wait=60):
                record = self.current(expected)  # stale callers may not signal/write a newer run
                if record['status'] == 'completed': return not self.faults(record)
                self.accept_stop(record, source)
                if not own:
                    try:
                        require(self.terminate(record))
                    except Exception:
                        self.fault(record, 'CONTROLLER_EXIT_UNCONFIRMED')
                else:
                    require(record['controller']['pid'] == os.getpid())
                try:
                    with self.locked('mutation', wait=2):
                        record = self.current(expected)
                        return self.cleanup(record, own, source)
                except Exception:
                    self.fault(record, 'CLEANUP_LOCK_OR_STATE_UNKNOWN')
                    # Still attempt the fixed API/Docker stop, but never touch
                    # DB/latch or report success while a mutation may be alive.
                    errors = self.stop_worker() if record.get('admitted') else []
                    self.receipt(record, 'failed_state_unknown', ['CLEANUP_LOCK_OR_STATE_UNKNOWN', *errors])
                    return False
        except Exception:
            # Do not overwrite another run or race the stop-lock holder's receipt.
            if self.current()['id'] == expected:
                self.intent(record, source)
                self.fault(record, 'STOP_LOCK_OR_STATE_UNKNOWN')
            return False

    def receipt(self, record, status, errors):
        self.current(record['id'])
        value = {'id': record['id'], 'status': status, 'errors': errors, 'at': int(time.time())}
        self.b.atomic(self.folder(record)/'stop.json', value)
        self.b.atomic(self.state/'stop.json', value)

    def stop_checks(self, record, own):
        self.receipt(record, 'stopping_state_unknown', [])
        errors = []
        if record.get('admitted'):
            errors.extend(self.stop_worker())
            try:
                state = self.inspect()['State']
                require(not state['Running'] and state['ExitCode'] == 0 and not state['OOMKilled'])
            except Exception: errors.append('UNCLEAN_OR_UNKNOWN')
            try:
                self.maintenance(True)
                helper, image = self.helper()
                helper.helper(image, 'verify')
                self.verify_sui()
            except Exception: errors.append('DB_OR_MAINTENANCE_UNCONFIRMED')
        else:
            errors.append('PREFLIGHT_INCOMPLETE')
        pending_path = self.folder(record)/'mutation.json'
        if pending_path.exists() and self.b.decode(self.b.read_trusted(pending_path))['pending'] is not None:
            errors.append('OPERATION_COMPLETION_UNCONFIRMED')
        if self.faults(record): errors.append('LATCHED_FAILURE')
        if not own and not self.exited(record): errors.append('CONTROLLER_ALIVE')
        for error in errors: self.fault(record, error)
        self.receipt(record, 'failed_state_unknown' if errors else
                     'worker_stopped_pending_controller_exit' if own else 'clean_stopped', errors)
        return errors

    def cleanup(self, record, own, source):
        errors = self.stop_checks(record, own)
        if not own:
            # Only normal completion + post-stop may release the deployment gate.
            completed = not errors and record['status'] == 'finishing' and source == 'post-stop'
            if completed:
                try: self.quiescent()
                except Exception:
                    completed = False
                    self.fault(record, 'OLD_CUTOFF_UNCONFIRMED')
                    self.receipt(record, 'failed_state_unknown', ['OLD_CUTOFF_UNCONFIRMED'])
            record['status'] = 'completed' if completed else 'failed_requires_review'
            self.b.atomic(self.record, record)
            if completed: self.b.atomic(self.b.STATE/'paper-check.json', {'status': 'completed'})
        return not errors and not self.faults(record)

    def stop_worker(self):
        errors = []
        with contextlib.suppress(Exception): self.api('POST', '/api/control', {'command': 'stop'})
        try: self.docker.call(['update', '--restart=no', CONTAINER], timeout=10)
        except Exception: errors.append('RESTART_UNCONFIRMED')
        try: self.docker.call(['stop', '--timeout', '40', CONTAINER], timeout=50)
        except Exception:
            errors.append('NORMAL_STOP_FAILED')
            try: self.docker.call(['kill', CONTAINER], timeout=10)
            except Exception: errors.append('STOP_UNKNOWN')
        return errors

    def consume_retry(self, record, permit):
        consumed = permit.with_name('retry-consumed.json')
        require(not os.path.lexists(consumed))
        require(self.b.decode(self.b.read_trusted(permit)) == {'id': record['id']})
        self.b.atomic(permit.with_name('failed-run.json'), record)
        os.rename(permit, consumed)
        with self.b.directory(permit.parent) as directory_fd:
            os.fsync(directory_fd)

    def note_start_request(self, duration):
        # The fixed systemd unit cannot receive the length, so the request
        # entrypoint leaves it as a root-owned note for the next run only.
        require(duration in DURATIONS)
        self.b.atomic(self.state/'start-request.json',
                      {'duration': duration, 'at': int(time.time()*1000)})

    def take_start_request(self):
        path = self.state/'start-request.json'
        if not os.path.lexists(path):
            return '30m'
        # Consume before validating, under a preserved name: a stale or
        # malformed note must never leak into a later run, and the last
        # request stays on disk as evidence either way.
        consumed = path.with_name('start-request-consumed.json')
        os.rename(path, consumed)
        with self.b.directory(self.state) as directory_fd:
            os.fsync(directory_fd)
        request = self.b.decode(self.b.read_trusted(consumed))
        require(set(request) == {'duration', 'at'} and request['duration'] in DURATIONS and
                type(request['at']) is int)
        now = int(time.time()*1000)
        require(request['at'] <= now+60000)
        if now-request['at'] > 600000:
            return '30m'
        return request['duration']

    def admit_session(self):
        config = self.b.decode(self.b.read_trusted(POLICY))
        require(config == {'enabled': True, 'mode': 'sui-30m'})
        with self.locked('stop'), self.locked('mutation'):
            duration = self.take_start_request()
            timer = cutoff_timer(duration)
            require(not (self.state/'abort-inhibit.json').exists())
            self.quiescent()
            permit = None
            if self.record.exists():
                old = self.current()
                if old['status'] == 'failed_requires_review':
                    require(not os.path.lexists(self.b.STATE/'paper-check-failed.json'))
                    marker = self.b.decode(self.b.read_trusted(self.b.STATE/'paper-check.json'))
                    require(marker == {'status': 'in_progress'})
                    permit = self.folder(old)/'retry-approved.json'
                    require(not os.path.lexists(permit.with_name('retry-consumed.json')))
                    require(self.b.decode(self.b.read_trusted(permit)) == {'id': old['id']})
                else:
                    require(old['status'] == 'completed')
                require(self.exited(old))
                previous = self.b.decode(self.b.read_trusted(self.folder(old)/'stop.json'))
                require(previous['id'] == old['id'] and previous['status'] == 'clean_stopped' and not self.faults(old))
            if permit is None:
                self.b.Broker(state=self.b.STATE).check_paper_session()
            else:
                self.consume_retry(old, permit)
            now = int(time.time()*1000)
            self.run_id = uuid.uuid4().hex
            (self.state/self.run_id).mkdir(mode=0o700)
            identity, _ = self.identity(os.getpid())
            record = {'status': 'in_progress', 'id': self.run_id, 'controller': identity, 'admitted': False,
                      'started': now, 'cutoff': now+DURATIONS[duration]*1000, 'duration': duration}
            self.b.atomic(self.b.STATE/'paper-check.json', {'status': 'in_progress'})
            self.b.atomic(self.record, record)
        return record, duration, timer

    def preflight(self, record):
        # A death in this pre-admission window used to leave only
        # PREFLIGHT_INCOMPLETE in the stop receipt, with no hint of
        # which check died. Record the check and the exception
        # class (never the message) in the run folder, then let
        # the failure propagate exactly as before.
        check = 'storage'
        detail = None
        try:
            space = os.statvfs(self.b.BACKUPS)
            require(space.f_bavail*space.f_frsize >= 20*1024**3 and space.f_favail >= 100000)
            check = 'ledger'
            ledger = self.b.decode(self.b.read_trusted(self.b.STATE/'ledger.json'))
            require(ledger['status'] == 'prepared_stopped')
            check = 'container'
            detail = 'inspect'
            i = self.inspect()
            detail = 'state'
            require(i['State']['Status'] in ('created', 'exited') and not i['State']['Running'] and
                    i['State']['ExitCode'] == 0 and not i['State']['OOMKilled'])
            detail = 'restart_user'
            require(i['HostConfig']['RestartPolicy']['Name'] == 'no' and i['Config']['User'] == '1000:1000')
            detail = 'env'
            env = dict(v.split('=', 1) for v in i['Config']['Env'])
            require(env.get('MODE') == 'PAPER' and env.get('TRADING_PAIR') == 'SUI_USDC' and
                    env.get('PAPER_CHECK_MODE') == self.session_mode and env.get('MARKET_DATA_PROVIDER') in MARKET_SOURCES)
            self.expected_source = MARKET_SOURCES[env['MARKET_DATA_PROVIDER']]
            detail = 'ports'
            require(i['HostConfig']['PortBindings'] == {'3100/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3100'}]})
            detail = 'memory'
            require(i['HostConfig']['Memory'] == i['HostConfig']['MemorySwap'] == 1024**3)
            detail = 'label'
            require(self.b.SHA.fullmatch(ledger['sha']) and
                    i['Config']['Labels'].get('org.opencontainers.image.revision') == ledger['sha'])
            detail = 'transaction'
            require(len(ledger['transaction']) == 32 and all(c in '0123456789abcdef' for c in ledger['transaction']))
            detail = 'image'
            frozen = self.b.decode(self.b.read_trusted(self.b.STATE/ledger['transaction']/'compose.json'))
            require(i['Config']['Image'] == frozen['services']['bot']['image'])
            detail = None
            check = 'admission'
            with self.locked('mutation'):
                require(not (self.folder(record)/'stop-request.json').exists())
                record['admitted'] = True
                self.b.atomic(self.record, record)
        except BaseException as error:
            self.record_preflight(record, check, error, detail)
            raise
        return ledger

    def monitor_once(self, timer):
        if timer is None:
            self.quiescent()
        else:
            self.system('is-active', '--quiet', timer)
        d = self.api('GET', '/api/deployment')
        require(d['mode'] == 'PAPER' and d['running'] and d['databaseHealthy'] and d['ledgerOk'])
        require(self.api('GET', '/api/pairs')['selected'] == 'SUI_USDC')
        market = self.api('GET', '/api/dashboard/summary')['summary']['marketData']
        self.note_market(market)
        require(market['source'] == self.expected_source and 0 <= time.time()*1000-market['lastSuccessAt'] <= 90000)
        i = self.inspect()
        require(i['State']['Running'] and not i['State']['OOMKilled'] and i['RestartCount'] == 0)
        require(i['State'].get('Health', {}).get('Status') == 'healthy')
        stats = self.b.decode(self.docker.call(['stats', '--no-stream', '--format', '{{json .}}', CONTAINER], timeout=10))
        memory_percent = float(stats['MemPerc'].rstrip('%'))
        require(0 <= memory_percent < 90)
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        available_kib = int(memory['MemAvailable'].split()[0])
        require(available_kib >= 256*1024)
        space = os.statvfs(self.b.BACKUPS)
        require(space.f_bavail*space.f_frsize >= 20*1024**3)
        # Evidence contains no headers/token/API bodies.
        self.b.atomic(self.state/'progress.json', {'at': int(time.time()), 'status': 'monitoring', 'pair': 'SUI_USDC',
                                                 'memory_percent': memory_percent, 'host_available_kib': available_kib,
                                                 'market_last_success': market['lastSuccessAt']})

    @contextlib.contextmanager
    def deployment_lock(self):
        import fcntl
        # Same lock inode as deployment. Never unlink it.
        with self.b.directory(self.b.STATE):
            pass
        fd = os.open(self.b.STATE/'lock', os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600)
        try:
            import stat
            s = os.fstat(fd)
            require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1 and not s.st_mode & 0o077)
            fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
            self._deployment_locked = True
            yield
        finally:
            self._deployment_locked = False
            os.close(fd)

    def run(self):
        with self.deployment_lock():
            record, duration, timer = self.admit_session()
            ledger = self.preflight(record)
            if timer is not None:
                self.guard('timer', lambda: self.system('start', timer))
                self.system('is-active', '--quiet', timer)
            backup = self.guard('backup', self.backup)
            with self.locked('mutation'):
                require(self.current(self.run_id)['status'] == 'in_progress' and
                        not (self.folder(record)/'stop-request.json').exists())
                record['backup'] = backup
                self.b.atomic(self.record, record)
            stage = 'maintenance-release'
            self.note_stage(stage)
            try:
                self.guard('unlatch', lambda: self.maintenance(False))
                stage = 'worker-start'
                self.note_stage(stage)
                self.guard('worker-start', lambda: self.docker.call(['start', CONTAINER], timeout=20))
                # Readiness GETs only. Never retry a start/arm/order/reset action.
                stage = 'worker-readiness'
                self.note_stage(stage)
                d = self.wait_ready(self.session_cutoff(record))
                stage = 'deployment-state'
                self.note_stage(stage)
                require(d['mode'] == 'PAPER' and not d['running'] and not d['maintenance'] and
                        d['databaseHealthy'] and d['ledgerOk'] and d['paperCheck']['enabled'] and not d['paperCheck']['armed'])
                stage = 'pair-selection'
                self.note_stage(stage)
                require(self.api('GET', '/api/pairs')['selected'] == 'SUI_USDC')
                stage = 'market-summary'
                self.note_stage(stage)
                market = self.api('GET', '/api/dashboard/summary')['summary']['marketData']
                stage = 'market-freshness'
                self.note_stage(stage)
                self.wait_market_fresh(market, self.session_cutoff(record))
                # Existing start guards check connectivity/accounting/market state.
                stage = 'arm'
                self.note_stage(stage)
                armed = self.guard('arm', lambda: self.api('POST', '/api/paper-check/arm',
                                 self.arm_request(record)))
                require(armed['expires'] == self.arm_expiry(record) and armed['armed'] and not armed['expired'])
                stage = 'paper-start'
                self.note_stage(stage)
                started = self.guard('paper-start', lambda: self.api('POST', '/api/control', {'command': 'start'}))
                require(started['running'] is True)
                stage = 'monitoring'
                self.note_stage(stage)
                end = time.monotonic()+DURATIONS[duration] if timer is not None else None
                while timer is None or (time.monotonic() < end and time.time()*1000 < record['cutoff']-5000):
                    self.monitor_once(timer)
                    time.sleep(5)
                stage = 'normal-stop'
                self.note_stage(stage)
                require(self.stop(own=True, expected=self.run_id, source='normal'))
                self.system('stop', timer)
                with self.locked('stop'), self.locked('mutation'):
                    record = self.current(self.run_id)
                    require(record['status'] == 'in_progress' and not self.faults(record))
                    require(self.b.decode(self.b.read_trusted(self.folder(record)/'stop-request.json'))['source'] == 'normal')
                    record['status'] = 'finishing'
                    self.b.atomic(self.record, record)
                # ExecStopPost confirms this process actually exited, then alone
                # publishes clean_stopped/completed and releases deployment gate.
            except BaseException as error:
                # Never log exception text, HTTP bodies, headers, or argv.
                detail = ''
                if isinstance(error, urllib.error.HTTPError) and type(error.code) is int and 100 <= error.code <= 599:
                    detail = f' http_status={error.code}'
                with contextlib.suppress(Exception):
                    failure = {'id': self.run_id, 'stage': stage}
                    if detail:
                        failure['http_status'] = error.code
                    if stage == 'worker-readiness':
                        failure['readiness'] = getattr(self, 'readiness', {})
                    if stage in ('market-freshness', 'monitoring') and getattr(self, 'market', None) is not None:
                        failure['market'] = self.market
                    self.b.atomic(self.folder(self.current(self.run_id))/'failure.json', failure)
                print(f'PAPER_CHECK_STAGE_FAILED stage={stage}{detail}', file=sys.stderr, flush=True)
                self.stop(own=True, expected=self.run_id, source='failure')
                raise


class ProductionController(Controller):
    """Same lifecycle machinery, separate policy and durable evidence.

    The service/wrapper are deliberately shipped in the next implementation
    stage. No Docker restart or detached child is used to launch this runner.
    """
    session_mode = 'sui-prod'

    def __init__(self, broker, state=STATE):
        self.validation_state = Path(state)
        with broker.directory(self.validation_state):
            pass
        self.b = broker
        self.state = self.validation_state/'production'
        self.record = self.state/'prod.json'
        self.docker = broker.Docker(self.state)

    def prepare_state(self):
        self.state.mkdir(mode=0o700, exist_ok=True)
        with self.b.directory(self.state):
            pass

    def enabled(self):
        config = self.b.decode(self.b.read_trusted(PROD_POLICY))
        require(config == {'enabled': True} and config['enabled'] is True)

    def session_cutoff(self, record):
        # Only a process-local comparison bound. Never persist Infinity or
        # invent a cutoff that could accidentally arm a validation timer.
        require('cutoff' not in record)
        return float('inf')

    def current(self, expected=None):
        record = super().current(expected)
        require(record.get('mode') == self.session_mode and 'cutoff' not in record and
                record.get('status') in ('in_progress', 'completed', 'failed_requires_review') and
                record.get('stage') in ('preflight', 'backup', 'stopped', *DIAGNOSTIC_STAGES) and
                type(record.get('started')) is int and record['started'] >= 0 and
                ('stopped' not in record or type(record['stopped']) is int and record['stopped'] >= record['started']) and
                type(record.get('admitted')) is bool and
                (record.get('sha') is None or isinstance(record['sha'], str) and self.b.SHA.fullmatch(record['sha'])))
        return record

    def fault(self, record, code):
        self.b.atomic(self.state/'failed.json', {'id': record['id'], 'status': 'manual_reconciliation_required'})
        self.b.atomic(self.folder(record)/('fault-'+uuid.uuid4().hex+'.json'), {'id': record['id'], 'error': code})

    def faults(self, record):
        return os.path.lexists(self.state/'failed.json') or any(self.folder(record).glob('fault-*.json'))

    def validation_closed(self):
        # Never consume a validation retry/deploy permission on this path.
        validation = Controller(self.b, self.validation_state)
        if validation.record.exists():
            old = validation.current()
            require(old['status'] == 'completed' and validation.exited(old) and not validation.faults(old))
            receipt = self.b.decode(self.b.read_trusted(validation.folder(old)/'stop.json'))
            require(receipt['id'] == old['id'] and receipt['status'] == 'clean_stopped')
        require(not os.path.lexists(self.validation_state/'abort-inhibit.json'))
        self.b.Broker(state=self.b.STATE).check_paper_session()

    def admit_session(self):
        self.enabled()
        with self.locked('stop'), self.locked('mutation'):
            require(not os.path.lexists(self.state/'abort-inhibit.json') and not os.path.lexists(self.state/'failed.json'))
            self.quiescent()
            self.validation_closed()
            if self.record.exists():
                old = self.current()
                require(old['status'] == 'completed' and self.exited(old) and not self.faults(old))
                receipt = self.b.decode(self.b.read_trusted(self.folder(old)/'stop.json'))
                require(receipt['id'] == old['id'] and receipt['status'] == 'clean_stopped')
            # Consume the explicit request under the same stop mutex as record
            # publication. prod-stop can cancel a queued service even when an
            # older completed record exists; a delayed runner cannot restart it.
            self.consume_start()
            self.run_id = uuid.uuid4().hex
            (self.state/self.run_id).mkdir(mode=0o700)
            identity, _ = self.identity(os.getpid())
            record = {'status': 'in_progress', 'mode': self.session_mode, 'id': self.run_id,
                      'controller': identity, 'admitted': False, 'started': int(time.time()*1000),
                      'sha': None, 'stage': 'preflight'}
            self.b.atomic(self.record, record)
        return record, None, None

    def preflight(self, record):
        ledger = super().preflight(record)
        with self.locked('mutation'):
            require(self.current(self.run_id)['status'] == 'in_progress' and
                    not (self.folder(record)/'stop-request.json').exists())
            record.update(sha=ledger['sha'], stage='backup')
            self.b.atomic(self.record, record)
        return ledger

    def note_stage(self, stage):
        require(stage in DIAGNOSTIC_STAGES)
        record = self.current(self.run_id)
        record['stage'] = stage
        self.b.atomic(self.record, record)

    def arm_request(self, record):
        return {'issuedAt': int(time.time()*1000)}

    def arm_expiry(self, record):
        return None

    def note_start(self):
        self.b.atomic(self.state/'start-request.json', {'at': int(time.time()*1000)})

    def consume_start(self, cancelled=False):
        path = self.state/'start-request.json'
        if cancelled and not os.path.lexists(path):
            return
        target = self.state/('start-request-cancelled.json' if cancelled else 'start-request-consumed.json')
        os.replace(path, target)
        with self.b.directory(self.state) as fd:
            os.fsync(fd)
        if not cancelled:
            request = self.b.decode(self.b.read_trusted(target))
            require(set(request) == {'at'} and type(request['at']) is int and
                    -2000 <= int(time.time()*1000)-request['at'] <= 600000)

    def cleanup(self, record, own, source):
        lock = contextlib.nullcontext() if getattr(self, '_deployment_locked', False) else self.deployment_lock()
        with lock:
            errors = self.stop_checks(record, own)
            intent = self.b.decode(self.b.read_trusted(self.folder(record)/'stop-request.json'))
            # Only explicit prod-stop can complete a production session. A crash,
            # post-stop hook, readiness failure or monitor failure never counts.
            completed = not own and not errors and not self.faults(record) and intent['source'] == 'prod-stop'
            record['status'] = 'completed' if completed else 'failed_requires_review'
            if not own:
                record['stopped'] = int(time.time()*1000)
            if completed:
                record['stage'] = 'stopped'
            self.b.atomic(self.record, record)
            return not errors and not self.faults(record)

    def run(self):
        self.prepare_state()
        try:
            super().run()
        except BaseException as error:
            # Include preflight/backup/persistence failures, which the
            # validation service delegates to its existing post-stop hook.
            if getattr(self, 'run_id', None) and self.record.exists():
                record = self.current(self.run_id)
                with contextlib.suppress(Exception):
                    failure = self.folder(record)/'failure.json'
                    if not failure.exists():
                        self.b.atomic(failure, {'id': record['id'], 'stage': record['stage'], 'error': type(error).__name__})
                if not (self.folder(record)/'stop.json').exists():
                    self.stop(own=True, expected=self.run_id, source='failure')
            elif getattr(self, 'run_id', None):
                self.b.atomic(self.state/'failed.json', {'id': self.run_id, 'status': 'manual_reconciliation_required'})
            raise

    def prod_start(self):
        self.enabled()
        self.prepare_state()
        with self.locked('stop'), self.locked('mutation'):
            require(not os.path.lexists(self.state/'abort-inhibit.json') and not os.path.lexists(self.state/'failed.json'))
            if self.record.exists():
                record = self.current()
                require(record['status'] == 'completed' and self.exited(record) and not self.faults(record))
            self.quiescent()
            self.validation_closed()
            self.note_start()
            self.system('start', '--no-block', PROD_SERVICE)
        return {'status': 'accepted'}

    def prod_stop(self):
        self.prepare_state()
        with self.locked('stop'):
            self.consume_start(cancelled=True)
            if not self.record.exists():
                with contextlib.suppress(Exception):
                    self.system('stop', '--no-block', PROD_SERVICE)
                return {'status': 'not_started'}
            record = self.current()
            if record['status'] != 'completed':
                self.accept_stop(record, 'prod-stop')
            with contextlib.suppress(Exception):
                self.system('stop', '--no-block', PROD_SERVICE)
        require(self.stop(expected=record['id'], source='prod-stop'))
        return {'status': self.current(record['id'])['status']}

    def watchdog_status(self):
        # Fixed root-trusted path only. No imports from the checker and no writes.
        # A bad/missing optional artifact must not hide the live production state.
        try:
            raw = self.b.read_trusted(WATCHDOG_RECORD, maximum=8192)
            require(len(raw) <= 8192)
            def pairs(items):
                result = {}
                for key, value in items:
                    require(key not in result)
                    result[key] = value
                return result
            value = json.loads(raw, object_pairs_hook=pairs,
                               parse_constant=lambda _: require(False))
            require(type(value) is dict and set(value) == {'at', 'verdict', 'reasons', 'run_id'})
            require(type(value['at']) is int and 0 <= value['at'] <= int(time.time())+60 and
                    value['verdict'] in ('ok', 'attention', 'not_started'))
            require(type(value['reasons']) is list and len(value['reasons']) <= 32 and
                    all(type(code) is str and code in WATCHDOG_REASONS for code in value['reasons']))
            require((value['verdict'] == 'attention') == bool(value['reasons']))
            require(value['run_id'] is None or type(value['run_id']) is str and
                    re.fullmatch(r'[a-f0-9]{32}', value['run_id']))
            require(value['verdict'] != 'ok' or value['run_id'] is not None)
            require(value['verdict'] != 'not_started' or value['run_id'] is None)
            return {'record': value, 'code': None}
        except FileNotFoundError:
            return {'record': None, 'code': 'WATCHDOG_RECORD_MISSING'}
        except Exception:
            return {'record': None, 'code': 'WATCHDOG_RECORD_INVALID'}

    def prod_status(self):
        # Read-only even before first use: no mkdir, locks, helpers or writes.
        watchdog = self.watchdog_status()
        if not self.state.exists():
            return {'run': None, 'requires_review': False, 'watchdog': watchdog}
        with self.b.directory(self.state):
            pass
        if not self.record.exists():
            return {'run': None, 'requires_review': os.path.lexists(self.state/'abort-inhibit.json') or os.path.lexists(self.state/'failed.json'), 'watchdog': watchdog}
        record = self.current()
        run = {key: record.get(key) for key in ('id', 'status', 'started', 'stopped', 'sha', 'stage', 'admitted')}
        alive = not self.exited(record)
        worker = None
        if record['status'] == 'in_progress' and record['admitted'] and alive:
            try:
                d = self.api('GET', '/api/deployment')
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException):
                # Transport failures are an observation, not a status-command
                # failure. Never expose exception messages, URLs or headers.
                worker = {'reachable': False, 'reason': 'WORKER_UNREACHABLE'}
            else:
                worker = {key: d[key] for key in ('running', 'maintenance', 'databaseHealthy', 'ledgerOk') if type(d.get(key)) is bool}
                worker['paper'] = d.get('mode') == 'PAPER'
        return {'run': run, 'controller_alive': alive, 'worker': worker,
                'requires_review': record['status'] == 'failed_requires_review' or self.faults(record), 'watchdog': watchdog}


def main():
    os.umask(0o077)
    try:
        require(os.geteuid() == 0 and ((len(sys.argv) == 2 and sys.argv[1] in ('request', 'run', 'stop', 'post-stop', 'prod-run', 'prod-post-stop')) or (len(sys.argv) == 3 and sys.argv[1] == 'approve-retry') or (len(sys.argv) == 4 and sys.argv[1] == 'approve-deploy')))
        # All ancestors and module must be root-owned/non-writable by SSH user.
        import stat
        current = BROKER.parent
        while current != Path('/'):
            s = current.lstat()
            require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022)
            current = current.parent
        s = BROKER.lstat()
        require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1 and not s.st_mode & 0o022)
        spec = importlib.util.spec_from_file_location('trusted_broker', BROKER)
        b = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(b)
        b.read_trusted(Path(__file__), maximum=PROGRAM_READ_MAXIMUM)
        controller = Controller(b)
        if sys.argv[1] == 'approve-deploy':
            controller.approve_deploy(sys.argv[2], sys.argv[3])
            print('PAPER_CHECK_DEPLOY_APPROVED')
        elif sys.argv[1] == 'approve-retry':
            controller.approve_retry(sys.argv[2])
            print('PAPER_CHECK_RETRY_APPROVED')
        elif sys.argv[1] == 'request':
            import pwd
            account = pwd.getpwnam('suiba-deploy')
            require(os.environ.get('SUDO_USER') == account.pw_name and os.environ.get('SUDO_UID') == str(account.pw_uid))
            signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(RuntimeError()))
            signal.alarm(5)
            request = b.decode(sys.stdin.buffer.read(257))
            signal.alarm(0)
            require(isinstance(request, dict) and set(request) <= {'operation', 'duration', 'mode', 'sha'} and
                    request.get('operation') in ('start', 'status', 'abort', 'diagnose', 'reconcile', 'approve-retry', 'approve-deploy', 'revoke-retry', 'release-cutoff', 'prod-start', 'prod-stop', 'prod-status'))
            require(request['operation'] in ('start', 'reconcile', 'approve-deploy') or set(request) == {'operation'})
            require(request['operation'] in ('reconcile', 'approve-deploy') or 'sha' not in request)
            require(request['operation'] == 'start' or 'duration' not in request)
            duration = request.get('duration', '30m')
            require(duration in DURATIONS)
            if request['operation'] in ('prod-start', 'prod-stop', 'prod-status'):
                production = ProductionController(b)
                action = {'prod-start': production.prod_start, 'prod-stop': production.prod_stop,
                          'prod-status': production.prod_status}[request['operation']]
                print(json.dumps(action()))
            elif request['operation'] == 'reconcile':
                mode = request.get('mode', 'retry')
                require(mode in ('retry', 'deploy'))
                require(mode == 'deploy' or 'sha' not in request)
                print(json.dumps(controller.reconcile_preflight(mode, request.get('sha'))))
            elif request['operation'] == 'approve-retry':
                print(json.dumps(controller.approve_retry(controller.current()['id'])))
            elif request['operation'] == 'approve-deploy':
                require(type(request.get('sha')) is str)
                controller.approve_deploy(controller.current()['id'], request['sha'])
                print(json.dumps({'deploy_approved': request['sha']}))
            elif request['operation'] == 'revoke-retry':
                print(json.dumps(controller.revoke_retry()))
            elif request['operation'] == 'release-cutoff':
                print(json.dumps(controller.release_cutoff()))
            elif request['operation'] == 'diagnose':
                print(json.dumps(controller.diagnose()))
            elif request['operation'] == 'status':
                record = controller.current()
                receipt = controller.folder(record)/'stop.json'
                print(json.dumps({'run': record, 'requires_review': controller.faults(record),
                                  'stop': b.decode(b.read_trusted(receipt)) if receipt.exists() else None}))
            elif request['operation'] == 'start':
                require(not (controller.state/'abort-inhibit.json').exists())
                controller.note_start_request(duration)
                controller.system('start', '--no-block', SERVICE)
                print('PAPER_CHECK_REQUEST_ACCEPTED')
            else:
                with controller.locked('stop'):
                    # Also fences abort before run.json has been published.
                    controller.b.atomic(controller.state/'abort-inhibit.json', {'status': 'manual_reconciliation_required'})
                    if controller.record.exists():
                        controller.accept_stop(controller.current(), 'abort')
                controller.system('start', '--no-block', CUTOFF)
                print('PAPER_CHECK_ABORT_REQUESTED')
        elif sys.argv[1] == 'prod-run':
            ProductionController(b).run()
        elif sys.argv[1] == 'prod-post-stop':
            production = ProductionController(b)
            record = production.current() if production.record.exists() else None
            require(production.stop(expected=record['id'] if record else None, source='post-stop'))
        elif sys.argv[1] in ('stop', 'post-stop'):
            record = controller.current() if controller.record.exists() else None
            require(controller.stop(expected=record['id'] if record else None,
                                    source='post-stop' if sys.argv[1] == 'post-stop' else 'cutoff'))
        else:
            controller.run()
        return 0
    except BaseException:
        print('PAPER_CHECK_FAILED; inspect root-owned state; no automatic restart', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
