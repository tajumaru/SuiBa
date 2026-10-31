#!/usr/bin/python3
"""Root-owned, no-argument release admission. Never starts a container.

The SSH caller controls only a SHA/operation request and an untrusted archive.
All paths, Docker policy and approval records are administrator-owned.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

SHA = re.compile(r"[a-f0-9]{40}\Z")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
HEX = re.compile(r"[a-f0-9]{64}\Z")
MAX_ARCHIVE = 2 * 1024**3
POLICY = Path('/etc/suiba-deploy')
STATE = Path('/var/lib/suiba-deploy')
INCOMING = Path('/var/lib/suiba-incoming')
BACKUPS = Path('/opt/suiba/backups')
DATA = 'suiba-vps-data'
REPORTS = 'suiba-vps-reports'
PROJECT = 'suiba-vps'
RUNTIME = '/opt/suiba/shared/runtime.env'
TOKEN = '/opt/suiba/shared/admin-token'


class Rejected(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_KEY')
        result[key] = value
    return result


def decode(raw):
    return json.loads(raw, object_pairs_hook=unique_object)


def request(raw):
    require(len(raw) <= 512, 'REQUEST_TOO_LARGE')
    value = decode(raw)
    require(isinstance(value, dict) and set(value) == {'operation', 'sha'}, 'REQUEST_SCHEMA')
    require(value['operation'] in ('deploy', 'rollback'), 'OPERATION')
    require(isinstance(value['sha'], str) and SHA.fullmatch(value['sha']), 'SHA')
    return value


@contextlib.contextmanager
def directory(path, owner=0):
    """Walk every ancestor with openat/O_NOFOLLOW, not realpath then reopen."""
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'PATH')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(path.parts[1:]):
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
            s = os.fstat(fd)
            expected = owner if index == len(path.parts) - 2 else 0
            require(s.st_uid == expected and not (s.st_mode & 0o022), 'DIRECTORY_OWNER_MODE')
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def regular(path, owner=0):
    with directory(Path(path).parent) as parent:
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == owner and not (s.st_mode & 0o022), 'FILE_OWNER_MODE')
        yield fd
    finally:
        os.close(fd)


def read_trusted(path, maximum=65536):
    with regular(path) as fd:
        raw = os.read(fd, maximum + 1)
        require(len(raw) <= maximum, 'TRUSTED_FILE_TOO_LARGE')
        return raw


def atomic(path, value):
    # Parent was verified and is never writable by the SSH caller.
    raw = json.dumps(value, sort_keys=True).encode() + b'\n'
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        with directory(path.parent) as parent:
            os.fsync(parent)
    finally:
        if temp.exists():
            temp.unlink()


class Docker:
    def __init__(self, state):
        self.state = state

    def call(self, args, image='', output=None, timeout=180):
        # No inherited DOCKER/COMPOSE/NODE/LD/PYTHON variables or user plugins.
        env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(self.state),
               'DOCKER_CONFIG': '/etc/suiba-deploy/docker',
               'DOCKER_HOST': 'unix:///var/run/docker.sock', 'SUIBA_IMAGE': image}
        # Bounded on-disk diagnostics, never returned to a caller/log.
        # docker output is small for these fixed commands; archive output streams.
        import tempfile
        with tempfile.TemporaryFile(dir=self.state) as capture:
            result = subprocess.run(['/usr/bin/docker', *args], env=env, cwd='/',
                                    stdin=subprocess.DEVNULL, stdout=output or capture,
                                    stderr=subprocess.DEVNULL, timeout=timeout, check=False)
            require(result.returncode == 0, 'DOCKER_OPERATION_FAILED')
            if output:
                return ''
            require(capture.tell() <= 1024**2, 'DOCKER_OUTPUT_TOO_LARGE')
            capture.seek(0)
            return capture.read().decode().strip()


def validate_model(model, image):
    """Fixed project/service, volumes, secret and every executable privilege."""
    require(set(model.get('services', {})) == {'bot'} and model.get('name') == PROJECT, 'COMPOSE_PROJECT')
    bot = model['services']['bot']
    allowed = {'image', 'pull_policy', 'environment', 'ports', 'volumes', 'init', 'restart',
               'stop_signal', 'stop_grace_period', 'mem_limit', 'mem_reservation', 'memswap_limit',
               'cpus', 'pids_limit', 'read_only', 'tmpfs', 'cap_drop', 'security_opt', 'healthcheck',
               'logging', 'secrets', 'networks', 'command', 'entrypoint'}
    require(set(bot) <= allowed, 'COMPOSE_UNKNOWN_SERVICE_FIELD')
    # Compose versions can materialize these omitted defaults as JSON null.
    require(bot.get('command') is None and bot.get('entrypoint') is None, 'COMPOSE_EXECUTABLE_OVERRIDE')
    require(bot['image'] == image and bot.get('pull_policy') == 'never', 'COMPOSE_IMAGE')
    env = bot.get('environment', {})
    for key, expected in {'MODE': 'PAPER', 'HOST': '0.0.0.0', 'PORT': '3100',
                          'DATABASE_PATH': '/app/data/bot.sqlite', 'REQUIRE_EXISTING_DATABASE': '1',
                          'ADMIN_TOKEN': '', 'ADMIN_TOKEN_FILE': '/run/secrets/admin-token',
                          'NODE_OPTIONS': '--max-old-space-size=640', 'VALIDATION_REPORT_DIR': '/app/reports'}.items():
        require(env.get(key) == expected, 'COMPOSE_ENVIRONMENT')
    require(bot.get('read_only') is True and bot.get('init') is True, 'COMPOSE_ISOLATION')
    require(bot.get('cap_drop') == ['ALL'] and bot.get('security_opt') == ['no-new-privileges:true'], 'COMPOSE_PRIVILEGES')
    require(int(bot['mem_limit']) == 1024**3 and int(bot['memswap_limit']) == 1024**3 and
            int(bot['mem_reservation']) == 512*1024**2 and float(bot['cpus']) == 1 and bot['pids_limit'] == 128, 'COMPOSE_RESOURCES')
    require(bot.get('stop_signal') == 'SIGTERM' and bot.get('stop_grace_period') == '40s', 'COMPOSE_STOP')
    ports = bot.get('ports', [])
    require(len(ports) == 1 and ports[0].get('host_ip') == '127.0.0.1' and str(ports[0].get('published')) == '3100' and ports[0].get('target') == 3100, 'COMPOSE_PORT')
    mounts = bot.get('volumes', [])
    require(len(mounts) == 2 and {(m.get('source'), m.get('target'), m.get('type')) for m in mounts} ==
            {('vps-data', '/app/data', 'volume'), ('vps-reports', '/app/reports', 'volume')}, 'COMPOSE_MOUNTS')
    require(model.get('volumes') == {'vps-data': {'name': DATA, 'external': True}, 'vps-reports': {'name': REPORTS, 'external': True}}, 'COMPOSE_VOLUMES')
    require(model.get('secrets') == {'admin-token': {'name': PROJECT+'_admin-token', 'file': TOKEN}}, 'COMPOSE_SECRET')
    require(bot.get('secrets') == [{'source': 'admin-token', 'target': '/run/secrets/admin-token'}] or
            bot.get('secrets') == [{'source': 'admin-token', 'target': 'admin-token'}], 'COMPOSE_SECRET_MOUNT')
    # Hash pinning below covers the rest (tmpfs, network, logs, health command).


class Broker:
    def __init__(self, policy=POLICY, state=STATE, incoming=INCOMING, backups=BACKUPS, docker=None):
        # Alternative paths/transport exist for imported test code only, not CLI/env.
        self.policy, self.state, self.incoming, self.backups = map(Path, (policy, state, incoming, backups))
        self.docker = docker or Docker(self.state)
        self.model = None

    def compose(self, args):
        return self.docker.call(['compose', '-p', PROJECT, '-f', str(self.model), *args])

    def stopped(self):
        ids = self.docker.call(['ps', '-aq', '--filter', 'label=com.docker.compose.project='+PROJECT,
                               '--filter', 'label=com.docker.compose.service=bot']).split()
        require(len(ids) <= 1 and all(re.fullmatch('[a-f0-9]{12,64}', cid) for cid in ids), 'CONTAINER_IDENTITY')
        return ids

    def emergency_stop(self):
        # Best effort, without candidate Compose or environment. Never start/reset.
        try:
            for cid in self.stopped():
                with contextlib.suppress(Exception):
                    self.docker.call(['update', '--restart=no', cid])
                try:
                    self.docker.call(['stop', '--timeout', '40', cid], timeout=60)
                except Exception:
                    self.docker.call(['kill', cid])
                require(self.docker.call(['inspect', '--format', '{{.State.Running}}', cid]) == 'false', 'STOP_UNCONFIRMED')
            return True
        except Exception:
            return False

    def helper(self, helper, command, scratch=None, output=None):
        require(command in ('maintenance', 'verify', 'backup'), 'HELPER_COMMAND')
        name = 'suiba-broker-'+self.transaction_id+'-'+command
        args = ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--user', '1000:1000',
                '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '64',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000', '-v', DATA+':/app/data']
        if scratch:
            args += ['-v', scratch+':/app/reports']
        # The administrator-pinned helper ID, not the newly submitted image.
        try:
            return self.docker.call([*args, helper, 'node', '--import', 'tsx', 'docker/vps-data.mjs', command], output=output)
        except BaseException:
            # A timed-out Docker CLI does not prove its container stopped.
            try:
                self.docker.call(['rm', '-f', name])
            except Exception:
                self.helper_unknown = True
            raise

    def snapshot(self, sha, uid, expected, target):
        with directory(self.incoming, uid) as base:
            d = os.open(sha, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base)
            try:
                s = os.fstat(d)
                require(s.st_uid == uid and not (s.st_mode & 0o022), 'INCOMING_DIRECTORY')
                fd = os.open('image.tar.gz', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=d)
            finally:
                os.close(d)
        try:
            s = os.fstat(fd)
            require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == uid and 0 < s.st_size <= MAX_ARCHIVE, 'ARCHIVE_FILE')
            h, total = hashlib.sha256(), 0
            with open(target, 'xb') as out:
                os.chmod(target, 0o600)
                while True:
                    chunk = os.read(fd, 1024**2)
                    if not chunk:
                        break
                    total += len(chunk)
                    require(total <= MAX_ARCHIVE, 'ARCHIVE_LIMIT')
                    h.update(chunk)
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            require(h.hexdigest() == expected, 'ARCHIVE_DIGEST')
        finally:
            os.close(fd)

    def execute(self, req, uid):
        require(os.geteuid() == 0, 'ROOT_REQUIRED')
        for path in (self.policy, self.state, self.backups, self.policy/'docker', self.policy/'approvals'):
            with directory(path):
                pass
        lockfd = os.open(self.state/'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            s = os.fstat(lockfd)
            require(s.st_uid == 0 and s.st_nlink == 1 and stat.S_ISREG(s.st_mode) and not (s.st_mode & 0o077), 'LOCK_FILE')
            fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Revalidate imported callers too; CLI never accepts a path/image/config.
            request(json.dumps(req).encode())
            try:
                return self.transaction(req, uid)
            finally:
                # Only the root-created snapshot file, never incoming/DB/backup.
                if getattr(self, 'archive', None):
                    self.archive.unlink(missing_ok=True)
        finally:
            os.close(lockfd)

    def transaction(self, req, uid):
        sha, operation = req['sha'], req['operation']
        policy = decode(read_trusted(self.policy/'policy.json'))
        require(set(policy) == {'helper_image', 'compose_sha256'} and DIGEST.fullmatch(policy['helper_image']) and HEX.fullmatch(policy['compose_sha256']), 'POLICY_SCHEMA')
        compose = read_trusted(self.policy/'compose.yaml')
        require(hashlib.sha256(compose).hexdigest() == policy['compose_sha256'], 'COMPOSE_DIGEST')
        read_trusted(RUNTIME) if self.policy == POLICY else None
        if self.policy == POLICY:
            with regular(TOKEN, 1000) as token:
                require(os.fstat(token).st_size >= 32 and not (os.fstat(token).st_mode & 0o077), 'SECRET_MODE')
        approval = decode(read_trusted(self.policy/'approvals'/f'{sha}.json'))
        require(set(approval) == {'sha', 'operation', 'archive_sha256', 'image_id', 'sequence', 'expires', 'repository', 'ref', 'ci_run'}, 'APPROVAL_SCHEMA')
        require(approval['sha'] == sha and approval['operation'] == operation and approval['repository'] == 'tajumaru/SuiBa' and approval['ref'] == 'refs/heads/main', 'APPROVAL_IDENTITY')
        require(HEX.fullmatch(approval['archive_sha256']) and DIGEST.fullmatch(approval['image_id']), 'APPROVAL_DIGEST')
        require(type(approval['sequence']) is int and approval['sequence'] > 0 and type(approval['expires']) is int and approval['expires'] > time.time() and type(approval['ci_run']) is int and approval['ci_run'] > 0, 'APPROVAL_EXPIRY_SEQUENCE')
        ledger = self.state/'ledger.json'
        previous = decode(read_trusted(ledger)) if os.path.lexists(ledger) else {'sequence': 0}
        require(approval['sequence'] > previous['sequence'], 'REPLAY_OR_OLD_RELEASE')
        require(previous.get('status') not in ('in_progress', 'failed_state_unknown'), 'ADMIN_RECONCILIATION_REQUIRED')
        attempt = self.state/'attempt.json'
        if os.path.lexists(attempt):
            require(time.time() - decode(read_trusted(attempt))['at'] >= 30, 'RATE_LIMIT')
        atomic(attempt, {'at': int(time.time())})
        transaction = self.state/uuid.uuid4().hex
        self.transaction_id = transaction.name
        self.helper_unknown = False
        transaction.mkdir(mode=0o700)
        archive = transaction/'image.tar.gz'
        self.archive = archive
        self.snapshot(sha, uid, approval['archive_sha256'], archive)
        # Freeze and validate the root-owned model. Never read uploaded Compose/scripts.
        image = approval['image_id']
        model = decode(self.docker.call(['compose', '-p', PROJECT, '-f', str(self.policy/'compose.yaml'), 'config', '--format', 'json'], image=image))
        validate_model(model, image)
        model['services']['bot']['restart'] = 'no'  # A prepared release must stay stopped.
        model['services']['bot']['user'] = '1000:1000'
        model['services']['bot']['entrypoint'] = ['/usr/local/bin/node', '--import', './scripts/enforce-node-version.mjs', '--import', 'tsx', 'apps/worker/src/index.ts']
        model['services']['bot']['command'] = []
        model['services']['bot']['environment']['PATH'] = '/usr/local/bin:/usr/bin:/bin'
        self.model = transaction/'compose.json'
        atomic(self.model, model)
        self.docker.call(['volume', 'inspect', DATA, REPORTS])  # Never auto-create a ledger.
        self.docker.call(['image', 'inspect', policy['helper_image']])
        self.docker.call(['load', '-i', str(archive)])
        identity = decode(self.docker.call(['image', 'inspect', '--format', '{{json .}}', image]))
        require(identity['Id'] == image and identity['Os'] == 'linux' and identity['Architecture'] == 'amd64' and identity['Config']['User'] in ('node', '1000', '1000:1000') and identity['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == sha, 'IMAGE_IDENTITY')
        # Consume approval before mutation. Failure/retry requires a NEW admin sequence.
        record = {'sequence': approval['sequence'], 'sha': sha, 'image_id': image, 'operation': operation, 'status': 'in_progress', 'transaction': transaction.name}
        scratch = 'suiba-vps-broker-'+transaction.name
        scratch_created = False
        try:
            atomic(ledger, record)
            self.helper(policy['helper_image'], 'maintenance')
            self.compose(['stop', '--timeout', '40', 'bot'])
            for cid in self.stopped():
                status = decode(self.docker.call(['inspect', '--format', '{{json .State}}', cid]))
                require(not status['Running'] and not status['OOMKilled'] and status['ExitCode'] == 0, 'UNCLEAN_CONTAINER_STOP')
            self.helper(policy['helper_image'], 'verify')
            self.docker.call(['volume', 'create', scratch])
            scratch_created = True
            backup = self.backups/(transaction.name+'.tar')
            partial = backup.with_suffix('.partial')
            with open(partial, 'xb') as stream:
                os.chmod(partial, 0o600)
                self.helper(policy['helper_image'], 'backup', scratch, stream)
                stream.flush()
                os.fsync(stream.fileno())
            require(partial.stat().st_size > 0, 'BACKUP_EMPTY')
            os.rename(partial, backup)
            with directory(self.backups) as parent:
                os.fsync(parent)
            h = hashlib.sha256()
            with open(backup, 'rb') as stream:
                for block in iter(lambda: stream.read(1024**2), b''):
                    h.update(block)
            atomic(transaction/'backup.json', {'file': backup.name, 'sha256': h.hexdigest()})
            # No up/start/restart. Runtime health acceptance is a separately approved task.
            self.compose(['create', '--no-build', '--force-recreate', 'bot'])
            ids = self.stopped()
            require(len(ids) == 1, 'CREATED_CONTAINER_MISSING')
            status = decode(self.docker.call(['inspect', '--format', '{{json .State}}', ids[0]]))
            require(status['Status'] == 'created' and not status['Running'], 'CREATED_CONTAINER_RUNNING')
            record['status'] = 'prepared_stopped'
            record['backup'] = backup.name
            atomic(ledger, record)
            atomic(transaction/'receipt.json', record)
            return record
        except BaseException:
            record['status'] = 'failed_stopped' if self.emergency_stop() and not self.helper_unknown else 'failed_state_unknown'
            atomic(ledger, record)
            atomic(transaction/'receipt.json', record)
            raise
        finally:
            if scratch_created:
                with contextlib.suppress(Exception):
                    self.docker.call(['volume', 'rm', scratch])


def main():
    os.umask(0o077)
    try:
        require(len(sys.argv) == 1 and os.geteuid() == 0, 'ENTRYPOINT')
        account = pwd.getpwnam('suiba-deploy')
        require(os.environ.get('SUDO_USER') == 'suiba-deploy' and os.environ.get('SUDO_UID') == str(account.pw_uid) and account.pw_uid != 0, 'CALLER')
        read_trusted(Path(__file__))
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, lambda *_: (_ for _ in ()).throw(Rejected('INTERRUPTED')))
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(Rejected('INPUT_TIMEOUT')))
        signal.alarm(5)
        req = request(sys.stdin.buffer.read(513))
        signal.alarm(0)
        result = Broker().execute(req, account.pw_uid)
        print(json.dumps({'status': result['status'], 'sha': result['sha']}))
    except BaseException:
        # No exception text: Docker/paths/environment might contain credentials.
        print('SUIBA_BROKER_REJECTED_OR_FAILED; administrator must inspect root-owned receipt', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
