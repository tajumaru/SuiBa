import copy
import io
import tarfile
import hashlib
import importlib.util
import json
import os
import stat
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import unittest.mock
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('broker', Path(__file__).with_name('broker.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
SHA = 'a'*40
IMAGE = 'sha256:'+'b'*64
HELPER = 'sha256:'+'c'*64
CID = 'd'*64


def model():
    return {
        'name': b.PROJECT,
        'services': {'bot': {
            'image': IMAGE, 'pull_policy': 'never',
            'environment': {'MODE': 'PAPER', 'HOST': '0.0.0.0', 'PORT': '3100',
                'DATABASE_PATH': '/app/data/bot.sqlite', 'REQUIRE_EXISTING_DATABASE': '1',
                'ADMIN_TOKEN': '', 'ADMIN_TOKEN_FILE': '/run/secrets/admin-token',
                'NODE_OPTIONS': '--max-old-space-size=640', 'VALIDATION_REPORT_DIR': '/app/reports'},
            'read_only': True, 'init': True, 'cap_drop': ['ALL'],
            'security_opt': ['no-new-privileges:true'], 'mem_limit': 1024**3,
            'memswap_limit': 1024**3, 'mem_reservation': 512*1024**2, 'cpus': 1.0,
            'pids_limit': 128, 'stop_signal': 'SIGTERM', 'stop_grace_period': '40s',
            'ports': [{'host_ip': '127.0.0.1', 'published': '3100', 'target': 3100}],
            'volumes': [{'source': 'vps-data', 'target': '/app/data', 'type': 'volume'},
                        {'source': 'vps-reports', 'target': '/app/reports', 'type': 'volume'}],
            'secrets': [{'source': 'admin-token', 'target': '/run/secrets/admin-token'}]}},
        'volumes': {'vps-data': {'name': b.DATA, 'external': True}, 'vps-reports': {'name': b.REPORTS, 'external': True}},
        'secrets': {'admin-token': {'name': 'suiba-vps_admin-token', 'file': '/opt/suiba/shared/admin-token'}}}


class FakeDocker:
    def __init__(self):
        self.calls = []
        self.failure = None
        self.created = False
        self.rendered = model()

    def call(self, args, image='', output=None, timeout=180):
        self.calls.append(args)
        if self.failure == 'maintenance' and args[-1] == 'maintenance':
            raise b.Rejected('INJECTED')
        if self.failure == 'backup' and args[-1] == 'backup':
            raise b.Rejected('INJECTED')
        if args[0] == 'compose':
            if 'config' in args:
                return json.dumps(self.rendered)
            if 'create' in args:
                if self.failure == 'create':
                    raise b.Rejected('INJECTED')
                self.created = True
        if args[0] == 'ps':
            return CID
        if args[:2] == ['image', 'inspect'] and '--format' in args:
            return json.dumps({'Id': IMAGE, 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'User': 'node', 'Env': ['MODE=PAPER'], 'Labels': {'org.opencontainers.image.revision': SHA}}})
        if args[0] == 'inspect':
            if args[2] == '{{.State.Running}}':
                return 'false'
            return json.dumps({'Running': False, 'OOMKilled': self.failure == 'oom',
                'ExitCode': 137 if self.failure == 'timeout' else 0,
                'Status': 'created' if self.created else 'exited'})
        if output:
            output.write(b'cold-backup-fixture')
        return ''


class BrokerTests(unittest.TestCase):
    def test_paper_session_blocks_deploy_after_controller_lock_is_gone(self):
        with tempfile.TemporaryDirectory(prefix='paper-session-', dir='/var/lib') as root:
            broker = b.Broker(state=root)
            marker = Path(root)/'paper-check.json'
            broker.check_paper_session()  # Ordinary PAPER, feature never used.
            for value in ({'status': 'in_progress'}, {'status': 'failed_state_unknown'}, {}, {'status': 'completed', 'extra': True}):
                b.atomic(marker, value)
                with self.assertRaises(b.Rejected):
                    broker.check_paper_session()
            b.atomic(marker, {'status': 'completed'})
            broker.check_paper_session()
            b.atomic(Path(root)/'paper-check-failed.json', {'status':'manual_reconciliation_required'})
            with self.assertRaises(b.Rejected): broker.check_paper_session()

    def paper_deploy_permit(self, paper):
        run_id = 'e'*32
        folder = paper/run_id
        folder.mkdir()
        record = {'id': run_id, 'status': 'failed_requires_review'}
        stop = {'id': run_id, 'status': 'clean_stopped', 'errors': []}
        b.atomic(paper/'run.json', record)
        for name in ('stop', 'mutation'):
            (paper/(name+'.lock')).touch(mode=0o600)
        b.atomic(folder/'stop.json', stop)
        b.atomic(self.state/'paper-check.json', {'status': 'in_progress'})
        permit = {
            'id': run_id, 'sha': SHA,
            'approval_sha256': hashlib.sha256((self.policy/'approvals'/(SHA+'.json')).read_bytes()).hexdigest(),
            'run_sha256': hashlib.sha256((paper/'run.json').read_bytes()).hexdigest(),
            'stop_sha256': hashlib.sha256((folder/'stop.json').read_bytes()).hexdigest(),
        }
        path = self.state/('paper-deploy-'+SHA+'.json')
        b.atomic(path, permit)
        return path

    def paper_fixture(self, paper, permit=True):
        # paper_deploy_permit with an explicit folder mode, so the
        # fixture also survives a group-writable umask.
        run_id = 'e'*32
        folder = paper/run_id
        folder.mkdir(mode=0o700)
        b.atomic(paper/'run.json', {'id': run_id, 'status': 'failed_requires_review'})
        b.atomic(folder/'stop.json', {'id': run_id, 'status': 'clean_stopped', 'errors': []})
        b.atomic(self.state/'paper-check.json', {'status': 'in_progress'})
        if not permit:
            return None
        value = {
            'id': run_id, 'sha': SHA,
            'approval_sha256': hashlib.sha256((self.policy/'approvals'/(SHA+'.json')).read_bytes()).hexdigest(),
            'run_sha256': hashlib.sha256((paper/'run.json').read_bytes()).hexdigest(),
            'stop_sha256': hashlib.sha256((folder/'stop.json').read_bytes()).hexdigest(),
        }
        path = self.state/('paper-deploy-'+SHA+'.json')
        b.atomic(path, value)
        return path

    def test_reviewed_deploy_is_single_use_and_keeps_failed_record(self):
        with tempfile.TemporaryDirectory(dir=self.root) as tmp, patch.object(b, 'PAPER_STATE', Path(tmp)):
            paper = Path(tmp)
            permit = self.paper_deploy_permit(paper)
            self.assertEqual(self.broker.check_paper_session(self.req), permit)
            with self.assertRaises(b.Rejected):
                self.broker.check_paper_session()  # Controller start is still blocked.
            result = self.broker.execute(self.req, 1001)
            self.assertEqual(result['status'], 'prepared_stopped')
            self.assertEqual(json.loads((paper/'run.json').read_bytes())['status'], 'failed_requires_review')
            self.assertTrue(permit.with_suffix('.consumed.json').exists())
            with self.assertRaises(b.Rejected):
                self.broker.execute(self.req, 1001)

    def test_reviewed_deploy_refuses_changed_proof_or_approval(self):
        for changed in ('run', 'stop', 'approval', 'fault', 'retry', 'abort', 'expired'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory(dir=self.root) as tmp:
                paper = Path(tmp)
                with patch.object(b, 'PAPER_STATE', paper):
                    permit = self.paper_deploy_permit(paper)
                    folder = paper/('e'*32)
                    if changed in ('run', 'stop'):
                        path = paper/'run.json' if changed == 'run' else folder/'stop.json'
                        path.write_bytes(path.read_bytes()+b' ')
                    elif changed == 'approval':
                        path = self.policy/'approvals'/(SHA+'.json')
                        path.write_bytes(path.read_bytes()+b' ')
                    elif changed == 'fault':
                        b.atomic(folder/'fault-late.json', {})
                    elif changed == 'retry':
                        b.atomic(folder/'retry-approved.json', {})
                    elif changed == 'abort':
                        b.atomic(paper/'abort-inhibit.json', {})
                    if changed == 'expired':
                        with patch.object(b.time, 'time', return_value=self.approval['expires']+1):
                            with self.assertRaises(b.Rejected):
                                self.broker.check_paper_session(self.req)
                    else:
                        with self.assertRaises(b.Rejected):
                            self.broker.check_paper_session(self.req)
                    self.assertTrue(permit.exists())

    def test_reviewed_deploy_refuses_concurrent_stop_without_consuming(self):
        with tempfile.TemporaryDirectory(dir=self.root) as tmp, patch.object(b, 'PAPER_STATE', Path(tmp)):
            paper = Path(tmp)
            permit = self.paper_deploy_permit(paper)
            with b.regular(paper/'stop.lock') as fd:
                b.fcntl.flock(fd, b.fcntl.LOCK_EX|b.fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    self.broker.execute(self.req, 1001)
            self.assertTrue(permit.exists())
            self.assertFalse(self.docker.calls)

    def test_consumed_permit_blocks_replay_after_unlink_failure(self):
        with tempfile.TemporaryDirectory(dir=self.root) as tmp, patch.object(b, 'PAPER_STATE', Path(tmp)):
            permit = self.paper_deploy_permit(Path(tmp))
            with patch.object(b.os, 'unlink', side_effect=OSError('fixture')):
                with self.assertRaises(OSError):
                    self.broker.consume_paper_deploy(permit)
            self.assertTrue(permit.exists())
            self.assertTrue(permit.with_suffix('.consumed.json').exists())
            with self.assertRaises(b.Rejected):
                self.broker.check_paper_session(self.req)

    def test_missing_paper_permit_rejects_with_its_own_code(self):
        with tempfile.TemporaryDirectory(dir=self.root) as tmp, patch.object(b, 'PAPER_STATE', Path(tmp)):
            self.paper_fixture(Path(tmp), permit=False)
            with self.assertRaises(b.Rejected) as caught:
                self.broker.check_paper_session(self.req)
            self.assertEqual(caught.exception.args, ('PAPER_DEPLOY_PERMIT_MISSING',))
            self.assertEqual(b.public_failure_code(caught.exception), 'PAPER_DEPLOY_PERMIT_MISSING')

    def test_missing_permit_target_rejects_with_its_own_code(self):
        for missing in ('run', 'stop', 'approval'):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory(dir=self.root) as tmp, patch.object(b, 'PAPER_STATE', Path(tmp)):
                paper = Path(tmp)
                self.paper_fixture(paper)
                target = {'run': paper/'run.json', 'stop': paper/('e'*32)/'stop.json',
                          'approval': self.policy/'approvals'/(SHA+'.json')}[missing]
                target.unlink()
                try:
                    with self.assertRaises(b.Rejected) as caught:
                        self.broker.check_paper_session(self.req)
                    self.assertEqual(caught.exception.args, ('PAPER_DEPLOY_STATE_MISSING',))
                finally:
                    if missing == 'approval':
                        self.save_approval()

    def test_consume_race_rejects_as_already_consumed(self):
        with tempfile.TemporaryDirectory(dir=self.root) as tmp, patch.object(b, 'PAPER_STATE', Path(tmp)):
            permit = self.paper_fixture(Path(tmp))
            permit.with_suffix('.consumed.json').write_bytes(b'{}\n')
            with self.assertRaises(b.Rejected) as caught:
                self.broker.consume_paper_deploy(permit)
            self.assertEqual(caught.exception.args, ('PAPER_DEPLOY_ALREADY_CONSUMED',))
            self.assertTrue(permit.exists())

    def test_execute_records_a_pre_transaction_failure(self):
        with tempfile.TemporaryDirectory(dir=self.root) as tmp, patch.object(b, 'PAPER_STATE', Path(tmp)):
            self.paper_fixture(Path(tmp), permit=False)
            with self.assertRaises(b.Rejected) as caught:
                self.broker.execute(self.req, 1001)
            self.assertEqual(caught.exception.args, ('PAPER_DEPLOY_PERMIT_MISSING',))
            record = json.loads((self.state/'last-failure.json').read_text())
            self.assertEqual(record['code'], 'PAPER_DEPLOY_PERMIT_MISSING')
            self.assertEqual(record['sha'], SHA)
            self.assertEqual(record['operation'], 'deploy')
            self.assertFalse(self.docker.calls)

    def strict_policy_modes(self):
        # Files written by setUp inherit the process umask; the
        # broker's trusted reads require non-group-writable modes.
        for name in ('policy.json', 'compose.yaml'):
            os.chmod(self.policy/name, 0o600)
        os.chmod(self.policy/'approvals'/(SHA+'.json'), 0o600)

    def test_missing_approval_file_rejects_with_its_own_code(self):
        self.strict_policy_modes()
        (self.policy/'approvals'/(SHA+'.json')).unlink()
        with self.assertRaises(b.Rejected) as caught:
            self.broker.transaction(self.req, 1001)
        self.assertEqual(caught.exception.args, ('APPROVAL_FILE_MISSING',))

    def test_missing_archive_rejects_with_its_own_code(self):
        self.strict_policy_modes()
        self.archive.unlink()
        with self.assertRaises(b.Rejected) as caught:
            self.broker.transaction(self.req, 1001)
        self.assertEqual(caught.exception.args, ('ARCHIVE_MISSING',))

    def setUp(self):
        # Transaction tests isolate archive parsing; real tar tests below cover it.
        self.identity_patch = patch.object(b, 'archive_identity', return_value=(IMAGE, {}))
        self.identity_patch.start()
        self.temp = tempfile.TemporaryDirectory(prefix='suiba-broker-', dir='/var/lib')
        self.root = Path(self.temp.name)
        self.policy, self.state, self.incoming, self.backups = [self.root/x for x in ['policy', 'state', 'incoming', 'backups']]
        for p in [self.policy, self.state, self.incoming, self.backups, self.policy/'docker', self.policy/'approvals']:
            p.mkdir(mode=0o700)
        os.chown(self.incoming, 1001, 1001)
        self.upload = self.incoming/SHA
        self.upload.mkdir(mode=0o700)
        os.chown(self.upload, 1001, 1001)
        self.archive = self.upload/'image.tar.gz'
        self.archive.write_bytes(b'approved-archive')
        os.chown(self.archive, 1001, 1001)
        compose = b'root-reviewed-compose-fixture'
        (self.policy/'compose.yaml').write_bytes(compose)
        (self.policy/'policy.json').write_text(json.dumps({'helper_image': HELPER, 'compose_sha256': hashlib.sha256(compose).hexdigest()}))
        self.approval = {'sha': SHA, 'operation': 'deploy', 'archive_sha256': hashlib.sha256(b'approved-archive').hexdigest(),
                         'image_id': IMAGE, 'sequence': 1, 'expires': int(time.time())+3600,
                         'repository': 'tajumaru/SuiBa', 'ref': 'refs/heads/main', 'ci_run': 123}
        self.save_approval()
        self.docker = FakeDocker()
        self.broker = b.Broker(self.policy, self.state, self.incoming, self.backups, self.docker)
        self.req = {'operation': 'deploy', 'sha': SHA}

    def tearDown(self):
        self.identity_patch.stop()
        self.temp.cleanup()

    def save_approval(self):
        (self.policy/'approvals'/f'{SHA}.json').write_text(json.dumps(self.approval))

    def test_containerd_lookup_uses_only_proven_manifest_and_creates_stopped(self):
        mid = 'sha256:'+'e'*64
        descriptor = {'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'digest': mid, 'size': 123}
        original = self.docker.call
        def call(args, **kwargs):
            if args[:2] == ['image', 'inspect'] and '--format' in args:
                if args[-1] == IMAGE:
                    raise b.Rejected('DOCKER_OPERATION_FAILED')
                self.assertEqual(args[-1], mid)
                identity = json.loads(original(args, **kwargs))
                identity.update(Id=mid, Descriptor=descriptor)
                return json.dumps(identity)
            return original(args, **kwargs)
        self.docker.call = call
        with patch.object(b, 'archive_identity', return_value=(IMAGE, {mid: descriptor})):
            self.assertEqual(self.broker.execute(self.req, 1001)['status'], 'prepared_stopped')
        self.assertEqual(json.loads(self.broker.model.read_text())['services']['bot']['image'], mid)

    def test_expiry_during_load_does_not_consume_or_mutate(self):
        clock = [time.time()]
        original = self.docker.call
        def call(args, **kwargs):
            if args[0] == 'load':
                clock[0] = self.approval['expires']
            return original(args, **kwargs)
        self.docker.call = call
        with patch.object(b.time, 'time', side_effect=lambda: clock[0]):
            with self.assertRaisesRegex(b.Rejected, 'APPROVAL_EXPIRED_BEFORE_MUTATION'):
                self.broker.execute(self.req, 1001)
        self.assertFalse((self.state/'ledger.json').exists())
        self.assertFalse(any(a[0] in ('run', 'stop', 'update') or 'create' in a for a in self.docker.calls))

    def test_fake_docker_output_limits_and_timeout(self):
        for script in ["import os;\nwhile True: os.write(1,b'x'*65536)",
                       "import os;\nwhile True: os.write(2,b'x'*65536)",
                       "import os;\nwhile True: os.write(1,b'x'*65536);os.write(2,b'x'*65536)"]:
            with self.subTest(script=script), self.assertRaisesRegex(b.Rejected, 'DOCKER_OUTPUT_TOO_LARGE'):
                b.bounded_process(['/usr/bin/python3', '-c', script], {}, timeout=5)
        with self.assertRaisesRegex(b.Rejected, 'DOCKER_TIMEOUT'):
            b.bounded_process(['/usr/bin/python3', '-c', 'import time;time.sleep(20)'], {}, timeout=0.2)
        self.assertEqual(b.bounded_process(['/usr/bin/python3', '-c', "print('ok')"], {}), b'ok\n')

    def test_process_failure_records_exit_and_counts_but_never_output(self):
        for program, expected in (("import os;os.write(1,b'secret-output');os.write(2,b'secret-stderr');raise SystemExit(23)", 23),
                                  ("import os,signal;os.kill(os.getpid(),signal.SIGTERM)", -15)):
            with self.subTest(exit=expected), self.assertRaises(b.Rejected) as caught:
                b.bounded_process(['/usr/bin/python3', '-c', program], {})
            value = b.failure_diagnostic(caught.exception, 'verify-databases')
            self.assertEqual(value['code'], 'DOCKER_OPERATION_FAILED')
            self.assertEqual(value['process']['exit_code'], expected)
            self.assertEqual(value['process']['phase'], 'wait')
            self.assertNotIn('secret-', json.dumps(value))

    def test_failure_diagnostic_redacts_untrusted_errors_and_attributes(self):
        for error, code in ((b.Rejected('secret-token'), 'UNEXPECTED_REJECTION'),
                            (OSError('secret-token'), 'OS_ERROR'),
                            (RuntimeError('secret-token'), 'UNEXPECTED_EXCEPTION'),
                            (subprocess.TimeoutExpired(['secret-token'], 1, output=b'secret-token'), 'PROCESS_TIMEOUT')):
            error._broker_process_diagnostic = {'argv': 'secret-token'}
            value = b.failure_diagnostic(error, 'maintenance')
            self.assertEqual(value['code'], code)
            self.assertIsNone(value['process'])
            self.assertNotIn('secret-token', json.dumps(value))

    def test_emergency_stop_all_duplicates_despite_first_failure(self):
        calls = []
        second = 'e'*64
        def call(args, **kwargs):
            calls.append(args)
            if args[0] == 'ps':
                return CID+' '+second
            if args[0] == 'update' and args[-1] == CID:
                raise b.Rejected('UPDATE_FAILED')
            if args[0] in ('stop', 'kill') and args[-1] == CID:
                raise b.Rejected('STOP_FAILED')
            return 'false'
        self.docker.call = call
        self.assertFalse(self.broker.emergency_stop())
        self.assertTrue(any(a[0] == 'stop' and a[-1] == second for a in calls))

    def test_restart_disable_failure_is_not_confirmed_safe(self):
        original = self.docker.call
        def call(args, **kwargs):
            if args[0] == 'update':
                raise b.Rejected('UPDATE_FAILED')
            return original(args, **kwargs)
        self.docker.call = call
        self.assertFalse(self.broker.emergency_stop())

    def test_unknown_or_interrupted_state_requires_administrator(self):
        for status in ('in_progress', 'failed_state_unknown'):
            b.atomic(self.state/'ledger.json', {'sequence': 0, 'status': status})
            with self.assertRaisesRegex(b.Rejected, 'ADMIN_RECONCILIATION_REQUIRED'):
                self.broker.execute(self.req, 1001)
            self.assertEqual(self.docker.calls, [])

    def test_success_creates_only_and_uses_pinned_helper(self):
        r = self.broker.execute(self.req, 1001)
        self.assertEqual(r['status'], 'prepared_stopped')
        self.assertTrue((self.backups/r['backup']).read_bytes())
        frozen = json.loads(self.broker.model.read_text())['services']['bot']
        self.assertEqual(frozen['restart'], 'no')
        self.assertEqual(frozen['user'], '1000:1000')
        self.assertEqual(frozen['command'], [])
        for a in self.docker.calls:
            if a[0] == 'run':
                self.assertIn(HELPER, a)
                self.assertNotIn(IMAGE, a)
            if a[0] == 'compose':
                self.assertNotIn('up', a)
                self.assertNotIn('start', a)
        self.assertFalse(list(self.state.glob('*/image.tar.gz')))

    def test_request_rejects_extra_fields_paths_commands_and_duplicate_json(self):
        for raw in [b'{}', b'{"operation":"start","sha":"'+SHA.encode()+b'"}',
                    json.dumps({**self.req, 'image': 'evil'}).encode(),
                    json.dumps({**self.req, 'sha': '../'+SHA}).encode(),
                    b'{"operation":"deploy","operation":"rollback","sha":"'+SHA.encode()+b'"}', b'x'*513]:
            with self.subTest(raw=raw), self.assertRaises(Exception):
                b.request(raw)
        self.assertEqual(b.request(json.dumps(self.req).encode()), self.req)

    def test_unapproved_expired_wrong_ref_or_digest_never_stops_or_creates(self):
        for field, value in [('expires', 1), ('ref', 'refs/heads/evil'), ('archive_sha256', '0'*64), ('image_id', 'suiba:latest')]:
            with self.subTest(field=field):
                original = self.approval[field]
                self.approval[field] = value
                self.save_approval()
                with self.assertRaises(Exception):
                    self.broker.execute(self.req, 1001)
                self.approval[field] = original
                for a in self.docker.calls:
                    self.assertNotIn('stop', a)
                    self.assertNotIn('create', a)

    def test_symlink_archive_rejected(self):
        self.archive.unlink()
        self.archive.symlink_to(self.policy/'policy.json')
        with self.assertRaises(Exception):
            self.broker.execute(self.req, 1001)
        self.assertEqual(self.docker.calls, [])

    def test_hardlink_archive_rejected(self):
        os.link(self.archive, self.upload/'alias')
        with self.assertRaises(Exception):
            self.broker.execute(self.req, 1001)

    def test_fifo_and_symlink_upload_directory_rejected(self):
        self.archive.unlink()
        os.mkfifo(self.archive)
        os.chown(self.archive, 1001, 1001)
        with self.assertRaises(Exception):
            self.broker.execute(self.req, 1001)
        self.archive.unlink()
        (self.state/'attempt.json').unlink()
        self.upload.rmdir()
        self.upload.symlink_to(self.policy, target_is_directory=True)
        with self.assertRaises(Exception):
            self.broker.execute(self.req, 1001)

    def test_uploaded_scripts_and_compose_are_never_used(self):
        (self.upload/'compose.yaml').write_text('privileged: true')
        (self.upload/'deploy-vps.sh').write_text('touch /root/escalation')
        self.broker.execute(self.req, 1001)
        for call in self.docker.calls:
            self.assertNotIn(str(self.upload/'compose.yaml'), call)
            self.assertNotIn(str(self.upload/'deploy-vps.sh'), call)

    def test_snapshot_is_frozen_before_docker(self):
        original_call = self.docker.call
        def mutate_after_snapshot(args, **kwargs):
            if args[0] == 'compose' and 'config' in args:
                self.archive.write_bytes(b'changed-after-hash')
            if args[0] == 'load':
                self.assertEqual(Path(args[-1]).read_bytes(), b'approved-archive')
            return original_call(args, **kwargs)
        self.docker.call = mutate_after_snapshot
        self.broker.execute(self.req, 1001)

    def test_oversized_archive_rejected_without_docker(self):
        limit = b.MAX_ARCHIVE
        try:
            b.MAX_ARCHIVE = 4
            with self.assertRaises(b.Rejected):
                self.broker.execute(self.req, 1001)
            self.assertEqual(self.docker.calls, [])
        finally:
            b.MAX_ARCHIVE = limit

    def test_cli_rejects_unterminated_input_with_deadline(self):
        child = subprocess.Popen(['/usr/sbin/runuser', '-u', 'suiba-deploy', '--', '/usr/bin/sudo', '-n', '/usr/local/sbin/suiba-deploy'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            # Keep stdin open. Production must not wait forever for EOF.
            self.assertEqual(child.wait(timeout=8), 1)
        finally:
            child.stdin.close()
            child.stdout.close()
            child.stderr.close()

    def test_symlink_parent_and_writable_policy_rejected(self):
        original = self.policy/'compose.yaml'
        original.rename(self.policy/'real')
        original.symlink_to(self.policy/'real')
        with self.assertRaises(Exception):
            self.broker.execute(self.req, 1001)
        original.unlink()
        (self.policy/'real').rename(original)
        os.chmod(self.policy, 0o777)
        with self.assertRaises(Exception):
            self.broker.execute(self.req, 1001)

    def test_counterfeit_compose_hash_rejected(self):
        (self.policy/'compose.yaml').write_text('services: {bot: {privileged: true}}')
        with self.assertRaises(b.Rejected):
            self.broker.execute(self.req, 1001)
        self.assertEqual(self.docker.calls, [])

    def test_rendered_compose_privilege_and_mount_injection_rejected(self):
        defaults = model()
        defaults['services']['bot'].update(command=None, entrypoint=None)
        b.validate_model(defaults, IMAGE)
        for key, value in [('privileged', True), ('command', ['sh']), ('entrypoint', ['sh']), ('build', '.')]:
            candidate = model()
            candidate['services']['bot'][key] = value
            with self.subTest(key=key), self.assertRaises(b.Rejected):
                b.validate_model(candidate, IMAGE)
        for key, value in [('MODE', 'LIVE'), ('NODE_OPTIONS', '--require /evil')]:
            candidate = model()
            candidate['services']['bot']['environment'][key] = value
            with self.assertRaises(b.Rejected):
                b.validate_model(candidate, IMAGE)
        candidate = model()
        candidate['services']['bot']['volumes'][0]['source'] = '/var/run/docker.sock'
        with self.assertRaises(b.Rejected):
            b.validate_model(candidate, IMAGE)

    def test_failure_after_gate_disables_restart_stops_and_never_starts(self):
        for stage in ['maintenance', 'backup', 'create', 'oom', 'timeout']:
            with self.subTest(stage=stage):
                # Independent admission/receipt for each injected failure.
                for p in ['ledger.json', 'attempt.json']:
                    (self.state/p).unlink(missing_ok=True)
                self.docker = FakeDocker()
                self.docker.failure = stage
                self.broker.docker = self.docker
                with self.assertRaises(Exception):
                    self.broker.execute(self.req, 1001)
                ledger = json.loads((self.state/'ledger.json').read_text())
                self.assertEqual(ledger['status'], 'failed_stopped')
                evidence = json.loads((self.state/ledger['transaction']/'failure.json').read_text())
                self.assertEqual(ledger['failure'], evidence)
                self.assertEqual(evidence['stage'], {'maintenance': 'maintenance', 'backup': 'backup',
                    'create': 'create-container', 'oom': 'verify-stopped', 'timeout': 'verify-stopped'}[stage])
                self.assertEqual(stat.S_IMODE((self.state/ledger['transaction']/'failure.json').stat().st_mode), 0o600)
                self.assertTrue(any(a[0] == 'update' and '--restart=no' in a for a in self.docker.calls))
                self.assertTrue(any(a[0] == 'stop' for a in self.docker.calls))
                if stage != 'create':
                    self.assertFalse(any(a[0] == 'compose' and 'create' in a for a in self.docker.calls))

    def test_diagnostic_write_failure_still_attempts_safe_stop(self):
        original = b.atomic
        def atomic(path, value):
            if path.name == 'failure.json':
                raise OSError('secret-storage-details')
            return original(path, value)
        self.docker.failure = 'maintenance'
        with patch.object(b, 'atomic', side_effect=atomic), self.assertRaises(b.Rejected):
            self.broker.execute(self.req, 1001)
        ledger = json.loads((self.state/'ledger.json').read_text())
        self.assertEqual(ledger['status'], 'failed_stopped')
        self.assertEqual(ledger['failure']['stage'], 'maintenance')
        self.assertTrue(any(args[0] == 'stop' for args in self.docker.calls))
        self.assertNotIn('secret-storage-details', json.dumps(ledger))

    def test_unknown_stop_keeps_unknown_status_and_original_failure(self):
        original = self.docker.call
        def call(args, **kwargs):
            if args[0] == 'run' and args[-1] == 'verify':
                raise b.Rejected('DOCKER_OPERATION_FAILED')
            if args[0] == 'update':
                raise b.Rejected('secret-cleanup-error')
            return original(args, **kwargs)
        self.docker.call = call
        with self.assertRaises(b.Rejected): self.broker.execute(self.req, 1001)
        ledger = json.loads((self.state/'ledger.json').read_text())
        self.assertEqual(ledger['status'], 'failed_state_unknown')
        self.assertEqual(ledger['failure']['stage'], 'verify-databases')
        self.assertEqual(ledger['failure']['code'], 'DOCKER_OPERATION_FAILED')
        with self.assertRaises(b.Rejected): self.broker.execute(self.req, 1001)

    def test_replay_rejected_without_docker_calls(self):
        self.broker.execute(self.req, 1001)
        self.docker.calls.clear()
        with self.assertRaises(b.Rejected):
            self.broker.execute(self.req, 1001)
        self.assertEqual(self.docker.calls, [])

    def use_ci_policy(self):
        compose = (self.policy/'compose.yaml').read_bytes()
        (self.policy/'policy.json').write_text(json.dumps(
            {'helper_image': HELPER, 'compose_sha256': hashlib.sha256(compose).hexdigest(),
             'approval_source': 'ci'}))
        return {'operation': 'deploy', 'sha': SHA,
                'archive_sha256': hashlib.sha256(b'approved-archive').hexdigest(),
                'image_id': IMAGE, 'ci_run': 456}

    def test_ci_approval_success_derives_sequence_and_records_run(self):
        req = self.use_ci_policy()
        result = self.broker.execute(req, 1001)
        self.assertEqual(result['status'], 'prepared_stopped')
        ledger = json.loads((self.state/'ledger.json').read_text())
        self.assertEqual(ledger['sequence'], 1)
        self.assertEqual(ledger['ci_run'], 456)
        self.assertEqual(ledger['status'], 'prepared_stopped')

    def test_ci_approval_replay_and_older_run_rejected_newer_run_proceeds(self):
        req = self.use_ci_policy()
        self.broker.execute(req, 1001)
        self.docker.calls.clear()
        for stale in (456, 455):
            with self.subTest(ci_run=stale), self.assertRaisesRegex(b.Rejected, 'REPLAY_OR_OLD_RELEASE'):
                self.broker.execute({**req, 'ci_run': stale}, 1001)
        self.assertEqual(self.docker.calls, [])
        (self.state/'attempt.json').unlink()
        result = self.broker.execute({**req, 'ci_run': 457}, 1001)
        self.assertEqual(result['status'], 'prepared_stopped')
        self.assertEqual(result['sequence'], 2)
        self.assertEqual(result['ci_run'], 457)

    def test_ci_approval_wrong_archive_digest_never_mutates(self):
        req = self.use_ci_policy()
        with self.assertRaisesRegex(b.Rejected, 'ARCHIVE_DIGEST'):
            self.broker.execute({**req, 'archive_sha256': '0'*64}, 1001)
        for a in self.docker.calls:
            self.assertNotIn(a[0], ('load', 'run'))
            self.assertNotIn('create', a)
            self.assertNotIn('stop', a)
        self.assertFalse((self.state/'ledger.json').exists())

    def test_ci_fields_rejected_in_file_mode(self):
        req = {'operation': 'deploy', 'sha': SHA,
               'archive_sha256': hashlib.sha256(b'approved-archive').hexdigest(),
               'image_id': IMAGE, 'ci_run': 456}
        with self.assertRaisesRegex(b.Rejected, 'REQUEST_SCHEMA'):
            self.broker.execute(req, 1001)
        self.assertEqual(self.docker.calls, [])
        self.assertFalse((self.state/'ledger.json').exists())

    def test_ci_mode_requires_ci_fields(self):
        self.use_ci_policy()
        with self.assertRaisesRegex(b.Rejected, 'CI_APPROVAL_REQUIRED'):
            self.broker.execute(self.req, 1001)
        self.assertEqual(self.docker.calls, [])

    def test_request_accepts_ci_shape_and_rejects_partial_or_bad_digests(self):
        req = {'operation': 'deploy', 'sha': SHA,
               'archive_sha256': hashlib.sha256(b'approved-archive').hexdigest(),
               'image_id': IMAGE, 'ci_run': 456}
        self.assertEqual(b.request(json.dumps(req).encode()), req)
        for bad in [{k: v for k, v in req.items() if k != 'ci_run'},
                    {**req, 'archive_sha256': 'zz'},
                    {**req, 'image_id': 'suiba:latest'},
                    {**req, 'ci_run': 0},
                    {**req, 'ci_run': '456'}]:
            with self.subTest(bad=bad), self.assertRaises(Exception):
                b.request(json.dumps(bad).encode())

    def test_rollback_requires_explicit_new_approval(self):
        self.req['operation'] = 'rollback'
        with self.assertRaises(b.Rejected):
            self.broker.execute(self.req, 1001)
        self.approval['operation'] = 'rollback'
        self.save_approval()
        self.assertEqual(self.broker.execute(self.req, 1001)['operation'], 'rollback')

    def test_ssh_user_cannot_write_policy_or_use_arbitrary_sudo(self):
        result = subprocess.run(['/usr/sbin/runuser', '-u', 'suiba-deploy', '--', '/usr/bin/sudo', '-n', '/usr/bin/id'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        result = subprocess.run(['/usr/sbin/runuser', '-u', 'suiba-deploy', '--', '/usr/bin/sudo', '-n', 'LD_PRELOAD=/tmp/evil', '/usr/local/sbin/suiba-deploy'], input=b'{}', capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        result = subprocess.run(['/usr/sbin/runuser', '-u', 'suiba-deploy', '--', '/usr/bin/sudo', '-n', '/usr/local/sbin/suiba-deploy', '--help'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        result = subprocess.run(['/usr/sbin/runuser', '-u', 'suiba-deploy', '--', '/usr/bin/sudo', '-n', '/usr/local/sbin/suiba-deploy'], input=b'{}', capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'SUIBA_BROKER_REJECTED', result.stderr)
        result = subprocess.run(['/usr/sbin/runuser', '-u', 'suiba-deploy', '--', '/usr/bin/test', '-w', str(self.policy)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)


class ArchiveIdentityTests(unittest.TestCase):
    def fixture(self, root, oci=True, corrupt=None):
        config = {'os': 'linux', 'architecture': 'amd64', 'config': {'User': 'node', 'Env': ['MODE=PAPER'], 'Labels': {'org.opencontainers.image.revision': SHA}}, 'rootfs': {'type': 'layers', 'diff_ids': []}}
        raw = json.dumps(config).encode()
        cid = 'sha256:'+hashlib.sha256(raw).hexdigest()
        name = 'blobs/sha256/'+cid[7:] if oci else cid[7:]+'.json'
        objects = {name: raw, 'manifest.json': json.dumps([{'Config': name, 'Layers': [], 'RepoTags': ['suiba:'+SHA]}]).encode()}
        descriptors = {}
        if oci:
            manifest = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'config': {'mediaType': 'application/vnd.oci.image.config.v1+json', 'digest': cid, 'size': len(raw)}, 'layers': []}
            if corrupt == 'config_reference':
                manifest['config']['digest'] = IMAGE
            mr = json.dumps(manifest).encode()
            mid = 'sha256:'+hashlib.sha256(mr).hexdigest()
            descriptor = {'mediaType': manifest['mediaType'], 'digest': mid, 'size': len(mr)}
            objects['blobs/sha256/'+mid[7:]] = mr
            objects['index.json'] = json.dumps({'schemaVersion': 2, 'manifests': [descriptor]}).encode()
            objects['oci-layout'] = b'{"imageLayoutVersion":"1.0.0"}'
            descriptors[mid] = descriptor
        if corrupt == 'blob':
            objects[name] += b' '
        if corrupt == 'duplicate_image':
            objects['manifest.json'] = json.dumps([{'Config': name, 'Layers': []}]*2).encode()
        path = Path(root)/'test.tar.gz'
        with tarfile.open(path, 'w:gz') as t:
            for n, data in objects.items():
                m = tarfile.TarInfo(n); m.size = len(data)
                t.addfile(m, io.BytesIO(data))
        return path, cid, descriptors

    def test_classic_and_containerd_identity(self):
        for oci in (False, True):
            with tempfile.TemporaryDirectory() as root:
                path, cid, manifests = self.fixture(root, oci)
                self.assertEqual(b.archive_identity(path, cid, SHA), (cid, manifests))
                identity = {'Id': cid, 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'User': 'node', 'Env': ['MODE=PAPER'], 'Labels': {'org.opencontainers.image.revision': SHA}}}
                self.assertEqual(b.loaded_identity(identity, cid, manifests, SHA), cid)
                for mid, desc in manifests.items():
                    self.assertEqual(b.archive_identity(path, mid, SHA), (cid, manifests))
                    identity.update(Id=mid, Descriptor=desc)
                    self.assertEqual(b.loaded_identity(identity, cid, manifests, SHA), mid)

    def test_tampered_archive_manifest_and_config_rejected(self):
        for corrupt in ('blob', 'config_reference', 'duplicate_image'):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as root:
                path, cid, _ = self.fixture(root, corrupt=corrupt)
                with self.assertRaises(Exception):
                    b.archive_identity(path, cid, SHA)

    def test_wrong_approval_revision_and_docker_response_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path, cid, manifests = self.fixture(root)
            for approved, sha in ((IMAGE, SHA), (cid, 'f'*40)):
                with self.assertRaises(Exception):
                    b.archive_identity(path, approved, sha)
            mid = next(iter(manifests))
            for identity in ({'Id': IMAGE}, {'Id': mid, 'Descriptor': {}}, {'Id': cid, 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'User': 'root'}}):
                with self.assertRaises(Exception):
                    b.loaded_identity(identity, cid, manifests, SHA)


class VerifyTests(unittest.TestCase):
    """The read-only verify operation: the deploy's pre-mutation
    host checks, with no approval, no writes and no Docker
    mutation — a diagnosis, never a deployment."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='suiba-broker-verify-', dir='/var/lib')
        self.root = Path(self.temp.name)
        self.policy, self.state, self.backups = [self.root/x for x in ['policy', 'state', 'backups']]
        for p in [self.policy, self.state, self.backups, self.policy/'docker', self.policy/'approvals']:
            p.mkdir(mode=0o700, parents=True)
        compose = b'root-reviewed-compose-fixture'
        (self.policy/'compose.yaml').write_bytes(compose)
        (self.policy/'policy.json').write_text(json.dumps(
            {'helper_image': HELPER, 'compose_sha256': hashlib.sha256(compose).hexdigest(),
             'approval_source': 'ci'}))
        # The broker's trusted-file checks reject group/other
        # writable files; pin modes explicitly (a permissive
        # umask would otherwise make the fixtures 0o660).
        os.chmod(self.policy/'compose.yaml', 0o600)
        os.chmod(self.policy/'policy.json', 0o600)
        shared = self.root/'shared'
        shared.mkdir(mode=0o700)
        runtime = shared/'runtime.env'
        runtime.write_text('MODE=PAPER\n')
        os.chmod(runtime, 0o600)
        token = shared/'admin-token'
        token.write_bytes(b'a'*64)
        os.chown(token, 1000, 1000)
        os.chmod(token, 0o400)
        self.runtime_patch = patch.object(b, 'RUNTIME', str(runtime))
        self.token_patch = patch.object(b, 'TOKEN', str(token))
        self.runtime_patch.start()
        self.token_patch.start()
        self.docker = FakeDocker()
        self.broker = b.Broker(self.policy, self.state, self.root/'incoming', self.backups, self.docker)
        self.req = {'operation': 'verify'}

    def tearDown(self):
        self.runtime_patch.stop()
        self.token_patch.stop()
        self.temp.cleanup()

    def test_verify_reports_every_check_ok(self):
        result = self.broker.execute(self.req, 1001)
        self.assertEqual(result, {'status': 'verified', 'operation': 'verify',
                                  'checks': {'policy': True, 'compose_digest': True,
                                             'runtime_env': True, 'admin_token': True,
                                             'volumes': True, 'helper_image': True}})

    def test_verify_fails_on_missing_volume_with_deploy_code(self):
        original = self.docker.call
        def call(args, **kwargs):
            if args[:2] == ['volume', 'inspect']:
                raise b.Rejected('DOCKER_OPERATION_FAILED')
            return original(args, **kwargs)
        self.docker.call = call
        with self.assertRaisesRegex(b.Rejected, 'DOCKER_OPERATION_FAILED'):
            self.broker.execute(self.req, 1001)
        # The volume check precedes the helper-image check, and a
        # failed diagnosis leaves no deploy bookkeeping behind.
        self.assertFalse(any(a[:2] == ['image', 'inspect'] for a in self.docker.calls))
        self.assertFalse((self.state/'ledger.json').exists())
        self.assertFalse((self.state/'attempt.json').exists())

    def test_verify_rejects_short_admin_token(self):
        token = Path(b.TOKEN)
        os.chmod(token, 0o600)
        token.write_bytes(b'a'*16)
        os.chmod(token, 0o400)
        with self.assertRaisesRegex(b.Rejected, 'SECRET_MODE'):
            self.broker.execute(self.req, 1001)
        self.assertEqual(self.docker.calls, [])

    def test_verify_performs_no_mutation(self):
        self.broker.execute(self.req, 1001)
        # Only execute()'s own lock file may appear in state: no
        # ledger, no attempt record, no transaction directory.
        self.assertEqual({p.name for p in self.state.iterdir()}, {'lock'})
        self.assertEqual(list(self.backups.iterdir()), [])
        self.assertIsNone(self.broker.model)
        self.assertTrue(self.docker.calls)
        for args in self.docker.calls:
            self.assertIn(args[0], ('volume', 'image'))
            self.assertEqual(args[1], 'inspect')

    def test_request_shape_for_verify(self):
        self.assertEqual(b.request(b'{"operation":"verify"}'), {'operation': 'verify'})
        for raw in [b'{"operation":"verify","sha":"'+SHA.encode()+b'"}',
                    b'{"operation":"verify","ci_run":1}',
                    b'{"operation":"verify","operation":"deploy"}']:
            with self.subTest(raw=raw), self.assertRaises(Exception):
                b.request(raw)


class PublicResultTests(unittest.TestCase):
    """The deploy-user-readable outcome mirror: whitelisted
    fields only, world-readable, and never fatal."""

    def publish(self, root, status, code, sha):
        target = Path(root) / 'last-deploy.json'
        with unittest.mock.patch.object(b, 'PUBLIC_RESULT', target):
            b.publish_public_result(status, code, sha)
        return target

    def test_writes_whitelisted_failure_and_success(self):
        with tempfile.TemporaryDirectory() as root:
            target = self.publish(root, 'failed', 'SECRET_MODE', SHA)
            value = json.loads(target.read_text())
            self.assertEqual(value['status'], 'failed')
            self.assertEqual(value['code'], 'SECRET_MODE')
            self.assertEqual(value['sha'], SHA)
            self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o644)
            target = self.publish(root, 'prepared_stopped', None, SHA)
            value = json.loads(target.read_text())
            self.assertEqual(value['status'], 'prepared_stopped')
            self.assertIsNone(value['code'])

    def test_drops_unlisted_values(self):
        with tempfile.TemporaryDirectory() as root:
            target = self.publish(root, 'failed', 'leak: /root/secret', 'not-a-sha')
            value = json.loads(target.read_text())
            self.assertIsNone(value['code'])
            self.assertIsNone(value['sha'])
            # An unlisted status is never published at all.
            target.unlink()
            self.publish(root, 'running', None, SHA)
            self.assertFalse(target.exists())

    def test_failure_code_selection(self):
        self.assertEqual(b.public_failure_code(b.Rejected('COMPOSE_DIGEST')), 'COMPOSE_DIGEST')
        self.assertEqual(b.public_failure_code(b.Rejected('surprise text')), 'UNEXPECTED_REJECTION')
        self.assertEqual(b.public_failure_code(OSError('x')), 'OS_ERROR')
        self.assertEqual(b.public_failure_code(ValueError('x')), 'UNEXPECTED_EXCEPTION')

    def test_publish_never_raises(self):
        with tempfile.TemporaryDirectory() as root:
            missing = Path(root) / 'no-such-dir' / 'last-deploy.json'
            with unittest.mock.patch.object(b, 'PUBLIC_RESULT', missing):
                b.publish_public_result('failed', 'OS_ERROR', SHA)  # must not raise


class ProgramReadTests(unittest.TestCase):
    def test_broker_fits_its_self_read_maximum(self):
        # main() reads this file whole through read_trusted before
        # dispatching anything. The 64 KiB default fits state
        # files only; the maximum is explicit so a future size
        # increase cannot refuse every broker operation on the
        # host the way it did for the paper-check controller.
        source = Path(b.__file__).read_bytes()
        self.assertLess(len(source), 262144)
        self.assertIn('read_trusted(Path(__file__), maximum=262144)', source.decode())


if __name__ == '__main__':
    unittest.main(verbosity=2)
