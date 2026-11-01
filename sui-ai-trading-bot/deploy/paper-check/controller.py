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
            helper, image = self.helper()
            helper.helper(image, 'maintenance')
        else:
            # Exactly one fixed offline latch. No generic shell or path argument.
            helper, image = self.helper()
            self.docker.call(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--user', '1000:1000',
                '--memory', '128m', '--memory-swap', '128m', '--pids-limit', '32',
                '-v', self.b.DATA+':/app/data', '--entrypoint', '/usr/local/bin/node', image,
                '-e', 'const f=require("fs"),p="/app/data/bot.sqlite.maintenance";const s=f.lstatSync(p);if(!s.isFile()||s.nlink!==1)throw Error("UNSAFE_LATCH");f.unlinkSync(p);const d=f.openSync("/app/data","r");f.fsyncSync(d);f.closeSync(d)'])

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

    def stop(self):
        # A rejected preflight must not stop an unrelated ordinary PAPER boot.
        if not self.record.exists():
            return True
        active = self.b.decode(self.b.read_trusted(self.record))
        if active.get('status') not in ('in_progress', 'failed_requires_review'):
            return True
        # If the stop process itself is killed, do not leave a success receipt.
        with contextlib.suppress(Exception):
            self.b.atomic(self.state/'stop.json', {'status': 'stopping_state_unknown', 'at': int(time.time())})
        errors = []
        with contextlib.suppress(Exception):
            self.api('POST', '/api/control', {'command': 'stop'})
        try:
            self.docker.call(['update', '--restart=no', CONTAINER], timeout=10)
        except Exception:
            errors.append('RESTART_UNCONFIRMED')
        try:
            self.docker.call(['stop', '--timeout', '40', CONTAINER], timeout=50)
        except Exception:
            errors.append('NORMAL_STOP_FAILED')
            try:
                self.docker.call(['kill', CONTAINER], timeout=10)
            except Exception:
                errors.append('STOP_UNKNOWN')
        try:
            state = self.inspect()['State']
            require(not state['Running'] and state['ExitCode'] == 0 and not state['OOMKilled'])
        except Exception:
            errors.append('UNCLEAN_OR_UNKNOWN')
        try:
            self.maintenance(True)
            helper, image = self.helper()
            helper.helper(image, 'verify')
        except Exception:
            errors.append('DB_OR_MAINTENANCE_UNCONFIRMED')
        self.b.atomic(self.state/'stop.json', {'status': 'failed_state_unknown' if errors else 'clean_stopped',
                                             'errors': errors, 'at': int(time.time())})
        return not errors

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
            config = self.b.decode(self.b.read_trusted(Path('/etc/suiba-paper-check/policy.json')))
            require(config == {'enabled': True, 'mode': 'sui-30m'})
            if self.record.exists():
                old = self.b.decode(self.b.read_trusted(self.record))
                require(old['status'] == 'completed')
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
            backup = self.backup()
            record = {'status': 'in_progress', 'id': uuid.uuid4().hex, 'backup': backup,
                      'started': int(time.time()), 'cutoff': int(time.time())+1800}
            self.b.atomic(self.record, record)
            # Durable refusal survives controller SIGKILL and lock release.
            self.b.atomic(self.b.STATE/'paper-check.json', {'status': 'in_progress'})
            self.system('start', TIMER)
            self.system('is-active', '--quiet', TIMER)
            try:
                self.maintenance(False)
                self.docker.call(['start', CONTAINER], timeout=20)
                # Readiness GETs only. Never retry a start/arm/order/reset action.
                deadline = time.monotonic()+60
                while True:
                    try:
                        d = self.api('GET', '/api/deployment')
                        if d.get('startReady') is True:
                            break
                        require(time.monotonic() < deadline)
                        time.sleep(1)
                    except urllib.error.URLError as error:
                        # Expected readiness only: no retry for HTTP/API errors,
                        # timeouts or a failed start/arm request.
                        require(not isinstance(error, urllib.error.HTTPError) and isinstance(error.reason, ConnectionRefusedError))
                        require(time.monotonic() < deadline)
                        time.sleep(1)
                require(d['mode'] == 'PAPER' and not d['running'] and not d['maintenance'] and
                        d['databaseHealthy'] and d['ledgerOk'] and d['paperCheck']['enabled'] and not d['paperCheck']['armed'])
                require(self.api('GET', '/api/pairs')['selected'] == 'SUI_USDC')
                market = self.api('GET', '/api/dashboard/summary')['summary']['marketData']
                require(market['source'] == 'GeckoTerminal' and 0 <= time.time()*1000-market['lastSuccessAt'] <= 90000)
                # Existing start guards check connectivity/accounting/market state.
                self.api('POST', '/api/paper-check/arm', {})
                started = self.api('POST', '/api/control', {'command': 'start'})
                require(started['running'] is True)
                end = time.monotonic()+1800
                while time.monotonic() < end and time.time() < record['cutoff']-5:
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
                require(self.stop())
                record['status'] = 'completed'
                self.b.atomic(self.record, record)
                self.system('stop', TIMER)
                self.b.atomic(self.b.STATE/'paper-check.json', {'status': 'completed'})
            except BaseException:
                self.stop()
                record['status'] = 'failed_requires_review'
                self.b.atomic(self.record, record)
                raise
        finally:
            os.close(fd)


def main():
    os.umask(0o077)
    try:
        require(os.geteuid() == 0 and len(sys.argv) == 2 and sys.argv[1] in ('request', 'run', 'stop'))
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
                print(json.dumps(b.decode(b.read_trusted(controller.record))))
            elif request['operation'] == 'start':
                controller.system('start', '--no-block', SERVICE)
                print('PAPER_CHECK_REQUEST_ACCEPTED')
            else:
                controller.system('start', '--no-block', 'suiba-paper-check-cutoff.service')
                print('PAPER_CHECK_ABORT_REQUESTED')
        elif sys.argv[1] == 'stop':
            require(controller.stop())
        else:
            controller.run()
        return 0
    except BaseException:
        print('PAPER_CHECK_FAILED; inspect root-owned state; no automatic restart', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
