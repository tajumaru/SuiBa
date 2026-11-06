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
    read_trusted = staticmethod(lambda path, maximum=65536: path.read_bytes())
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
                FakeBroker.atomic(policy/'policy.json', {'helper_image': 'fixture', 'compose_sha256': 'fixture'})
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

    def test_renderer_uses_the_same_failure_allowlists(self):
        # This cross-file check belongs in the repository suite. The isolated
        # broker security image intentionally contains only /tests and broker code.
        import ast
        script = Path(__file__).parents[2]/'docker/ssh-paper-status.sh'
        renderer = script.read_text().split("<<'PYCODE'", 1)[1].split('\n', 1)[1].rsplit('\nPYCODE', 1)[0]
        values = {}
        for node in ast.walk(ast.parse(renderer)):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Tuple):
                for name in node.targets:
                    if isinstance(name, ast.Name): values[name.id] = ast.literal_eval(node.value)
        broker = Path(__file__).parent.parent/'broker/broker.py'
        source = ast.parse(broker.read_text())
        constants = {node.targets[0].id: ast.literal_eval(node.value) for node in source.body
            if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id in ('FAILURE_CODES', 'FAILURE_STAGES')}
        self.assertEqual(values['codes'], constants['FAILURE_CODES'])
        self.assertEqual(values['stages'], constants['FAILURE_STAGES'])

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

    def test_diagnostic_backup_is_none_before_the_backup_stage(self):
        ctl = object.__new__(c.Controller)
        self.assertIsNone(ctl.diagnostic_backup({'id': 'a'*32}, None))

    def test_container_checks_name_the_failing_item(self):
        import re
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            root = Path(tmp)
            FakeBroker.atomic(root/'ledger.json', {'status': 'prepared_stopped', 'sequence': 6,
                'sha': 'a'*40, 'transaction': 'b'*32})
            tx = root/('b'*32)
            tx.mkdir()
            FakeBroker.atomic(tx/'compose.json', {'services': {'bot': {'image': 'img:1'}}})
            FakeBroker.atomic(root/'paper-check.json', {'status': 'in_progress'})
            ctl = object.__new__(c.Controller)
            ctl.b = SimpleNamespace(STATE=root, SHA=re.compile(r'[a-f0-9]{40}'), decode=json.loads,
                read_trusted=FakeBroker.read_trusted, __file__=c.__file__)
            container = {'State': {'Status': 'created', 'Running': False, 'ExitCode': 0, 'OOMKilled': False},
                'HostConfig': {'RestartPolicy': {'Name': 'no'},
                    'PortBindings': {'3100/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3101'}]},
                    'Memory': 1024**3, 'MemorySwap': 1024**3},
                'Config': {'User': '1000:1000', 'Image': 'img:1',
                    'Env': ['MODE=PAPER', 'TRADING_PAIR=SUI_USDC', 'PAPER_CHECK_MODE=sui-30m',
                            'MARKET_DATA_PROVIDER=geckoterminal'],
                    'Labels': {'org.opencontainers.image.revision': 'a'*40}}}
            response = b'ActiveState=inactive\nSubState=dead\nNextElapseUSecMonotonic=\nNextElapseUSecRealtime=\nJob=\n'
            with patch.object(c.subprocess, 'check_output', return_value=response):
                checks = ctl.diagnostic_host(container)['container_checks']
            self.assertEqual(checks, {'state': True, 'restart_user': True, 'env': True, 'ports': False,
                                      'memory': True, 'label': True, 'image': True})

    def test_approve_deploy_materializes_the_ci_approval_record(self):
        import re
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
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
            FakeBroker.atomic(policy/'policy.json', {'helper_image': 'fixture', 'compose_sha256': 'fixture',
                                                     'approval_source': 'ci'})
            FakeBroker.atomic(paper/record['id']/'stop.json', {'id': record['id'], 'status': 'clean_stopped'})
            ctl.quiescent = lambda: None
            ctl.diagnose_locked = lambda: {'stop': {'status': 'clean_stopped'}, 'requires_review': False,
                                           'diagnostics': {'exit_code': 0, 'oom_killed': False}}
            ctl.helper = lambda: (SimpleNamespace(helper=lambda *args: None), 'fixture')
            ctl.verify_sui = lambda: None
            sha = 'f'*40
            ctl.approve_deploy(record['id'], sha)
            approval = json.loads((policy/'approvals'/(sha+'.json')).read_bytes())
            self.assertEqual(approval['sha'], sha)
            self.assertEqual(approval['operation'], 'deploy')
            self.assertTrue(int(time.time()) < approval['expires'] <= int(time.time()) + 3600)
            permit = json.loads((state/('paper-deploy-'+sha+'.json')).read_bytes())
            import hashlib as hl
            self.assertEqual(permit['approval_sha256'],
                             hl.sha256((policy/'approvals'/(sha+'.json')).read_bytes()).hexdigest())

    def make_reconcile_fixture(self, root):
        import re
        from types import SimpleNamespace
        paper, state, backups_root, data = root/'paper', root/'broker', root/'backups', root/'data'
        for folder in (paper, state, backups_root, data):
            folder.mkdir(mode=0o700, parents=True)
        ctl = object.__new__(c.Controller)
        ctl.state, ctl.record = paper, paper/'run.json'
        record = initialize(ctl)
        record['status'] = 'failed_requires_review'
        FakeBroker.atomic(ctl.record, record)
        folder = paper/record['id']
        stop = {'id': record['id'], 'status': 'failed_state_unknown', 'errors': ['PREFLIGHT_INCOMPLETE']}
        FakeBroker.atomic(folder/'stop.json', stop)
        FakeBroker.atomic(paper/'stop.json', stop)
        (folder/'fault-fixture.json').write_text('{}')
        FakeBroker.atomic(state/'paper-check-failed.json', {'status': 'manual_reconciliation_required'})
        FakeBroker.atomic(state/'ledger.json', {'status': 'prepared_stopped', 'sequence': 6,
                                                'sha': 'a'*40, 'transaction': 'b'*32})
        (data/'bot.sqlite.maintenance').write_text('deployment\n')
        ctl.b = SimpleNamespace(STATE=state, DATA='suiba-vps-data', SHA=re.compile(r'[a-f0-9]{40}'),
            decode=FakeBroker.decode, read_trusted=FakeBroker.read_trusted, atomic=FakeBroker.atomic,
            directory=FakeBroker.directory)
        ctl.inspect = lambda: {'State': {'StartedAt': '0001-01-01T00:00:00Z', 'Running': False, 'ExitCode': 0}}
        ctl.docker = SimpleNamespace(call=lambda args, timeout=0: json.dumps(
            [{'Name': 'suiba-vps-data', 'Mountpoint': str(data)}]))
        ctl.quiescent = lambda: None
        ctl.diagnose = lambda: {'stop': {'status': 'clean_stopped'}, 'requires_review': False}
        return ctl, record, paper, state, backups_root

    def reconcile_fixture(self, root):
        ctl, record, paper, state, backups_root = self.make_reconcile_fixture(root)
        inactive = b'ActiveState=inactive\nJob=\n'
        return ctl, record, paper, state, backups_root, inactive

    def test_reconcile_retry_heals_and_approves(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            ctl, record, paper, state, backups_root, inactive = self.reconcile_fixture(Path(tmp))
            with patch.object(c, 'RECONCILE_BACKUPS', backups_root), \
                 patch.object(c.subprocess, 'check_output', return_value=inactive):
                result = ctl.reconcile_preflight('retry')
            self.assertEqual(result['mode'], 'retry')
            self.assertTrue(result['reconciled'])
            folder = paper/record['id']
            self.assertEqual(json.loads((folder/'retry-approved.json').read_bytes()), {'id': record['id']})
            for stop_path in (folder/'stop.json', paper/'stop.json'):
                healed = json.loads(stop_path.read_bytes())
                self.assertEqual(healed['status'], 'clean_stopped')
                self.assertEqual(healed['errors'], [])
            self.assertFalse((state/'paper-check-failed.json').exists())
            self.assertFalse((folder/'fault-fixture.json').exists())
            backup = backups_root/result['backup']
            self.assertTrue((backup/'run.json').exists())
            self.assertTrue((backup/'paper-check-failed.json').exists())
            self.assertTrue((backup/'fault-fixture.json').exists())

    def test_reconcile_deploy_approves_the_given_sha(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            ctl, record, paper, state, backups_root, inactive = self.reconcile_fixture(Path(tmp))
            calls = []
            ctl.approve_deploy = lambda run_id, sha: calls.append((run_id, sha))
            with patch.object(c, 'RECONCILE_BACKUPS', backups_root), \
                 patch.object(c.subprocess, 'check_output', return_value=inactive):
                result = ctl.reconcile_preflight('deploy', 'e'*40)
            self.assertEqual(result['mode'], 'deploy')
            self.assertEqual(calls, [(record['id'], 'e'*40)])
            self.assertFalse((paper/record['id']/'retry-approved.json').exists())

    def test_reconcile_refuses_on_unexpected_evidence(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            ctl, record, paper, state, backups_root, inactive = self.reconcile_fixture(Path(tmp))
            folder = paper/record['id']
            FakeBroker.atomic(folder/'stop.json', {'id': record['id'], 'status': 'failed_state_unknown',
                                                   'errors': ['SOMETHING_ELSE']})
            with patch.object(c, 'RECONCILE_BACKUPS', backups_root), \
                 patch.object(c.subprocess, 'check_output', return_value=inactive):
                with self.assertRaises(Exception):
                    ctl.reconcile_preflight('retry')
            self.assertTrue((state/'paper-check-failed.json').exists())
            self.assertEqual(json.loads((folder/'stop.json').read_bytes())['errors'], ['SOMETHING_ELSE'])
            self.assertEqual(list(backups_root.iterdir()), [])

    def test_record_preflight_keeps_only_check_and_error_class(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            state = Path(tmp)/'paper'
            (state/('a'*32)).mkdir(parents=True)
            ctl = object.__new__(c.Controller)
            ctl.state = state
            ctl.b = SimpleNamespace(atomic=FakeBroker.atomic, directory=FakeBroker.directory)
            try:
                raise RuntimeError('sensitive path /var/lib/secret')
            except RuntimeError as error:
                ctl.record_preflight({'id': 'a'*32}, 'container', error)
            saved = json.loads((state/('a'*32)/'preflight.json').read_bytes())
            self.assertEqual(saved, {'id': 'a'*32, 'check': 'container', 'error': 'RuntimeError'})
            ctl.record_preflight({'id': 'a'*32}, 'container', RuntimeError('fixture'), 'env')
            saved = json.loads((state/('a'*32)/'preflight.json').read_bytes())
            self.assertEqual(saved, {'id': 'a'*32, 'check': 'container', 'error': 'RuntimeError', 'detail': 'env'})

    def test_approve_retry_op_writes_the_permit_only_for_a_clean_failure(self):
        def fixture(root, stop_status='clean_stopped', requires_review=False):
            ctl = object.__new__(c.Controller)
            ctl.b, ctl.state = FakeBroker, root
            record = initialize(ctl)
            record['status'] = 'failed_requires_review'
            run = {'id': record['id'], 'status': 'failed_requires_review'}
            ctl.diagnose = lambda: {'run': run, 'stop': {'status': stop_status},
                                    'requires_review': requires_review}
            ctl.current = lambda: record
            ctl.locked = lambda name: contextlib.nullcontext()
            return ctl, record
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            ctl, record = fixture(Path(tmp))
            self.assertEqual(ctl.approve_retry(record['id']), {'approved': record['id']})
            saved = json.loads((Path(tmp)/record['id']/'retry-approved.json').read_text())
            self.assertEqual(saved, {'id': record['id']})
            # A second approval is refused: the permit is single-use.
            with self.assertRaises(RuntimeError): ctl.approve_retry(record['id'])
        for patch in ({'stop_status': 'failed_state_unknown'}, {'requires_review': True}):
            with self.subTest(**patch), tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
                ctl, record = fixture(Path(tmp), **patch)
                with self.assertRaises(RuntimeError): ctl.approve_retry(record['id'])
                self.assertFalse((Path(tmp)/record['id']/'retry-approved.json').exists())
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            ctl, record = fixture(Path(tmp))
            with self.assertRaises(RuntimeError): ctl.approve_retry('b'*32)

    def test_diagnostic_summary_accepts_a_run_without_backup(self):
        import io
        script = Path(__file__).parents[2]/'docker/ssh-paper-status.sh'
        renderer = script.read_text().split("<<'PYCODE'", 1)[1].split('\n', 1)[1].rsplit('\nPYCODE', 1)[0]
        payload = {
            'run': {'id': 'a'*32, 'status': 'failed_requires_review', 'duration': '6h'},
            'stop': {'id': 'a'*32, 'status': 'failed_state_unknown', 'errors': ['PREFLIGHT_INCOMPLETE']},
            'requires_review': True,
            'diagnostics': {'stage': None, 'maintenance': True, 'backup_verified': False,
                'oom_killed': False, 'exit_code': 0, 'healthcheck_exit': None, 'http_status': None,
                'deltas': None},
        }
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            path = Path(tmp)/'response'
            def render():
                path.write_text(json.dumps(payload))
                output = io.StringIO()
                with patch.object(c.sys, 'argv', ['summary', str(path), 'diagnose']), contextlib.redirect_stdout(output):
                    exec(compile(renderer, 'summary', 'exec'), {})
                return output.getvalue()
            output = render()
            self.assertIn('PREFLIGHT_INCOMPLETE', output)
            self.assertIn('not taken', output)
            self.assertIn('unavailable', output)
            payload['diagnostics']['preflight'] = {'check': 'container', 'error': 'RuntimeError'}
            self.assertIn('check=container, error=RuntimeError', render())
            payload['diagnostics']['preflight'] = {'check': 'secret-fixture', 'error': 'RuntimeError'}
            with self.assertRaises(SystemExit):
                render()
            payload['diagnostics']['preflight'] = {'check': 'container', 'error': 'RuntimeError', 'detail': 'env'}
            self.assertIn('check=container, error=RuntimeError, detail=env', render())
            payload['diagnostics']['preflight'] = {'check': 'container', 'error': 'RuntimeError', 'detail': 'secret-fixture'}
            with self.assertRaises(SystemExit):
                render()
            payload['diagnostics']['preflight'] = {'check': 'ledger', 'error': 'RuntimeError', 'detail': 'env'}
            with self.assertRaises(SystemExit):
                render()
            payload['diagnostics']['preflight'] = None
            host = {'restart_disabled': True, 'paper': True, 'fault_marker': True,
                'timer_active': False, 'timer_elapsed': False, 'timer_next_scheduled': False,
                'timer_job_pending': False, 'sequence': 6, 'sha': 'a'*40,
                'ledger_status': 'prepared_stopped', 'paper_gate': 'in_progress',
                'container_status': 'created', 'controller_sha256': 'a'*64, 'broker_sha256': 'b'*64,
                'broker_failure': None,
                'container_checks': {'state': True, 'restart_user': True, 'env': True, 'ports': False,
                                     'memory': True, 'label': True, 'image': True}}
            payload['diagnostics']['host'] = host
            self.assertIn('ports=NG', render())
            host['container_checks']['ports'] = 'yes'
            with self.assertRaises(SystemExit):
                render()
            # Differences claimed without a verified backup are a lie.
            payload['diagnostics']['deltas'] = {pair: {'starts': 0, 'orders': 0, 'fills': 0}
                                                 for pair in ('SUI_USDC', 'WAL_USDC')}
            with self.assertRaises(SystemExit):
                render()
            payload['diagnostics']['deltas'] = None
            payload['stop']['errors'] = ['secret-fixture-do-not-log']
            with self.assertRaises(SystemExit):
                render()

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

    def test_market_fresh_waits_for_the_first_success(self):
        fresh = {'source': 'GeckoTerminal', 'lastSuccessAt': 1000}
        cold = {'source': 'GeckoTerminal', 'lastSuccessAt': None}
        # Already fresh: returns on the passed-in summary, never polls.
        ctl = object.__new__(c.Controller)
        def forbidden(*a): raise AssertionError('must not poll')
        ctl.api = forbidden
        with patch.object(c.time, 'time', return_value=1.0):
            ctl.wait_market_fresh(fresh, 10**13)
        # Cold start (no success recorded yet) then a success: the
        # wait polls instead of dying on the None like the old
        # single-shot check did.
        ctl = object.__new__(c.Controller)
        calls = []
        pages = iter([{'summary': {'marketData': cold}}, {'summary': {'marketData': fresh}}])
        ctl.api = lambda *a: calls.append(a) or next(pages)
        with patch.object(c.time, 'time', return_value=1.0), patch.object(c.time, 'sleep'):
            ctl.wait_market_fresh(cold, 10**13)
        self.assertEqual(len(calls), 2)
        # Never fresh: the two-minute deadline rejects the run.
        ctl = object.__new__(c.Controller)
        ctl.api = lambda *a: {'summary': {'marketData': cold}}
        with patch.object(c.time, 'monotonic', side_effect=[0, 0, 121]), patch.object(c.time, 'time', return_value=1.0), patch.object(c.time, 'sleep'):
            with self.assertRaises(RuntimeError): ctl.wait_market_fresh(cold, 10**13)

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


class DurationTests(unittest.TestCase):
    def make(self, root):
        ctl = object.__new__(c.Controller)
        ctl.b, ctl.state = FakeBroker, Path(root)
        return ctl

    def test_cutoff_timer_names_follow_the_fixed_units(self):
        self.assertEqual(c.cutoff_timer('30m'), c.TIMER)
        self.assertEqual(c.cutoff_timer('6h'), 'suiba-paper-check-cutoff-6h.timer')
        self.assertEqual(c.cutoff_timer('24h'), 'suiba-paper-check-cutoff-24h.timer')
        self.assertEqual(c.cutoff_timers(), (c.TIMER, 'suiba-paper-check-cutoff-6h.timer',
                                             'suiba-paper-check-cutoff-24h.timer'))
        self.assertEqual(c.DURATIONS, {'30m': 1800, '6h': 21600, '24h': 86400})

    def test_start_request_defaults_without_a_note(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(self.make(root).take_start_request(), '30m')

    def test_start_request_round_trip_consumes_the_note(self):
        with tempfile.TemporaryDirectory() as root:
            ctl = self.make(root)
            ctl.note_start_request('24h')
            self.assertEqual(ctl.take_start_request(), '24h')
            self.assertFalse((Path(root)/'start-request.json').exists())
            consumed = json.loads((Path(root)/'start-request-consumed.json').read_text())
            self.assertEqual(consumed['duration'], '24h')
            self.assertEqual(ctl.take_start_request(), '30m')

    def test_start_request_rejects_unknown_duration(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(Exception):
                self.make(root).note_start_request('12h')

    def test_start_request_stale_note_falls_back_to_default(self):
        with tempfile.TemporaryDirectory() as root:
            ctl = self.make(root)
            FakeBroker.atomic(Path(root)/'start-request.json',
                              {'duration': '6h', 'at': int(time.time()*1000)-660000})
            self.assertEqual(ctl.take_start_request(), '30m')
            self.assertTrue((Path(root)/'start-request-consumed.json').exists())

    def test_start_request_future_note_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            ctl = self.make(root)
            FakeBroker.atomic(Path(root)/'start-request.json',
                              {'duration': '6h', 'at': int(time.time()*1000)+120000})
            with self.assertRaises(Exception):
                ctl.take_start_request()

    @unittest.skipUnless(os.name == 'posix', 'mocked shell pipeline runs on Linux')
    def test_start_script_sends_only_the_fixed_request(self):
        script = Path(__file__).parents[2]/'docker/ssh-paper-start.sh'
        with tempfile.TemporaryDirectory(dir=script.parent) as tmp:
            root = Path(tmp)
            (root/'bin').mkdir(); (root/'runner').mkdir()
            for name, body in (
                ('ssh-keygen', '#!/bin/sh\nprintf "%s" "secret-key-output"\n'),
                ('ssh', '#!/bin/sh\ncat > "$MOCK_STDIN"\ncat "$MOCK_RESPONSE"\nprintf "%s" "secret-ssh-stderr" >&2\n')):
                path = root/'bin'/name
                path.write_text(body); path.chmod(0o755)
            env = {**os.environ, 'PATH': str(root/'bin')+':'+os.environ['PATH'],
                'RUNNER_TEMP': str(root/'runner'), 'VPS_HOST': 'fixture.invalid',
                'VPS_USER': 'suiba-deploy', 'VPS_PORT': '22', 'VPS_SSH_KEY': 'secret-key-fixture',
                'VPS_KNOWN_HOSTS': 'fixture-only', 'MOCK_RESPONSE': str(root/'response'),
                'MOCK_STDIN': str(root/'stdin'), 'PAPER_START_CONFIRMATION': 'START-PAPER',
                'PAPER_START_DURATION': '6h', 'GITHUB_STEP_SUMMARY': str(root/'summary')}
            (root/'response').write_text('PAPER_CHECK_REQUEST_ACCEPTED\n')
            (root/'summary').write_text('')
            result = c.subprocess.run(['/bin/bash', str(script)], env=env, text=True,
                                      capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0)
            self.assertEqual((root/'stdin').read_text(), '{"operation":"start","duration":"6h"}\n')
            self.assertIn('- Duration: `6h`', result.stdout)
            self.assertEqual(result.stdout, (root/'summary').read_text())
            self.assertNotIn('secret-', result.stdout+result.stderr)
            self.assertEqual(list((root/'runner').iterdir()), [])
            (root/'response').write_text('unexpected-response\n')
            result = c.subprocess.run(['/bin/bash', str(script)], env=env, text=True,
                                      capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn('unexpected-response', result.stdout+result.stderr)
            env['PAPER_START_DURATION'] = '12h'
            (root/'stdin').unlink()
            result = c.subprocess.run(['/bin/bash', str(script)], env=env, text=True,
                                      capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 1)
            self.assertFalse((root/'stdin').exists())

    def test_start_request_malformed_note_is_rejected_and_consumed(self):
        with tempfile.TemporaryDirectory() as root:
            ctl = self.make(root)
            FakeBroker.atomic(Path(root)/'start-request.json', {'duration': '6h'})
            with self.assertRaises(Exception):
                ctl.take_start_request()
            self.assertFalse((Path(root)/'start-request.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
