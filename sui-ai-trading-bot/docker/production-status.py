"""Runner-only shape validation. Never imports or changes host components."""
import json
from pathlib import Path
import re
import sys
import time

CONTRACT = json.loads(Path(__file__).with_name('production-monitor-contract.json').read_text(encoding='utf-8'))
HOST_REASONS = frozenset(CONTRACT['host_reasons'])


def require(value):
    if not value: raise ValueError('PRODUCTION_RESPONSE_INVALID')


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
             0 <= value['lastDecisionAt'] <= (now+60)*1000))
    return value


def failure_summary(value, run):
    require(type(value) is dict and set(value) == {'status', 'stage', 'code', 'http_status', 'backup'})
    require(value['status'] == run['status'] and value['status'] in ('in_progress', 'completed', 'failed_requires_review'))
    require(value['stage'] is None or value['stage'] in CONTRACT['stages'])
    require(value['code'] is None or type(value['code']) is str and
            re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', value['code']))
    require(value['http_status'] is None or type(value['http_status']) is int and 100 <= value['http_status'] <= 599)
    require(value['backup'] in ('confirmed', 'unconfirmed', 'unknown'))
    return value


def production(value, now):
    require(type(value) is dict and type(value.get('requires_review')) is bool and 'run' in value)
    optional = value.get('watchdog')
    require(type(optional) is dict and set(optional) == {'record', 'code'})
    if optional['record'] is None:
        require(optional['code'] in ('WATCHDOG_RECORD_MISSING', 'WATCHDOG_RECORD_INVALID'))
    else:
        require(optional['code'] is None)
        watchdog(optional['record'], now)
    run = value['run']
    if run is None:
        require(set(value) == {'run', 'requires_review', 'watchdog'})
        return value
    require({'run', 'requires_review', 'worker', 'controller_alive', 'watchdog', 'shadow'} <= set(value) <=
            {'run', 'requires_review', 'worker', 'controller_alive', 'watchdog', 'shadow', 'failure'} and
            type(value['controller_alive']) is bool and type(run) is dict and
            set(run) == {'id', 'status', 'started', 'stopped', 'sha', 'stage', 'admitted'})
    if 'failure' in value:
        failure_summary(value['failure'], run)
    shadow(value['shadow'], now)
    require(hex_id(run['id']) and run['status'] in CONTRACT['prod_states'][2:] and
            type(run['started']) is int and 0 <= run['started'] <= (now+60)*1000 and
            type(run['admitted']) is bool and run['stage'] in CONTRACT['stages'])
    require(run['stopped'] is None or type(run['stopped']) is int and run['started'] <= run['stopped'] <= (now+60)*1000)
    require(run['sha'] is None or type(run['sha']) is str and re.fullmatch(r'[a-f0-9]{40}', run['sha']))
    worker = value['worker']
    if worker is not None:
        require(type(worker) is dict)
        require(unreachable(worker) or
                set(worker) == {'running', 'maintenance', 'databaseHealthy', 'ledgerOk', 'paper'} and
                all(type(v) is bool for v in worker.values()))
    require(run['status'] == 'in_progress' or worker is None)
    return value


def watchdog(value, now):
    require(type(value) is dict and set(value) == {'at', 'verdict', 'reasons', 'run_id', 'shadow'})
    require(type(value['at']) is int and value['at'] >= 0 and value['verdict'] in ('ok', 'attention', 'not_started'))
    require(type(value['reasons']) is list and len(value['reasons']) <= 32 and
            all(type(code) is str and code in HOST_REASONS for code in value['reasons']))
    require(value['run_id'] is None or hex_id(value['run_id']))
    require((value['verdict'] == 'attention') == bool(value['reasons']))
    require(value['verdict'] != 'not_started' or value['run_id'] is None)
    require(value['verdict'] != 'ok' or hex_id(value['run_id']))
    shadow(value['shadow'], now)
    return value


def combine(prod, now, prod_read=True):
    result = {'at': int(now), 'verdict': 'attention', 'reasons': [], 'run_id': None,
              'prod_state': 'unknown', 'watchdog_at': None}
    if not prod_read:
        result['reasons'] = ['PROD_STATUS_UNAVAILABLE']; return result
    try: production(prod, now)
    except Exception:
        result['reasons'] = ['PROD_STATUS_INVALID']; return result
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
        if watch['at'] <= now+60:
            result['watchdog_at'] = watch['at']
        if not -60 <= now-watch['at'] <= CONTRACT['watchdog_max_age']:
            reasons.add('WATCHDOG_STALE')
        if watch['run_id'] != result['run_id']: reasons.add('WATCHDOG_RUN_MISMATCH')
        if watch['verdict'] == 'not_started' and run is not None: reasons.add('STATUS_INCONSISTENT')
        reasons.update(watch['reasons'])
    if prod.get('failure') is not None:
        # Validated above; carried through so the alert can name the
        # stage and code instead of only that the run failed.
        result['failure'] = prod['failure']
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
