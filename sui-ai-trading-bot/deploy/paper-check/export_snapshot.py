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
from decimal import Decimal, InvalidOperation

ARCHIVE_LIMIT = 512 * 1024**2
EXPORT_LIMIT = 256 * 1024**2
ROW_LIMIT = 800000
EXPORT_TIMEOUT_SECONDS = 180
WINDOW_DAYS = 14
WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000
LIQUIDATION_ROW_LIMIT = WINDOW_MS // (5 * 60 * 1000) + 1
# The limits remain bounded by the 14-day window and the worker's maximum
# write cadence. At the minimum 30-second cycle interval, even a deliberately
# conservative one-row-per-cycle fixture for every event table (plus the two
# cycle audit rows, small calibration-event stream, and separately capped
# shadow calls) stays below these limits with more than 2x headroom.
JSON_TABLES = ('forecast_records', 'forecast_calibrations', 'shadow_decisions', 'strategy_decisions', 'technical_indicators', 'operation_candidates',
               'paper_orders', 'paper_trades', 'operation_events', 'cycle_audits')
TABLES = JSON_TABLES + ('liquidation_buckets', 'narration_entries')
DATABASES = {'bot.sqlite': 'SUI_USDC.sqlite', 'bot.sqlite.WAL_USDC.sqlite': 'WAL_USDC.sqlite'}
ERROR_CODES = frozenset(('EXPORT_BACKUP_MISSING', 'EXPORT_MANIFEST_MISMATCH', 'EXPORT_ARCHIVE_INVALID',
    'EXPORT_LIMIT_EXCEEDED', 'EXPORT_DATABASE_INVALID', 'EXPORT_RUN_INVALID', 'EXPORT_PACKAGE_INVALID',
    'EXPORT_PROD_NOT_RUNNING'))
INDICATORS = frozenset('ema20 ema50 rsi macd signal histogram atr volumeChange priceChange'.split())
CONDITIONS = frozenset('hasPosition stopLoss takeProfit latestVolumePositive previousVolumePositive volumeChangeExceeded emaUp emaGapShrinking rsiRecovery histogramImproving emaDown rsiReversal histogramDeclining'.split())
RULES = frozenset('NO_SIGNAL STOP_LOSS TAKE_PROFIT VOLUME_REJECT BUY_SIGNAL SELL_SIGNAL'.split())
SAFE_FAILURE_CODES = frozenset('''SUI_READ_FAILED API_BACKOFF API_RETRIES_EXHAUSTED API_CANCELLED
QUOTE_EXPIRED UPSTREAM_TIMEOUT UPSTREAM_CONNECT_TIMEOUT UPSTREAM_HEADERS_TIMEOUT
UPSTREAM_BODY_TIMEOUT UPSTREAM_DNS_FAILED UPSTREAM_TLS_FAILED UPSTREAM_NETWORK_FAILED
UPSTREAM_HTTP_404 UPSTREAM_HTTP_429 UPSTREAM_HTTP_500 UPSTREAM_HTTP_502 UPSTREAM_HTTP_503
UPSTREAM_HTTP_504 STALE_ORDERBOOK INVALID_ORDERBOOK SPREAD_TOO_WIDE THIN_ORDERBOOK
INDEXER_DELAYED MARKET_PAIR_MISMATCH MIN_ORDER_SIZE MARKET_SOURCE_CHANGED MARKET_UNAVAILABLE
MARKET_DATA_STALLED MARKET_FETCH_IN_PROGRESS NATIVE_USDC_POOL_NOT_FOUND INSUFFICIENT_CANDLES
INVALID_CANDLE CANDLE_GAP PRICE_OUTLIER STALE_CANDLES UNKNOWN_PRICE_IMPACT
NO_LIQUID_ROUTE_OR_UNMODELED_FEE DATA_OR_EXECUTION_FAILURE'''.split())
REQUEST_EVENT_CODES = frozenset(
    f'{kind}_{reason}' for kind in ('MARKET', 'QUOTE', 'HEALTH') for reason in SAFE_FAILURE_CODES)
HTTP_EVENT_CODES = frozenset(f'UPSTREAM_HTTP_{status}' for status in range(100, 600))
OPERATION_EVENT_CODES = frozenset('''MANUAL_START MANUAL_STOP EMERGENCY_STOP EMERGENCY_CLEARED
MANUAL_RESET PROCESS_SHUTDOWN PROCESS_RESTART_STOPPED PROCESS_SHUTDOWN_CANCELLED
PAPER_NETWORK_PAUSED PAPER_NETWORK_RECOVERED PAPER_RECOVERY_EXHAUSTED PAPER_RECOVERY_FLAPPING
PAPER_RECOVERY_READ_FAILED PAPER_ORDER_STATE_UNKNOWN PAPER_RECONCILIATION_FAILED
CONSECUTIVE_API_ERRORS DAILY_LOSS_LIMIT NARRATION_GENERATION_FAILED NO_POSITION
INVALID_STATE_OR_QUOTE INVALID_AMOUNT BOT_STOPPED COIN_DIRECTION COIN_NOT_ALLOWED INVALID_NUMBERS
MAX_ORDER INSUFFICIENT_BALANCE DAILY_BUY_LIMIT MAX_HOLDING SLIPPAGE_OR_IMPACT NO_LIQUIDITY
STALE_MARKET DUPLICATE_ORDER CONCURRENT_ORDER QUOTE_INVALID QUOTE_MARKET_MOVED
EXECUTION_CONTEXT_CHANGED DEPLOYMENT_MAINTENANCE UNKNOWN_COSTS INVALID_POSITION
INSUFFICIENT_POSITION INVALID_PROFIT_CONFIG PROFIT_DATA_UNKNOWN QUOTE_UNAVAILABLE
PROFIT_GUARD_DISABLED PROTECTIVE_EXIT_PROFIT_BYPASS MINIMUM_NET_PROFIT_MET
MINIMUM_NET_PROFIT_NOT_MET PROJECTED_NET_EXCEEDS_ROUND_TRIP_COST PROJECTED_NET_INSUFFICIENT
VALIDATION_RECORD_FAILED DATABASE_UNAVAILABLE UNKNOWN_FAILURE PROCESS_RESTART_INTERRUPTED
EXTERNAL_STOP WORKER_OOM WORKER_EXITED WORKER_EXITED_CLEAN UNKNOWN'''.split())
EVENT_CODES = SAFE_FAILURE_CODES | REQUEST_EVENT_CODES | HTTP_EVENT_CODES | OPERATION_EVENT_CODES
RISK_STATUSES = frozenset(('NOT_EVALUATED', 'ALLOWED', 'REJECTED'))
# Keep this allowlist in sync when packages/risk-engine adds a reason code.
RISK_REASON_CODES = frozenset('''INVALID_STATE_OR_QUOTE INVALID_AMOUNT BOT_STOPPED
COIN_DIRECTION COIN_NOT_ALLOWED INVALID_NUMBERS MAX_ORDER INSUFFICIENT_BALANCE
DAILY_BUY_LIMIT DAILY_LOSS_LIMIT MAX_HOLDING SLIPPAGE_OR_IMPACT NO_LIQUIDITY
QUOTE_EXPIRED STALE_MARKET DUPLICATE_ORDER CONCURRENT_ORDER'''.split())
EPISODE_OUTCOMES = frozenset(('RECOVERED', 'EXHAUSTED', 'STOPPED', 'INTERRUPTED'))
TALLY_KEY = re.compile(r'[A-Za-z][A-Za-z0-9 ]{0,31}/[A-Z][A-Z0-9_]{0,63}')
SHADOW_PROMPT_VERSION = re.compile(r'shadow-[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]{0,5}')
SHADOW_MODEL = re.compile(r'gpt-5\.4-(?:nano|mini)')
NARRATION_KINDS = frozenset('''cycle trade rejection stop start warning recovery nearMiss watchHit
reach superReach priceLine priceLineReached sellLine sellLineCrossing review alert monthlyReport
epoch btc forecastCall forecastHit forecastMiss forecastTouch forecastTouchNear bookWall
forecastCalib memory'''.split())


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
    if table == 'forecast_records':
        out.update(numeric_fields(value, ('origin',)))
        for key in ('up', 'lo'):
            points = value.get(key)
            if (type(points) is list and 1 <= len(points) <= 48
                    and all(number(point) and point > 0 for point in points)):
                out[key] = points
    elif table == 'forecast_calibrations':
        if value.get('pair') in ('SUI_USDC', 'WAL_USDC'): out['pair'] = value['pair']
        out.update(numeric_fields(value, ('at', 'previousScale', 'scale', 'scored',
                                          'totalScored', 'coveragePct')))
        if type(value.get('widened')) is bool: out['widened'] = value['widened']
    elif table == 'strategy_decisions':
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
            if e.get('regime') in ('up', 'down', 'range', 'unknown'):
                evidence['regime'] = e['regime']
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
        prompt_version = value.get('promptVersion')
        if (type(prompt_version) is str and len(prompt_version) <= 80
                and SHADOW_PROMPT_VERSION.fullmatch(prompt_version)):
            out['promptVersion'] = prompt_version
        if value.get('reasonCode') in ('INVALID_JSON', 'INVALID_SCHEMA', 'INVALID_REFERENCE', 'TIMEOUT', 'CREDENTIAL_IN_OUTPUT', 'ADAPTER_FAILED', 'SHADOW_API_KEY_MISSING', 'OPENAI_AUTH_FAILED', 'OPENAI_RATE_LIMITED', 'OPENAI_HTTP_ERROR', 'OPENAI_NETWORK_FAILED', 'OPENAI_REFUSAL', 'OPENAI_INCOMPLETE', 'OPENAI_RESPONSE_FAILED', 'OPENAI_INVALID_RESPONSE'): out['reasonCode'] = value['reasonCode']
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
        model = value.get('model')
        if type(model) is str and SHADOW_MODEL.fullmatch(model): out['model'] = model
        # Only the owner-approved model family is public; arbitrary strings remain private.
    elif table == 'operation_candidates':
        # Candidate order IDs are a public join key only in the paper namespace.
        out.pop('orderId', None)
        order_id = value.get('orderId')
        if type(order_id) is str and len(order_id) <= 1024 and order_id.startswith('paper:'):
            out['orderId'] = order_id
        elif public and type(order_id) is str and re.fullmatch(r'h:[a-f0-9]{64}', order_id):
            # Extracts built by a producer that predates the raw paper join
            # key carry the hashed form instead; it is the standard public
            # form for every other id, so validation keeps it as-is.
            out['orderId'] = order_id
        if value.get('side') in ('BUY', 'SELL'): out['side'] = value['side']
        if value.get('finalAction') in ('PENDING', 'BUY', 'SELL', 'WAIT', 'SAFE_STOP'): out['finalAction'] = value['finalAction']
        risk = value.get('risk')
        if type(risk) is dict and risk.get('status') in RISK_STATUSES:
            out['risk'] = {'status': risk['status']}
            reasons = risk.get('reasons')
            if type(reasons) is list:
                out['risk']['reasons'] = [reason for reason in reasons
                                          if type(reason) is str and reason in RISK_REASON_CODES]
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
    aggregates = {'shadowByVersion': {}, 'paperRoundTrips': 0,
                  'paperRealizedPnlUsdc': Decimal(0), 'narrationEntries': 0,
                  'forecastCalibrations': 0}
    window_to = int(time.time() * 1000)
    window_from = window_to - WINDOW_MS
    for name, target in DATABASES.items():
        if name not in seen: continue
        source = sqlite3.connect((root/name).as_uri()+'?mode=ro', uri=True)
        source.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        destination = sqlite3.connect(root/target)
        counts = {}
        try:
            source.execute('PRAGMA query_only=ON')
            names = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            # Canonical unsanitized source aggregates:
            # shadowByVersion: shadow_decisions grouped by promptVersion; total=row count,
            # aiOnlyBuy=action 'BUY' and ruleAction not 'BUY', errors=status 'ERROR'.
            # paperRoundTrips: completed round trips are paper_trades rows whose side is 'SELL'.
            # paperRealizedPnlUsdc: sum realizedProfitUsdc over every paper_trades row.
            # narrationEntries and forecastCalibrations: source-table row counts.
            if 'shadow_decisions' in names:
                for version, total, ai_only_buy, errors in source.execute(
                        "SELECT json_extract(json,'$.promptVersion'),count(*),"
                        "sum(CASE WHEN json_extract(json,'$.action')='BUY' AND "
                        "coalesce(json_extract(json,'$.ruleAction'),'')!='BUY' "
                        "THEN 1 ELSE 0 END),"
                        "sum(CASE WHEN json_extract(json,'$.status')='ERROR' "
                        "THEN 1 ELSE 0 END) "
                        "FROM shadow_decisions GROUP BY json_extract(json,'$.promptVersion')"):
                    # Legacy/malformed versions share a non-sensitive bucket;
                    # arbitrary raw strings must not become public manifest keys.
                    if type(version) is not str or not SHADOW_PROMPT_VERSION.fullmatch(version):
                        version = 'unknown'
                    current = aggregates['shadowByVersion'].setdefault(
                        version, {'total': 0, 'aiOnlyBuy': 0, 'errors': 0})
                    current['total'] += total
                    current['aiOnlyBuy'] += ai_only_buy
                    current['errors'] += errors
            if 'paper_trades' in names:
                for raw, in source.execute('SELECT json FROM paper_trades'):
                    trade = json.loads(raw)
                    check(type(trade) is dict, 'EXPORT_DATABASE_INVALID')
                    if trade.get('side') == 'SELL': aggregates['paperRoundTrips'] += 1
                    realized = trade.get('realizedProfitUsdc')
                    if realized is not None:
                        try: amount = Decimal(str(realized))
                        except InvalidOperation: raise ExportError('EXPORT_DATABASE_INVALID') from None
                        check(amount.is_finite(), 'EXPORT_DATABASE_INVALID')
                        aggregates['paperRealizedPnlUsdc'] += amount
            if 'narration_entries' in names:
                aggregates['narrationEntries'] += source.execute(
                    'SELECT count(*) FROM narration_entries').fetchone()[0]
            if 'forecast_calibrations' in names:
                aggregates['forecastCalibrations'] += source.execute(
                    'SELECT count(*) FROM forecast_calibrations').fetchone()[0]
            check(time.monotonic() < deadline, 'EXPORT_LIMIT_EXCEEDED')
            for table in JSON_TABLES:
                check(time.monotonic() < deadline, 'EXPORT_LIMIT_EXCEEDED')
                if table not in names: continue
                destination.execute(f'CREATE TABLE {table}(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,json TEXT NOT NULL)')
                count = 0
                for row_id, at, raw in source.execute(
                        f'SELECT id,timestamp,json FROM {table} '
                        'WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp,id',
                        (window_from, window_to)):
                    total_rows += 1
                    check(total_rows <= ROW_LIMIT and time.monotonic() < deadline, 'EXPORT_LIMIT_EXCEEDED')
                    check(type(at) is int and 0 <= at <= 2**53 and identifier(row_id) is not None, 'EXPORT_DATABASE_INVALID')
                    value = sanitize(table, json.loads(raw))
                    if value is None: continue
                    destination.execute(f'INSERT INTO {table} VALUES(?,?,?)', (identifier(row_id), at, json.dumps(value, allow_nan=False, separators=(',', ':'))))
                    count += 1
                counts[table] = count
            if 'liquidation_buckets' in names:
                # The worker has already reduced the external feed to one
                # aggregate per five-minute bucket. Export only the event time
                # and long-liquidation scale needed to reproduce the scene;
                # short totals, event counts, update times and raw events are
                # not review inputs and remain private.
                destination.execute(
                    'CREATE TABLE liquidation_buckets('
                    'bucket_at INTEGER PRIMARY KEY,long_usd REAL NOT NULL)')
                rows = source.execute(
                    'SELECT bucket_at,long_usd FROM liquidation_buckets '
                    'WHERE bucket_at BETWEEN ? AND ? ORDER BY bucket_at DESC LIMIT ?',
                    (window_from // 1000, window_to // 1000,
                     LIQUIDATION_ROW_LIMIT)).fetchall()
                count = 0
                for bucket_at, long_usd in reversed(rows):
                    total_rows += 1
                    check(total_rows <= ROW_LIMIT and time.monotonic() < deadline,
                          'EXPORT_LIMIT_EXCEEDED')
                    check(type(bucket_at) is int and 0 <= bucket_at <= 2**53 and
                          number(long_usd) and long_usd >= 0,
                          'EXPORT_DATABASE_INVALID')
                    destination.execute(
                        'INSERT INTO liquidation_buckets VALUES(?,?)',
                        (bucket_at, long_usd))
                    count += 1
                counts['liquidation_buckets'] = count
            if 'narration_entries' in names:
                # Narration text and its source metadata remain private. Keep
                # only the three fields needed to count kinds and audit cursor
                # continuity, using the same 14-day event-time window.
                destination.execute(
                    'CREATE TABLE narration_entries('
                    'seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,occurred_at INTEGER NOT NULL)')
                pair = target.removesuffix('.sqlite')
                count = 0
                for seq, kind, occurred_at in source.execute(
                        'SELECT seq,kind,occurred_at FROM narration_entries '
                        'WHERE pair=? AND occurred_at BETWEEN ? AND ? '
                        'ORDER BY occurred_at,seq',
                        (pair, window_from, window_to)):
                    total_rows += 1
                    check(total_rows <= ROW_LIMIT and time.monotonic() < deadline,
                          'EXPORT_LIMIT_EXCEEDED')
                    check(type(seq) is int and 0 < seq <= 2**53 and
                          kind in NARRATION_KINDS and
                          type(occurred_at) is int and 0 <= occurred_at <= 2**53,
                          'EXPORT_DATABASE_INVALID')
                    destination.execute(
                        'INSERT INTO narration_entries VALUES(?,?,?)',
                        (seq, kind, occurred_at))
                    count += 1
                counts['narration_entries'] = count
            destination.commit()
        except (sqlite3.Error, ValueError, TypeError): raise ExportError('EXPORT_DATABASE_INVALID') from None
        finally:
            source.close()
            destination.close()
        data = (root/target).read_bytes()
        check(len(data) <= EXPORT_LIMIT, 'EXPORT_LIMIT_EXCEEDED')
        files[target] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'rows': counts}
    realized = aggregates['paperRealizedPnlUsdc']
    aggregates['paperRealizedPnlUsdc'] = int(realized) if realized == realized.to_integral() else float(realized)
    manifest = {'version': 2, 'scope': scope, 'public': True,
                'window': {'from': window_from, 'to': window_to},
                'run': run, 'sourceArchiveSha256': source_sha256, 'files': files,
                'aggregates': aggregates,
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
    deadline = time.monotonic()+EXPORT_TIMEOUT_SECONDS
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
    deadline = time.monotonic()+EXPORT_TIMEOUT_SECONDS
    with tempfile.TemporaryDirectory(prefix='suiba-prod-export-') as tmp:
        root = Path(tmp)
        seen = _unpack_archive(stream, root, deadline)
        return _package(root, seen, run, 'PROD_LIVE_PUBLIC_EXTRACT', source_sha256, deadline)
