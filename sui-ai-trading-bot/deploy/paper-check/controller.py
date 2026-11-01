#!/usr/bin/python3
"""Fixed root-owned PAPER test supervisor. Install only after independent review.

No image/path/duration/command is accepted from SSH. No token is returned.
The stop entrypoint deliberately does not acquire the run/deploy lock.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
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
POLICY = Path('/etc/suiba-paper-check/policy.json')


def require(value):
    if not value:
        raise RuntimeError('PAPER_CHECK_REJECTED')


class Controller:
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
        require(expected is None or value == expected)
        return record

    def folder(self, record):
        path = self.state/record['id']
        with self.b.directory(path): pass
        return path

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
            require(time.time()*1000 < record['cutoff'])
            self.b.atomic(self.folder(record)/'mutation.json', {'id': self.run_id, 'pending': operation})
            result = action()
            self.b.atomic(self.folder(record)/'mutation.json', {'id': self.run_id, 'pending': None})
            return result

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
        for unit in (TIMER, CUTOFF):
            raw = subprocess.check_output(['/usr/bin/systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'Job'],
                                          timeout=5, env={'PATH': '/usr/bin:/bin'}, stderr=subprocess.DEVNULL).decode()
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
        deadline = time.monotonic()+60
        while True:
            require(time.monotonic() < deadline and time.time()*1000 < cutoff)
            i = self.inspect()
            require(i['State']['Running'] and not i['State']['OOMKilled'] and i['RestartCount'] == 0)
            health = i['State'].get('Health', {}).get('Status')
            require(health in ('starting', 'healthy'))
            if health == 'healthy':
                try:
                    d = self.api('GET', '/api/deployment')
                    if d.get('startReady') is True:
                        return d
                except urllib.error.URLError as error:
                    require(not isinstance(error, urllib.error.HTTPError) and isinstance(error.reason, ConnectionRefusedError))
            time.sleep(1)

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
        if record['status'] == 'completed': return True
        expected = record['id']
        try:
            with self.locked('stop', wait=60):
                record = self.current(expected)  # stale callers may not signal/write a newer run
                if record['status'] == 'completed': return True
                try:
                    with self.locked('mutation'):
                        self.intent(record, source)
                except Exception:
                    # Emergency intent blocks subsequent admissions. The current
                    # operation is already journaled and cannot yield clean success.
                    self.intent(record, source)
                    self.fault(record, 'MUTATION_IN_FLIGHT')
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
                    self.receipt(record, 'failed_state_unknown', ['CLEANUP_LOCK_OR_STATE_UNKNOWN'])
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

    def cleanup(self, record, own, source):
        self.receipt(record, 'stopping_state_unknown', [])
        errors = []
        if record.get('admitted'):
            with contextlib.suppress(Exception): self.api('POST', '/api/control', {'command': 'stop'})
            try: self.docker.call(['update', '--restart=no', CONTAINER], timeout=10)
            except Exception: errors.append('RESTART_UNCONFIRMED')
            try: self.docker.call(['stop', '--timeout', '40', CONTAINER], timeout=50)
            except Exception:
                errors.append('NORMAL_STOP_FAILED')
                try: self.docker.call(['kill', CONTAINER], timeout=10)
                except Exception: errors.append('STOP_UNKNOWN')
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

    def run(self):
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
            self.b.Broker(state=self.b.STATE).check_paper_session()
            config = self.b.decode(self.b.read_trusted(POLICY))
            require(config == {'enabled': True, 'mode': 'sui-30m'})
            if self.record.exists():
                old = self.b.decode(self.b.read_trusted(self.record))
                require(old['status'] == 'completed')
            with self.locked('stop'), self.locked('mutation'):
                require(not (self.state/'abort-inhibit.json').exists())
                self.quiescent()
                if self.record.exists():
                    old = self.current()
                    require(old['status'] == 'completed')
                    require(self.exited(old))
                    previous = self.b.decode(self.b.read_trusted(self.folder(old)/'stop.json'))
                    require(previous['id'] == old['id'] and previous['status'] == 'clean_stopped' and not self.faults(old))
                now = int(time.time()*1000)
                self.run_id = uuid.uuid4().hex
                (self.state/self.run_id).mkdir(mode=0o700)
                identity, _ = self.identity(os.getpid())
                record = {'status': 'in_progress', 'id': self.run_id, 'controller': identity, 'admitted': False,
                          'started': now, 'cutoff': now+1800000}
                self.b.atomic(self.b.STATE/'paper-check.json', {'status': 'in_progress'})
                self.b.atomic(self.record, record)
            space = os.statvfs(self.b.BACKUPS)
            require(space.f_bavail*space.f_frsize >= 20*1024**3 and space.f_favail >= 100000)
            ledger = self.b.decode(self.b.read_trusted(self.b.STATE/'ledger.json'))
            require(ledger['status'] == 'prepared_stopped')
            i = self.inspect()
            require(i['State']['Status'] in ('created', 'exited') and not i['State']['Running'] and
                    i['State']['ExitCode'] == 0 and not i['State']['OOMKilled'])
            require(i['HostConfig']['RestartPolicy']['Name'] == 'no' and i['Config']['User'] == '1000:1000')
            env = dict(v.split('=', 1) for v in i['Config']['Env'])
            require(env.get('MODE') == 'PAPER' and env.get('TRADING_PAIR') == 'SUI_USDC' and
                    env.get('PAPER_CHECK_MODE') == 'sui-30m' and env.get('MARKET_DATA_PROVIDER') == 'geckoterminal')
            require(i['HostConfig']['PortBindings'] == {'3100/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3100'}]})
            require(i['HostConfig']['Memory'] == i['HostConfig']['MemorySwap'] == 1024**3)
            require(self.b.SHA.fullmatch(ledger['sha']) and
                    i['Config']['Labels'].get('org.opencontainers.image.revision') == ledger['sha'])
            require(len(ledger['transaction']) == 32 and all(c in '0123456789abcdef' for c in ledger['transaction']))
            frozen = self.b.decode(self.b.read_trusted(self.b.STATE/ledger['transaction']/'compose.json'))
            require(i['Config']['Image'] == frozen['services']['bot']['image'])
            with self.locked('mutation'):
                require(not (self.folder(record)/'stop-request.json').exists())
                record['admitted'] = True
                self.b.atomic(self.record, record)
            self.guard('timer', lambda: self.system('start', TIMER))
            self.system('is-active', '--quiet', TIMER)
            backup = self.guard('backup', self.backup)
            with self.locked('mutation'):
                require(self.current(self.run_id)['status'] == 'in_progress' and
                        not (self.folder(record)/'stop-request.json').exists())
                record['backup'] = backup
                self.b.atomic(self.record, record)
            try:
                self.guard('unlatch', lambda: self.maintenance(False))
                self.guard('worker-start', lambda: self.docker.call(['start', CONTAINER], timeout=20))
                # Readiness GETs only. Never retry a start/arm/order/reset action.
                d = self.wait_ready(record['cutoff'])
                require(d['mode'] == 'PAPER' and not d['running'] and not d['maintenance'] and
                        d['databaseHealthy'] and d['ledgerOk'] and d['paperCheck']['enabled'] and not d['paperCheck']['armed'])
                require(self.api('GET', '/api/pairs')['selected'] == 'SUI_USDC')
                market = self.api('GET', '/api/dashboard/summary')['summary']['marketData']
                require(market['source'] == 'GeckoTerminal' and 0 <= time.time()*1000-market['lastSuccessAt'] <= 90000)
                # Existing start guards check connectivity/accounting/market state.
                armed = self.guard('arm', lambda: self.api('POST', '/api/paper-check/arm',
                                 {'expiresAt': record['cutoff'], 'issuedAt': int(time.time()*1000)}))
                require(armed['expires'] == record['cutoff'] and armed['armed'] and not armed['expired'])
                started = self.guard('paper-start', lambda: self.api('POST', '/api/control', {'command': 'start'}))
                require(started['running'] is True)
                end = time.monotonic()+1800
                while time.monotonic() < end and time.time()*1000 < record['cutoff']-5000:
                    self.system('is-active', '--quiet', TIMER)
                    d = self.api('GET', '/api/deployment')
                    require(d['mode'] == 'PAPER' and d['running'] and d['databaseHealthy'] and d['ledgerOk'])
                    require(self.api('GET', '/api/pairs')['selected'] == 'SUI_USDC')
                    market = self.api('GET', '/api/dashboard/summary')['summary']['marketData']
                    require(market['source'] == 'GeckoTerminal' and 0 <= time.time()*1000-market['lastSuccessAt'] <= 90000)
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
                    time.sleep(5)
                require(self.stop(own=True, expected=self.run_id, source='normal'))
                self.system('stop', TIMER)
                with self.locked('stop'), self.locked('mutation'):
                    record = self.current(self.run_id)
                    require(record['status'] == 'in_progress' and not self.faults(record))
                    require(self.b.decode(self.b.read_trusted(self.folder(record)/'stop-request.json'))['source'] == 'normal')
                    record['status'] = 'finishing'
                    self.b.atomic(self.record, record)
                # ExecStopPost confirms this process actually exited, then alone
                # publishes clean_stopped/completed and releases deployment gate.
            except BaseException:
                self.stop(own=True, expected=self.run_id, source='failure')
                raise
        finally:
            os.close(fd)


def main():
    os.umask(0o077)
    try:
        require(os.geteuid() == 0 and len(sys.argv) == 2 and sys.argv[1] in ('request', 'run', 'stop', 'post-stop'))
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
        b.read_trusted(Path(__file__))
        controller = Controller(b)
        if sys.argv[1] == 'request':
            import pwd
            account = pwd.getpwnam('suiba-deploy')
            require(os.environ.get('SUDO_USER') == account.pw_name and os.environ.get('SUDO_UID') == str(account.pw_uid))
            signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(RuntimeError()))
            signal.alarm(5)
            request = b.decode(sys.stdin.buffer.read(257))
            signal.alarm(0)
            require(request in ({'operation': 'start'}, {'operation': 'status'}, {'operation': 'abort'}))
            if request['operation'] == 'status':
                record = controller.current()
                receipt = controller.folder(record)/'stop.json'
                print(json.dumps({'run': record, 'requires_review': controller.faults(record),
                                  'stop': b.decode(b.read_trusted(receipt)) if receipt.exists() else None}))
            elif request['operation'] == 'start':
                require(not (controller.state/'abort-inhibit.json').exists())
                controller.system('start', '--no-block', SERVICE)
                print('PAPER_CHECK_REQUEST_ACCEPTED')
            else:
                with controller.locked('stop'):
                    # Also fences abort before run.json has been published.
                    controller.b.atomic(controller.state/'abort-inhibit.json', {'status': 'manual_reconciliation_required'})
                    if controller.record.exists():
                        controller.intent(controller.current(), 'abort')
                controller.system('start', '--no-block', CUTOFF)
                print('PAPER_CHECK_ABORT_REQUESTED')
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
