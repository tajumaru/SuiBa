"""EPHEMERAL Linux CI only: real systemd timer + real Docker dummy, no Worker.

Test timer is shortened to 2 seconds; production units remain fixed at 30min.
Only random test units, directories, containers and volumes are removed.
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
    return subprocess.check_output(['/usr/bin/docker', *args], stderr=subprocess.PIPE, timeout=30).decode().strip()


def load_controller():
    spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('controller.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if len(sys.argv) == 5 and sys.argv[1] == 'stop-fixture':
    c = load_controller()
    base, name, image = Path(sys.argv[2]), sys.argv[3], sys.argv[4]
    assert base.parent == Path('/var/lib') and base.name.startswith('suiba-paper-timer-')
    c.CONTAINER = name
    ctl = object.__new__(c.Controller)
    class Broker:
        decode = staticmethod(json.loads)
        read_trusted = staticmethod(lambda path: path.read_bytes())
        @staticmethod
        def atomic(path, value):
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps(value))
            temporary.replace(path)
    class Docker:
        def call(self, args, **kwargs):
            return docker(*args)
    ctl.b, ctl.state, ctl.docker = Broker, base, Docker()
    ctl.record = base/'run.json'
    def no_api(*args):
        raise TimeoutError('dummy has no authenticated API')
    ctl.api = no_api
    ctl.maintenance = lambda value: None  # Fixture was initialized with latch.
    class Helper:
        def helper(self, *args):
            docker('run', '--rm', '--network', 'none', '-v', name+'-data:/app/data', image,
                   'node', '--import', 'tsx', 'docker/vps-data.mjs', 'verify')
    ctl.helper = lambda: (Helper(), image)
    sys.exit(0 if ctl.stop() else 1)


assert os.geteuid() == 0
image = sys.argv[1]
script = Path(__file__).resolve()
assert 'suiba-vps' not in image
for outcome in ('disconnected-client', 'crashed-controller'):
    name = 'suiba-paper-timer-'+uuid.uuid4().hex
    base = Path(tempfile.mkdtemp(prefix=name, dir='/var/lib'))
    unit = Path('/run/systemd/system')/(name+'.service')
    timer = unit.with_suffix('.timer')
    try:
        docker('volume', 'create', name+'-data')
        (base/'run.json').write_text('{"status":"in_progress"}')
        docker('run', '--rm', '--network', 'none', '-v', name+'-data:/app/data', image,
               'node', '--import', 'tsx', 'docker/vps-data.mjs', 'initialize', 'NEW-PAPER-LEDGER')
        docker('run', '-d', '--name', name, '--restart', 'no', '--network', 'none', '--init',
               '--memory', '128m', '--memory-swap', '128m', '--entrypoint', '/usr/local/bin/node', image,
               '-e', 'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0))')
        unit.write_text('[Service]\nType=oneshot\nExecStart=/usr/bin/python3 -I '+str(script)+' stop-fixture '+str(base)+' '+name+' '+image+'\nRestart=no\n')
        timer.write_text('[Timer]\nOnActiveSec=2s\nAccuracySec=100ms\nUnit='+name+'.service\n')
        subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True)
        # The SSH/client/controller analogue exits immediately. The timer is
        # owned by PID1, not this process or that short-lived launcher.
        code = 'import subprocess,os;subprocess.run(["/usr/bin/systemctl","start","'+name+'.timer"],check=True);os._exit('+('9' if outcome=='crashed-controller' else '0')+')'
        exited = subprocess.run(['/usr/bin/python3', '-c', code])
        assert exited.returncode == (9 if outcome=='crashed-controller' else 0)
        deadline = time.monotonic()+30
        receipt = {}
        while time.monotonic()<deadline:
            if (base/'stop.json').exists():
                receipt = json.loads((base/'stop.json').read_text())
                if receipt.get('status') != 'stopping_state_unknown':
                    break
            time.sleep(0.2)
        assert receipt['status'] == 'clean_stopped', receipt
        state = json.loads(docker('inspect', name))[0]
        assert not state['State']['Running'] and state['State']['ExitCode'] == 0 and not state['State']['OOMKilled']
        assert state['HostConfig']['RestartPolicy']['Name'] == 'no'
        print('PASS: independent timer '+outcome+' -> real dummy stop / DB verify / clean receipt; no Worker')
    finally:
        subprocess.run(['/usr/bin/systemctl', 'stop', name+'.timer', name+'.service'], check=False)
        for path in (timer, unit):
            path.unlink(missing_ok=True)
        subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=False)
        with contextlib.suppress(Exception):
            docker('rm', '-f', name)
        with contextlib.suppress(Exception):
            docker('volume', 'rm', name+'-data')
        assert base.parent == Path('/var/lib') and base.name.startswith(name)
        shutil.rmtree(base)
