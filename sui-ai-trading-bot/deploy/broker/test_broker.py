import copy
import io
import tarfile
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
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
                self.assertTrue(any(a[0] == 'update' and '--restart=no' in a for a in self.docker.calls))
                self.assertTrue(any(a[0] == 'stop' for a in self.docker.calls))
                if stage != 'create':
                    self.assertFalse(any(a[0] == 'compose' and 'create' in a for a in self.docker.calls))

    def test_replay_rejected_without_docker_calls(self):
        self.broker.execute(self.req, 1001)
        self.docker.calls.clear()
        with self.assertRaises(b.Rejected):
            self.broker.execute(self.req, 1001)
        self.assertEqual(self.docker.calls, [])

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


if __name__ == '__main__':
    unittest.main(verbosity=2)
