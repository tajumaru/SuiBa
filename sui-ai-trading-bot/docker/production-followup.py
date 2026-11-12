"""Runner-only follow-up for the production control workflow.

The start/stop wrappers answer with a single fixed line (accepted /
completed) because the host operation is only the admission request:
a start that is accepted can still die minutes later, and a stop can
close a record that failed. This follow-up re-reads production status
through the monitor's existing read path (ssh-prod-status.sh, which
validates the host payload with production-status.py) and prints the
failure summary PR #215 added to that payload — the same fields and
wording production-notify.mjs puts in the alert Issue — so a failed
start or a failure-closing stop is diagnosable from the Actions log
alone. It never sends a host operation itself, prints nothing when the
record carries no failure evidence, and never fails the job: the
control operation has already succeeded by the time it runs.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).parent
CONTRACT = json.loads((HERE/'production-monitor-contract.json').read_text(encoding='utf-8'))
STATUS_SCRIPT = HERE/'ssh-prod-status.sh'
ATTEMPTS = 7
INTERVAL_SECONDS = 15
REPORT_KEYS = {'at', 'verdict', 'reasons', 'run_id', 'prod_state', 'watchdog_at'}
FAILURE_STATUSES = ('in_progress', 'completed', 'failed_requires_review')
CODE_PATTERN = re.compile(r'[A-Za-z][A-Za-z0-9_]{0,63}')


def valid_failure(value):
    """The failure object production-status.py may carry, re-validated
    with the same rules production-notify.mjs applies before printing."""
    if type(value) is not dict or set(value) != {'status', 'stage', 'code', 'http_status', 'backup'}:
        return None
    if value['status'] not in FAILURE_STATUSES:
        return None
    if value['stage'] is not None and value['stage'] not in CONTRACT['stages']:
        return None
    if value['code'] is not None and not (type(value['code']) is str and CODE_PATTERN.fullmatch(value['code'])):
        return None
    if value['http_status'] is not None and not (type(value['http_status']) is int and 100 <= value['http_status'] <= 599):
        return None
    if value['backup'] not in ('confirmed', 'unconfirmed', 'unknown'):
        return None
    return value


def parse_report(value):
    """(prod_state, run_id, failure) for a combined monitor report, or
    None when the report is not the shape production-status.py writes.
    failure is the validated summary, or None when the record carries
    no failure evidence."""
    if type(value) is not dict or not REPORT_KEYS <= set(value) <= REPORT_KEYS | {'failure'}:
        return None
    if value['prod_state'] not in CONTRACT['prod_states']:
        return None
    if value['run_id'] is not None and not (type(value['run_id']) is str and re.fullmatch(r'[a-f0-9]{32}', value['run_id'])):
        return None
    failure = None
    if 'failure' in value:
        failure = valid_failure(value['failure'])
        if failure is None:
            return None
    return value['prod_state'], value['run_id'], failure


def failure_lines(failure):
    """Exactly the lines production-notify.mjs renders in the alert
    Issue for the same summary (HTTP状態 only when a status exists)."""
    lines = [
        f"- 失敗段階: `{failure['stage'] if failure['stage'] is not None else 'unknown'}`",
        f"- 失敗コード: `{failure['code'] if failure['code'] is not None else 'unknown'}`",
    ]
    if failure['http_status'] is not None:
        lines.append(f"- HTTP状態: `{failure['http_status']}`")
    backup = {'confirmed': '確認済み', 'unconfirmed': '未確認'}.get(failure['backup'], '不明')
    lines.append(f'- バックアップ: {backup}')
    return lines


def read_report():
    """One status read through the monitor's path. The raw host payload
    stays inside production-status.py; only its validated combined
    report is read here. Any failure reads as no evidence."""
    folder = Path(tempfile.mkdtemp(prefix='suiba-prod-followup.', dir=os.environ.get('RUNNER_TEMP') or None))
    report_file = folder/'report.json'
    try:
        env = {**os.environ, 'PRODUCTION_REPORT_FILE': str(report_file)}
        subprocess.run(['bash', str(STATUS_SCRIPT)], env=env, capture_output=True, timeout=90, check=False)
        data = report_file.read_bytes()
        if len(data) > 65536:
            return None
        return json.loads(data)
    except Exception:
        return None
    finally:
        try:
            report_file.unlink(missing_ok=True)
            folder.rmdir()
        except OSError:
            pass


def run(mode, read, sleep, emit, attempts=ATTEMPTS, interval=INTERVAL_SECONDS):
    if mode == 'stop':
        parsed = parse_report(read())
        if parsed is not None:
            state, _run_id, failure = parsed
            if failure is not None and state == 'completed':
                emit(failure_lines(failure))
        return 0
    # mode == 'start': poll briefly for the fast failure class (the
    # admission gauntlet). A 'completed' record is only trusted when
    # this same follow-up saw its run live first — the record visible
    # in the first moments can still be the previous, already-closed
    # one, and its failure is not this start's to report.
    seen_live = set()
    for attempt in range(attempts):
        parsed = parse_report(read())
        if parsed is not None:
            state, run_id, failure = parsed
            if run_id is not None and state in ('in_progress', 'failed_requires_review'):
                seen_live.add(run_id)
            if failure is not None:
                last = attempt == attempts - 1
                if (state == 'failed_requires_review'
                        or (state == 'completed' and run_id in seen_live)
                        or (last and state == 'in_progress')):
                    emit(failure_lines(failure))
                    return 0
        if attempt < attempts - 1:
            sleep(interval)
    return 0


def emit_block(lines):
    block = '\n'.join(['### Failure detail (follow-up status read)', *lines]) + '\n'
    sys.stdout.write(block)
    sys.stdout.flush()
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as out:
            out.write(block)


def main():
    mode = os.environ.get('PROD_FOLLOWUP_MODE')
    if mode not in ('start', 'stop'):
        print('PRODUCTION_FOLLOWUP_FAILED (mode details withheld)', file=sys.stderr)
        return 1
    return run(mode, read_report, time.sleep, emit_block)


if __name__ == '__main__':
    sys.exit(main())
