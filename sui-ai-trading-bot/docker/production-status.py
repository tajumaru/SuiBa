"""Runner-only shape validation. Never imports or changes host components."""
import json
from pathlib import Path
import re
import sys
import time

CONTRACT = json.loads(Path(__file__).with_name('production-monitor-contract.json').read_text(encoding='utf-8'))
HOST_REASONS = frozenset(CONTRACT['host_reasons'])


SHAPE_KINDS = frozenset(CONTRACT['shape_kinds'])


def shape_kind(value):
    if value is None: return 'null'
    if type(value) is bool: return 'boolean'
    if type(value) is int: return 'integer'
    if type(value) is float: return 'number'
    if type(value) is str: return 'string'
    if type(value) is list: return 'array'
    if type(value) is dict: return 'object'
    return 'other'


class ShapeError(ValueError):
    def __init__(self, check, expected, value):
        super().__init__('PRODUCTION_RESPONSE_INVALID')
        self.detail = {'check': check, 'expected': expected, 'actual': shape_kind(value)}


def require(value, check='production_status', expected='valid', actual=None):
    if not value: raise ShapeError(check, expected, actual)


def hex_id(value):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{32}', value) is not None


def unreachable(worker):
    return (type(worker) is dict and set(worker) == {'reachable', 'reason'} and
            worker['reachable'] is False and worker['reason'] == 'WORKER_UNREACHABLE')


def shadow(value, now):
    require(value is None or type(value) is dict and
            set(value) == {'total', 'aiOnlyBuy', 'errors', 'lastDecisionAt'} and
            all(type(value[key]) is int and value[key] >= 0 for key in ('total', 'aiOnlyBuy', 'errors')) and
            value['aiOnlyBuy'] <= value['total'] and value['errors'] <= value['total'] and
            (value['lastDecisionAt'] is None or type(value['lastDecisionAt']) is int and
             0 <= value['lastDecisionAt'] <= (now+60)*1000), 'shadow', 'shadow_or_null', value)
    return value


def failure_summary(value, run):
    require(type(value) is dict and set(value) == {'status', 'stage', 'code', 'http_status', 'backup'},
            'failure', 'failure_summary', value)
    require(value['status'] == run['status'] and value['status'] in ('in_progress', 'completed', 'failed_requires_review'))
    require(value['stage'] is None or value['stage'] in CONTRACT['stages'])
    require(value['code'] is None or type(value['code']) is str and
            re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', value['code']))
    require(value['http_status'] is None or type(value['http_status']) is int and 100 <= value['http_status'] <= 599)
    require(value['backup'] in ('confirmed', 'unconfirmed', 'unknown'))
    return value


def stop_string(value, pattern):
    return type(value) is str and re.fullmatch(pattern, value) is not None


def stop_codes(value, limit):
    return (type(value) is list and len(value) <= limit and
            all(stop_string(code, r'[A-Z][A-Z_]{2,47}') for code in value))


def stop_filename(value):
    return stop_string(value, r'[A-Za-z0-9._-]+\.sqlite') and len(value) <= 128


def valid_verify_details(value):
    return (type(value) is dict and set(value) in ({'error', 'unknown_files'}, {'error', 'name', 'unknown_files'}) and
            (value['error'] is None or stop_string(value['error'], r'VPS_[A-Z_]{2,48}')) and
            type(value['unknown_files']) is list and len(value['unknown_files']) <= 16 and
            all(stop_filename(name) for name in value['unknown_files']))


def valid_stop_diagnosis(value):
    if type(value) is not dict:
        return False
    stage = value.get('stage')
    if stage not in ('maintenance', 'verify', 'verify_sui'):
        return False
    details = {key: item for key, item in value.items() if key != 'stage'}
    if not details:
        return True
    if stage == 'verify':
        return valid_verify_details(details) and ('name' not in details or stop_filename(details['name']))
    return (stage == 'verify_sui' and set(details) == {'actual'} and
            stop_string(details['actual'], r'[A-Z][A-Z0-9_]{0,31}'))


def stop_summary(value):
    require(type(value) is dict and set(value) == {'status', 'errors', 'faults', 'diagnosis'} and
            stop_string(value['status'], r'[a-z_]{3,48}') and stop_codes(value['errors'], 8) and
            stop_codes(value['faults'], 32) and value['faults'] == sorted(set(value['faults'])) and
            (value['diagnosis'] is None or valid_stop_diagnosis(value['diagnosis'])),
            'stop', 'stop_summary', value)


def production(value, now):
    require(type(value) is dict, 'status', 'object', value)
    require(type(value.get('requires_review')) is bool, 'requires_review', 'boolean', value.get('requires_review'))
    require('run' in value, 'run', 'present', None)
    optional = value.get('watchdog')
    require(type(optional) is dict and set(optional) == {'record', 'code'}, 'watchdog', 'watchdog', optional)
    if optional['record'] is None:
        require(optional['code'] in ('WATCHDOG_RECORD_MISSING', 'WATCHDOG_RECORD_INVALID'), 'watchdog.code', 'watchdog_code', optional['code'])
    else:
        require(optional['code'] is None, 'watchdog.code', 'null', optional['code'])
        watchdog(optional['record'], now)
    run = value['run']
    if run is None:
        require(set(value) == {'run', 'requires_review', 'watchdog'}, 'status.keys', 'not_started_status', value)
        return value
    require({'run', 'requires_review', 'worker', 'controller_alive', 'watchdog', 'shadow'} <= set(value) <=
            {'run', 'requires_review', 'worker', 'controller_alive', 'watchdog', 'shadow', 'failure', 'stop', 'closeout'} and
            type(value['controller_alive']) is bool and type(run) is dict and
            set(run) == {'id', 'status', 'started', 'stopped', 'sha', 'stage', 'admitted'}, 'status.keys', 'running_status', value)
    if 'failure' in value:
        failure_summary(value['failure'], run)
    if 'stop' in value:
        stop_summary(value['stop'])
    if 'closeout' in value:
        closeout = value['closeout']
        require(type(closeout) is dict and set(closeout) == {'preflight', 'admitted'} and
                all(code is None or code in CONTRACT['closeout_reasons'] for code in closeout.values()),
                'closeout', 'closeout_summary', closeout)
    shadow(value['shadow'], now)
    require(hex_id(run['id']) and run['status'] in CONTRACT['prod_states'][2:] and
            type(run['started']) is int and 0 <= run['started'] <= (now+60)*1000 and
            type(run['admitted']) is bool and run['stage'] in CONTRACT['stages'], 'run', 'production_run', run)
    require(run['stopped'] is None or type(run['stopped']) is int and run['started'] <= run['stopped'] <= (now+60)*1000,
            'run.stopped', 'timestamp_or_null', run['stopped'])
    require(run['sha'] is None or type(run['sha']) is str and re.fullmatch(r'[a-f0-9]{40}', run['sha']),
            'run.sha', 'sha40_or_null', run['sha'])
    worker = value['worker']
    if worker is not None:
        require(type(worker) is dict, 'worker', 'worker_or_unreachable', worker)
        require(unreachable(worker) or
                set(worker) == {'running', 'maintenance', 'databaseHealthy', 'ledgerOk', 'paper',
                                'hasPosition', 'networkPause', 'networkStopReason'} and
                all(type(worker[key]) is bool for key in
                    ('running', 'maintenance', 'databaseHealthy', 'ledgerOk', 'paper', 'hasPosition')) and
                (worker['networkPause'] is None or type(worker['networkPause']) is dict) and
                (worker['networkStopReason'] is None or type(worker['networkStopReason']) is str and
                 re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,100}', worker['networkStopReason'])),
                'worker', 'worker_or_unreachable', worker)
    require(run['status'] == 'in_progress' or worker is None, 'worker', 'null_when_stopped', worker)
    return value


def watchdog(value, now):
    require(type(value) is dict and {'at', 'verdict', 'reasons', 'run_id', 'shadow'} <= set(value) <=
            {'at', 'verdict', 'reasons', 'run_id', 'shadow', 'detail'}, 'watchdog', 'watchdog', value)
    detail = value.get('detail')
    require(detail is None or type(detail) is dict and set(detail) == {'check', 'expected', 'actual'} and
            detail['check'] in CONTRACT['detail_checks'] and detail['expected'] in CONTRACT['detail_expected'] and
            detail['actual'] in CONTRACT['shape_kinds'], 'watchdog', 'watchdog', value)
    require(('STATUS_INVALID' in value['reasons']) == (detail is not None), 'watchdog', 'watchdog', value)
    require(type(value['at']) is int and value['at'] >= 0 and value['verdict'] in ('ok', 'attention', 'not_started'))
    require(type(value['reasons']) is list and len(value['reasons']) <= 32 and
            all(type(code) is str and code in HOST_REASONS for code in value['reasons']))
    require(value['run_id'] is None or hex_id(value['run_id']))
    require((value['verdict'] == 'attention') == bool(value['reasons']))
    require(value['verdict'] != 'not_started' or value['run_id'] is None)
    require(value['verdict'] != 'ok' or hex_id(value['run_id']))
    if 'closeout' in value:
        closeout = value['closeout']
        require(type(closeout) is dict and set(closeout) == {'preflight', 'admitted'} and
                all(code is None or code in CONTRACT['closeout_reasons'] for code in closeout.values()),
                'closeout', 'closeout_summary', closeout)
    shadow(value['shadow'], now)
    return value


def combine(prod, now, prod_read=True):
    result = {'at': int(now), 'verdict': 'attention', 'reasons': [], 'run_id': None,
              'prod_state': 'unknown', 'watchdog_at': None, 'detail': None}
    if not prod_read:
        result['reasons'] = ['PROD_STATUS_UNAVAILABLE']; return result
    try: production(prod, now)
    except ShapeError as error:
        result.update(reasons=['PROD_STATUS_INVALID'], detail=error.detail); return result
    except Exception:
        result.update(reasons=['PROD_STATUS_INVALID'], detail={
            'check': 'production_status', 'expected': 'valid', 'actual': shape_kind(prod)}); return result
    watch = prod['watchdog']['record']
    run = prod['run']
    reasons = set()
    if prod['requires_review']: reasons.add('REVIEW_REQUIRED')
    # Before first production use, a missing/private watchdog record must not
    # create an issue. This is not evidence of recovery: the notifier stays quiet.
    if run is None and not reasons:
        result.update(verdict='not_started', prod_state='not_started'); return result
    if run is not None:
        result.update(run_id=run['id'], prod_state=run['status'])
        if run['status'] == 'failed_requires_review': reasons.add('RUN_FAILED')
        if run['status'] == 'in_progress' and not prod['controller_alive']: reasons.add('CONTROLLER_NOT_RUNNING')
        if run['status'] != 'in_progress' and prod['controller_alive']: reasons.add('CONTROLLER_UNEXPECTED')
        worker = prod['worker']
        if unreachable(worker):
            reasons.add('WORKER_UNREACHABLE')
        elif worker is not None:
            for key, code in (('running', 'TRADING_STOPPED'), ('databaseHealthy', 'DATABASE_UNHEALTHY'),
                              ('ledgerOk', 'LEDGER_UNHEALTHY'), ('paper', 'NOT_PAPER')):
                if not worker[key]: reasons.add(code)
            if worker['maintenance']: reasons.add('MAINTENANCE_ENABLED')
        elif run['status'] == 'in_progress' and run['stage'] == 'monitoring' and prod['controller_alive']:
            reasons.add('WORKER_STATE_INVALID')
    if watch is not None:
        result['detail'] = watch.get('detail')
        if watch['at'] <= now+60:
            result['watchdog_at'] = watch['at']
        if not -60 <= now-watch['at'] <= CONTRACT['watchdog_max_age']:
            reasons.add('WATCHDOG_STALE')
        if watch['run_id'] != result['run_id'] and (run is None or watch['at'] * 1000 >= run['started']):
            reasons.add('WATCHDOG_RUN_MISMATCH')
        if watch['verdict'] == 'not_started' and run is not None: reasons.add('STATUS_INCONSISTENT')
        reasons.update(watch['reasons'])
    if prod.get('failure') is not None:
        # Validated above; carried through so the alert can name the
        # stage and code instead of only that the run failed.
        result['failure'] = prod['failure']
    if 'stop' in prod:
        result['stop'] = prod['stop']
    if 'closeout' in prod:
        result['closeout'] = prod['closeout']
    result.update(verdict='attention' if reasons else 'ok', reasons=sorted(reasons))
    return result


def read(path):
    with Path(path).open('rb') as source: data = source.read(65537)
    require(len(data) <= 65536)
    # Reject duplicate keys and non-standard NaN/Infinity, even in unused fields.
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value); value[key] = item
        return value
    return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: require(False))


def main():
    try:
        require(len(sys.argv) == 4 and sys.argv[2] in ('0', '1'))
        prod = None
        if sys.argv[2] == '1':
            try: prod = read(sys.argv[1])
            except Exception: pass
        result = combine(prod, time.time(), sys.argv[2] == '1')
        Path(sys.argv[3]).write_text(json.dumps(result, allow_nan=False)+'\n', encoding='utf-8')
        if type(prod) is dict and type(prod.get('watchdog')) is dict and prod['watchdog'].get('code') in ('WATCHDOG_RECORD_MISSING', 'WATCHDOG_RECORD_INVALID'):
            print(prod['watchdog']['code'])
        print('SUIBA_PROD_MONITOR_'+result['verdict'].upper()+(' '+','.join(result['reasons']) if result['reasons'] else ''))
        return 0
    except Exception:
        print('PRODUCTION_STATUS_FAILED (details withheld)', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
