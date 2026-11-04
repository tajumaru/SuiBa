import importlib.util
import contextlib
import os
import time
import uuid
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('controller.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class FakeBroker:
    @staticmethod
    @contextlib.contextmanager
    def directory(path):
        if os.name == 'nt': yield None
        else:
            fd = os.open(path, os.O_RDONLY|os.O_DIRECTORY)
            try: yield fd
            finally: os.close(fd)
    decode = staticmethod(json.loads)
    read_trusted = staticmethod(lambda path: path.read_bytes())
    @staticmethod
    def atomic(path, value):
        temp = path.with_name(path.name+'.'+uuid.uuid4().hex)
        temp.write_text(json.dumps(value))
        temp.replace(path)


def initialize(ctl):
    FakeBroker.STATE = ctl.state
    record = {'id': 'a'*32, 'status': 'in_progress', 'admitted': True,
              'cutoff': int(time.time()*1000)+1800000, 'controller': {'pid': 99999999, 'start': '0', 'boot': str(uuid.UUID(int=0))}}
    (ctl.state/record['id']).mkdir(exist_ok=True)
    ctl.record = ctl.state/'run.json'
    ctl.record.write_text(json.dumps(record))
    ctl.run_id = record['id']
    ctl.terminate = lambda record: True
    ctl.exited = lambda record: True
    return record


class StopTests(unittest.TestCase):
    def setUp(self):
        if os.name == 'nt':
            flags = patch.object(os, 'O_NOFOLLOW', 0, create=True)
            flags.start(); self.addCleanup(flags.stop)
            @contextlib.contextmanager
            def local_lock(*args, **kwargs): yield
            self.local_lock = patch.object(c.Controller, 'locked', local_lock)
            self.local_lock.start()
            self.addCleanup(self.local_lock.stop)

    def test_retry_permission_bound_to_run_and_consumed_before_fsync_failure(self):
        with tempfile.TemporaryDirectory() as root:
            ctl = object.__new__(c.Controller)
            ctl.b = FakeBroker
            record = {'id': 'a'*32, 'status': 'failed_requires_review'}
            permit = Path(root)/'retry-approved.json'
            FakeBroker.atomic(permit, {'id': 'b'*32})
            with self.assertRaises(Exception):
                ctl.consume_retry(record, permit)
            self.assertTrue(permit.exists())
            FakeBroker.atomic(permit, {'id': record['id']})
            with patch.object(os, 'fsync', side_effect=OSError('fixture fsync failure')):
                with self.assertRaises(OSError):
                    ctl.consume_retry(record, permit)
            self.assertFalse(permit.exists())
            self.assertEqual(json.loads(permit.with_name('failed-run.json').read_bytes()), record)
            FakeBroker.atomic(permit, {'id': record['id']})
            with self.assertRaises(Exception):
                ctl.consume_retry(record, permit)

    @unittest.skipIf(os.name == 'nt', 'Linux flock and directory fsync')
    def test_deploy_review_requires_clean_proof_and_is_exclusive(self):
        import re
        from types import SimpleNamespace
        for failure in (None, 'diagnostic', 'quiescent', 'helper', 'pair', 'wrong-id', 'retry', 'expired'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
                root = Path(tmp)
                paper, state, policy = [root/name for name in ('paper', 'broker', 'policy')]
                for folder in (paper, state, policy, policy/'approvals'):
                    folder.mkdir(mode=0o700)
                ctl = object.__new__(c.Controller)
                ctl.state, ctl.record = paper, paper/'run.json'
                record = initialize(ctl)
                record['status'] = 'failed_requires_review'
                FakeBroker.atomic(ctl.record, record)
                FakeBroker.atomic(state/'paper-check.json', {'status': 'in_progress'})
                (state/'lock').touch(mode=0o600)
                @contextlib.contextmanager
                def regular(path):
                    fd = os.open(path, os.O_RDONLY)
                    try:
                        yield fd
                    finally:
                        os.close(fd)
                ctl.b = SimpleNamespace(STATE=state, POLICY=policy, SHA=re.compile(r'[a-f0-9]{40}'),
                    regular=regular, decode=FakeBroker.decode, read_trusted=FakeBroker.read_trusted,
                    atomic=FakeBroker.atomic, directory=FakeBroker.directory)
                sha = 'f'*40
                approval = {'sha': sha, 'operation': 'deploy', 'expires': int(time.time())+60}
                if failure == 'expired':
                    approval['expires'] = 0
                FakeBroker.atomic(policy/'approvals'/(sha+'.json'), approval)
                FakeBroker.atomic(paper/record['id']/'stop.json', {'id': record['id'], 'status': 'clean_stopped'})
                def check(stage):
                    if failure == stage:
                        raise RuntimeError('fixture')
                ctl.quiescent = lambda: check('quiescent')
                ctl.diagnose_locked = lambda: check('diagnostic') or {
                    'stop': {'status': 'clean_stopped'}, 'requires_review': False,
                    'diagnostics': {'exit_code': 0, 'oom_killed': False}}
                ctl.helper = lambda: (SimpleNamespace(helper=lambda *args: check('helper')), 'fixture')
                ctl.verify_sui = lambda: check('pair')
                if failure == 'retry':
                    FakeBroker.atomic(paper/record['id']/'retry-approved.json', {})
                run_id = 'b'*32 if failure == 'wrong-id' else record['id']
                permit = state/('paper-deploy-'+sha+'.json')
                if failure:
                    with self.assertRaises(Exception):
                        ctl.approve_deploy(run_id, sha)
                    self.assertFalse(permit.exists())
                else:
                    ctl.approve_deploy(run_id, sha)
                    self.assertEqual(json.loads(permit.read_bytes())['id'], record['id'])
                    self.assertEqual(json.loads(ctl.record.read_bytes())['status'], 'failed_requires_review')
                    with self.assertRaises(Exception):
                        ctl.approve_deploy(run_id, sha)

    def test_diagnostic_summary_is_safe_and_accepts_older_reports(self):
        import io
        script = Path(__file__).parents[2]/"docker/ssh-paper-status.sh"
        renderer = script.read_text().split("<<'PYCODE'", 1)[1].split("\n", 1)[1].rsplit("\nPYCODE", 1)[0]
        payload = {
            'run': {'id': 'a'*32, 'status': 'failed_requires_review'},
            'stop': {'id': 'a'*32, 'status': 'clean_stopped'}, 'requires_review': False,
            'diagnostics': {'stage': 'worker-readiness', 'maintenance': True, 'backup_verified': True,
                'oom_killed': False, 'exit_code': 0, 'healthcheck_exit': 0, 'http_status': None,
                'deltas': {pair: {'starts': 0, 'orders': 0, 'fills': 0} for pair in ('SUI_USDC', 'WAL_USDC')}},
        }
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            path = Path(tmp)/'response'
            def render():
                path.write_text(json.dumps(payload))
                output = io.StringIO()
                with patch.object(c.sys, 'argv', ['summary', str(path), 'diagnose']), contextlib.redirect_stdout(output):
                    exec(compile(renderer, 'summary', 'exec'), {})
                return output.getvalue()
            self.assertIn('worker-readiness', render())
            payload['diagnostics']['runtime'] = {pair: {'running': False, 'emergency': False,
                'error': 'API_CANCELLED', 'before_error': 'API_CANCELLED'} for pair in ('SUI_USDC', 'WAL_USDC')}
            payload['diagnostics']['selected_pair'] = 'SUI_USDC'
            output = render()
            self.assertIn('before-run error=API_CANCELLED', output)
            self.assertIn('running=False', output)
            host = {'restart_disabled': True, 'paper': True, 'fault_marker': False,
                'timer_active': False, 'timer_elapsed': False, 'timer_next_scheduled': False,
                'timer_job_pending': False, 'sequence': 6, 'sha': 'a'*40,
                'ledger_status': 'failed_state_unknown', 'paper_gate': 'in_progress',
                'container_status': 'exited', 'controller_sha256': 'a'*64, 'broker_sha256': 'b'*64,
                'broker_failure': {'version': 1, 'stage': 'verify-databases', 'code': 'DOCKER_OPERATION_FAILED',
                    'process': {'phase': 'wait', 'exit_code': 23, 'stdout_bytes': 0, 'stderr_bytes': 17}}}
            payload['diagnostics']['host'] = host
            self.assertIn('stage=verify-databases, code=DOCKER_OPERATION_FAILED', render())
            self.assertIn('exit=23', render())
            host['broker_failure']['code'] = 'secret-fixture-do-not-log'
            with self.assertRaises(SystemExit): render()
            host['broker_failure']['code'] = 'DOCKER_OPERATION_FAILED'
            payload['diagnostics']['runtime']['SUI_USDC']['error'] = 'secret-fixture-do-not-log'
            with self.assertRaises(SystemExit) as failure:
                render()
            self.assertEqual(str(failure.exception), 'PAPER_STATUS_INVALID')

    def test_host_diagnostic_reports_deployment_gate_timer_and_versions(self):
        import re
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            root = Path(tmp)
            FakeBroker.atomic(root/'ledger.json', {'status': 'prepared_stopped', 'sequence': 5, 'sha': 'a'*40})
            FakeBroker.atomic(root/'paper-check.json', {'status': 'in_progress'})
            ctl = object.__new__(c.Controller)
            ctl.b = SimpleNamespace(STATE=root, SHA=re.compile(r'[a-f0-9]{40}'), decode=json.loads,
                read_trusted=FakeBroker.read_trusted, __file__=c.__file__)
            container = {'State': {'Status': 'exited'}, 'HostConfig': {'RestartPolicy': {'Name': 'no'}},
                         'Config': {'Env': ['MODE=PAPER']}}
            for next_time in ('0', 'infinity', '1min'):
                response = ('ActiveState=active\nSubState=elapsed\nNextElapseUSecMonotonic='+next_time+'\nNextElapseUSecRealtime=\nJob=\n').encode()
                with patch.object(c.subprocess, 'check_output', return_value=response):
                    result = ctl.diagnostic_host(container)
                self.assertEqual(result['timer_next_scheduled'], next_time == '1min')
            self.assertEqual(result['sequence'], 5)
            self.assertEqual(result['paper_gate'], 'in_progress')
            self.assertTrue(result['timer_elapsed'])
            self.assertFalse(result['fault_marker'])
            self.assertEqual(len(result['controller_sha256']), 64)
            self.assertIsNone(result['broker_failure'])

    @unittest.skipUnless(os.name == 'posix', 'mocked shell pipeline runs on Linux')
    def test_actions_logs_equal_validated_summary_and_never_echo_secrets(self):
        script = Path(__file__).parents[2]/'docker/ssh-paper-status.sh'
        payload = {'run': {'id': 'a'*32, 'status': 'failed_requires_review'},
            'stop': {'id': 'a'*32, 'status': 'clean_stopped'}, 'requires_review': False,
            'diagnostics': {'stage': 'worker-readiness', 'maintenance': True, 'backup_verified': True,
                'oom_killed': False, 'exit_code': 0, 'healthcheck_exit': 0, 'http_status': None,
                'deltas': {pair: {'starts': 0, 'orders': 0, 'fills': 0} for pair in ('SUI_USDC', 'WAL_USDC')},
                'runtime': {pair: {'running': False, 'emergency': False, 'error': 'API_CANCELLED',
                    'before_error': 'API_CANCELLED'} for pair in ('SUI_USDC', 'WAL_USDC')},
                'selected_pair': 'SUI_USDC'}}
        with tempfile.TemporaryDirectory(dir=script.parent) as tmp:
            root = Path(tmp)
            (root/'bin').mkdir(); (root/'runner').mkdir()
            for name, body in (
                ('ssh-keygen', '#!/bin/sh\nprintf "%s" "secret-key-output"\n'),
                ('ssh', '#!/bin/sh\ncat >/dev/null\ncat "$MOCK_RESPONSE"\nprintf "%s" "secret-ssh-stderr" >&2\n')):
                path = root/'bin'/name
                path.write_text(body); path.chmod(0o755)
            env = {**os.environ, 'PATH': str(root/'bin')+':'+os.environ['PATH'],
                'RUNNER_TEMP': str(root/'runner'), 'VPS_HOST': 'fixture.invalid',
                'VPS_USER': 'suiba-deploy', 'VPS_PORT': '22', 'VPS_SSH_KEY': 'secret-key-fixture',
                'VPS_KNOWN_HOSTS': 'fixture-only', 'MOCK_RESPONSE': str(root/'response'),
                'PAPER_STATUS_CONFIRMATION': 'CHECK-PAPER-DIAGNOSTICS',
                'GITHUB_STEP_SUMMARY': str(root/'summary')}
            for valid in (True, False):
                if not valid:
                    payload['diagnostics']['runtime']['SUI_USDC']['error'] = 'secret-response-fixture'
                (root/'response').write_text(json.dumps(payload))
                (root/'summary').write_text('')
                result = c.subprocess.run(['/bin/bash', str(script)], env=env, text=True,
                                          capture_output=True, timeout=15)
                summary = (root/'summary').read_text()
                self.assertEqual(result.returncode == 0, valid)
                self.assertEqual(result.stdout, summary)
                if valid:
                    self.assertIn('before-run error=API_CANCELLED', result.stdout)
                else:
                    self.assertEqual(result.stdout, '')
                self.assertNotIn('secret-', result.stdout+result.stderr+summary)
                self.assertEqual(list((root/'runner').iterdir()), [])

    def test_normal_api_failure_docker_hang_oom_and_db_failure(self):
        for failure in (None, 'api', 'stop', 'daemon', 'oom', 'db'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
                ctl = object.__new__(c.Controller)
                ctl.b, ctl.state = FakeBroker, Path(root)
                ctl.record = Path(root)/'run.json'
                initialize(ctl)
                calls = []
                class Docker:
                    def call(self, args, **kwargs):
                        calls.append(args)
                        if failure == 'daemon' or (failure == 'stop' and args[0] == 'stop'):
                            raise TimeoutError()
                        return ''
                ctl.docker = Docker()
                def api(*args):
                    calls.append(['api'])
                    if failure == 'api':
                        raise TimeoutError()
                ctl.api = api
                ctl.inspect = lambda: {'State': {'Running': False, 'ExitCode': 0, 'OOMKilled': failure == 'oom'}}
                ctl.maintenance = lambda value: calls.append(['maintenance', value])
                class Helper:
                    def helper(self, *args):
                        if failure == 'db':
                            raise RuntimeError()
                ctl.helper = lambda: (Helper(), 'fixture')
                ctl.verify_sui = lambda: None
                good = ctl.stop()
                self.assertEqual(good, failure in (None, 'api'))
                self.assertTrue(any(a[0] == 'stop' for a in calls))
                self.assertIn(['maintenance', True], calls)
                receipt = json.loads((Path(root)/'stop.json').read_text())
                self.assertEqual(receipt['status'], 'clean_stopped' if good else 'failed_state_unknown')

    def test_health_starting_healthy_unhealthy_timeout(self):
        for outcome in ('healthy', 'unhealthy', 'timeout'):
            ctl = object.__new__(c.Controller)
            values = iter(['starting', 'healthy' if outcome == 'healthy' else 'unhealthy'])
            calls = []
            ctl.inspect = lambda: {'State': {'Running': True, 'OOMKilled': False, 'Health': {'Status': next(values)}}, 'RestartCount': 0}
            ctl.api = lambda *a: calls.append(a) or {'startReady': True, 'readiness': {'ledger': True, 'secret': 'fixture'}}
            with patch.object(c.time, 'monotonic', side_effect=[0, 0, 61] if outcome == 'timeout' else [0, 0, 1]), patch.object(c.time, 'time', return_value=0), patch.object(c.time, 'sleep'):
                if outcome == 'healthy':
                    self.assertTrue(ctl.wait_ready(100000)['startReady'])
                    self.assertEqual(ctl.readiness, {'health': 'healthy', 'ledger': True})
                    self.assertEqual(len(calls), 1)
                else:
                    with self.assertRaises(RuntimeError): ctl.wait_ready(100000)
                    self.assertEqual(calls, [])

    def test_release_timeout_retires_helper_before_relatch(self):
        for failure in ('start', 'daemon', None):
            with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
                ctl = object.__new__(c.Controller)
                ctl.b, ctl.state = FakeBroker, Path(root)
                initialize(ctl)
                FakeBroker.DATA = 'fixture-data'
                events = []
                class Docker:
                    def call(self, args, **kwargs):
                        events.append(args[0])
                        if args[0] == 'start' and failure:
                            raise TimeoutError()
                        if args[0] == 'rm' and failure == 'daemon':
                            raise TimeoutError()
                        if args[0] == 'inspect':
                            return '[{"State":{"Running":false,"ExitCode":0,"OOMKilled":false}}]'
                        return ''
                ctl.docker = Docker()
                class Helper:
                    def helper(self, *args): events.append('relatch')
                ctl.helper = lambda: (Helper(), 'fixture')
                if failure:
                    with self.assertRaises(TimeoutError): ctl.maintenance(False)
                else: ctl.maintenance(False)
                if failure == 'daemon':
                    with self.assertRaises(TimeoutError): ctl.maintenance(True)
                    self.assertNotIn('relatch', events)
                    self.assertFalse(json.loads((Path(root)/'release-helper.json').read_text())['retired'])
                else:
                    ctl.maintenance(True)
                    self.assertLess(events.index('rm'), events.index('relatch'))
                    self.assertTrue(json.loads((Path(root)/'release-helper.json').read_text())['retired'])
                # The delayed start target is removed, rather than an untracked
                # running helper able to unlink the newly restored latch.
                self.assertIn('create', events)
                self.assertIn('rm', events)

    def test_termination_failure_and_survival_are_latched(self):
        for failure in ('signal', 'alive'):
            with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
                ctl = object.__new__(c.Controller)
                ctl.b, ctl.state = FakeBroker, Path(root)
                record = initialize(ctl)
                ctl.exited = lambda r: failure != 'alive'
                def terminate(record): raise TimeoutError()
                ctl.terminate = terminate
                ctl.docker = type('Docker', (), {'call': lambda *args, **kwargs: ''})()
                ctl.api = lambda *a: None
                ctl.inspect = lambda: {'State': {'Running': False, 'ExitCode': 0, 'OOMKilled': False}}
                ctl.maintenance = lambda value: None
                ctl.helper = lambda: (type('Helper', (), {'helper': lambda *a: None})(), 'fixture')
                ctl.verify_sui = lambda: None
                self.assertFalse(ctl.stop())
                self.assertEqual(json.loads((ctl.state/'stop.json').read_text())['status'], 'failed_state_unknown')
                # Later successful cleanup must not erase the signal failure.
                ctl.terminate = lambda r: True
                ctl.exited = lambda r: True
                self.assertFalse(ctl.stop())
                for operation in ('unlatch', 'worker-start', 'arm', 'paper-start'):
                    with self.assertRaises(RuntimeError): ctl.guard(operation, lambda: self.fail('mutation admitted after stop'))

    def test_self_stop_is_pending_until_post_stop_confirms_exit(self):
        with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
            ctl = object.__new__(c.Controller)
            ctl.b, ctl.state = FakeBroker, Path(root)
            record = initialize(ctl)
            record['controller']['pid'] = os.getpid()
            ctl.b.atomic(ctl.record, record)
            ctl.exited = lambda r: False
            ctl.docker = type('Docker', (), {'call': lambda *a, **k: ''})()
            ctl.api = lambda *a: None
            ctl.inspect = lambda: {'State': {'Running': False, 'ExitCode': 0, 'OOMKilled': False}}
            ctl.maintenance = lambda value: None
            ctl.helper = lambda: (type('Helper', (), {'helper': lambda *a: None})(), 'fixture')
            ctl.verify_sui = lambda: None
            self.assertTrue(ctl.stop(own=True, source='normal'))
            self.assertEqual(json.loads((ctl.state/'stop.json').read_text())['status'], 'worker_stopped_pending_controller_exit')
            record['status'] = 'finishing'; ctl.b.atomic(ctl.record, record)
            ctl.exited = lambda r: True
            ctl.quiescent = lambda: None
            self.assertTrue(ctl.stop(source='post-stop'))
            self.assertEqual(ctl.current()['status'], 'completed')
            self.assertEqual(json.loads((ctl.state/'stop.json').read_text())['status'], 'clean_stopped')
            ctl.fault(ctl.current(), 'LATE_STOP_FAILURE')
            self.assertFalse(ctl.stop())

    @unittest.skipIf(os.name == 'nt', 'actual flock is tested in Linux CI')
    def test_stop_lock_failure_preserves_receipt_and_blocks_reentry(self):
        with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
            ctl = object.__new__(c.Controller)
            ctl.b, ctl.state = FakeBroker, Path(root)
            record = initialize(ctl)
            ctl.b.atomic(ctl.state/'stop.json', {'id': record['id'], 'status':'stopping_state_unknown'})
            original = ctl.locked
            @contextlib.contextmanager
            def no_wait(name, **kwargs):
                with original(name, wait=0): yield
            with original('stop'), patch.object(ctl, 'locked', no_wait):
                self.assertFalse(ctl.stop())
            self.assertEqual(json.loads((ctl.state/'stop.json').read_text())['status'], 'stopping_state_unknown')
            self.assertTrue(ctl.faults(record))
            with self.assertRaises(RuntimeError): ctl.guard('worker-start', lambda: self.fail('unexpected action'))

    def test_stale_stop_cannot_write_new_run(self):
        with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
            ctl = object.__new__(c.Controller)
            ctl.b, ctl.state = FakeBroker, Path(root)
            initialize(ctl)
            with self.assertRaises(RuntimeError): ctl.stop(expected='b'*32)
            self.assertFalse((ctl.state/'stop.json').exists())

    def test_rejected_preflight_does_not_touch_ordinary_paper(self):
        with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
            ctl = object.__new__(c.Controller)
            ctl.b, ctl.state = FakeBroker, Path(root)
            ctl.record = Path(root)/'run.json'
            self.assertTrue(ctl.stop())
            record = initialize(ctl)
            record['status'] = 'completed'
            ctl.record.write_text(json.dumps(record))
            self.assertTrue(ctl.stop())


if __name__ == '__main__':
    unittest.main(verbosity=2)
