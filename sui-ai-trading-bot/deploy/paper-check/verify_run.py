"""Disposable Linux CI: production run()/stop(), real PID1 and Docker, NO Worker.

Only the API and container topology are fixtures. DB/helpers, persistence,
deployment lock and production systemd cleanup are exercised, never production paths.
"""
import contextlib
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


def docker(*args):
    return subprocess.check_output(['/usr/bin/docker', *args], stderr=subprocess.PIPE, timeout=40).decode().strip()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def fixture(base, name, image, scenario):
    c = module('controller', Path(__file__).with_name('controller.py'))
    b = module('broker', Path(__file__).parent.parent/'broker/broker.py')
    b.STATE, b.POLICY, b.BACKUPS, b.DATA = base/'broker', base/'policy', base/'backups', name+'-data'
    c.CONTAINER, c.SERVICE, c.TIMER = name, name+'.service', name+'-cutoff.timer'
    c.POLICY = base/'controller-policy.json'
    ctl = c.Controller(b, base/'state')
    original_inspect = ctl.inspect
    def inspect():
        value = original_inspect()
        # Dummy has no HTTP listener; never publish a port or run Worker.
        value['HostConfig']['PortBindings'] = {'3100/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3100'}]}
        value['State']['Health'] = {'Status': 'healthy'}
        return value
    ctl.inspect = inspect
    def api(method, path, value=None):
        if path == '/api/deployment':
            return {'mode': 'PAPER', 'running': (base/'started').exists(), 'maintenance': False,
                    'databaseHealthy': True, 'ledgerOk': True, 'startReady': True,
                    'paperCheck': {'enabled': True, 'armed': False}}
        if path == '/api/pairs': return {'selected': 'SUI_USDC'}
        if path == '/api/dashboard/summary':
            return {'summary': {'marketData': {'source': 'GeckoTerminal', 'lastSuccessAt': time.time()*1000}}}
        if path == '/api/paper-check/arm':
            return {'armed': True, 'expired': False, 'expires': value['expiresAt']}
        if value == {'command': 'start'}:
            (base/'started').touch()
            return {'running': True}
        return {'running': False}
    ctl.api = api
    original_atomic = b.atomic
    def atomic(path, value):
        if scenario == 'persistence' and path == ctl.record:
            # Crash between fsynced temp write and replacement: old record must
            # remain absent while durable deployment interlock stays closed.
            pending = path.with_name('run.json.interrupted')
            with open(pending, 'xb') as out:
                out.write(json.dumps(value).encode()); out.flush(); os.fsync(out.fileno())
            (base/'ready').touch()
            time.sleep(120)
        original_atomic(path, value)
        if path.name == 'progress.json': (base/'ready').touch()
    b.atomic = atomic
    original_call = ctl.docker.call
    def call(args, **kwargs):
        if scenario == 'helper' and args[0] == 'create':
            args = list(args)
            args[-1] = 'setTimeout(()=>{'+args[-1]+'},20000)'
        if scenario == 'helper' and args[:2] == ['start', '-a']:
            original_call(['start', args[2]], timeout=10)
            (base/'ready').touch()
            time.sleep(120)  # Lost response; helper is still scheduled to unlink.
        return original_call(args, **kwargs)
    ctl.docker.call = call
    return c, ctl


if len(sys.argv) == 7 and sys.argv[1] in ('run', 'stop'):
    operation, root, name, image, scenario = sys.argv[1:6]
    # Seventh argument is an explicit disposable-fixture sentinel.
    assert sys.argv[6] == 'DUMMY-ONLY'
    base = Path(root)
    assert base.parent == Path('/var/lib') and base.name.startswith('suiba-full-run-')
    c, ctl = fixture(base, name, image, scenario if operation == 'run' else 'stop')
    if operation == 'run': ctl.run()
    else:
        with contextlib.suppress(Exception): ctl.system('kill', '--kill-whom=main', '--signal=SIGKILL', c.SERVICE)
        sys.exit(0 if ctl.stop() else 1)
    sys.exit(0)


assert os.geteuid() == 0
image = sys.argv[1]
identity = json.loads(docker('image', 'inspect', image))[0]
digest = identity['Id']
sha = identity['Config']['Labels']['org.opencontainers.image.revision']
script = Path(__file__).resolve()
for scenario in ('crash', 'timer', 'helper', 'persistence'):
    name = 'suiba-full-run-'+uuid.uuid4().hex
    base = Path(tempfile.mkdtemp(prefix=name, dir='/var/lib'))
    unit = Path('/run/systemd/system')/(name+'.service')
    cutoff = unit.with_name(name+'-cutoff.service')
    timer = unit.with_name(name+'-cutoff.timer')
    try:
        for folder in ('broker', 'policy', 'backups', 'state'): (base/folder).mkdir(mode=0o700)
        transaction = base/'broker'/('a'*32); transaction.mkdir(mode=0o700)
        (transaction/'compose.json').write_text(json.dumps({'services': {'bot': {'image': digest}}}))
        (base/'broker/ledger.json').write_text(json.dumps({'status': 'prepared_stopped', 'sha': sha, 'transaction': 'a'*32}))
        (base/'policy/policy.json').write_text(json.dumps({'helper_image': digest}))
        (base/'controller-policy.json').write_text('{"enabled":true,"mode":"sui-30m"}')
        docker('volume', 'create', name+'-data')
        docker('run', '--rm', '--network', 'none', '-v', name+'-data:/app/data', digest,
               'node', '--import', 'tsx', 'docker/vps-data.mjs', 'initialize', 'NEW-PAPER-LEDGER')
        docker('create', '--name', name, '--restart', 'no', '--network', 'none', '--init', '--user', '1000:1000',
               '--memory', '1g', '--memory-swap', '1g', '-e', 'MODE=PAPER', '-e', 'TRADING_PAIR=SUI_USDC',
               '-e', 'MARKET_DATA_PROVIDER=geckoterminal', '-e', 'PAPER_CHECK_MODE=sui-30m',
               '--entrypoint', '/usr/local/bin/node', digest,
               '-e', 'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0))')
        command = '/usr/bin/python3 -I '+str(script)+' {op} '+str(base)+' '+name+' '+digest+' '+scenario+' DUMMY-ONLY'
        production = Path(__file__).with_name('suiba-paper-check.service').read_text()
        production = production.replace('/usr/bin/python3 -I /usr/local/libexec/suiba-paper-check.py run', command.format(op='run'))
        production = production.replace('/usr/bin/python3 -I /usr/local/libexec/suiba-paper-check.py stop', command.format(op='stop'))
        if scenario == 'timer': production = '\n'.join(x for x in production.splitlines() if not x.startswith('ExecStopPost='))+'\n'
        unit.write_text(production)
        cutoff.write_text('[Service]\nType=oneshot\nExecStart='+command.format(op='stop')+'\nTimeoutStartSec=120s\n')
        timer.write_text('[Timer]\nOnActiveSec=8s\nAccuracySec=100ms\nUnit='+name+'-cutoff.service\n')
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'start', name+'.service'], check=True)
        deadline = time.monotonic()+90
        while not (base/'ready').exists() and time.monotonic()<deadline: time.sleep(.1)
        assert (base/'ready').exists(), 'RUN_DID_NOT_REACH_INJECTION'
        if scenario != 'timer': subprocess.run(['systemctl', 'kill', '--kill-whom=main', '--signal=SIGKILL', name+'.service'], check=True)
        receipt = {}
        while time.monotonic()<deadline:
            path = base/'state/stop.json'
            if path.exists():
                receipt = json.loads(path.read_text())
                if receipt['status'] in ('clean_stopped', 'failed_state_unknown'): break
            if scenario == 'persistence' and subprocess.run(['systemctl', 'is-active', '--quiet', name+'.service']).returncode: break
            time.sleep(.2)
        if scenario == 'persistence':
            assert not (base/'state/run.json').exists()
            assert json.loads((base/'broker/paper-check.json').read_text()) == {'status': 'in_progress'}
            assert not (base/'started').exists()
        else:
            assert receipt.get('status') == 'clean_stopped', receipt
            if scenario == 'helper':
                helper = json.loads((base/'state/release-helper.json').read_text())
                assert helper['retired'] and not docker('ps', '-aq', '--filter', 'name='+helper['name'])
        state = json.loads(docker('inspect', name))[0]['State']
        assert not state['Running'] and not state['OOMKilled']
        # Verify the real fixed selected_pair query accepts SUI and rejects WAL.
        c, ctl = fixture(base, name, digest, 'stop')
        ctl.verify_sui()
        docker('run', '--rm', '--network', 'none', '--user', '1000:1000', '-v', name+'-data:/app/data', '--entrypoint', '/usr/local/bin/node', digest,
               '-e', 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/app/data/bot.sqlite.pairs.sqlite");d.prepare("UPDATE bot_runtime_state SET json=? WHERE key=?").run(JSON.stringify("WAL_USDC"),"selected_pair");d.close()')
        try: ctl.verify_sui()
        except Exception: pass
        else: raise AssertionError('WAL_SELECTION_ACCEPTED')
        if scenario != 'persistence':
            assert not ctl.stop()
            assert json.loads((base/'state/stop.json').read_text())['status'] == 'failed_state_unknown'
        print('PASS: production run/stop '+scenario+'; no Worker; SUI SQL rejects WAL')
    finally:
        subprocess.run(['systemctl', 'stop', name+'-cutoff.timer', name+'.service', name+'-cutoff.service'], check=False)
        for path in (unit, cutoff, timer): path.unlink(missing_ok=True)
        subprocess.run(['systemctl', 'daemon-reload'], check=False)
        release = base/'state/release-helper.json'
        if release.exists():
            with contextlib.suppress(Exception): docker('rm', '-f', json.loads(release.read_text())['name'])
        with contextlib.suppress(Exception): docker('rm', '-f', name)
        with contextlib.suppress(Exception): docker('volume', 'rm', name+'-data')
        assert base.parent == Path('/var/lib') and base.name.startswith(name)
        shutil.rmtree(base)
