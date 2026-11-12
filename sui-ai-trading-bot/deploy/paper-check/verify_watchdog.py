"""Ephemeral PID1/su/sudo watchdog verification; no Worker or recovery ops.

The status wrapper and host evidence are fixtures. The actual checker, sudo
privilege round-trip, unit sandbox, timer, atomic output and journal are real.
"""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid


def system(*args):
    return subprocess.check_output(['/usr/bin/systemctl', *args], stderr=subprocess.PIPE, timeout=30).decode().strip()


def wait_record(path, predicate):
    deadline = time.monotonic()+30
    while time.monotonic() < deadline:
        try:
            value = json.loads(path.read_text())
            if predicate(value): return value
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(.2)
    raise AssertionError('WATCHDOG_FIXTURE_DID_NOT_REPORT')


def dump_journal_timeout(name, record, expected, last_error):
    print('WATCHDOG_JOURNAL_TIMEOUT expected='+repr(expected), flush=True)
    try:
        info = record.stat()
        print('RESULT_FILE path='+str(record)+' mtime_ns='+str(info.st_mtime_ns), flush=True)
        print(record.read_text(), flush=True)
    except OSError as error:
        print('RESULT_FILE_UNAVAILABLE '+repr(error), flush=True)
    if last_error is not None:
        print('JOURNAL_LAST_ERROR '+repr(last_error), flush=True)
    for label, command in (
        ('SERVICE_STATE', ['/usr/bin/systemctl', 'show', name+'.service',
                           '-p', 'ActiveState', '-p', 'SubState', '-p', 'Result',
                           '-p', 'ExecMainStatus', '-p', 'InvocationID']),
        ('JOURNAL_RECENT', ['journalctl', '-u', name+'.service', '--no-pager',
                            '-n', '60', '-o', 'short-iso-precise']),
    ):
        print(label, flush=True)
        try:
            print(subprocess.check_output(command, stderr=subprocess.STDOUT, timeout=5).decode(), flush=True)
        except (OSError, subprocess.SubprocessError) as error:
            print(label+'_UNAVAILABLE '+repr(error), flush=True)


def wait_journal(name, record, expected):
    # Match wait_record's 30s budget / 200ms cadence, but bound each command
    # by the remaining budget too. A saved result is not a journal barrier.
    deadline = time.monotonic()+30
    last_error = None
    while (remaining := deadline-time.monotonic()) > 0:
        try:
            output = subprocess.check_output(
                ['journalctl', '-u', name+'.service', '--no-pager', '-o', 'cat'],
                stderr=subprocess.STDOUT, timeout=min(10, remaining)).decode()
            if expected in output:
                return
        except (OSError, subprocess.SubprocessError) as error:
            last_error = error
        remaining = deadline-time.monotonic()
        if remaining > 0:
            time.sleep(min(.2, remaining))
    dump_journal_timeout(name, record, expected, last_error)
    raise AssertionError('WATCHDOG_FIXTURE_JOURNAL_DID_NOT_REPORT '+expected)


if len(sys.argv) == 5 and sys.argv[1] == 'check':
    base, output = Path(sys.argv[2]), Path(sys.argv[3])
    assert sys.argv[4] == 'DUMMY-ONLY' and base.parent == output.parent == Path('/var/lib')
    assert base.name.startswith('suiba-watchdog-fixture-') and output.name.startswith('suiba-watchdog-result-')
    spec = importlib.util.spec_from_file_location('watchdog', base/'code/watchdog.py')
    w = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(w)
    w.STATE = output
    # nobody is an existing unprivileged account, granted one no-argument,
    # read-only fixture wrapper in a temporary sudoers rule. No host user is added.
    w.STATUS_COMMAND = ('/usr/bin/su', '-s', '/bin/sh', 'nobody', '-c', '/usr/bin/sudo -n -- '+str(base/'wrapper'))
    w.Host.collect = lambda self, status, now: json.loads((base/'evidence.json').read_text())
    sys.argv = [sys.argv[0]]
    sys.exit(w.main())


def main():
    assert len(sys.argv) == 1 and os.geteuid() == 0
    identity = uuid.uuid4().hex
    name = 'suiba-watchdog-fixture-'+identity
    result_name = 'suiba-watchdog-result-'+identity
    base = Path(tempfile.mkdtemp(prefix=name, dir='/var/lib'))
    base.chmod(0o755)
    output = Path('/var/lib')/result_name
    unit = Path('/run/systemd/system')/(name+'.service')
    timer = unit.with_suffix('.timer')
    sudoers = Path('/etc/sudoers.d')/name
    script = Path(__file__).resolve()
    record = output/'status.json'
    try:
        code = base/'code'; code.mkdir(mode=0o755)
        for filename in ('watchdog.py', 'verify_watchdog.py'):
            shutil.copyfile(script.with_name(filename), code/filename)
        wrapper = base/'wrapper'
        wrapper.write_text('#!/usr/bin/python3\nimport json,os,sys\nassert os.geteuid()==0 and len(sys.argv)==1\nassert json.loads(sys.stdin.buffer.read(257))=={"operation":"prod-status"}\nsys.stdout.write(open('+repr(str(base/'response.json'))+').read())\n')
        wrapper.chmod(0o755)
        sudoers.write_text('nobody ALL=(root) NOPASSWD: '+str(wrapper)+' ""\n')
        sudoers.chmod(0o440)
        subprocess.run(['/usr/sbin/visudo', '-cf', str(sudoers)], check=True)
        def response(value):
            path = base/'response.tmp'
            path.write_text(json.dumps(value)); path.chmod(0o600)
            path.replace(base/'response.json')
        response({'run': None, 'requires_review': False})
        (base/'evidence.json').write_text('{}')
        service = script.with_name('suiba-prod-watchdog.service').read_text()
        service = service.replace('/usr/bin/python3 -I /usr/local/libexec/suiba-prod-watchdog.py',
            '/usr/bin/python3 -I '+str(code/'verify_watchdog.py')+' check '+str(base)+' '+str(output)+' DUMMY-ONLY')
        service = service.replace('StateDirectory=suiba-watchdog\n', 'StateDirectory='+result_name+'\n')
        unit.write_text(service)
        timer.write_text(script.with_name('suiba-prod-watchdog.timer').read_text()
                         .replace('OnBootSec=2min', 'OnBootSec=1s').replace('OnUnitActiveSec=5min', 'OnUnitActiveSec=2s')
                         .replace('AccuracySec=30s', 'AccuracySec=100ms').replace('suiba-prod-watchdog.service', name+'.service'))
        system('daemon-reload')
        system('start', name+'.timer')
        wait_record(record, lambda v: v['verdict'] == 'not_started')
        def journal():
            return subprocess.check_output(['journalctl', '-u', name+'.service', '--no-pager', '-o', 'cat'], timeout=10).decode()
        assert 'SUIBA_WATCHDOG_' not in journal()
        now = time.time()
        status = {'run': {'id': 'a'*32, 'status': 'in_progress', 'started': int((now-1000)*1000),
                         'stopped': None, 'sha': 'e'*40, 'stage': 'monitoring', 'admitted': True},
                  'controller_alive': True, 'requires_review': False,
                  'worker': {'running': True, 'maintenance': False, 'databaseHealthy': True, 'ledgerOk': True, 'paper': True}}
        evidence = {'service_active': True, 'cutoffs_quiet': True,
                    'container': {'running': True, 'oom': False, 'restarts': 0, 'restart': 'no', 'health': 'healthy', 'exit': 0},
                    'progress': {'at': int(now), 'status': 'monitoring', 'pair': 'SUI_USDC', 'market_last_success': now*1000},
                    'memory_kib': 1024*1024, 'disk_bytes': 30*1024**3, 'disk_inodes': 200000,
                    'backup_ok': True, 'lifecycle': 'running', 'latch': False}
        (base/'evidence.json').write_text(json.dumps(evidence))
        record.write_text('SECRET_FIXTURE_PREVIOUS_RESULT')
        response(status)
        wait_record(record, lambda v: v['verdict'] == 'ok')
        assert 'SUIBA_WATCHDOG_OK' in journal()
        status['worker'] = {'reachable': False, 'reason': 'WORKER_UNREACHABLE'}
        response(status)
        wait_record(record, lambda v: v['verdict'] == 'attention' and v['reasons'] == ['WORKER_UNREACHABLE'])
        wait_journal(name, record, 'SUIBA_WATCHDOG_ATTENTION WORKER_UNREACHABLE')
        # Invalid wrapper output cannot leak into either record or journal.
        (base/'response.json').write_text('SECRET_FIXTURE_RESPONSE')
        wait_record(record, lambda v: v['reasons'] == ['STATUS_UNAVAILABLE'])
        assert 'SECRET_FIXTURE' not in journal()+record.read_text()
        response({'run': None, 'requires_review': False})
        last = wait_record(record, lambda v: v['verdict'] == 'not_started')
        count = journal().count('SUIBA_WATCHDOG_')
        wait_record(record, lambda v: v['verdict'] == 'not_started' and v['at'] > last['at'])
        assert journal().count('SUIBA_WATCHDOG_') == count
        assert record.stat().st_uid == 0 and stat.S_IMODE(record.stat().st_mode) == 0o600
        assert output.stat().st_uid == 0 and stat.S_IMODE(output.stat().st_mode) == 0o700
        assert system('show', name+'.service', '-p', 'NRestarts', '--value') == '0'
        assert system('show', name+'.service', '-p', 'Restart', '--value') == 'no'
        print('PASS: watchdog timer / restricted read-only sudo wrapper / journal / atomic result; no recovery')
    except BaseException:
        with contextlib.suppress(Exception):
            subprocess.run(['journalctl', '-u', name+'.service', '--no-pager', '-n', '60'], check=False)
        raise
    finally:
        subprocess.run(['systemctl', 'stop', name+'.timer', name+'.service'], check=False)
        for path in (unit, timer, sudoers): path.unlink(missing_ok=True)
        subprocess.run(['systemctl', 'daemon-reload'], check=False)
        for path, prefix in ((base, 'suiba-watchdog-fixture-'), (output, 'suiba-watchdog-result-')):
            assert path.parent == Path('/var/lib') and path.name.startswith(prefix)
            if path.exists(): shutil.rmtree(path)


if __name__ == '__main__':
    main()
