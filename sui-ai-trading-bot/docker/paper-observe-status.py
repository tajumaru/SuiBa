"""Runner-only shape validation for the paper-check status observation.

Reads the raw controller status response captured by ssh-paper-observe.sh
and writes the small, fully validated report the notifier consumes. A read
failure or any shape violation is reported as attention with a fixed reason
code; raw host output never leaves this process."""
import json
from pathlib import Path
import re
import sys
import time

RUN_STATES = ('in_progress', 'finishing', 'completed', 'failed_requires_review')
DURATIONS = ('30m', '2h', '6h', '24h')


def require(value):
    if not value: raise ValueError('PAPER_RESPONSE_INVALID')


def hex_id(value):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{32}', value) is not None


def read(path):
    raw = Path(path).read_bytes()
    require(len(raw) <= 65536)

    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result

    def constant(name):
        raise ValueError('PAPER_RESPONSE_INVALID')

    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)


def combine(payload, now, read_ok=True):
    result = {'at': int(now), 'verdict': 'attention', 'reasons': [],
              'run_id': None, 'run_status': None, 'duration': None}
    if not read_ok:
        result['reasons'] = ['PAPER_STATUS_UNAVAILABLE']; return result
    try:
        require(type(payload) is dict and type(payload.get('requires_review')) is bool)
        run = payload.get('run')
        if run is None:
            if payload['requires_review']:
                result['reasons'] = ['RUN_FAILED_REQUIRES_REVIEW']; return result
            result.update(verdict='no_run'); return result
        require(type(run) is dict and hex_id(run.get('id')))
        require(run.get('status') in RUN_STATES)
        duration = run.get('duration')
        require(duration is None or duration in DURATIONS)
    except Exception:
        result['reasons'] = ['PAPER_STATUS_INVALID']; return result
    reasons = set()
    # requires_review is the controller's fault latch. While a run is admitted
    # and in progress (or finishing), the latch may still describe the previous
    # failure's reconciliation state, so the run's own status decides. A latch
    # on a terminal run means the failure was never reconciled.
    if run['status'] == 'failed_requires_review':
        reasons.add('RUN_FAILED_REQUIRES_REVIEW')
    elif payload['requires_review'] and run['status'] not in ('in_progress', 'finishing'):
        reasons.add('RUN_FAILED_REQUIRES_REVIEW')
    result.update(verdict='attention' if reasons else 'ok', reasons=sorted(reasons),
                  run_id=run['id'], run_status=run['status'], duration=duration)
    return result


def main():
    result_path, read_flag, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    payload = None
    if read_flag == '1':
        try: payload = read(result_path)
        except Exception: read_flag = '0'
    report = combine(payload, time.time(), read_flag == '1')
    Path(out_path).write_text(json.dumps(report), encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
