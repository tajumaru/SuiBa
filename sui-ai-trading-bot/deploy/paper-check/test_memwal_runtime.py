#!/usr/bin/env python3
"""Offline MemWAL helper and approval/SSH route regressions; dummy values only."""
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('memwal_runtime', HERE/'memwal-runtime.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class MemwalRuntimeTests(unittest.TestCase):
    def value(self):
        return {
            'SUIBA_MEMWAL_ENABLED': 'false',
            'MEMWAL_PRIVATE_KEY': 'a' * 64,
            'MEMWAL_ACCOUNT_ID': '0x' + 'b' * 64,
            'MEMWAL_RELAYER_URL': 'https://relayer.memory.walrus.xyz',
            'MEMWAL_NAMESPACE': 'offline-test',
        }

    def test_payload_is_exact_bounded_and_validated(self):
        self.assertEqual(helper.payload(json.dumps(self.value())), self.value())
        valid = {**self.value(), 'MEMWAL_PRIVATE_KEY': 'suiprivkey1' + 'q' * 59}
        self.assertEqual(helper.payload(json.dumps(valid)), valid)
        invalid = (
            {}, [], {**self.value(), 'OTHER': 'x'},
            {**self.value(), 'SUIBA_MEMWAL_ENABLED': 'TRUE'},
            {**self.value(), 'MEMWAL_PRIVATE_KEY': 'not-a-key'},
            {**self.value(), 'MEMWAL_ACCOUNT_ID': '0x1234'},
            {**self.value(), 'MEMWAL_RELAYER_URL': 'https://example.invalid'},
            {**self.value(), 'MEMWAL_NAMESPACE': 'UPPER'},
            {**self.value(), 'MEMWAL_NAMESPACE': 'x' * 33},
        )
        for value in invalid:
            with self.assertRaises((ValueError, TypeError)):
                helper.payload(json.dumps(value))
        duplicate = json.dumps(self.value())[:-1] + ',"MEMWAL_NAMESPACE":"other"}'
        for raw in (duplicate, 'x' * 8193):
            with self.assertRaises((ValueError, TypeError)):
                helper.payload(raw)

    def test_updates_only_owned_lines_and_fails_while_lock_is_held(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            runtime, lock = root/'runtime.env', root/'lock'
            original = (b'# retained\r\nOTHER=value\r\nMEMWALISH=untouched\n'
                        b'SUIBA_MEMWAL_ENABLED=true\nMEMWAL_PRIVATE_KEY=' + b'c' * 64 + b'\n'
                        b'MEMWAL_ACCOUNT_ID=0x' + b'd' * 64 + b'\n'
                        b'MEMWAL_RELAYER_URL=https://relayer.memory.walrus.xyz\n'
                        b'MEMWAL_NAMESPACE=old\n')
            runtime.write_bytes(original)
            lock.touch()
            for path in (runtime, lock):
                path.chmod(0o600)
            with patch.object(helper, 'trusted_parents'), \
                 patch.object(helper, 'checked_file', side_effect=os.fstat):
                helper.update(self.value(), runtime, lock)
                result = runtime.read_bytes()
                self.assertIn(b'# retained\r\nOTHER=value\r\nMEMWALISH=untouched\n', result)
                for key, value in self.value().items():
                    self.assertIn((key + '=' + value + '\n').encode(), result)
                with lock.open('rb') as supervisor:
                    fcntl.flock(supervisor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    before = runtime.read_bytes()
                    with self.assertRaises(BlockingIOError):
                        helper.update(self.value(), runtime, lock)
                    self.assertEqual(runtime.read_bytes(), before)

    def test_invalid_or_ambiguous_files_are_not_rewritten(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            runtime, lock = root/'runtime.env', root/'lock'
            lock.touch(mode=0o600)
            with patch.object(helper, 'trusted_parents'), \
                 patch.object(helper, 'checked_file', side_effect=os.fstat):
                for content in (b'MEMWAL_NAMESPACE=a\nMEMWAL_NAMESPACE=b\n',
                                b'export MEMWAL_PRIVATE_KEY=old\n',
                                b'OTHER=unterminated'):
                    runtime.write_bytes(content)
                    runtime.chmod(0o600)
                    with self.assertRaises(ValueError):
                        helper.update(self.value(), runtime, lock)
                    self.assertEqual(runtime.read_bytes(), content)

    def test_errors_and_success_never_echo_secret(self):
        secret = self.value()['MEMWAL_PRIVATE_KEY']
        for error in (None, ValueError(secret)):
            stdin = io.TextIOWrapper(io.BytesIO(json.dumps(self.value()).encode()))
            with patch.object(helper.os, 'geteuid', return_value=0), \
                 patch.object(helper.sys, 'argv', ['helper']), \
                 patch.object(helper.sys, 'stdin', stdin), \
                 patch.object(helper, 'update', side_effect=error), \
                 patch('sys.stdout', new_callable=io.StringIO) as out, \
                 patch('sys.stderr', new_callable=io.StringIO) as err:
                self.assertEqual(helper.main(), int(error is not None))
                self.assertNotIn(secret, out.getvalue() + err.getvalue())

    def test_ssh_route_and_workflow_shape(self):
        app = HERE.parents[1]
        repo = app.parent
        workflow = (repo/'.github/workflows/suiba-memwal-runtime.yml').read_text()
        for text in ("github.ref == 'refs/heads/main'",
                     "inputs.confirmation == 'UPDATE-MEMWAL-RUNTIME'",
                     "vars.SUIBA_PROD_CONTROL_ENABLED == 'true'",
                     'environment: sakura-vps', 'group: suiba-production-control',
                     '${{ secrets.SUIBA_MEMWAL_PRIVATE_KEY }}',
                     'https://relayer.memory.walrus.xyz', 'MEMWAL_NAMESPACE: potario'):
            self.assertIn(text, workflow)
        source = (app/'docker/ssh-memwal-runtime.sh').read_text()
        self.assertIn("'sudo -n -- /usr/local/sbin/suiba-memwal-runtime' >/dev/null 2>/dev/null", source)
        self.assertIn('set +x', source)
        self.assertNotIn('GITHUB_OUTPUT', source)
        self.assertNotIn('GITHUB_STEP_SUMMARY', source)

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fixture = root/'bin'
            fixture.mkdir()
            (fixture/'ssh-keygen').write_text('#!/bin/sh\nexit 0\n')
            (fixture/'ssh').write_text("""#!/usr/bin/python3
import json, os, sys
keys = ('SUIBA_MEMWAL_ENABLED','MEMWAL_PRIVATE_KEY','MEMWAL_ACCOUNT_ID','MEMWAL_RELAYER_URL','MEMWAL_NAMESPACE')
value = json.load(sys.stdin)
assert value == {key:os.environ[key] for key in keys}
assert sys.argv[-1] == 'sudo -n -- /usr/local/sbin/suiba-memwal-runtime'
print(value['MEMWAL_PRIVATE_KEY'])
print(value['MEMWAL_PRIVATE_KEY'], file=sys.stderr)
sys.exit(int(os.environ['MOCK_EXIT']))
""")
            for path in fixture.iterdir():
                path.chmod(0o755)
            env = {**os.environ, 'PATH': str(fixture)+':'+os.environ['PATH'],
                   'RUNNER_TEMP': folder, 'VPS_HOST': 'offline.invalid', 'VPS_PORT': '22',
                   'VPS_USER': 'suiba-deploy', 'VPS_SSH_KEY': 'dummy',
                   'VPS_KNOWN_HOSTS': 'dummy',
                   'MEMWAL_RUNTIME_CONFIRMATION': 'UPDATE-MEMWAL-RUNTIME', **self.value()}
            for code in ('0', '1'):
                result = subprocess.run(['bash', str(app/'docker/ssh-memwal-runtime.sh')],
                                        env={**env, 'MOCK_EXIT': code},
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, int(code))
                self.assertNotIn(self.value()['MEMWAL_PRIVATE_KEY'], result.stdout+result.stderr)
                self.assertEqual(list(root.glob('suiba-memwal-runtime.*')), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
