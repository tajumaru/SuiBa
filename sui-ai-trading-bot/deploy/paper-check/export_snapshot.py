"""Public, allowlisted extracts from a pinned PRE-RUN archive. No live DB access."""
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import re
import sqlite3
import tarfile
import tempfile
import time
import zipfile

ARCHIVE_LIMIT = 128 * 1024**2
EXPORT_LIMIT = 16 * 1024**2
ROW_LIMIT = 100000
TABLES = ('shadow_decisions', 'strategy_decisions', 'technical_indicators', 'operation_candidates',
          'paper_orders', 'paper_trades', 'operation_events', 'cycle_audits')
DATABASES = {'bot.sqlite': 'SUI_USDC.sqlite', 'bot.sqlite.WAL_USDC.sqlite': 'WAL_USDC.sqlite'}
ERROR_CODES = frozenset(('EXPORT_BACKUP_MISSING', 'EXPORT_MANIFEST_MISMATCH', 'EXPORT_ARCHIVE_INVALID',
    'EXPORT_LIMIT_EXCEEDED', 'EXPORT_DATABASE_INVALID', 'EXPORT_RUN_INVALID', 'EXPORT_PACKAGE_INVALID',
    'EXPORT_PROD_NOT_RUNNING'))
INDICATORS = frozenset('ema20 ema50 rsi macd signal histogram atr volumeChange priceChange'.split())
CONDITIONS = frozenset('hasPosition stopLoss takeProfit latestVolumePositive previousVolumePositive volumeChangeExceeded emaUp emaGapShrinking rsiRecovery histogramImproving emaDown rsiReversal histogramDeclining'.split())
RULES = frozenset('NO_SIGNAL STOP_LOSS TAKE_PROFIT VOLUME_REJECT BUY_SIGNAL SELL_SIGNAL'.split())
EVENT_CODES = frozenset('''MANUAL_START MANUAL_STOP EMERGENCY_STOP PROCESS_SHUTDOWN
UPSTREAM_TIMEOUT UPSTREAM_CONNECT_TIMEOUT UPSTREAM_HEADERS_TIMEOUT UPSTREAM_BODY_TIMEOUT
UPSTREAM_NETWORK_FAILED UPSTREAM_DNS_FAILED UPSTREAM_HTTP_429 UPSTREAM_HTTP_502 UPSTREAM_HTTP_503
UPSTREAM_HTTP_504 MARKET_DATA_STALLED STALE_CANDLES CANDLE_GAP INVALID_CANDLE INSUFFICIENT_CANDLES
PAPER_RECOVERY_EXHAUSTED PAPER_RECONCILIATION_FAILED SUI_READ_FAILED API_BACKOFF
CONSECUTIVE_API_ERRORS MARKET_SOURCE_CHANGED MARKET_PAIR_MISMATCH VALIDATION_RECORD_FAILED
DATABASE_UNAVAILABLE PROCESS_RESTART_INTERRUPTED PROCESS_RESTART_STOPPED
PAPER_NETWORK_PAUSED PAPER_NETWORK_RECOVERED'''.split())
EPISODE_OUTCOMES = frozenset(('RECOVERED', 'EXHAUSTED', 'STOPPED', 'INTERRUPTED'))
TALLY_KEY = re.compile(r'[A-Za-z][A-Za-z0-9 ]{0,31}/[A-Z][A-Z0-9_]{0,63}')


class ExportError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def check(value, code):
    if not value: raise ExportError(code)


def number(value):
    return type(value) in (int, float) and abs(value) <= 2**53 and math.isfinite(value)


def identifier(value):
    if type(value) is not str or len(value) > 1024: return None
    return 'h:' + hashlib.sha256(value.encode('utf-8')).hexdigest()


def numeric_fields(value, names):
    if type(value) is not dict: return {}
    return {key: value[key] for key in names if key in value and number(value[key])}


def decimal_fields(value, names):
    if type(value) is not dict: return {}
    return {key: value[key] for key in names if key in value and (
        number(value[key]) or (type(value[key]) is str and len(value[key]) <= 80 and
                              re.fullmatch(r'-?\d+(?:\.\d+)?', value[key])))}


def sanitize(table, value, public=False):
    check(type(value) is dict, 'EXPORT_DATABASE_INVALID')
    if table == 'technical_indicators': return numeric_fields(value, INDICATORS)
    out = {}
    def ref(item):
        if public:
            return item if type(item) is str and re.fullmatch(r'h:[a-f0-9]{64}', item) else None
        return identifier(item)
    for key in ('orderId', 'cycleId', 'candidateId'):
        if key in value and ref(value[key]) is not None: out[key] = ref(value[key])
    out.update(numeric_fields(value, ('timestamp', 'createdAt', 'beganAt', 'endedAt')))
    if table == 'strategy_decisions':
        if value.get('action') in ('BUY', 'SELL', 'WAIT'): out['action'] = value['action']
        out.update(numeric_fields(value, ('confidence',)))
        e = value.get('evidence')
        if type(e) is dict:
            evidence = numeric_fields(e, ('version', 'evaluatedAt', 'candleTimestamp', 'previousCandleTimestamp'))
            inputs = e.get('inputs', {})
            evidence['inputs'] = numeric_fields(inputs, ('price', 'latestVolume', 'previousVolume', 'entryPrice'))
            if type(inputs) is dict:
                if inputs.get('entryPrice', False) is None: evidence['inputs']['entryPrice'] = None
                for key in ('current', 'previous'):
                    if type(inputs.get(key)) is dict: evidence['inputs'][key] = numeric_fields(inputs[key], INDICATORS)
            if type(e.get('conditions')) is dict:
                evidence['conditions'] = {k: v for k, v in e['conditions'].items() if k in CONDITIONS and type(v) is bool}
            if e.get('selectedRule') in RULES: evidence['selectedRule'] = e['selectedRule']
            # thresholds, stopLossPct, takeProfitPct and free-text reason are settings/text, not public data.
            out['evidence'] = evidence
        ctx = value.get('analysisContext')
        if type(ctx) is dict:
            out['analysisContext'] = {k: ctx[k] for k in ('runningAtStart', 'runningAtAnalysis', 'ordersAllowedAtAnalysis') if type(ctx.get(k)) is bool}
            if ref(ctx.get('cycleId')) is not None: out['analysisContext']['cycleId'] = ref(ctx['cycleId'])
    elif table == 'shadow_decisions':
        out.update(numeric_fields(value, ('candleTimestamp', 'conditionCount', 'confidence', 'latencyMs', 'calledAt')))
        if value.get('status') in ('OK', 'ERROR', 'SKIPPED_BUDGET', 'SKIPPED_DISABLED'): out['status'] = value['status']
        if value.get('action') in ('BUY', 'WAIT'): out['action'] = value['action']
        if value.get('ruleAction') in ('BUY', 'SELL', 'WAIT'): out['ruleAction'] = value['ruleAction']
        if value.get('selectedRule') in RULES: out['selectedRule'] = value['selectedRule']
        if value.get('promptVersion') == 'shadow-s1-v1': out['promptVersion'] = value['promptVersion']
        if value.get('reasonCode') in ('INVALID_JSON', 'INVALID_SCHEMA', 'INVALID_REFERENCE', 'TIMEOUT', 'CREDENTIAL_IN_OUTPUT', 'ADAPTER_FAILED'): out['reasonCode'] = value['reasonCode']
        out['usage'] = numeric_fields(value.get('usage'), ('inputTokens', 'outputTokens', 'cost'))
        snapshot = value.get('snapshot')
        if type(snapshot) is dict:
            e = snapshot.get('evidence')
            if type(e) is dict: out.update(numeric_fields(e.get('inputs'), ('price',)))
        elif number(value.get('price')): out['price'] = value['price']
        keys = {
            'indicator': INDICATORS,
            'condition': CONDITIONS,
            'candle': frozenset('open high low close volume timestamp periodHigh periodLow changePct'.split()),
            'book': frozenset('bid ask spread fetchedAt'.split()),
            'portfolio': frozenset('hasPosition entryPrice dailyBought'.split()),
        }
        rationale = value.get('rationale')
        refs = rationale.get('refs') if type(rationale) is dict else None
        if type(refs) is list:
            out['rationale'] = {'refs': [
                {k: r[k] for k in ('type', 'key', 'value')}
                for r in refs[:5] if type(r) is dict and type(r.get('type')) is str
                and r['type'] in keys and type(r.get('key')) is str
                and r['key'] in keys[r['type']] and number(r.get('value'))]}
        # model is local-only until provider/model allowlist is explicitly decided.
    elif table == 'operation_candidates':
        if value.get('side') in ('BUY', 'SELL'): out['side'] = value['side']
        if value.get('finalAction') in ('PENDING', 'BUY', 'SELL', 'WAIT', 'SAFE_STOP'): out['finalAction'] = value['finalAction']
        out.update(decimal_fields(value, ('requestedInputAtomic', 'quantityAtomic', 'quotePriceUsdc', 'expectedSaleUsdc', 'netProfitUsdc', 'dexFeeUsdc', 'gasUsdc', 'additionalFeeUsdc', 'buyGasUsdc')))
        out.update(numeric_fields(value, ('quoteExpiresAt', 'reverseQuoteExpiresAt')))
    elif table == 'paper_orders':
        if value.get('side') in ('BUY', 'SELL'): out['side'] = value['side']
        if value.get('status') in ('FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'PENDING'): out['status'] = value['status']
        q = value.get('quote')
        if type(q) is dict:
            out['quote'] = decimal_fields(q, ('amountIn', 'amountOut', 'minAmountOut'))
            out['quote'].update(numeric_fields(q, ('createdAt', 'expiresAt', 'priceImpact', 'slippage')))
    elif table == 'paper_trades':
        if value.get('side') in ('BUY', 'SELL'): out['side'] = value['side']
        out.update(numeric_fields(value, ('quantity', 'price', 'fee', 'pnl', 'slippage', 'priceImpact')))
        out.update(decimal_fields(value, ('allocatedCostUsdc', 'realizedProfitUsdc')))
        if type(value.get('costs')) is dict:
            out['costs'] = decimal_fields(value['costs'], ('additionalFeeUsdc', 'gasUsdc', 'dexFeeUsdc'))
    elif table == 'operation_events':
        if value.get('kind') not in ('STOP', 'ERROR', 'ANOMALY', 'CONTROL', 'BOOT', 'WAIT'): return None
        out['kind'] = value['kind']
        out['code'] = value.get('code') if value.get('code') in EVENT_CODES else 'REDACTED'
        # The closing record of a recovery episode (counts per
        # api/reason, first/last failure, duration, outcome) is
        # operational data, not free text: keep it in a strictly
        # numeric/allowlisted shape so a later reader can name
        # which upstream failed and for how long. A malformed
        # episode is dropped alone; the event itself survives.
        episode = value.get('episode')
        if type(episode) is dict:
            clean = numeric_fields(episode, ('startedAt', 'endedAt', 'durationMs', 'failures', 'lastFailureAt'))
            if episode.get('outcome') in EPISODE_OUTCOMES: clean['outcome'] = episode['outcome']
            tally = episode.get('tally')
            if type(tally) is dict:
                kept = {}
                for key, count in tally.items():
                    if type(key) is str and TALLY_KEY.fullmatch(key) and \
                            type(count) is int and 1 <= count <= 100000:
                        kept[key] = count
                    if len(kept) >= 32: break
                if kept: clean['tally'] = kept
            if clean: out['episode'] = clean
    elif table == 'cycle_audits':
        if value.get('phase') in ('START', 'END'): out['phase'] = value['phase']
        for key in ('runningAtStart', 'runningAtEnd'):
            if type(value.get(key)) is bool: out[key] = value[key]
    return out


def public_run(record):
    check(type(record) is dict and type(record.get('id')) is str and
          re.fullmatch(r'[a-f0-9]{32}', record['id']) and record.get('status') in
          ('in_progress', 'finishing', 'completed', 'failed_requires_review'), 'EXPORT_RUN_INVALID')
    out = {'id': record['id'], 'status': record['status'], 'pair': 'SUI_USDC', 'mode': 'PAPER'}
    out.update({k: record[k] for k in ('started', 'stopped', 'cutoff') if type(record.get(k)) is int and 0 <= record[k] <= 2**53})
    if record.get('duration') in ('30m', '2h', '6h', '24h'): out['duration'] = record['duration']
    if type(record.get('sha')) is str and re.fullmatch(r'[a-f0-9]{40}', record['sha']): out['sha'] = record['sha']
    return out


def public_prod_run(record):
    # Production has no duration/cutoff and no pre-run backup: the public run
    # block names the live production session the snapshot was taken from.
    # Only a running session can be snapshotted, so any other status is an
    # invalid source record here (the controller refuses it earlier with
    # EXPORT_PROD_NOT_RUNNING).
    check(type(record) is dict and type(record.get('id')) is str and
          re.fullmatch(r'[a-f0-9]{32}', record['id']) and record.get('status') == 'in_progress',
          'EXPORT_RUN_INVALID')
    out = {'id': record['id'], 'status': 'in_progress', 'pair': 'SUI_USDC', 'mode': 'PAPER'}
    if type(record.get('started')) is int and 0 <= record['started'] <= 2**53:
        out['started'] = record['started']
    if type(record.get('sha')) is str and re.fullmatch(r'[a-f0-9]{40}', record['sha']): out['sha'] = record['sha']
    return out


def _unpack_archive(stream, root, deadline):
    allowed = {name+suffix for name in DATABASES for suffix in ('', '-wal')}
    seen, size = set(), 0
    try:
        with tarfile.open(fileobj=stream, mode='r:') as archive:
            for index, member in enumerate(archive):
                check(index < 4096 and time.monotonic() < deadline, 'EXPORT_LIMIT_EXCEEDED')
                name = member.name.removeprefix('./')
                check(not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts, 'EXPORT_ARCHIVE_INVALID')
                if name not in allowed: continue
                check(member.isfile() and name not in seen, 'EXPORT_ARCHIVE_INVALID')
                seen.add(name)
                size += member.size
                check(size <= ARCHIVE_LIMIT, 'EXPORT_LIMIT_EXCEEDED')
                with archive.extractfile(member) as src, (root/name).open('xb') as dst:
                    while data := src.read(1024*1024): dst.write(data)
    except (tarfile.TarError, OSError): raise ExportError('EXPORT_ARCHIVE_INVALID') from None
    check('bot.sqlite' in seen, 'EXPORT_DATABASE_INVALID')
    return seen


def _package(root, seen, run, scope, source_sha256, deadline):
    result = io.BytesIO()
    files, total_rows = {}, 0
    for name, target in DATABASES.items():
        if name not in seen: continue
        source = sqlite3.connect((root/name).as_uri()+'?mode=ro', uri=True)
        source.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        destination = sqlite3.connect(root/target)
        counts = {}
        try:
            source.execute('PRAGMA query_only=ON')
            names = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in TABLES:
                check(time.monotonic() < deadline, 'EXPORT_LIMIT_EXCEEDED')
                if table not in names: continue
                destination.execute(f'CREATE TABLE {table}(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,json TEXT NOT NULL)')
                count = 0
                for row_id, at, raw in source.execute(f'SELECT id,timestamp,json FROM {table} ORDER BY timestamp,id'):
                    total_rows += 1
                    check(total_rows <= ROW_LIMIT and time.monotonic() < deadline, 'EXPORT_LIMIT_EXCEEDED')
                    check(type(at) is int and 0 <= at <= 2**53 and identifier(row_id) is not None, 'EXPORT_DATABASE_INVALID')
                    value = sanitize(table, json.loads(raw))
                    if value is None: continue
                    destination.execute(f'INSERT INTO {table} VALUES(?,?,?)', (identifier(row_id), at, json.dumps(value, allow_nan=False, separators=(',', ':'))))
                    count += 1
                counts[table] = count
            destination.commit()
        except (sqlite3.Error, ValueError, TypeError): raise ExportError('EXPORT_DATABASE_INVALID') from None
        finally:
            source.close()
            destination.close()
        data = (root/target).read_bytes()
        check(len(data) <= EXPORT_LIMIT, 'EXPORT_LIMIT_EXCEEDED')
        files[target] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'rows': counts}
    manifest = {'version': 1, 'scope': scope, 'public': True,
                'run': run, 'sourceArchiveSha256': source_sha256, 'files': files,
                'omitted': ['settings', 'runtime', 'auth', 'market_candles', 'portfolio_snapshots', 'thresholds', 'free_text', 'raw_ids']}
    check(sum(v['bytes'] for v in files.values()) <= EXPORT_LIMIT, 'EXPORT_LIMIT_EXCEEDED')
    with zipfile.ZipFile(result, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('manifest.json', json.dumps(manifest, sort_keys=True, separators=(',', ':')))
        for name in files: archive.write(root/name, arcname=name)
    check(result.tell() <= EXPORT_LIMIT, 'EXPORT_LIMIT_EXCEEDED')
    return result.getvalue()


def build_export(stream, record):
    run = public_run(record)
    backup = record.get('backup')
    check(type(backup) is dict and type(backup.get('sha256')) is str and
          re.fullmatch(r'[a-f0-9]{64}', backup['sha256']), 'EXPORT_BACKUP_MISSING')
    stream.seek(0, 2)
    check(0 < stream.tell() <= ARCHIVE_LIMIT, 'EXPORT_LIMIT_EXCEEDED')
    stream.seek(0)
    check(hashlib.file_digest(stream, 'sha256').hexdigest() == backup['sha256'], 'EXPORT_MANIFEST_MISMATCH')
    stream.seek(0)
    deadline = time.monotonic()+60
    with tempfile.TemporaryDirectory(prefix='suiba-public-export-') as tmp:
        root = Path(tmp)
        seen = _unpack_archive(stream, root, deadline)
        return _package(root, seen, run, 'PRE_RUN_BACKUP_PUBLIC_EXTRACT', backup['sha256'], deadline)


def build_live_export(stream, record, source_sha256):
    """Same allowlisted extract, from a snapshot of the LIVE production DBs.

    The controller takes transactionally consistent copies of the running
    worker's databases with the sqlite backup API and tars those copies;
    digest is the sha256 of that exact tar stream, recorded for traceability
    (there is no pre-run backup manifest to bind against)."""
    run = public_prod_run(record)
    check(type(source_sha256) is str and re.fullmatch(r'[a-f0-9]{64}', source_sha256), 'EXPORT_ARCHIVE_INVALID')
    stream.seek(0, 2)
    check(0 < stream.tell() <= ARCHIVE_LIMIT, 'EXPORT_LIMIT_EXCEEDED')
    stream.seek(0)
    deadline = time.monotonic()+60
    with tempfile.TemporaryDirectory(prefix='suiba-prod-export-') as tmp:
        root = Path(tmp)
        seen = _unpack_archive(stream, root, deadline)
        return _package(root, seen, run, 'PROD_LIVE_PUBLIC_EXTRACT', source_sha256, deadline)
