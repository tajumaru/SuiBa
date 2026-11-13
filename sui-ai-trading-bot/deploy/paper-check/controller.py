#!/usr/bin/python3
"""Fixed root-owned PAPER test supervisor. Install only after independent review.

No image/path/duration/command is accepted from SSH. No token is returned.
The stop entrypoint deliberately does not acquire the run/deploy lock.

Root-only recovery: approve-deploy RUN_ID RELEASE_SHA. Requires an inactive
cutoff and an existing independent release approval. Preserves failed history;
issues one permission consumed by the broker before the next deployment attempt.
"""
import contextlib
import datetime
import hashlib
import http.client
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
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
DURATIONS = {'30m': 1800, '2h': 7200, '6h': 21600, '24h': 86400}
RESET_REFUSAL_CODES = frozenset(('RESET_EMERGENCY_ACTIVE', 'RESET_SCOPE_CHANGED',
                               'RESET_NOT_PREDECESSOR', 'RESET_SCOPE_UNAVAILABLE'))
# Program files (this controller, the broker) are read whole for
# integrity checks. The broker's read_trusted default of 64 KiB
# is sized for state files; this controller passed it at the
# production-ops stage (84 KiB by the monitor stage), after
# which every entry point refused to run on the host while
# module-level tests stayed green. Program reads pass this
# maximum explicitly, and a test keeps the file below it.
PROGRAM_READ_MAXIMUM = 262144
EXPORT_PROGRAM = Path('/usr/local/libexec/suiba-paper-export.py')
EXPORT_CODES = frozenset(('EXPORT_BACKUP_MISSING', 'EXPORT_MANIFEST_MISMATCH', 'EXPORT_ARCHIVE_INVALID',
    'EXPORT_LIMIT_EXCEEDED', 'EXPORT_DATABASE_INVALID', 'EXPORT_RUN_INVALID', 'EXPORT_PACKAGE_INVALID',
    'EXPORT_PROGRAM_INVALID', 'EXPORT_PROD_NOT_RUNNING'))
# The start op returns as soon as the supervisor is launched; the
# supervisor creates the pre-run backup during admission and only
# then records it on the run record. An export issued immediately
# after start (the paper cycle's start-then-export sequence) can
# therefore arrive before the backup exists. While the same run is
# still in_progress, export_snapshot polls the record for the
# backup for at most this window instead of refusing at once.
EXPORT_BACKUP_WAIT_SECONDS = 180
EXPORT_BACKUP_POLL_SECONDS = 5
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


def provider_profile_ok(env):
    # The DeepBook profile pairs the provider with verified candle
    # reconstruction (docs/DEEPBOOK_24H_PAPER.md): without it, any
    # hole in the indexer's candle series fails every fetch with
    # CANDLE_GAP. Two validation runs stopped at market-freshness on
    # 2026-11-07 before this completeness check existed; refuse the
    # incomplete profile here instead, in seconds.
    if env.get('MARKET_DATA_PROVIDER') == 'deepbook':
        return env.get('DEEPBOOK_RECONSTRUCT_CANDLES') == 'verified'
    return env.get('MARKET_DATA_PROVIDER') in MARKET_SOURCES


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
# The run stage each guarded operation belongs to, mapped to the
# operation name guard() journals as mutation.json's pending. The
# two vocabularies differ only for the maintenance release: the
# stage is 'maintenance-release' while the journaled operation is
# 'unlatch'. Production reaches only these guarded operations (the
# timer and preset guards are validation-only), so a stranded
# production pending always names one of these stages.
GUARD_STAGE_OPERATIONS = {
    'backup': 'backup',
    'maintenance-release': 'unlatch',
    'worker-start': 'worker-start',
    'arm': 'arm',
    'paper-start': 'paper-start',
}
DIAGNOSTIC_LIMIT = 128 * 1024**2
DIAGNOSTIC_DATABASES = ('bot.sqlite', 'bot.sqlite.WAL_USDC.sqlite')
# Fixed run presets, chosen per run through the start request like the
# duration. 'safe' changes nothing. 'hard' swaps the SUI settings for
# the dashboard's hard preset (applyHardPreset in
# apps/dashboard/src/settingsPresets.ts) for that run only: the
# controller snapshots the live settings before the worker starts and
# restores them when the run is finalized, so a preset can never leak
# into a later run or into production. tests/preset-parity.test.ts
# guards this table against drifting from the dashboard's values.
PRESETS = ('safe', 'hard')
HARD_PRESET = {
    "maxOrder": 5,
    "dailyBuyLimit": 20,
    "maxSlippage": 0.003,
    "profitGuardEnabled": True,
    "minNetProfitUsdc": 0.01,
    "minNetProfitPct": 0.005,
    "oversold": 45,
    "emaGapShrinkEnabled": True,
    "takeProfitPct": 0.015,
    "stopLossPct": 0.01,
}


def read_current_settings(db_path):
    with contextlib.closing(sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)) as db:
        row = db.execute("SELECT json FROM bot_runtime_state WHERE key='settings'").fetchone()
    require(row is not None)
    settings = json.loads(row[0])
    require(isinstance(settings, dict))
    return settings


def write_current_settings(db_path, settings, at_ms):
    # Mirror BotDatabase.updateSettings: the live key-value row plus a
    # bot_settings audit append, in one transaction.
    payload = json.dumps(settings)
    with contextlib.closing(sqlite3.connect(str(db_path), timeout=30)) as db:
        with db:
            db.execute("INSERT INTO bot_runtime_state(key, json) VALUES('settings', ?)"
                       " ON CONFLICT(key) DO UPDATE SET json=excluded.json", (payload,))
            db.execute("INSERT INTO bot_settings(id, timestamp, json) VALUES(?, ?, ?)",
                       (f'{at_ms}:{uuid.uuid4()}', at_ms, payload))
    require(read_current_settings(db_path) == settings)
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


ADMISSION_CODES = frozenset('''ADMISSION_POLICY ADMISSION_LOCK ADMISSION_START_REQUEST
ADMISSION_ABORT_INHIBIT ADMISSION_QUIESCENT ADMISSION_PREVIOUS_RUN ADMISSION_RETRY_LATCH
ADMISSION_RETRY_MARKER ADMISSION_RETRY_CONSUMED ADMISSION_RETRY_PERMIT ADMISSION_PREVIOUS_STATUS
ADMISSION_PREVIOUS_EXIT ADMISSION_PREVIOUS_STOP ADMISSION_FRESH_GATE ADMISSION_RETRY_CONSUME
ADMISSION_RECORD RETRY_REVIEW RETRY_RUN RETRY_STOP RETRY_LOCK RETRY_CURRENT RETRY_CONSUMED
RETRY_ALREADY_APPROVED RETRY_RECORD'''.split())


class AdmissionRejected(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class SnapshotExportRejected(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


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
// Post-run cycle evidence from the SUI database only: what the
// worker's own cycles most recently recorded (a stopped worker
// keeps the first persisted runtime error, so the runtime row
// alone cannot name what later cycles failed with), plus the
// last fetch timing. Shape-sanitized here and re-validated by
// the controller; any surprise degrades to null.
let evidence = null;
try {
  const db = new DatabaseSync("/audit/after/bot.sqlite", { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    const shape = /^[A-Z][A-Z0-9_]{0,63}$/;
    // Tally keys are "<api>/<code>"; the api names are display
    // names that contain spaces ("DeepBook Indexer", "Sui gRPC"),
    // so the api part must allow spaces or every API-failure
    // episode sanitizes away to nothing.
    const tallyKey = /^[A-Za-z][A-Za-z0-9 ]{0,31}\/[A-Z][A-Z0-9_]{0,63}$/;
    const episodeOutcomes = ["RECOVERED", "EXHAUSTED", "STOPPED", "INTERRUPTED"];
    const sanitizeEpisode = (ep) => {
      if (!ep || typeof ep !== "object" || Array.isArray(ep)) return null;
      const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
      const s = num(ep.startedAt), m = num(ep.durationMs), f = num(ep.failures);
      if (s === null || m === null || f === null || !Number.isInteger(f)) return null;
      if (!ep.tally || typeof ep.tally !== "object" || Array.isArray(ep.tally)) return null;
      const tally = {};
      for (const [key, count] of Object.entries(ep.tally)) {
        if (!tallyKey.test(key) || !Number.isInteger(count) || count < 1 || count > 100000)
          return null;
        tally[key] = count;
        if (Object.keys(tally).length > 8) return null;
      }
      const out = {s, m, f, y: tally};
      if (ep.outcome !== undefined) {
        if (!episodeOutcomes.includes(ep.outcome)) return null;
        out.o = ep.outcome;
      }
      if (ep.lastFailureAt !== undefined) {
        const l = num(ep.lastFailureAt);
        if (l === null) return null;
        out.l = l;
      }
      return out;
    };
    const events = [];
    for (const row of db.prepare(
        "SELECT timestamp, json FROM operation_events ORDER BY timestamp DESC LIMIT 10").all()) {
      try {
        const value = JSON.parse(row.json);
        if (typeof row.timestamp === "number" && shape.test(value.kind) && shape.test(value.code)) {
          const detail = value.details && typeof value.details.reasonDetail === "string" &&
            shape.test(value.details.reasonDetail) ? value.details.reasonDetail : null;
          const episode = sanitizeEpisode(value.episode);
          events.push({t: row.timestamp, k: value.kind, c: value.code, d: detail,
            ...(episode ? {e: episode} : {})});
        }
      } catch {}
    }
    // The most recent CLOSED episode, looked up directly: the
    // closing event falls out of the 10-event window above once
    // later cycles append their own events, but its summary is
    // the first thing a failure diagnosis needs.
    let episode = null;
    const episodeRow = db.prepare(
      "SELECT timestamp, json FROM operation_events " +
      "WHERE json_extract(json, '$.episode') IS NOT NULL " +
      "ORDER BY timestamp DESC LIMIT 1").get();
    if (episodeRow) {
      try {
        const value = JSON.parse(episodeRow.json);
        const clean = sanitizeEpisode(value.episode);
        if (clean && typeof episodeRow.timestamp === "number" && shape.test(value.code))
          episode = {t: episodeRow.timestamp, c: value.code, e: clean};
      } catch {}
    }
    let timing = null;
    const stateRow = db.prepare(
      "SELECT json FROM bot_runtime_state WHERE key='operation_state'").get();
    if (stateRow) {
      const state = JSON.parse(stateRow.json);
      const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
      timing = {dur: num(state.lastFetchDurationMs), att: num(state.lastFetchAttemptAt),
                suc: num(state.lastFetchSuccessAt)};
      // Persisted indexer latency aggregate: per read class
      // [total network samples, median of the recent window,
      // max, TTL cache hits counted apart from the samples].
      const agg = state.indexerLatency;
      if (agg && typeof agg === "object" && !Array.isArray(agg)) {
        const bucket = (b) => {
          if (!b || typeof b !== "object" || !Number.isInteger(b.count) || b.count < 1)
            return null;
          const recent = (Array.isArray(b.recent) ? b.recent : [])
            .filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
            .sort((a, z) => a - z);
          const cached = Number.isInteger(b.cached) && b.cached >= 0 ? b.cached : 0;
          return [b.count,
            recent.length ? Math.round(recent[Math.floor(recent.length / 2)]) : null,
            num(b.maxMs) !== null ? Math.round(b.maxMs) : null,
            cached];
        };
        const lat = {c: bucket(agg.candles), b: bucket(agg.book), s: bucket(agg.status)};
        if (lat.c || lat.b || lat.s) timing.lat = lat;
      }
    }
    evidence = {events, timing, episode};
  } finally { db.close(); }
} catch { evidence = null; }
console.log(JSON.stringify({deltas: result, runtime, selected_pair: selectedPair, evidence}));
""".replace('RUNTIME_ERROR_ALLOWLIST', json.dumps(RUNTIME_ERROR_CODES))


def export_backup_name(record):
    backup = record.get('backup')
    if type(backup) is dict and type(backup.get('file')) is str and \
            re.fullmatch(r'paper-check-[0-9a-f]{32}\.tar', backup['file']):
        return backup['file']
    return None


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
        self.pause_since = None
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

    def admission_step(self, code):
        self._admission_code, self._admission_observed = code, {}

    def admission_observe(self, key, value):
        # Return the original value: recording must not change any gate result.
        if getattr(self, '_admission_tracking', False):
            self._admission_observed[key] = value
        return value

    @contextlib.contextmanager
    def admission_evidence(self, operation):
        self._admission_tracking = True
        self.admission_step('ADMISSION_POLICY' if operation == 'admit' else 'RETRY_REVIEW')
        try:
            yield
        except BaseException:
            code = self._admission_code
            evidence = {'version': 1, 'at': int(time.time()*1000), 'operation': operation,
                        'code': code, 'observed': self._admission_observed}
            # No exception text, paths, request payloads or settings are recorded.
            with contextlib.suppress(Exception):
                self.b.atomic(self.state/'admission-failure.json', evidence)
            with contextlib.suppress(Exception):
                # A separate diagnostic lock never participates in admission gates.
                with self.locked('admission-history', wait=2):
                    history = self._read_admission_history()
                    history.append(evidence)
                    self.b.atomic(self.state/'admission-failures.json', self._bounded_admission_history(history))
            raise AdmissionRejected(code) from None
        finally:
            self._admission_tracking = False

    @staticmethod
    def _admission_entry(value):
        require(type(value) is dict and set(value) == {'version', 'at', 'operation', 'code', 'observed'})
        require(value['version'] == 1 and type(value['at']) is int and value['at'] >= 0 and
                value['operation'] in ('admit', 'approve-retry') and value['code'] in ADMISSION_CODES)
        observed = value['observed']
        require(type(observed) is dict and set(observed) <= {'unit', 'active_state', 'job_pending', 'permit_exists', 'consumed_exists', 'inhibit_exists'})
        for key, item in observed.items():
            if key == 'unit': require(item in (*cutoff_timers(), CUTOFF))
            elif key == 'active_state': require(item in ('active', 'activating', 'deactivating', 'inactive', 'failed', 'unknown'))
            else: require(type(item) is bool)
        return value

    @staticmethod
    def _bounded_admission_history(values):
        values = values[-5:]
        # Match broker.atomic's JSON encoding, with one byte reserved for a newline.
        while values and len(json.dumps(values, sort_keys=True).encode('utf-8'))+1 > 4096:
            values = values[1:]
        return values

    def _read_admission_history(self):
        try:
            values = self.b.decode(self.b.read_trusted(self.state/'admission-failures.json', maximum=4096))
            require(type(values) is list)
            valid = []
            for value in values:
                with contextlib.suppress(Exception):
                    valid.append(self._admission_entry(value))
            return self._bounded_admission_history(valid)
        except Exception:
            return []

    def admission_failures(self):
        history = self._read_admission_history()
        if history: return history
        try:
            return self._bounded_admission_history([self._admission_entry(self.admission_failure())])
        except Exception:
            return []

    def admission_failure(self):
        path = self.state/'admission-failure.json'
        if not path.exists(): return None
        try:
            return self._admission_entry(self.b.decode(self.b.read_trusted(path, maximum=4096)))
        except Exception:
            return {'code': 'ADMISSION_EVIDENCE_INVALID'}

    def status(self):
        record = self.current() if self.record.exists() else None
        receipt = self.folder(record)/'stop.json' if record else None
        return {'run': record, 'requires_review': self.faults(record) if record else False,
                'stop': self.b.decode(self.b.read_trusted(receipt)) if receipt and receipt.exists() else None,
                'admission_failure': self.admission_failure(), 'admission_failures': self.admission_failures()}

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
            try:
                result = action()
            except urllib.error.HTTPError as error:
                # A 4xx is a definitive refusal: the server evaluated
                # the request and the operation did not take effect,
                # so the pending marker must not survive it (a 409
                # paper-start refusal on 2026-11-07 otherwise left
                # OPERATION_COMPLETION_UNCONFIRMED behind for a start
                # that never ran). 5xx and transport failures stay
                # unconfirmed on purpose: the request may have landed.
                if 400 <= error.code < 500:
                    self.b.atomic(self.folder(record)/'mutation.json', {'id': self.run_id, 'pending': None})
                raise
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
            self.admission_observe('unit', unit)
            self.admission_observe('active_state', values.get('ActiveState') if values.get('ActiveState') in
                                   ('active', 'activating', 'deactivating', 'inactive', 'failed') else 'unknown')
            self.admission_observe('job_pending', values.get('Job') not in ('', '0'))
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
            with contextlib.suppress(Exception):
                self.b.write_lock_holder(self.b.STATE, 'controller', 'diagnose', lock)
            try:
                with self.locked('stop'), self.locked('mutation'):
                    report = self.diagnose_locked()
                    report['admission_failure'] = self.admission_failure()
                    report['admission_failures'] = self.admission_failures()
                    return report
            finally:
                with contextlib.suppress(Exception):
                    self.b.clear_lock_holder(self.b.STATE)

    def diagnose_locked(self):
        if not self.record.exists():
            return {'run': None, 'stop': None, 'requires_review': False, 'diagnostics': None,
                    'admission_failure': self.admission_failure(), 'admission_failures': self.admission_failures()}
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
        stage, http, readiness, market, stale_reset, reset_refusal = None, None, None, None, None, None
        if failure_path.exists():
            failure = self.b.decode(self.b.read_trusted(failure_path))
            require(failure['id'] == record['id'] and failure['stage'] in DIAGNOSTIC_STAGES)
            stage = failure['stage']
            reset_refusal = failure.get('reset_refusal')
            require(reset_refusal is None or (type(reset_refusal) is str and reset_refusal in RESET_REFUSAL_CODES))
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
            stale_reset = failure.get('stale_reset')
            if stale_reset is not None:
                require(type(stale_reset) is dict and set(stale_reset) == {'sent', 'ok', 'attempts'} and
                        stale_reset['sent'] is True and type(stale_reset['ok']) is bool and
                        type(stale_reset['attempts']) is int and stale_reset['attempts'] >= 1)
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
            'admission_failure': self.admission_failure(),
            'admission_failures': self.admission_failures(),
            'stop': {'id': stop['id'], 'status': stop['status'], 'errors': stop_errors},
            'requires_review': self.faults(record),
            'diagnostics': {
                'exit_code': state['ExitCode'], 'oom_killed': state['OOMKilled'],
                'healthcheck_exit': health[-1]['ExitCode'] if health else None,
                'maintenance': maintenance, 'stage': stage, 'http_status': http, 'preflight': preflight,
                'backup_verified': report is not None,
                'deltas': report['deltas'] if report is not None else None, 'readiness': readiness,
                'market': market, 'stale_reset': stale_reset,
                'reset_refusal': reset_refusal,
                'evidence': report['evidence'] if report is not None else None,
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
        # The broker's pre-transaction rejection record lives
        # outside the ledger: a deploy refused before transaction()
        # (the paper-session gate, a missing permit or approval)
        # writes only this public-code file, so without it the
        # refusal is invisible outside the host. Surface it
        # best-effort — the broker writes it best-effort too, so
        # any read or shape problem degrades to None instead of
        # breaking the diagnosis.
        broker_last_failure = None
        try:
            candidate = self.b.decode(self.b.read_trusted(self.b.STATE/'last-failure.json'))
            if (type(candidate) is dict and set(candidate) in ({'version', 'at', 'operation', 'sha', 'code'},
                                                                {'version', 'at', 'operation', 'sha', 'code', 'detail'})
                    and type(candidate['version']) is int and candidate['version'] == 1
                    and type(candidate['at']) is int and candidate['at'] > 0
                    and type(candidate['operation']) is str
                    and re.fullmatch(r'[a-z][a-z0-9-]{0,31}', candidate['operation'])
                    and type(candidate['sha']) is str and re.fullmatch(r'[a-f0-9]{40}', candidate['sha'])
                    and type(candidate['code']) is str
                    and re.fullmatch(r'[A-Z][A-Z_]{2,47}', candidate['code'])
                    and ('detail' not in candidate or (
                        type(candidate['detail']) is dict and set(candidate['detail']) in ({'errno', 'stage'}, {'errno', 'stage', 'holder'})
                        and (candidate['detail']['errno'] is None or type(candidate['detail']['errno']) is int)
                        and candidate['detail']['stage'] in self.b.PRE_TRANSACTION_STAGES
                        and ('holder' not in candidate['detail'] or (
                            candidate['detail']['stage'] == 'lock' and
                            candidate['detail']['errno'] == 11 and
                            self.b.valid_lock_holder(candidate['detail']['holder'])))))):
                broker_last_failure = {'at': candidate['at'], 'operation': candidate['operation'],
                                       'sha': candidate['sha'], 'code': candidate['code']}
                if 'detail' in candidate:
                    broker_last_failure['detail'] = candidate['detail']
        except Exception:
            broker_last_failure = None
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
                        and env.get('PAPER_CHECK_MODE') == 'sui-30m' and provider_profile_ok(env)),
            'ports': safe(lambda: container['HostConfig']['PortBindings'] == {'3100/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3100'}]}),
            'memory': safe(lambda: container['HostConfig']['Memory'] == container['HostConfig']['MemorySwap'] == 1024**3),
            'label': safe(lambda: self.b.SHA.fullmatch(ledger['sha']) and labels.get('org.opencontainers.image.revision') == ledger['sha']),
            'image': safe(lambda: frozen_image is not None and container['Config']['Image'] == frozen_image),
        }
        return {
            'ledger_status': ledger['status'] if ledger['status'] in known_states else 'unknown',
            'broker_failure': failure,
            'broker_last_failure': broker_last_failure,
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
                if (policy.get('approval_source') == 'ci'
                        and type(approval.get('expires')) is int and approval['expires'] <= time.time()):
                    # Expiry-wedge re-issue (作業6, decision A): a CI
                    # approval materialized by an earlier attempt can
                    # expire before its deploy consumes it, after which
                    # the expired record and the permit bound to it
                    # wedged this sha forever. Only a record this
                    # controller materialized (CI mode), and only once
                    # expired, may be re-materialized with the same
                    # content; a live record is never overwritten. The
                    # stale permit goes only when it binds the expired
                    # record's digest (its own lineage); a consumed
                    # marker or a foreign permit refuses with nothing
                    # changed, so single-use is preserved. The permit
                    # is dropped before the record is rewritten so a
                    # crash in between leaves the recoverable state
                    # (expired record, no permit), never a fresh
                    # record wedged behind a foreign permit.
                    stale_permit = self.b.STATE/('paper-deploy-'+sha+'.json')
                    stale_consumed = stale_permit.with_suffix('.consumed.json')
                    require(not os.path.lexists(stale_consumed))
                    if os.path.lexists(stale_permit):
                        stale = self.b.decode(self.b.read_trusted(stale_permit))
                        require(stale.get('approval_sha256') ==
                                hashlib.sha256(approval_bytes).hexdigest())
                        require(not os.path.lexists(stale_consumed))
                        stale_permit.unlink()
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
        with self.admission_evidence('approve-retry'):
            # The root CLI's approval, shared with the approve-retry
            # request op: only a run that was admitted and then stopped
            # cleanly (stop receipt clean_stopped, no fault evidence,
            # diagnose fully readable) may be retried. Preflight deaths
            # end in failed_state_unknown instead and stay with the
            # reconcile path; this method refuses them through the
            # stop-receipt check.
            report = self.diagnose()
            self.admission_step('RETRY_RUN')
            run = report['run']
            require(run['id'] == run_id and run['status'] == 'failed_requires_review')
            self.admission_step('RETRY_STOP')
            require(report['stop']['status'] == 'clean_stopped' and not report['requires_review'])
            folder = self.folder(run)
            self.admission_step('RETRY_LOCK')
            with self.locked('stop'), self.locked('mutation'):
                self.admission_step('RETRY_CURRENT')
                require(self.current()['id'] == run['id'])
                self.admission_step('RETRY_CONSUMED')
                require(not self.admission_observe('consumed_exists', os.path.lexists(folder/'retry-consumed.json')))
                self.admission_step('RETRY_ALREADY_APPROVED')
                require(not self.admission_observe('permit_exists', os.path.lexists(folder/'retry-approved.json')))
                self.admission_step('RETRY_RECORD')
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

    def heal_run(self):
        # Reviewed healing for the one wedge the approval paths
        # cannot pass: a guarded operation the server definitively
        # refused (HTTP 4xx) left its pending marker behind (before
        # the guard learned to clear it), so cleanup reported
        # OPERATION_COMPLETION_UNCONFIRMED and latched a fault for
        # an operation that never took effect — 2026-11-07, a
        # paper-start 409 over a boot-cycle STALE_CANDLES. The stop
        # receipt is failed_state_unknown, so approve_retry and
        # approve_deploy both refuse. Heal only when every piece of
        # evidence says the run is otherwise clean — the standard
        # reconcile_preflight applies to its narrower case — and
        # preserve the originals in a backup before touching them.
        record = self.current()
        require(record['status'] == 'failed_requires_review')
        require(self.exited(record))
        folder = self.folder(record)
        stop = self.b.decode(self.b.read_trusted(folder/'stop.json'))
        require(stop['id'] == record['id'] and stop['status'] == 'failed_state_unknown')
        errors = stop.get('errors')
        require(type(errors) is list and 'OPERATION_COMPLETION_UNCONFIRMED' in errors and
                set(errors) <= {'OPERATION_COMPLETION_UNCONFIRMED', 'LATCHED_FAILURE'})
        failure = self.b.decode(self.b.read_trusted(folder/'failure.json'))
        require(failure['id'] == record['id'] and failure['stage'] in ('arm', 'paper-start') and
                type(failure.get('http_status')) is int and 400 <= failure['http_status'] < 500)
        mutation = self.b.decode(self.b.read_trusted(folder/'mutation.json'))
        require(mutation['id'] == record['id'] and mutation['pending'] == failure['stage'])
        report = self.diagnose()
        diag = report['diagnostics']
        require(report['run']['id'] == record['id'] and report['stop']['status'] == 'failed_state_unknown')
        require(diag['exit_code'] == 0 and diag['oom_killed'] is False and diag['maintenance'] and
                diag['clean_lifecycle'] and diag['backup_verified'])
        self.quiescent()
        broker_latch = self.b.STATE/'paper-check-failed.json'
        require(os.path.lexists(broker_latch))
        backup = RECONCILE_BACKUPS/('heal-' + time.strftime('%Y%m%d%H%M%S'))
        backup.mkdir(mode=0o700)
        shutil.copy2(self.record, backup/'run.json')
        shutil.copy2(folder/'stop.json', backup/'stop.json')
        if (self.state/'stop.json').exists():
            shutil.copy2(self.state/'stop.json', backup/'stop-root.json')
        shutil.copy2(folder/'failure.json', backup/'failure.json')
        shutil.copy2(folder/'mutation.json', backup/'mutation.json')
        os.replace(broker_latch, backup/'paper-check-failed.json')
        for fault in sorted(folder.glob('fault-*.json')):
            os.replace(fault, backup/fault.name)
        self.b.atomic(folder/'mutation.json', {'id': record['id'], 'pending': None})
        self.receipt(record, 'clean_stopped', [])
        report = self.diagnose()
        require(report['stop']['status'] == 'clean_stopped' and not report['requires_review'])
        return {'healed': record['id'], 'backup': backup.name}

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
            evidence = audit.get('evidence')
            if evidence is not None:
                require(type(evidence) is dict and
                        {'events', 'timing'} <= set(evidence) <= {'events', 'timing', 'episode'})
                require(evidence.get('episode') is None or valid_episode_ref(evidence.get('episode')))
                require(type(evidence['events']) is list and len(evidence['events']) <= 10 and all(
                    type(e) is dict and set(e) in ({'t', 'k', 'c', 'd'}, {'t', 'k', 'c', 'd', 'e'})
                    and type(e['t']) in (int, float) and
                    re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', e['k']) and
                    re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', e['c']) and
                    (e['d'] is None or re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', e['d'])) and
                    (set(e) == {'t', 'k', 'c', 'd'} or valid_episode(e['e']))
                    for e in evidence['events']))
                timing = evidence['timing']
                require(timing is None or (type(timing) is dict and
                    {'dur', 'att', 'suc'} <= set(timing) <= {'dur', 'att', 'suc', 'lat'} and
                    all(timing[key] is None or type(timing[key]) in (int, float)
                        for key in ('dur', 'att', 'suc')) and
                    ('lat' not in timing or valid_latency(timing['lat']))))
            return {'deltas': result, 'runtime': {pair: audit['runtime'][name]
                    for pair, name in zip(('SUI_USDC', 'WAL_USDC'), DIAGNOSTIC_DATABASES)},
                    'selected_pair': audit['selected_pair'], 'evidence': evidence}

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
                    self.capture_reset_scope(d)
                    checks = d.get('readiness')
                    if isinstance(checks, dict):
                        self.readiness.update({key: checks[key] for key in (
                            'connectivity', 'apiAccess', 'emergencyClear', 'runtimeClear',
                            'suiHealthy', 'suiFresh', 'ledger') if type(checks.get(key)) is bool})
                    if getattr(self, 'stale_reset_ok', False):
                        self.readiness['staleReset'] = True
                    if d.get('startReady') is True and not getattr(self, 'reset_pending', False) and not self.reset_ack_pending():
                        return d
                    self.maybe_reset_stale()
                except urllib.error.URLError as error:
                    if isinstance(error, urllib.error.HTTPError) or not isinstance(error.reason, ConnectionRefusedError):
                        raise
            time.sleep(1)

    def maybe_reset_stale(self):
        # Only a retry-reviewed predecessor is eligible. The worker pins its boot,
        # error and generations; new errors or emergency never become reset targets.
        # Busy/uncertain transport may retry the same expectation, never a new scope.
        if not getattr(self, 'retry_admitted', False) or getattr(self, 'stale_reset_ok', False):
            return
        if self.reset_ack_pending() or getattr(self, 'reset_pending', False) or self.readiness.get('runtimeClear') is False:
            due = True
        elif self.readiness.get('apiAccess') is False:
            now = time.monotonic()
            if getattr(self, '_stale_since', None) is None:
                self._stale_since = now
            due = now-self._stale_since >= 5
        else:
            self._stale_since = None
            due = False
        if not due:
            return
        self.send_stale_reset()

    def reset_ack_pending(self):
        return bool(getattr(self, 'stale_reset_attempts', 0)) and not getattr(self, 'stale_reset_ok', False)

    def refuse_reset(self, code):
        self.reset_refusal = code
        raise RuntimeError(code)

    def capture_reset_scope(self, deployment):
        if not getattr(self, 'retry_admitted', False): return
        if type(deployment) is not dict: self.refuse_reset('RESET_SCOPE_UNAVAILABLE')
        checks = deployment.get('readiness')
        if type(checks) is dict and checks.get('emergencyClear') is False:
            self.refuse_reset('RESET_EMERGENCY_ACTIVE')
        scope = deployment.get('resetScope')
        keys = ('version', 'bootId', 'pair', 'generation', 'expectedError')
        if not (type(scope) is dict and set(scope) == {*keys, 'eligible', 'reason', 'pending'} and
                type(scope['version']) is int and scope['version'] == 1 and scope['pair'] == 'SUI_USDC' and
                type(scope['bootId']) is str and re.fullmatch(r'[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}', scope['bootId']) and
                type(scope['generation']) is str and re.fullmatch(r'[a-f0-9]{64}', scope['generation']) and
                (scope['expectedError'] is None or (type(scope['expectedError']) is str and re.fullmatch(r'[A-Z][A-Z0-9_]{0,99}', scope['expectedError']))) and
                type(scope['pending']) is bool and type(scope['eligible']) is bool and (scope['reason'] is None or
                    (type(scope['reason']) is str and scope['reason'] in RESET_REFUSAL_CODES))):
            self.refuse_reset('RESET_SCOPE_UNAVAILABLE')
        expected = {key: scope[key] for key in keys}
        if hasattr(self, 'expected_reset') and self.expected_reset != expected:
            self.refuse_reset('RESET_SCOPE_CHANGED')
        if scope['eligible'] is not True or scope['reason'] is not None:
            self.refuse_reset(scope['reason'] or 'RESET_SCOPE_CHANGED')
        if not hasattr(self, 'expected_reset'):
            self.expected_reset = expected
        self.reset_pending = scope['pending']

    def send_stale_reset(self):
        if not getattr(self, 'retry_admitted', False) or not hasattr(self, 'expected_reset'):
            self.refuse_reset('RESET_SCOPE_UNAVAILABLE')
        self.stale_reset_attempts = getattr(self, 'stale_reset_attempts', 0)+1
        try:
            self.api('POST', '/api/control', {'command': 'reset', 'expectedReset': self.expected_reset})
            self.stale_reset_ok = True
        except urllib.error.HTTPError as error:
            if error.code == 409:
                code = 'RESET_SCOPE_CHANGED'
                with contextlib.suppress(Exception):
                    raw = error.read(1025)
                    if len(raw) <= 1024:
                        value = json.loads(raw)
                        if type(value) is dict and value.get('error') in (*RESET_REFUSAL_CODES, 'RESET_BUSY'):
                            code = value['error']
                if code != 'RESET_BUSY': self.refuse_reset(code)
            elif error.code in (401, 403): self.refuse_reset('RESET_SCOPE_UNAVAILABLE')
        except (RuntimeError, urllib.error.URLError):
            pass

    def recheck_start_blockers(self, cutoff):
        # Recheck the original expectation immediately before start. Any new
        # failure aborts instead of refreshing the expected generation and resetting it.
        deadline = time.monotonic()+20
        while True:
            d = self.api('GET', '/api/deployment')
            self.capture_reset_scope(d)
            checks = d.get('readiness')
            if isinstance(checks, dict):
                if not hasattr(self, 'readiness'):
                    self.readiness = {}
                self.readiness.update({key: checks[key] for key in (
                    'connectivity', 'apiAccess', 'emergencyClear', 'runtimeClear',
                    'suiHealthy', 'suiFresh', 'ledger') if type(checks.get(key)) is bool})
                if getattr(self, 'stale_reset_ok', False):
                    self.readiness['staleReset'] = True
                if checks.get('runtimeClear') is True and checks.get('apiAccess') is True and not getattr(self, 'reset_pending', False) and not self.reset_ack_pending():
                    return
            require(time.monotonic() < deadline and time.time()*1000 < cutoff)
            self.send_stale_reset()
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

    def await_export_backup(self, record):
        # Poll for the pre-run backup of the run that was current
        # when the export arrived (see EXPORT_BACKUP_WAIT_SECONDS).
        # Returns the latest record for that same run: the wait ends
        # when a valid backup appears, when the run leaves
        # in_progress, or when the window expires. A different run
        # taking over the record also ends the wait, with the
        # original record returned, so the caller refuses rather
        # than exporting another run's backup.
        deadline = time.monotonic()+EXPORT_BACKUP_WAIT_SECONDS
        while time.monotonic() < deadline:
            time.sleep(EXPORT_BACKUP_POLL_SECONDS)
            polled = self.current()
            if polled['id'] != record['id']:
                return record
            record = polled
            if record.get('status') != 'in_progress' or export_backup_name(record) is not None:
                return record
        return record

    def export_snapshot(self):
        # Read only the pinned pre-run archive. No service/worker/volume/maintenance operation.
        stage = 'EXPORT_RUN_INVALID'
        try:
            record = self.current()
            stage = 'EXPORT_BACKUP_MISSING'
            if export_backup_name(record) is None and record.get('status') == 'in_progress':
                record = self.await_export_backup(record)
            backup = record.get('backup')
            require(type(backup) is dict and type(backup.get('file')) is str and
                    re.fullmatch(r'paper-check-[0-9a-f]{32}\.tar', backup['file']))
            stage = 'EXPORT_PROGRAM_INVALID'
            program = self.b.read_trusted(EXPORT_PROGRAM, maximum=PROGRAM_READ_MAXIMUM)
            scope = {'__name__': 'trusted_snapshot_export'}
            exec(compile(program, str(EXPORT_PROGRAM), 'exec'), scope)
            stage = 'EXPORT_BACKUP_MISSING'
            with self.b.regular(self.b.BACKUPS/backup['file']) as fd:
                with os.fdopen(os.dup(fd), 'rb') as stream:
                    return scope['build_export'](stream, record)
        except Exception as error:
            code = getattr(error, 'code', None)
            raise SnapshotExportRejected(code if code in EXPORT_CODES else stage) from None

    def data_dir(self):
        volume = self.b.decode(self.docker.call(['volume', 'inspect', self.b.DATA], timeout=10))
        require(len(volume) == 1 and volume[0]['Name'] == self.b.DATA)
        return Path(volume[0]['Mountpoint'])

    def sui_db_path(self):
        return self.data_dir()/'bot.sqlite'

    def apply_preset(self, record):
        # After the pre-run backup, before the worker starts: snapshot
        # the live SUI settings into the run folder, then swap in the
        # hard preset. The snapshot lands first, so a death anywhere in
        # this method still leaves finalization able to restore.
        db_path = self.sui_db_path()
        current = read_current_settings(db_path)
        self.b.atomic(self.folder(record)/'preset-snapshot.json',
                      {'settings': current, 'at': int(time.time()*1000)})
        write_current_settings(db_path, {**current, **HARD_PRESET}, int(time.time()*1000))

    def restore_preset(self, record):
        # Idempotent: a no-op unless a snapshot exists and no restore
        # has been marked yet.
        folder = self.folder(record)
        snapshot_path = folder/'preset-snapshot.json'
        if not os.path.lexists(snapshot_path) or os.path.lexists(folder/'preset-restored.json'):
            return
        snapshot = self.b.decode(self.b.read_trusted(snapshot_path))
        require(isinstance(snapshot.get('settings'), dict))
        write_current_settings(self.sui_db_path(), snapshot['settings'], int(time.time()*1000))
        self.b.atomic(folder/'preset-restored.json', {'at': int(time.time()*1000)})

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

    def await_normal_stop(self, record):
        # The deferral in stop() covers a normal stop that is
        # already visible, but the cutoff can still win the race
        # one step earlier: the timer fires at the cutoff while the
        # controller is only just leaving its monitoring loop — it
        # exits at cutoff-5s by design, and a slow final cycle plus
        # the stop preamble can eat that margin, so no 'normal'
        # stop-request exists yet when the cutoff looks. That is
        # what demoted the healthy 2026-11-07 09:13 run. The
        # backstop's question is whether the controller failed to
        # stop, so while the controller is alive, wait for its stop
        # to become visible (or the record to leave in_progress)
        # before forcing anything. A dead controller returns at
        # once, and a live one that never begins stopping is still
        # forced when the grace expires; the worker's session lease
        # has already expired at the cutoff either way. No locks are
        # held here: the controller's own stop needs them.
        deadline = time.monotonic()+60
        while time.monotonic() < deadline:
            record = self.current(record['id'])
            if record['status'] != 'in_progress': return
            if self.defer_to_normal_completion(record): return
            if self.exited(record): return
            time.sleep(2)

    def stop(self, own=False, expected=None, source='external'):
        if not self.record.exists(): return True
        record = self.current(expected)
        if record['status'] == 'completed': return not self.faults(record)
        expected = record['id']
        if source == 'cutoff':
            self.await_normal_stop(record)
            record = self.current(expected)
            if record['status'] == 'completed': return not self.faults(record)
        try:
            with self.locked('stop', wait=60):
                record = self.current(expected)  # stale callers may not signal/write a newer run
                if record['status'] == 'completed': return not self.faults(record)
                if source == 'cutoff' and self.defer_to_normal_completion(record):
                    return not self.faults(record)
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

    def defer_to_normal_completion(self, record):
        # The cutoff timer is a backstop for a controller that never
        # began its own stop. When the run's own normal stop is
        # already in flight — its stop-request (first writer wins)
        # says 'normal', or the record already reached 'finishing' —
        # finalization belongs to the service's ExecStopPost: only
        # source 'post-stop' may publish completion, so a cutoff
        # cleanup here could only demote a healthy run to
        # failed_requires_review. That is exactly what the
        # 2026-11-07 30m run hit: monitoring and the clean stop
        # completed, the timer fired mid-finalization, and the run
        # ended failed_requires_review with a clean receipt, no
        # faults and no failure record. Deferring stays safe even
        # if that controller were stuck mid-stop: the worker's
        # session lease expires at the cutoff, so nothing keeps
        # trading.
        if record['status'] == 'finishing': return True
        try:
            request = self.b.decode(self.b.read_trusted(self.folder(record)/'stop-request.json'))
        except Exception:
            return False
        return request.get('id') == record['id'] and request.get('source') == 'normal'

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
            preset_restored = True
            if record.get('preset') == 'hard':
                # The worker is stopped and its databases verified by
                # now: put the pre-run settings back before the run is
                # finalized, so no later run or production start can
                # inherit the preset. A failure here must not publish
                # completion; admission heals a leftover on the next
                # start as a backstop.
                try:
                    self.restore_preset(record)
                except Exception:
                    preset_restored = False
                    self.fault(record, 'PRESET_RESTORE_FAILED')
                    self.receipt(record, 'failed_state_unknown', ['PRESET_RESTORE_FAILED'])
            # Only normal completion + post-stop may release the deployment gate.
            completed = preset_restored and not errors and record['status'] == 'finishing' and source == 'post-stop'
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

    def note_start_request(self, duration, preset='safe'):
        # The fixed systemd unit cannot receive the length, so the request
        # entrypoint leaves it as a root-owned note for the next run only.
        require(duration in DURATIONS)
        require(preset in PRESETS)
        self.b.atomic(self.state/'start-request.json',
                      {'duration': duration, 'preset': preset, 'at': int(time.time()*1000)})

    def take_start_request(self):
        path = self.state/'start-request.json'
        if not os.path.lexists(path):
            return '30m', 'safe'
        # Consume before validating, under a preserved name: a stale or
        # malformed note must never leak into a later run, and the last
        # request stays on disk as evidence either way.
        consumed = path.with_name('start-request-consumed.json')
        os.rename(path, consumed)
        with self.b.directory(self.state) as directory_fd:
            os.fsync(directory_fd)
        request = self.b.decode(self.b.read_trusted(consumed))
        require(set(request) in ({'duration', 'at'}, {'duration', 'at', 'preset'})
                and request['duration'] in DURATIONS and type(request['at']) is int
                and request.get('preset', 'safe') in PRESETS)
        now = int(time.time()*1000)
        require(request['at'] <= now+60000)
        if now-request['at'] > 600000:
            return '30m', 'safe'
        return request['duration'], request.get('preset', 'safe')

    def admit_session(self):
        with self.admission_evidence('admit'):
            self.retry_admitted = False
            config = self.b.decode(self.b.read_trusted(POLICY))
            require(config == {'enabled': True, 'mode': 'sui-30m'})
            self.admission_step('ADMISSION_LOCK')
            with self.locked('stop'), self.locked('mutation'):
                self.admission_step('ADMISSION_START_REQUEST')
                duration, preset = self.take_start_request()
                timer = cutoff_timer(duration)
                self.admission_step('ADMISSION_ABORT_INHIBIT')
                require(not self.admission_observe('inhibit_exists', (self.state/'abort-inhibit.json').exists()))
                self.admission_step('ADMISSION_QUIESCENT')
                self.quiescent()
                permit = None
                old_record = None
                old_preset_pending = False
                if self.record.exists():
                    self.admission_step('ADMISSION_PREVIOUS_RUN')
                    old = self.current()
                    if old['status'] == 'failed_requires_review':
                        self.admission_step('ADMISSION_RETRY_LATCH')
                        require(not os.path.lexists(self.b.STATE/'paper-check-failed.json'))
                        self.admission_step('ADMISSION_RETRY_MARKER')
                        marker = self.b.decode(self.b.read_trusted(self.b.STATE/'paper-check.json'))
                        require(marker == {'status': 'in_progress'})
                        permit = self.folder(old)/'retry-approved.json'
                        self.admission_step('ADMISSION_RETRY_CONSUMED')
                        require(not self.admission_observe('consumed_exists', os.path.lexists(permit.with_name('retry-consumed.json'))))
                        self.admission_step('ADMISSION_RETRY_PERMIT')
                        self.admission_observe('permit_exists', os.path.lexists(permit))
                        require(self.b.decode(self.b.read_trusted(permit)) == {'id': old['id']})
                    else:
                        self.admission_step('ADMISSION_PREVIOUS_STATUS')
                        require(old['status'] == 'completed')
                    self.admission_step('ADMISSION_PREVIOUS_EXIT')
                    require(self.exited(old))
                    self.admission_step('ADMISSION_PREVIOUS_STOP')
                    previous = self.b.decode(self.b.read_trusted(self.folder(old)/'stop.json'))
                    require(previous['id'] == old['id'] and previous['status'] == 'clean_stopped' and not self.faults(old))
                    old_record = old
                    old_preset_pending = old.get('preset') == 'hard'
                if old_preset_pending:
                    # A previous preset run whose finalization could not
                    # restore the settings (or died before it) is healed
                    # here, while the worker is stopped, before any new
                    # run may start. restore_preset is idempotent.
                    self.admission_step('ADMISSION_PRESET_RESTORE')
                    self.restore_preset(old_record)
                if permit is None:
                    self.admission_step('ADMISSION_FRESH_GATE')
                    self.b.Broker(state=self.b.STATE).check_paper_session()
                else:
                    # The retry approval is the human review of the failed
                    # run; it also authorizes clearing that run's stale
                    # runtime error once at this start (see
                    # maybe_reset_stale), the same reset the owner would
                    # press on the dashboard after reviewing the failure.
                    self.admission_step('ADMISSION_RETRY_CONSUME')
                    self.retry_admitted = True
                    self.consume_retry(old, permit)
                self.admission_step('ADMISSION_RECORD')
                now = int(time.time()*1000)
                self.run_id = uuid.uuid4().hex
                (self.state/self.run_id).mkdir(mode=0o700)
                identity, _ = self.identity(os.getpid())
                record = {'status': 'in_progress', 'id': self.run_id, 'controller': identity, 'admitted': False,
                          'started': now, 'cutoff': now+DURATIONS[duration]*1000, 'duration': duration,
                          'preset': preset}
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
                    env.get('PAPER_CHECK_MODE') == self.session_mode and provider_profile_ok(env))
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
        require(d['mode'] == 'PAPER' and d['databaseHealthy'] and d['ledgerOk'])
        paused = declared_pause(d)
        if paused:
            # A declared recovery pause (market data stale, worker waiting
            # for its own recovery proofs) is not a stopped run: keep
            # monitoring the container and host, suspend the freshness
            # window, and let the worker's episode deadline govern. Only
            # the outer bound above ends a pause from this side.
            if self.pause_since is None:
                self.pause_since = time.time()*1000
            require(time.time()*1000 - self.pause_since <= PAUSE_OUTER_LIMIT_MS)
        else:
            self.pause_since = None
            require(d['running'])
        require(self.api('GET', '/api/pairs')['selected'] == 'SUI_USDC')
        market = self.api('GET', '/api/dashboard/summary')['summary']['marketData']
        self.note_market(market)
        require(market['source'] == self.expected_source)
        if not paused:
            require(0 <= time.time()*1000-market['lastSuccessAt'] <= 90000)
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
                                                 'paused': paused,
                                                 'memory_percent': memory_percent, 'host_available_kib': available_kib,
                                                 'market_last_success': market['lastSuccessAt']})

    @contextlib.contextmanager
    def deployment_lock(self, operation=None):
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
            # Name this holder beside the lock, so a contending
            # broker failure can say WHO holds it — a running
            # supervisor is the normal case — instead of leaving a
            # bare OS_ERROR. The broker's holder record is written
            # and cleared by the same helpers on its own path.
            # Observation only: any failure here is suppressed and
            # changes nothing about the lock itself.
            with contextlib.suppress(Exception):
                self.b.write_lock_holder(self.b.STATE, 'controller',
                                         operation or ('prod-run' if self.session_mode == 'sui-prod' else 'run'), fd)
            yield
        finally:
            self._deployment_locked = False
            with contextlib.suppress(Exception):
                self.b.clear_lock_holder(self.b.STATE)
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
            if record.get('preset') == 'hard':
                self.guard('preset', lambda: self.apply_preset(record))
            stage = 'maintenance-release'
            self.note_stage(stage)
            try:
                self.guard('unlatch', lambda: self.maintenance(False))
                stage = 'worker-start'
                self.note_stage(stage)
                self.guard('worker-start', lambda: self.docker.call(['start', CONTAINER], timeout=20))
                # Readiness GETs only, plus the retry-approved stale
                # reset in maybe_reset_stale (idempotent; resent
                # until it lands). Never retry a start/arm/order
                # action.
                stage = 'worker-readiness'
                self.note_stage(stage)
                d = self.wait_ready(self.session_cutoff(record))
                stage = 'deployment-state'
                self.note_stage(stage)
                require(d['mode'] == 'PAPER' and not d['running'] and not d['maintenance'] and
                        d['databaseHealthy'] and d['ledgerOk'] and d['paperCheck']['enabled'] and not d['paperCheck']['armed'])
                if self.readiness.get('staleReset'):
                    with self.locked('mutation'):
                        current = self.current(self.run_id)
                        current['staleReset'] = True
                        self.b.atomic(self.record, current)
                        record = current
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
                if getattr(self, 'retry_admitted', False):
                    self.recheck_start_blockers(self.session_cutoff(record))
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
                # Declare the normal stop before anything else can
                # interleave: the stop-request is first-writer-wins
                # and the cutoff backstop defers to a 'normal' one.
                self.intent(record, 'normal')
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
                    if getattr(self, 'reset_refusal', None) in RESET_REFUSAL_CODES:
                        failure['reset_refusal'] = self.reset_refusal
                    if detail:
                        failure['http_status'] = error.code
                    if stage == 'worker-readiness':
                        failure['readiness'] = getattr(self, 'readiness', {})
                    if getattr(self, 'stale_reset_attempts', 0):
                        # Record the reset's outcome on failure too:
                        # the success path alone cannot distinguish
                        # "reset landed, error rewritten" from
                        # "reset never arrived" (2026-11-07).
                        failure['stale_reset'] = {'sent': True,
                            'ok': bool(getattr(self, 'stale_reset_ok', False)),
                            'attempts': int(self.stale_reset_attempts)}
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
        self.retry_admitted = False
        with self.locked('stop'), self.locked('mutation'):
            require(not os.path.lexists(self.state/'abort-inhibit.json') and not os.path.lexists(self.state/'failed.json'))
            self.quiescent()
            self.validation_closed()
            if self.record.exists():
                old = self.current()
                require(old['status'] == 'completed' and self.exited(old) and not self.faults(old))
                receipt = self.b.decode(self.b.read_trusted(self.folder(old)/'stop.json'))
                require(receipt['id'] == old['id'] and receipt['status'] == 'clean_stopped')
                # F-10: a predecessor that failed and was closed out
                # by prod_stop (R3) keeps failure.json in its folder
                # as evidence. That close-out was the human review
                # of the failure, so — mirroring the paper retry
                # permit — it authorizes clearing the failed
                # session's stale runtime error once at this start
                # (see maybe_reset_stale); without it the worker's
                # latched error makes every later start fail at
                # worker-readiness. Any doubt (failure evidence
                # missing, unreadable, or naming another record)
                # stays a fresh start: detection never raises.
                try:
                    failure = self.b.decode(self.b.read_trusted(self.folder(old)/'failure.json'))
                    if type(failure) is dict and failure.get('id') == old['id']:
                        self.retry_admitted = True
                except Exception:
                    pass
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
        if getattr(self, '_deployment_locked', False):
            return self._cleanup_locked(record, own, source)
        try:
            with self.deployment_lock('prod-cleanup'):
                return self._cleanup_locked(record, own, source)
        except BlockingIOError:
            # The deployment lock is held by a deployment in flight:
            # pure contention, not failure evidence (audit F-9).
            # stop() faults any exception escaping cleanup as
            # CLEANUP_LOCK_OR_STATE_UNKNOWN, which would latch a
            # permanent fault — and the failed.json fence — for a
            # transient race. Return False instead: the stop reports
            # failure, nothing is latched, and a later attempt can
            # proceed once the deployment finishes. A lock-file
            # shape failure still raises: a malformed lock is real
            # state trouble, not contention.
            return False

    def _cleanup_locked(self, record, own, source):
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
        if not completed:
            # Observation only, after the failed status is durable:
            # persist the mid-run failure's concrete reason while
            # the worker's final state still exists to read. Never
            # allowed to change the close-out's outcome.
            with contextlib.suppress(Exception):
                self.note_run_failure(record)
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

    @staticmethod
    def started_at_epoch(value):
        # Docker reports StartedAt as RFC3339 (UTC 'Z' or an explicit
        # offset), with the zero time for a container that has never
        # started. Return the instant as a float epoch, or None when
        # the value is not a timestamp this code can prove.
        if not isinstance(value, str):
            return None
        match = re.fullmatch(
            r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?'
            r'(Z|[+-]\d{2}:?\d{2})', value)
        if not match:
            return None
        import calendar
        epoch = float(calendar.timegm(
            tuple(int(match.group(i)) for i in range(1, 7)) + (0, 0, 0)))
        if match.group(7):
            digits = (match.group(7) + '000000')[:6]
            epoch += int(digits)/1e6
        zone = match.group(8)
        if zone not in ('Z', '+00:00', '-00:00', '+0000', '-0000'):
            digits = zone[1:].replace(':', '')
            offset = int(digits[:2])*3600 + int(digits[2:])*60
            epoch -= offset if zone[0] == '+' else -offset
        return epoch

    def preflight_closeout_eligible(self, record):
        # Fail-closed evidence check for the one production failure
        # the normal stop path can never close: a run that died in
        # preflight, with the worker never started. stop_checks
        # faults a not-admitted record with PREFLIGHT_INCOMPLETE by
        # construction, so cleanup's completion condition is
        # unreachable and prod_start then refuses the record
        # forever. The admitted flag cannot be the discriminator
        # (audit F-3): preflight persists the admission flip before
        # ProductionController.preflight persists stage='backup',
        # so a death between the two writes leaves admitted=True at
        # stage 'preflight', with the worker never started — and
        # the boundary shape is wedged behind the stop intent its
        # own failure cleanup wrote first instead (cleanup completes
        # only for a 'prod-stop' intent). The evidence that
        # separates both shapes is failure.json at the preflight
        # stage plus the container never having started for this
        # session. Any doubt — unreadable evidence, an unexpected
        # fault, a pending mutation, a container that ran at or
        # after this session began — keeps the record in manual
        # reconciliation.
        try:
            folder = self.folder(record)
            failure = self.b.decode(self.b.read_trusted(folder/'failure.json'))
            if failure.get('id') != record['id'] or failure.get('stage') != 'preflight':
                return False
            pending = folder/'mutation.json'
            if pending.exists() and \
                    self.b.decode(self.b.read_trusted(pending)).get('pending') is not None:
                return False
            state = self.inspect()['State']
            if state.get('Running'):
                return False
            started_at = state.get('StartedAt')
            if started_at != '0001-01-01T00:00:00Z':
                epoch = self.started_at_epoch(started_at)
                if epoch is None or epoch >= record['started']/1000:
                    return False
            # LATCHED_FAILURE is a derived code, not an independent
            # failure: stop_checks appends it whenever a stop attempt
            # observes a failure that is already latched, and faults
            # it alongside the original code. A record that failed in
            # preflight and then went through one more stop attempt
            # therefore carries both codes without any new failure
            # having occurred, so both are accepted here; the other
            # conditions (failure.json at the preflight stage, no
            # pending mutation, the container never started for this
            # session, the latch naming this record) still gate the
            # close-out. PREFLIGHT_INCOMPLETE is only ever faulted
            # for a not-admitted record, so the F-3 boundary shape
            # may carry just LATCHED_FAILURE or no fault at all; the
            # accepted set bounds both shapes either way. Any other
            # fault code refuses.
            for fault in folder.glob('fault-*.json'):
                if self.b.decode(self.b.read_trusted(fault)).get('error') \
                        not in ('PREFLIGHT_INCOMPLETE', 'LATCHED_FAILURE'):
                    return False
            latch = self.state/'failed.json'
            if os.path.lexists(latch) and \
                    self.b.decode(self.b.read_trusted(latch)).get('id') != record['id']:
                return False
            return True
        except Exception:
            return False

    def admitted_closeout_eligible(self, record):
        # Fail-closed evidence check for the production failure the
        # preflight close-out cannot reach: a run that was admitted,
        # ran, and then failed (the first production run's upstream
        # HTTP 500 hard stop is the field case). The normal stop
        # path can never close it either: stop() faults the record
        # while closing a run whose controller is already gone —
        # CONTROLLER_EXIT_UNCONFIRMED when it cannot terminate the
        # dead controller, LATCHED_FAILURE from stop_checks whenever
        # a fault is already latched — so cleanup's completion
        # condition (no errors, no faults) stays unreachable and
        # prod_start refuses the record forever. Eligibility
        # therefore re-verifies everything the normal path would
        # have proven — the run's own failure record, a clean
        # container exit for this session, the same database
        # verification stop_checks runs, a dead controller, and no
        # pending mutation beyond a stranded guard operation proven
        # not in effect (audit F-2, below) — and accepts only the
        # faults the stop machinery itself produces. Any doubt —
        # unreadable evidence, an unclean exit, a failed
        # verification, an unexpected fault — keeps the record in
        # manual reconciliation.
        try:
            if record.get('admitted') is not True:
                return False
            folder = self.folder(record)
            failure = self.b.decode(self.b.read_trusted(folder/'failure.json'))
            if failure.get('id') != record['id']:
                return False
            # A guarded operation that dies on a non-4xx error
            # leaves its pending marker in mutation.json (guard
            # clears it only on success or a definitive 4xx
            # refusal), and only the dead runner could ever clear
            # it, so a stranded pending is judged here instead of
            # refused outright (audit F-2). It is acceptable only
            # when it names exactly the operation of the stage
            # failure.json records — guard() journals the operation
            # name while the failure record carries the run stage;
            # GUARD_STAGE_OPERATIONS maps the two — and the
            # operation is then proven not in effect by the
            # container and database evidence below. A pending
            # whose stage mismatches the failure record, or that
            # names no guarded stage at all, still refuses.
            pending = None
            mutation = folder/'mutation.json'
            if mutation.exists():
                pending = self.b.decode(
                    self.b.read_trusted(mutation)).get('pending')
            pending_closeout = False
            if pending is not None:
                if type(pending) is not str or \
                        GUARD_STAGE_OPERATIONS.get(failure.get('stage')) != pending:
                    return False
                pending_closeout = True
            state = self.inspect()['State']
            if state.get('Running') or state.get('ExitCode') != 0 or state.get('OOMKilled'):
                return False
            if pending_closeout and failure.get('stage') in ('backup', 'maintenance-release'):
                # Both stages run before the worker starts, so the
                # not-in-effect proof is the preflight one: the
                # container never started for this session. (A
                # backup stranded without its pending — the record
                # write after the backup itself — keeps the started
                # proof below and stays refused; it is a different
                # shape from F-2's.)
                started_at = state.get('StartedAt')
                if started_at != '0001-01-01T00:00:00Z':
                    epoch = self.started_at_epoch(started_at)
                    if epoch is None or epoch >= record['started']/1000:
                        return False
            else:
                epoch = self.started_at_epoch(state.get('StartedAt'))
                if epoch is None or epoch < record['started']/1000 - 60:
                    return False
            self.maintenance(True)
            helper, image = self.helper()
            helper.helper(image, 'verify')
            self.verify_sui()
            if not self.exited(record):
                return False
            # The four accepted codes are produced by the stop
            # machinery itself when it closes a run whose controller
            # is already gone, and none of them records an
            # independent failure of the run: stop() faults
            # CONTROLLER_EXIT_UNCONFIRMED when it cannot terminate
            # the dead controller, STOP_LOCK_OR_STATE_UNKNOWN and
            # CLEANUP_LOCK_OR_STATE_UNKNOWN when its own lock or
            # cleanup step cannot complete against the dead run,
            # and stop_checks appends the derived LATCHED_FAILURE
            # whenever a stop attempt observes an already-latched
            # failure. The run's actual failure is proven by the
            # evidence above (failure.json naming this record, the
            # container's clean exit, the database verification),
            # so these codes add no failure information of their
            # own; any other fault code refuses.
            accepted = ('LATCHED_FAILURE', 'CONTROLLER_EXIT_UNCONFIRMED',
                        'STOP_LOCK_OR_STATE_UNKNOWN',
                        'CLEANUP_LOCK_OR_STATE_UNKNOWN')
            if pending_closeout:
                # OPERATION_COMPLETION_UNCONFIRMED is faulted by
                # stop_checks whenever a stop attempt observes the
                # stranded pending. In this branch the pending
                # itself has just been proven — stage match, the
                # operation not in effect, the databases verified —
                # so the code records the pending's existence and
                # nothing else, exactly like the derived codes
                # above. Without the pending proof (no pending, or
                # a pending that did not match) it keeps refusing,
                # as does any other code.
                accepted += ('OPERATION_COMPLETION_UNCONFIRMED',)
            for fault in folder.glob('fault-*.json'):
                if self.b.decode(self.b.read_trusted(fault)).get('error') \
                        not in accepted:
                    return False
            latch = self.state/'failed.json'
            if os.path.lexists(latch) and \
                    self.b.decode(self.b.read_trusted(latch)).get('id') != record['id']:
                return False
            return True
        except Exception:
            return False

    def retire_orphan_latch(self):
        # Audit F-7: a production failed.json with no record at
        # all is an orphan — run() writes the latch for a runner
        # that died before it could publish its record — and
        # nothing else ever removes it, so prod_start would refuse
        # forever behind a latch that names no record. Retire it
        # as evidence (never delete it) so a later start is no
        # longer blocked by it. A latch that cannot be decoded
        # stays exactly where it is: unreadable evidence is not
        # destroyed, prod_start keeps refusing, and the operator
        # sees the latch in prod_status.
        latch = self.state/'failed.json'
        if not os.path.lexists(latch):
            return
        try:
            value = self.b.decode(self.b.read_trusted(latch))
            require(type(value) is dict)
        except Exception:
            return
        run_id = value.get('id')
        name = run_id if type(run_id) is str and \
            re.fullmatch(r'[a-f0-9]{32}', run_id) else 'unknown'
        target = self.state/('failed-orphan-'+name+'.json')
        if os.path.lexists(target):
            target = self.state/('failed-orphan-'+name+'-'+str(int(time.time()))+'.json')
        os.replace(latch, target)
        with self.b.directory(self.state) as directory_fd:
            os.fsync(directory_fd)

    def prod_stop(self):
        self.prepare_state()
        with self.locked('stop'):
            self.consume_start(cancelled=True)
            if not self.record.exists():
                self.retire_orphan_latch()
                with contextlib.suppress(Exception):
                    self.system('stop', '--no-block', PROD_SERVICE)
                return {'status': 'not_started'}
            record = self.current()
            if record['status'] == 'failed_requires_review':
                with self.locked('mutation'):
                    if self.preflight_closeout_eligible(record):
                        # Close the pre-admission failure out as a
                        # clean stop: the worker never ran, so there
                        # is nothing to stop and no state to verify
                        # beyond the evidence just checked. Remove the
                        # latch artifacts the failed run's own cleanup
                        # left, so the next prod_start sees the same
                        # clean state as after a normal stop.
                        self.receipt(record, 'clean_stopped', [])
                        for fault in self.folder(record).glob('fault-*.json'):
                            fault.unlink()
                        latch = self.state/'failed.json'
                        if os.path.lexists(latch):
                            latch.unlink()
                        record['status'] = 'completed'
                        record['stopped'] = int(time.time()*1000)
                        record['stage'] = 'stopped'
                        self.b.atomic(self.record, record)
                        return {'status': 'completed'}
                    if self.admitted_closeout_eligible(record):
                        # Close the post-admission failure out as a
                        # clean stop: the worker already stopped on
                        # its own failure and the eligibility check
                        # re-verified the container exit and the
                        # databases, so there is nothing left to
                        # stop. Remove the latch artifacts the stop
                        # attempts left, so the next prod_start sees
                        # the same clean state as after a normal
                        # stop. failure.json stays in the folder as
                        # the record of why the run failed.
                        self.receipt(record, 'clean_stopped', [])
                        for fault in self.folder(record).glob('fault-*.json'):
                            fault.unlink()
                        latch = self.state/'failed.json'
                        if os.path.lexists(latch):
                            latch.unlink()
                        record['status'] = 'completed'
                        record['stopped'] = int(time.time()*1000)
                        record['stage'] = 'stopped'
                        self.b.atomic(self.record, record)
                        return {'status': 'completed'}
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

    def backup_state(self, record):
        """The watchdog's backup confirmation, as a state: the run
        record names the archive, and the archive is on disk with
        the expected owner and shape. Integrity (the hash) stays
        with start/stop, exactly as in the watchdog."""
        backup = record.get('backup')
        if backup is None:
            return 'unconfirmed'
        if not (type(backup) is dict and set(backup) == {'file', 'sha256'} and
                type(backup['file']) is str and
                re.fullmatch(r'paper-check-[0-9a-f]{32}\.tar', backup['file']) and
                type(backup['sha256']) is str and re.fullmatch(r'[0-9a-f]{64}', backup['sha256'])):
            return 'unknown'
        try:
            info = (self.b.BACKUPS/backup['file']).lstat()
        except Exception:
            return 'unconfirmed'
        return 'confirmed' if (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                                info.st_nlink == 1) else 'unconfirmed'

    def fault_code(self, record):
        """The first recorded fault code for the run, strictly
        shaped, or None. Fault files are the run's own sticky
        evidence ({id, error}); anything malformed is skipped."""
        try:
            paths = sorted((self.state/record['id']).glob('fault-*.json'))[:4]
        except Exception:
            return None
        for path in paths:
            try:
                value = self.b.decode(self.b.read_trusted(path))
            except Exception:
                continue
            if (type(value) is dict and value.get('id') == record['id'] and
                    type(value.get('error')) is str and
                    re.fullmatch(r'[A-Z][A-Z_]{2,47}', value['error'])):
                return value['error']
        return None

    def worker_stop_code(self):
        """The worker's own latched stop reason, read from its
        runtime row, or None. Read-only and best-effort: close-out
        runs after stop_checks stopped the container, so the row
        is quiet — the preset snapshot reads the same file the
        same way after a stop, and the backup audit reads the
        same row from the archives. Only this session's reason
        can be present: wait_ready() returned only once the
        deployment reported startReady, which requires a clear
        runtime row, so an error latched at a monitoring-stage
        close-out was latched by this session. The value is
        sanitized to the code shape the failure summary carries
        (the worker's own vocabulary is upper-snake, capped at
        the summary's length); anything unexpected degrades to
        the generic code the audit program maps unknowns to."""
        try:
            with contextlib.closing(sqlite3.connect(
                    f'file:{self.sui_db_path()}?mode=ro', uri=True)) as db:
                row = db.execute(
                    "SELECT json FROM bot_runtime_state WHERE key='runtime'").fetchone()
            state = json.loads(row[0]) if row is not None else None
            if type(state) is not dict:
                return None
            if state.get('emergency') is True:
                # The worker's own snapshot names an emergency
                # stop ahead of any latched error.
                return 'EMERGENCY_STOP'
            error = state.get('error')
            if error is None:
                return None
            if type(error) is str and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', error):
                return error
            return 'OTHER_RUNTIME_ERROR'
        except Exception:
            return None

    def host_stop_reason(self):
        """Best-effort facts only, through the existing inspect and read-only DB paths.

        Missing or malformed evidence never proves an external stop. Times in
        operation_state are epoch milliseconds; Docker FinishedAt is UTC.
        """
        detail = dict(containerStatus=None, exitCode=None, oomKilled=None,
                      containerFinishedAt=None, lastAnalysisAt=None,
                      lastFetchSuccessAt=None, lastHealthyAt=None, gapSeconds=None)
        runtime_clear = False
        try:
            state = self.inspect()['State']
            if state.get('Status') in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'):
                detail['containerStatus'] = state['Status']
            if type(state.get('ExitCode')) is int:
                detail['exitCode'] = state['ExitCode']
            if type(state.get('OOMKilled')) is bool:
                detail['oomKilled'] = state['OOMKilled']
            finished = state.get('FinishedAt')
            if type(finished) is str and re.fullmatch(
                    r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z', finished):
                parsed = datetime.datetime.fromisoformat(finished.replace('Z', '+00:00'))
                if parsed.year > 1970:
                    detail['containerFinishedAt'] = finished
        except Exception:
            pass
        try:
            with contextlib.closing(sqlite3.connect(
                    f'file:{self.sui_db_path()}?mode=ro', uri=True)) as db:
                rows = dict(db.execute("SELECT key, json FROM bot_runtime_state "
                                       "WHERE key IN ('runtime', 'operation_state')"))
            runtime = json.loads(rows.get('runtime', 'null'))
            runtime_clear = (type(runtime) is dict and 'error' in runtime and
                             runtime['error'] is None and runtime.get('emergency') is not True)
            timing = json.loads(rows.get('operation_state', 'null'))
            if type(timing) is dict:
                for key in ('lastAnalysisAt', 'lastFetchSuccessAt'):
                    value = timing.get(key)
                    if type(value) in (int, float) and math.isfinite(value) and 0 < value <= 2**53:
                        detail[key] = value
        except Exception:
            pass
        healthy = [detail[key] for key in ('lastAnalysisAt', 'lastFetchSuccessAt')
                   if detail[key] is not None]
        if healthy:
            detail['lastHealthyAt'] = max(healthy)
        if detail['containerFinishedAt'] is not None and healthy:
            detail['gapSeconds'] = parsed.timestamp() - detail['lastHealthyAt']/1000
        code = 'UNKNOWN'
        if detail['oomKilled'] is True:
            code = 'WORKER_OOM'
        elif detail['containerStatus'] in ('exited', 'dead'):
            if detail['exitCode'] is not None and detail['exitCode'] != 0:
                code = 'WORKER_EXITED'
            elif detail['exitCode'] == 0 and runtime_clear and detail['gapSeconds'] is not None:
                gap = detail['gapSeconds']
                if gap <= 300:
                    code = 'EXTERNAL_STOP'
                elif gap > 300:
                    code = 'WORKER_EXITED_CLEAN'
        return code, detail

    def note_run_failure(self, record):
        """Persist a mid-run failure's concrete reason into the
        run's failure record, so the read-only status — and with
        it the monitor Issue and the STOP follow-up — can name
        WHY a session that ran for hours closed as
        failed_requires_review, not only THAT it did. Before
        this, failure.json was written only by the run()
        exception handlers: a controller that died mid-run left
        no failure record at all, and one that caught the
        failure recorded the stage and at most an HTTP status or
        a market snapshot — never the worker's stop reason.

        Monitoring-stage close-outs only: the stage proves the
        session passed readiness and actually ran (see
        worker_stop_code for why the reason is this session's).
        Existing failure evidence is preserved; only a missing
        code is filled, from the first source that knows one:
        the worker's latched stop reason, the market snapshot
        already on the failure record, then the stop machinery's
        first fault, then host/container and DB timing facts (UNKNOWN
        if those cannot explain the exit). Unreadable evidence is
        left untouched."""
        if record.get('stage') != 'monitoring':
            return
        path = self.folder(record)/'failure.json'
        failure = None
        if path.exists():
            try:
                value = self.b.decode(self.b.read_trusted(path))
                require(type(value) is dict and value.get('id') == record['id'] and
                        value.get('stage') in DIAGNOSTIC_STAGES)
                failure = value
            except Exception:
                return
            if failure.get('code') or failure.get('reset_refusal'):
                return
        code = self.worker_stop_code()
        if code is None and failure is not None:
            market = failure.get('market')
            if type(market) is dict:
                reason = market.get('reason')
                if type(reason) is str and \
                        re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', reason):
                    code = reason
        if code is None:
            code = self.fault_code(record)
        if failure is None:
            failure = {'id': record['id'], 'stage': 'monitoring'}
        if code is None:
            code, failure['detail'] = self.host_stop_reason()
        failure['code'] = code
        self.b.atomic(path, failure)

    def failure_summary(self, record):
        """Bounded, lock-free read of the run's failure evidence for
        the read-only status — the diagnosis the owner otherwise
        needs a root terminal to see. Fixed keys, validated values
        only (the same shapes diagnose() gates on); each field
        degrades to unknown on its own when its evidence is missing
        or malformed, and nothing here raises or writes. None when
        the run carries no failure evidence at all, so a healthy
        response keeps its exact existing shape. No gate reads
        this; it is observation only."""
        folder = self.state/record['id']
        failed = record['status'] == 'failed_requires_review'
        if not (failed or os.path.lexists(folder/'failure.json') or
                os.path.lexists(folder/'preflight.json') or self.faults(record)):
            return None
        summary = {'status': record['status'], 'stage': None, 'code': None,
                   'http_status': None, 'backup': self.backup_state(record)}
        try:
            value = self.b.decode(self.b.read_trusted(folder/'failure.json'))
            require(type(value) is dict and value.get('id') == record['id'] and
                    value.get('stage') in ('preflight', 'backup', 'stopped', *DIAGNOSTIC_STAGES))
            summary['stage'] = value['stage']
            refusal = value.get('reset_refusal')
            if type(refusal) is str and refusal in RESET_REFUSAL_CODES:
                summary['code'] = refusal
            recorded = value.get('code')
            if summary['code'] is None and type(recorded) is str and \
                    re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', recorded):
                # A code the close-out itself persisted for a
                # mid-run failure (see note_run_failure): the
                # worker's own stop reason, captured while the
                # evidence still existed to read.
                summary['code'] = recorded
            http = value.get('http_status')
            if type(http) is int and 100 <= http <= 599:
                summary['http_status'] = http
        except Exception:
            pass
        if summary['code'] is None:
            summary['code'] = self.fault_code(record)
        if summary['stage'] is None or summary['code'] is None:
            try:
                value = self.b.decode(self.b.read_trusted(folder/'preflight.json'))
                require(type(value) is dict and value.get('id') == record['id'] and
                        value.get('check') in PREFLIGHT_CHECKS and
                        type(value.get('error')) is str and
                        re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', value['error']))
                if summary['code'] is None:
                    summary['code'] = value['error']
                if summary['stage'] is None:
                    # A preflight record exists only when preflight
                    # itself failed, so it names the stage exactly.
                    summary['stage'] = 'preflight'
            except Exception:
                pass
        if summary['stage'] is None and failed:
            summary['stage'] = record['stage']
        return summary

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
        # The abort inhibit joins requires_review: nothing in the
        # repo writes production/abort-inhibit.json, yet prod_start
        # refuses while one exists, so its presence must be
        # discoverable here instead of surfacing only as a
        # reasonless start refusal (audit F-8).
        result = {'run': run, 'controller_alive': alive, 'worker': worker,
                  'requires_review': record['status'] == 'failed_requires_review' or self.faults(record)
                                     or os.path.lexists(self.state/'abort-inhibit.json'),
                  'watchdog': watchdog}
        failure = self.failure_summary(record)
        if failure is not None:
            result['failure'] = failure
        return result

    def export_prod_snapshot(self):
        # Read-only public extract of the LIVE production databases, feeding
        # the daily production review. The worker is never stopped, signalled
        # or reconfigured, and no helper container runs: each database is
        # copied with the sqlite backup API (a read transaction against the
        # running writer, WAL content included), the copies are tarred in
        # memory, and the pinned export program applies the same allowlist
        # and sanitizer as the pre-run extract.
        stage = 'EXPORT_RUN_INVALID'
        try:
            record = self.current()
            stage = 'EXPORT_PROD_NOT_RUNNING'
            require(record['status'] == 'in_progress')
            stage = 'EXPORT_PROGRAM_INVALID'
            program = self.b.read_trusted(EXPORT_PROGRAM, maximum=PROGRAM_READ_MAXIMUM)
            scope = {'__name__': 'trusted_snapshot_export'}
            exec(compile(program, str(EXPORT_PROGRAM), 'exec'), scope)
            stage = 'EXPORT_DATABASE_INVALID'
            root = self.data_dir()
            stream = io.BytesIO()
            with tempfile.TemporaryDirectory(prefix='suiba-prod-snapshot-') as tmp:
                folder = Path(tmp)
                names = []
                # Mirrors DATABASES in the export program: the main database
                # is required, the WAL pair database joins when present.
                for name in ('bot.sqlite', 'bot.sqlite.WAL_USDC.sqlite'):
                    source_path = root/name
                    if not source_path.is_file():
                        continue
                    source = sqlite3.connect(source_path.as_uri()+'?mode=ro', uri=True)
                    try:
                        destination = sqlite3.connect(folder/name)
                        try:
                            source.backup(destination)
                        finally:
                            destination.close()
                    finally:
                        source.close()
                    names.append(name)
                require('bot.sqlite' in names)
                with tarfile.open(fileobj=stream, mode='w') as archive:
                    for name in names:
                        archive.add(folder/name, arcname='./'+name)
            digest = hashlib.sha256(stream.getvalue()).hexdigest()
            stream.seek(0)
            return scope['build_live_export'](stream, record, digest)
        except Exception as error:
            code = getattr(error, 'code', None)
            raise SnapshotExportRejected(code if code in EXPORT_CODES else stage) from None


def request_caller(environ, getpwnam):
    """Classify the sudo caller of a `request` invocation.

    `suiba-deploy` is the full CI identity. `suiba-observe` is a read-only
    monitoring identity: the caller check is the SUDO_USER/SUDO_UID pair sudo
    itself sets, and the scope check below is what confines it. Any other
    caller is refused."""
    user = environ.get('SUDO_USER')
    require(user in ('suiba-deploy', 'suiba-observe'))
    account = getpwnam(user)
    require(environ.get('SUDO_UID') == str(account.pw_uid))
    return 'observe' if user == 'suiba-observe' else 'deploy'


def valid_episode(value):
    """Strict shape for the sanitized episode summary the diagnostic query
    extracts from a closing operation event ({s, m, f, y} = startedAt,
    durationMs, failures, tally; optional o = outcome, l = lastFailureAt).
    Mirrors sanitizeEpisode in DIAGNOSTIC_QUERY; any surprise makes the
    audit evidence invalid. Tally keys are "<api>/<code>" and the api
    names contain spaces ("DeepBook Indexer", "Sui gRPC")."""
    if type(value) is not dict or not {'s', 'm', 'f', 'y'} <= set(value) <= {'s', 'm', 'f', 'y', 'o', 'l'}:
        return False
    if any(type(value[key]) not in (int, float) or value[key] < 0 for key in ('s', 'm', 'f')):
        return False
    if 'o' in value and value['o'] not in ('RECOVERED', 'EXHAUSTED', 'STOPPED', 'INTERRUPTED'):
        return False
    if 'l' in value and (type(value['l']) not in (int, float) or value['l'] < 0):
        return False
    tally = value['y']
    if type(tally) is not dict or len(tally) > 8:
        return False
    return all(type(key) is str
               and re.fullmatch(r'[A-Za-z][A-Za-z0-9 ]{0,31}/[A-Z][A-Z0-9_]{0,63}', key)
               and type(count) is int and 1 <= count <= 100000
               for key, count in tally.items())


def valid_episode_ref(value):
    """The diagnostic query's latest-closed-episode pointer:
    {t, c, e} = the closing event's timestamp, its code and the
    sanitized episode summary it carries."""
    return type(value) is dict and set(value) == {'t', 'c', 'e'} \
        and type(value['t']) in (int, float) \
        and type(value['c']) is str \
        and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', value['c']) is not None \
        and valid_episode(value['e'])


def valid_latency(value):
    """The diagnostic query's compact indexer latency summary:
    {c, b, s} for the candles/book/status read classes, each
    either null or [total network samples, median ms, max ms]
    with an optional fourth element, the TTL cache-hit count
    counted apart from the samples."""
    if type(value) is not dict or set(value) != {'c', 'b', 's'}:
        return False
    for bucket in value.values():
        if bucket is None:
            continue
        if type(bucket) is not list or len(bucket) not in (3, 4):
            return False
        if type(bucket[0]) is not int or bucket[0] < 1:
            return False
        if any(item is not None and type(item) not in (int, float) for item in bucket[1:3]):
            return False
        if len(bucket) == 4 and (type(bucket[3]) is not int or bucket[3] < 0):
            return False
    return True


def require_caller_scope(caller, request):
    """The observe identity may only ever read: the paper-check status,
    the production status, or the fixed public extract of the live
    production databases (the same allowlisted, sanitized package the
    export workflow publishes). All three requests are exact,
    argument-free and read-only; anything else, and any extra key, is
    refused."""
    if caller == 'observe':
        require(request in ({'operation': 'status'}, {'operation': 'prod-status'},
                            {'operation': 'export-prod-snapshot'}))


# Outer bound for a declared recovery pause during monitoring. The worker's
# own stale-episode deadline is 30 minutes and its resume proofs take about
# two more; a worker that exhausts its deadline latches a runtime error,
# which ends the pause classification below and fails the run at once. This
# bound is only the backstop for a pause that somehow never resolves and
# never errors (decided 2026-11-08 after two validation runs were finalized
# by the first monitoring poll that saw running=false).
PAUSE_OUTER_LIMIT_MS = 40 * 60 * 1000


def declared_pause(deployment):
    """True only for the worker's declared recovery pause: not running, but
    connectivity is degraded (a recovery episode is open), no runtime error
    is latched, and no emergency is active. A plain stop, a latched error,
    and an emergency are not pauses and keep failing monitoring at once."""
    readiness = deployment.get('readiness')
    if type(readiness) is not dict:
        return False
    return (deployment.get('running') is False
            and readiness.get('connectivity') is False
            and readiness.get('runtimeClear') is True
            and readiness.get('emergencyClear') is True)


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
            caller = request_caller(os.environ, pwd.getpwnam)
            signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(RuntimeError()))
            signal.alarm(5)
            request = b.decode(sys.stdin.buffer.read(257))
            signal.alarm(0)
            require_caller_scope(caller, request)
            require(isinstance(request, dict) and set(request) <= {'operation', 'duration', 'mode', 'sha', 'preset'} and
                    request.get('operation') in ('start', 'status', 'abort', 'diagnose', 'reconcile', 'approve-retry', 'approve-deploy', 'revoke-retry', 'release-cutoff', 'heal-run', 'export-snapshot', 'export-prod-snapshot', 'prod-start', 'prod-stop', 'prod-status'))
            require(request['operation'] in ('start', 'reconcile', 'approve-deploy') or set(request) == {'operation'})
            require(request['operation'] in ('reconcile', 'approve-deploy') or 'sha' not in request)
            require(request['operation'] == 'start' or 'duration' not in request)
            require(request['operation'] == 'start' or 'preset' not in request)
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
            elif request['operation'] == 'heal-run':
                print(json.dumps(controller.heal_run()))
            elif request['operation'] == 'export-snapshot':
                sys.stdout.buffer.write(controller.export_snapshot())
            elif request['operation'] == 'export-prod-snapshot':
                sys.stdout.buffer.write(ProductionController(b).export_prod_snapshot())
            elif request['operation'] == 'diagnose':
                print(json.dumps(controller.diagnose()))
            elif request['operation'] == 'status':
                print(json.dumps(controller.status()))
            elif request['operation'] == 'start':
                require(not (controller.state/'abort-inhibit.json').exists())
                preset = request.get('preset', 'safe')
                require(preset in PRESETS)
                controller.note_start_request(duration, preset)
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
    except BaseException as error:
        if isinstance(error, AdmissionRejected) and error.code in ADMISSION_CODES:
            print('PAPER_CHECK_REASON='+error.code, file=sys.stderr)
        if isinstance(error, SnapshotExportRejected) and error.code in EXPORT_CODES:
            print('PAPER_EXPORT_REASON='+error.code, file=sys.stderr)
        print('PAPER_CHECK_FAILED; inspect root-owned state; no automatic restart', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
