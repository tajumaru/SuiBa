"""Root on an EPHEMERAL Linux CI runner only. No SSH, no Worker startup.

Real broker transaction + real Docker. All names/paths are random test fixtures;
the test transport records commands and uses a test Docker config directory.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location('broker', Path(__file__).with_name('broker.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
assert os.geteuid() == 0
image = sys.argv[1]
project = 'suiba-broker-int-'+uuid.uuid4().hex[:12]
base = Path(tempfile.mkdtemp(prefix=project, dir='/var/lib'))
data, reports, restore = [project+'-'+name for name in ('data', 'reports', 'restore')]
docker_env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(base), 'DOCKER_CONFIG': str(base/'policy'/'docker'), 'DOCKER_HOST': 'unix:///var/run/docker.sock'}


def docker(*args, input=None):
    return subprocess.check_output(['/usr/bin/docker', *args], env=docker_env, input=input, stderr=subprocess.PIPE).decode().strip()


class RealDocker:
    def __init__(self):
        self.calls = []

    def call(self, args, image='', output=None, timeout=180):
        self.calls.append(args)
        env = {**docker_env, 'SUIBA_IMAGE': image}
        r = subprocess.run(['/usr/bin/docker', *args], env=env, stdin=subprocess.DEVNULL,
                           stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if r.returncode:
            # Only fixtures here. Do not copy this diagnostic into production broker.
            raise RuntimeError('fixture Docker failure: '+r.stderr.decode()[-4000:])
        return '' if output else r.stdout.decode().strip()


def helper(volume, command, *extra):
    return docker('run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=64m',
                  '-v', volume+':/app/data', image, 'node', '--import', 'tsx', 'docker/vps-data.mjs', command, *extra)


try:
    for name in ['policy', 'state', 'incoming', 'backups', 'policy/docker', 'policy/approvals']:
        (base/name).mkdir(mode=0o700)
    os.chown(base/'incoming', 1001, 1001)
    runtime, token = base/'policy'/'runtime.env', base/'policy'/'admin-token'
    runtime.write_text('MARKET_DATA_PROVIDER=geckoterminal\n')
    token.write_text('fixture-only-not-a-real-token-'*2)
    os.chown(token, 1000, 1000)
    os.chmod(token, 0o400)
    sha = docker('image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image)
    assert b.SHA.fullmatch(sha)
    candidate = base/'incoming'/sha
    candidate.mkdir(mode=0o700)
    os.chown(candidate, 1001, 1001)
    archive = candidate/'image.tar.gz'
    # Ordinary Docker archive; load supports uncompressed and gzip archives.
    with open(archive, 'wb') as raw:
        subprocess.run(['/usr/bin/docker', 'save', image], env=docker_env, stdout=raw, check=True)
    os.chown(archive, 1001, 1001)
    image_id = docker('image', 'inspect', '--format', '{{.Id}}', image)
    source = Path('docker/compose.vps.yaml').read_text()
    source = source.replace('/opt/suiba/shared/runtime.env', str(runtime)).replace('/opt/suiba/shared/admin-token', str(token))
    source = source.replace('name: suiba-vps\n', 'name: '+project+'\n').replace('name: suiba-vps-data', 'name: '+data).replace('name: suiba-vps-reports', 'name: '+reports)
    compose = base/'policy'/'compose.yaml'
    compose.write_text(source)
    (base/'policy'/'policy.json').write_text(json.dumps({'helper_image': image_id, 'compose_sha256': hashlib.sha256(compose.read_bytes()).hexdigest()}))
    h = hashlib.sha256()
    with open(archive, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024**2), b''):
            h.update(chunk)
    approval = {'sha': sha, 'operation': 'deploy', 'archive_sha256': h.hexdigest(), 'image_id': image_id,
                'sequence': 1, 'expires': int(time.time())+3600, 'repository': 'tajumaru/SuiBa', 'ref': 'refs/heads/main', 'ci_run': 123}
    (base/'policy'/'approvals'/(sha+'.json')).write_text(json.dumps(approval))
    for volume in (data, reports, restore):
        docker('volume', 'create', volume)
    helper(data, 'initialize', 'NEW-PAPER-LEDGER')
    # Leave a real WAL/SHM with committed evidence. No Worker/engine is imported.
    crashed = subprocess.run(['/usr/bin/docker', 'run', '--rm', '--init', '--network', 'none', '-v', data+':/app/data', image,
        'node', '--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync('/app/data/bot.sqlite');d.exec(\"PRAGMA journal_mode=WAL;CREATE TABLE broker_evidence(value TEXT);INSERT INTO broker_evidence VALUES('retained')\");process.kill(process.pid,'SIGKILL');"], env=docker_env, capture_output=True)
    assert crashed.returncode == 137
    transport = RealDocker()
    raw_model = json.loads(transport.call(['compose', '-p', project, '-f', str(compose), 'config', '--format', 'json'], image=image_id))
    fixture_model = json.loads(json.dumps(raw_model))
    bot = fixture_model['services']['bot']
    bot.pop('ports', None)
    bot.pop('networks', None)
    bot['network_mode'] = 'none'
    bot['restart'] = 'no'
    bot['command'] = ['node', '-e', "const s=require('http').createServer((q,r)=>r.end(JSON.stringify({status:'ok',mode:'PAPER'})));s.listen(3100);process.on('SIGTERM',()=>s.close(()=>process.exit(0)));console.log('dummy-ready');"]
    fixture_model.pop('networks', None)
    old = base/'old.json'
    old.write_text(json.dumps(fixture_model))
    docker('compose', '-p', project, '-f', str(old), 'up', '-d', '--no-build', '--wait', '--wait-timeout', '120')
    # Patch module constants ONLY in imported test code. CLI has no such options.
    b.PROJECT, b.DATA, b.REPORTS, b.POLICY, b.RUNTIME, b.TOKEN = project, data, reports, base/'policy', str(runtime), str(token)
    broker = b.Broker(base/'policy', base/'state', base/'incoming', base/'backups', transport)
    receipt = broker.execute({'operation': 'deploy', 'sha': sha}, 1001)
    assert receipt['status'] == 'prepared_stopped'
    cid = docker('ps', '-aq', '--filter', 'label=com.docker.compose.project='+project, '--filter', 'label=com.docker.compose.service=bot')
    inspect = json.loads(docker('inspect', cid))[0]
    assert inspect['State']['Status'] == 'created' and not inspect['State']['Running']
    assert inspect['Config']['User'] == '1000:1000'
    assert inspect['HostConfig']['Memory'] == 1024**3
    assert inspect['HostConfig']['MemorySwap'] == 1024**3
    assert inspect['HostConfig']['RestartPolicy']['Name'] == 'no'
    assert all(not (a[0]=='compose' and any(x in a for x in ['start', 'up', 'restart'])) for a in transport.calls)
    backup = base/'backups'/receipt['backup']
    with open(backup, 'rb') as source:
        subprocess.run(['/usr/bin/docker', 'run', '--rm', '-i', '--network', 'none', '-v', restore+':/app/data', '--entrypoint', 'tar', image, '-C', '/app/data', '-xf', '-'], env=docker_env, stdin=source, check=True)
    helper(restore, 'verify')
    proof = docker('run', '--rm', '--network', 'none', '-v', restore+':/app/data', image, 'node', '--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync('/app/data/bot.sqlite',{readOnly:true});console.log(d.prepare('SELECT value FROM broker_evidence').get().value);d.close()")
    assert proof == 'retained'
    print('PASS: real broker admission/stop/WAL backup/restore/create-only/1GiB policy; no Worker started')
finally:
    # Only random test resources; never suiba-vps production objects.
    for cid in docker('ps', '-aq', '--filter', 'label=com.docker.compose.project='+project).split():
        docker('rm', '-f', cid)
    for volume in (data, reports, restore):
        with __import__('contextlib').suppress(Exception):
            docker('volume', 'rm', volume)
    with __import__('contextlib').suppress(Exception):
        docker('network', 'rm', project+'_default')
    assert base.parent == Path('/var/lib') and base.name.startswith(project)
    shutil.rmtree(base)
