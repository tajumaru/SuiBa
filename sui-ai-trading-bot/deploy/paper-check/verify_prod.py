"""Ephemeral PID1/Docker check of the shipped production unit; never Worker.

Only the authenticated API is a fixture. The actual ProductionController,
unit hardening, pidfd stop, helpers, backups and DB/latch checks are exercised.
All paths/units/containers/volumes belong to a randomly named test fixture.
"""
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import importlib.util

spec = importlib.util.spec_from_file_location('run_fixture', Path(__file__).with_name('verify_run.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
docker = fixtures.docker


def system(*args):
    return subprocess.check_output(['/usr/bin/systemctl', *args], stderr=subprocess.PIPE, timeout=60).decode().strip()


def wait_for(action, label):
    deadline = time.monotonic()+90
    while time.monotonic() < deadline:
        if action():
            return
        time.sleep(.2)
    raise AssertionError(label)


if len(sys.argv) == 7 and sys.argv[1] in ('prod-run', 'prod-post-stop'):
    operation, root, name, image, scenario = sys.argv[1:6]
    base = Path(root)
    assert sys.argv[6] == 'DUMMY-ONLY' and base.parent == Path('/var/lib') and base.name.startswith('suiba-prod-unit-')
    c, ctl = fixtures.fixture(base, name, image, scenario, production=True)
    if operation == 'prod-run':
        ctl.run()
    else:
        record = ctl.current() if ctl.record.exists() else None
        assert ctl.stop(expected=record['id'] if record else None, source='post-stop')
    sys.exit(0)


def main():
    assert os.geteuid() == 0 and len(sys.argv) == 2
    image = sys.argv[1]
    identity = json.loads(docker('image', 'inspect', image))[0]
    digest = identity['Id']
    sha = identity['Config']['Labels']['org.opencontainers.image.revision']
    script = Path(__file__).resolve()
    for scenario in ('explicit-stop', 'crash', 'market-failure'):
        name = 'suiba-prod-unit-'+uuid.uuid4().hex
        base = Path(tempfile.mkdtemp(prefix=name, dir='/var/lib'))
        unit = Path('/run/systemd/system')/(name+'.service')
        cutoff = unit.with_name(name+'-cutoff.service')
        try:
            for folder in ('broker', 'policy', 'backups', 'state', 'code', 'code/paper-check', 'code/broker'):
                (base/folder).mkdir(mode=0o700)
            code = base/'code'
            for filename in ('controller.py', 'verify_run.py', 'verify_prod.py'):
                shutil.copyfile(script.with_name(filename), code/'paper-check'/filename)
            shutil.copyfile(script.parent.parent/'broker/broker.py', code/'broker/broker.py')
            transaction = base/'broker'/('a'*32)
            transaction.mkdir(mode=0o700)
            (transaction/'compose.json').write_text(json.dumps({'services': {'bot': {'image': digest}}}))
            (base/'broker/ledger.json').write_text(json.dumps({'status': 'prepared_stopped', 'sequence': 1, 'sha': sha, 'transaction': 'a'*32}))
            (base/'policy/policy.json').write_text(json.dumps({'helper_image': digest}))
            docker('volume', 'create', name+'-data')
            docker('run', '--rm', '--network', 'none', '-v', name+'-data:/app/data', digest,
                   'node', '--import', 'tsx', 'docker/vps-data.mjs', 'initialize', 'NEW-PAPER-LEDGER')
            docker('create', '--name', name, '--restart', 'no', '--network', 'none', '--init', '--user', '1000:1000',
                   '--memory', '1g', '--memory-swap', '1g', '-e', 'MODE=PAPER', '-e', 'TRADING_PAIR=SUI_USDC',
                   '-e', 'MARKET_DATA_PROVIDER=geckoterminal', '-e', 'PAPER_CHECK_MODE=sui-prod',
                   '--entrypoint', '/usr/local/bin/node', digest,
                   '-e', 'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0))')
            command = '/usr/bin/python3 -I '+str(code/'paper-check/verify_prod.py')+' {op} '+str(base)+' '+name+' '+digest+' '+scenario+' DUMMY-ONLY'
            template = script.with_name('suiba-prod.service').read_text()
            for operation in ('prod-run', 'prod-post-stop'):
                template = template.replace('/usr/bin/python3 -I /usr/local/libexec/suiba-paper-check.py '+operation, command.format(op=operation))
            unit.write_text(template)
            cutoff.write_text('[Service]\nType=oneshot\nExecStart=/usr/bin/true\nRestart=no\n')
            system('daemon-reload')
            assert system('show', name+'.service', '-p', 'Type', '--value') == 'exec'
            assert system('show', name+'.service', '-p', 'Restart', '--value') == 'no'
            assert system('show', name+'.service', '-p', 'RuntimeMaxUSec', '--value') == 'infinity'
            assert system('show', name+'.service', '-p', 'UnitFileState', '--value') == 'static'
            c, ctl = fixtures.fixture(base, name, digest, scenario, production=True)
            # Merely installing the unit cannot start or enable production.
            assert system('show', name+'.service', '-p', 'ActiveState', '--value') == 'inactive'
            try:
                ctl.prod_start()
            except FileNotFoundError:
                pass
            else:
                raise AssertionError('PRODUCTION_STARTED_WITHOUT_POLICY')
            # Only the fixture's explicit opt-in creates a production policy.
            (base/'prod-policy.json').write_text('{"enabled":true}')
            assert ctl.prod_start() == {'status': 'accepted'}
            wait_for(lambda: (base/'ready').exists(), 'PRODUCTION_DID_NOT_REACH_MONITORING')
            record_id = ctl.current()['id']
            assert ctl.current()['stage'] == 'monitoring' and 'cutoff' not in ctl.current()
            assert not (base/'broker/paper-check.json').exists() and not (base/'state/run.json').exists()
            if scenario == 'explicit-stop':
                assert ctl.prod_stop()['status'] == 'completed'
            elif scenario == 'crash':
                system('kill', '--kill-whom=main', '--signal=SIGKILL', name+'.service')
            else:
                (base/'market-failed').touch()
            receipt_path = ctl.state/'stop.json'
            def stopped():
                return (receipt_path.exists() and json.loads(receipt_path.read_text())['status'] == 'clean_stopped' and
                        system('show', name+'.service', '-p', 'ActiveState', '--value') in ('inactive', 'failed'))
            wait_for(stopped, 'PRODUCTION_STOP_DID_NOT_FINISH')
            record = ctl.current()
            assert record['id'] == record_id
            assert record['status'] == ('completed' if scenario == 'explicit-stop' else 'failed_requires_review'), record
            assert system('show', name+'.service', '-p', 'NRestarts', '--value') == '0'
            inspection = json.loads(docker('inspect', name))[0]
            assert not inspection['State']['Running'] and inspection['State']['ExitCode'] == 0 and not inspection['State']['OOMKilled']
            assert inspection['HostConfig']['RestartPolicy']['Name'] == 'no'
            ctl.verify_sui()
            # Cleanup has restored latch and verified DBs using the real helper.
            helper, helper_image = ctl.helper()
            helper.helper(helper_image, 'verify')
            assert not ctl.prod_status()['controller_alive']
            if scenario == 'market-failure':
                failure = json.loads((ctl.folder(record)/'failure.json').read_text())
                assert failure['stage'] == 'monitoring'
            if scenario != 'explicit-stop':
                try:
                    ctl.prod_start()
                except RuntimeError:
                    pass
                else:
                    raise AssertionError('FAILED_PRODUCTION_RESTARTED')
                assert ctl.current()['id'] == record_id
            print('PASS: shipped production unit '+scenario+'; no Worker, no restart, no cutoff')
        except BaseException:
            with contextlib.suppress(Exception):
                subprocess.run(['journalctl', '-u', name+'.service', '--no-pager', '-n', '60'], check=False)
            # DIAGNOSTIC (scratch branch only): dump the run-folder state
            # that decided the stop outcome, before the finally removes it.
            with contextlib.suppress(Exception):
                state = base/'state/production'
                print('DIAG scenario:', scenario, flush=True)
                for path in sorted(state.rglob('*')):
                    if path.is_file() and path.suffix == '.json':
                        print('DIAG FILE', path.relative_to(base), path.read_bytes()[:600], flush=True)
                history = base/'cleanup-history'
                if history.exists():
                    print('DIAG cleanup-history:', history.read_bytes(), flush=True)
            raise
        finally:
            subprocess.run(['systemctl', 'stop', name+'.service', name+'-cutoff.service'], check=False)
            for path in (unit, cutoff): path.unlink(missing_ok=True)
            subprocess.run(['systemctl', 'daemon-reload'], check=False)
            release = base/'state/production/release-helper.json'
            if release.exists():
                with contextlib.suppress(Exception): docker('rm', '-f', json.loads(release.read_text())['name'])
            with contextlib.suppress(Exception): docker('rm', '-f', name)
            with contextlib.suppress(Exception): docker('volume', 'rm', name+'-data')
            assert base.parent == Path('/var/lib') and base.name.startswith(name)
            shutil.rmtree(base)


if __name__ == '__main__':
    main()
