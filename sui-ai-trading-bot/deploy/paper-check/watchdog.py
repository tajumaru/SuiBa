#!/usr/bin/python3
"""Stateless, read-only host checker. Only status.json and journal are written.

No controller imports, credentials, recovery commands or previous-result reads.
The production status request always goes through the existing restricted wrapper.
"""
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid

STATE = Path('/var/lib/suiba-watchdog')
PRODUCTION = Path('/var/lib/suiba-paper-check/production')
BACKUPS = Path('/opt/suiba/backups')
CONTAINER = 'suiba-vps-bot-1'
DATA = 'suiba-vps-data'
SERVICE = 'suiba-prod.service'
CUTOFFS = ('suiba-paper-check-cutoff.timer', 'suiba-paper-check-cutoff-6h.timer',
           'suiba-paper-check-cutoff-24h.timer', 'suiba-paper-check-cutoff.service')
STATUS_COMMAND = ('/usr/bin/su', '-s', '/bin/sh', 'suiba-deploy', '-c',
                  '/usr/bin/sudo -n -- /usr/local/sbin/suiba-paper-check')
PROGRESS_MAX_AGE = 90
STARTUP_GRACE = 180


def require(value):
    if not value:
        raise ValueError('WATCHDOG_INVALID_EVIDENCE')


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def shadow(value, now):
    require(value is None or isinstance(value, dict) and
            set(value) == {'total', 'aiOnlyBuy', 'errors', 'lastDecisionAt'} and
            all(type(value[key]) is int and value[key] >= 0 for key in ('total', 'aiOnlyBuy', 'errors')) and
            value['aiOnlyBuy'] <= value['total'] and value['errors'] <= value['total'] and
            (value['lastDecisionAt'] is None or type(value['lastDecisionAt']) is int and
             0 <= value['lastDecisionAt'] <= int((now+60)*1000)))
    return value


def read_json(path, owner=0, maximum=131072, directory_fd=None):
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == owner and not info.st_mode & 0o022)
        raw = os.read(fd, maximum+1)
        require(len(raw) <= maximum)
        value = json.loads(raw)
        require(isinstance(value, dict))
        return value, info
    finally:
        os.close(fd)


class Host:
    def command(self, args, request=None):
        result = subprocess.run(args, input=request, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=20, check=True, cwd='/',
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8',
                                     'HOME': '/', 'DOCKER_HOST': 'unix:///var/run/docker.sock',
                                     'DOCKER_CONFIG': '/etc/suiba-deploy/docker'})
        require(len(result.stdout) <= 131072)
        return result.stdout

    def status(self):
        value = json.loads(self.command(STATUS_COMMAND, b'{"operation":"prod-status"}'))
        require(isinstance(value, dict))
        return value

    def collect(self, status, now):
        result = {}
        run = status['run']
        try:
            raw = self.command(('/usr/bin/systemctl', 'show', SERVICE, *CUTOFFS,
                                '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Job')).decode()
            units = {}
            for block in raw.strip().split('\n\n'):
                values = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
                units[values['Id']] = values
            result['service_active'] = units[SERVICE]['LoadState'] == 'loaded' and units[SERVICE]['ActiveState'] == 'active'
            result['cutoffs_quiet'] = all(units[name]['LoadState'] == 'loaded' and
                units[name]['ActiveState'] in ('inactive', 'failed') and units[name]['Job'] in ('', '0') for name in CUTOFFS)
        except Exception:
            pass
        try:
            values = json.loads(self.command(('/usr/bin/docker', 'inspect', CONTAINER)))
            require(isinstance(values, list) and len(values) == 1)
            i = values[0]
            result['container'] = {'running': i['State']['Running'], 'oom': i['State']['OOMKilled'],
                'restarts': i['RestartCount'], 'restart': i['HostConfig']['RestartPolicy']['Name'],
                'health': i['State'].get('Health', {}).get('Status'), 'exit': i['State']['ExitCode']}
        except Exception:
            pass
        try:
            progress, info = read_json(PRODUCTION/'progress.json')
            require(number(run.get('started')) and info.st_mtime >= run['started']/1000)
            result['progress'] = progress
        except Exception:
            pass
        try:
            memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
            result['memory_kib'] = int(memory['MemAvailable'].split()[0])
            space = os.statvfs(BACKUPS)
            result['disk_bytes'] = space.f_bavail*space.f_frsize
            result['disk_inodes'] = space.f_favail
        except Exception:
            pass
        try:
            record, _ = read_json(PRODUCTION/'prod.json')
            require(record['id'] == run['id'] and record['started'] == run['started'])
            backup = record['backup']
            require(isinstance(backup['file'], str) and re.fullmatch(r'paper-check-[0-9a-f]{32}\.tar', backup['file']) and
                    isinstance(backup['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', backup['sha256']))
            info = (BACKUPS/backup['file']).lstat()
            # Provenance/freshness only: do not rehash large archives or open DBs
            # on every timer tick. Start/stop already verify backup integrity.
            result['backup_ok'] = (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and
                not info.st_mode & 0o022 and info.st_size > 0 and run['started']/1000-2 <= info.st_mtime <= now+2)
        except Exception:
            pass
        try:
            volumes = json.loads(self.command(('/usr/bin/docker', 'volume', 'inspect', DATA)))
            require(len(volumes) == 1 and volumes[0]['Name'] == DATA)
            source = Path(volumes[0]['Mountpoint'])
            require(source.is_absolute() and '..' not in source.parts and source.parts[-2:] == (DATA, '_data'))
            fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                lifecycle, _ = read_json('bot.sqlite.lifecycle.json', owner=1000, maximum=4096, directory_fd=fd)
                require(lifecycle.get('mode') == 'PAPER' and lifecycle.get('state') in ('running', 'clean'))
                result['lifecycle'] = lifecycle['state']
                try:
                    latch = os.stat('bot.sqlite.maintenance', dir_fd=fd, follow_symlinks=False)
                    require(stat.S_ISREG(latch.st_mode) and latch.st_uid == 1000 and latch.st_nlink == 1)
                    result['latch'] = True
                except FileNotFoundError:
                    result['latch'] = False
            finally:
                os.close(fd)
        except Exception:
            pass
        return result


def assess(status, evidence, now):
    require(type(status.get('requires_review')) is bool and 'run' in status)
    reasons = set()
    if status['requires_review']:
        reasons.add('REVIEW_REQUIRED')
    run = status['run']
    if run is None:
        return ('attention' if reasons else 'not_started'), sorted(reasons), None
    require(isinstance(run, dict) and isinstance(run.get('id'), str) and re.fullmatch(r'[0-9a-f]{32}', run['id']) and
            run.get('status') in ('in_progress', 'completed', 'failed_requires_review') and
            number(run.get('started')) and 0 <= run['started']/1000 <= now and
            type(status.get('controller_alive')) is bool)
    active = run['status'] == 'in_progress'
    starting = active and run.get('stage') != 'monitoring' and now-run['started']/1000 <= STARTUP_GRACE
    if run['status'] == 'failed_requires_review': reasons.add('RUN_FAILED')
    if active and not status['controller_alive']: reasons.add('CONTROLLER_NOT_RUNNING')
    if not active and status['controller_alive']: reasons.add('CONTROLLER_UNEXPECTED')
    if active and evidence.get('service_active') is not True: reasons.add('PROD_SERVICE_INACTIVE')
    if active and evidence.get('cutoffs_quiet') is not True: reasons.add('CUTOFF_NOT_QUIET')
    if active and not starting:
        if run.get('stage') != 'monitoring': reasons.add('STARTUP_STALLED')
        worker = status.get('worker')
        if worker == {'reachable': False, 'reason': 'WORKER_UNREACHABLE'}:
            reasons.add('WORKER_UNREACHABLE')
        elif not isinstance(worker, dict) or set(worker) != {'running', 'maintenance', 'databaseHealthy', 'ledgerOk', 'paper'} or any(type(v) is not bool for v in worker.values()):
            reasons.add('WORKER_STATE_INVALID')
        else:
            for key, code in (('running', 'TRADING_STOPPED'), ('databaseHealthy', 'DATABASE_UNHEALTHY'),
                              ('ledgerOk', 'LEDGER_UNHEALTHY'), ('paper', 'NOT_PAPER')):
                if not worker[key]: reasons.add(code)
            if worker['maintenance']: reasons.add('MAINTENANCE_ENABLED')
        p = evidence.get('progress', {})
        if not number(p.get('at')) or not 0 <= now-p['at'] <= PROGRESS_MAX_AGE or p.get('status') != 'monitoring' or p.get('pair') != 'SUI_USDC':
            reasons.add('PROGRESS_STALE')
        if not number(p.get('market_last_success')) or not 0 <= now*1000-p['market_last_success'] <= 90000:
            reasons.add('MARKET_STALE')
    container = evidence.get('container')
    if not isinstance(container, dict) or type(container.get('running')) is not bool or type(container.get('oom')) is not bool or type(container.get('restarts')) is not int or type(container.get('exit')) is not int:
        reasons.add('CONTAINER_UNAVAILABLE')
    else:
        if container['oom']: reasons.add('CONTAINER_OOM')
        if container['restarts'] != 0 or container.get('restart') != 'no': reasons.add('RESTART_POLICY_OR_COUNT')
        if active and not starting and not container['running']: reasons.add('CONTAINER_STOPPED')
        if active and not starting and container.get('health') != 'healthy': reasons.add('CONTAINER_UNHEALTHY')
        if not active and container['running']: reasons.add('UNEXPECTED_CONTAINER_RUNNING')
        if not container['running'] and container['exit'] != 0: reasons.add('UNCLEAN_CONTAINER_EXIT')
        if not starting:
            if evidence.get('lifecycle') != ('running' if container['running'] else 'clean'): reasons.add('LIFECYCLE_UNCONFIRMED')
            if type(evidence.get('latch')) is not bool: reasons.add('LATCH_UNCONFIRMED')
            elif not container['running'] and not evidence['latch']: reasons.add('STOPPED_WITHOUT_LATCH')
            elif active and container['running'] and evidence['latch']: reasons.add('MAINTENANCE_ENABLED')
    if not number(evidence.get('memory_kib')) or evidence['memory_kib'] < 256*1024: reasons.add('HOST_MEMORY_LOW_OR_UNKNOWN')
    if (not number(evidence.get('disk_bytes')) or evidence['disk_bytes'] < 20*1024**3 or
            not number(evidence.get('disk_inodes')) or evidence['disk_inodes'] < 100000): reasons.add('HOST_DISK_LOW_OR_UNKNOWN')
    if not starting and evidence.get('backup_ok') is not True: reasons.add('BACKUP_UNCONFIRMED')
    return ('attention' if reasons else 'ok'), sorted(reasons), run['id']


def check(host, now):
    try:
        status = host.status()
    except Exception:
        return {'at': int(now), 'verdict': 'attention', 'reasons': ['STATUS_UNAVAILABLE'], 'run_id': None, 'shadow': None}
    try:
        evidence = host.collect(status, now) if status.get('run') is not None else {}
        verdict, reasons, run_id = assess(status, evidence, now)
        return {'at': int(now), 'verdict': verdict, 'reasons': reasons, 'run_id': run_id,
                'shadow': shadow(status.get('shadow'), now)}
    except Exception:
        return {'at': int(now), 'verdict': 'attention', 'reasons': ['STATUS_INVALID'], 'run_id': None, 'shadow': None}


def record(value):
    # Never read the previous result: it is an output artifact, not checker state.
    STATE.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = '.status-'+uuid.uuid4().hex
    try:
        info = os.fstat(fd)
        require(info.st_uid == 0 and not info.st_mode & 0o077)
        out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(out, 'wb') as stream:
            stream.write((json.dumps(value, allow_nan=False)+'\n').encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(name, 'status.json', src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)


def main():
    try:
        require(len(sys.argv) == 1 and os.geteuid() == 0)
        value = check(Host(), time.time())
        record(value)
        if value['verdict'] != 'not_started':
            print('SUIBA_WATCHDOG_'+value['verdict'].upper()+(' '+','.join(value['reasons']) if value['reasons'] else ''), flush=True)
        return 0
    except Exception:
        print('SUIBA_WATCHDOG_RECORD_FAILED', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
