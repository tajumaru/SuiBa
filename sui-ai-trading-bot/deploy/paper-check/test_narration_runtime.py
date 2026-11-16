#!/usr/bin/env python3
"""Offline narration helper and approval/SSH route regressions."""
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
spec = importlib.util.spec_from_file_location('narration_runtime', HERE/'narration-runtime.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class NarrationRuntimeTests(unittest.TestCase):
    def value(self):
        return {'SUIBA_NARRATION_GENERATION_ENABLED': 'false'}

    def test_payload_is_exact_bounded_and_validated(self):
        self.assertEqual(helper.payload(json.dumps(self.value())), self.value())
        invalid = ({}, [], {**self.value(), 'OTHER': 'x'},
                   {'SUIBA_NARRATION_GENERATION_ENABLED': 'TRUE'},
                   {'SUIBA_NARRATION_GENERATION_ENABLED': True})
        for value in invalid:
            with self.assertRaises((ValueError, TypeError)):
                helper.payload(json.dumps(value))
        for raw in ('{"SUIBA_NARRATION_GENERATION_ENABLED":"false","SUIBA_NARRATION_GENERATION_ENABLED":"true"}',
                    'x' * 8193):
            with self.assertRaises((ValueError, TypeError)):
                helper.payload(raw)

    def test_updates_only_owned_line_and_fails_while_lock_is_held(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            runtime, lock = root/'runtime.env', root/'lock'
            original = (b'# retained\r\nOTHER=value\r\nSUIBA_NARRATION_GENERATION_ENABLED=true\n'
                        b'SUIBA_NARRATION_GENERATION_ENABLED_SUFFIX=untouched\n')
            runtime.write_bytes(original)
            lock.touch()
            for path in (runtime, lock):
                path.chmod(0o600)
            with patch.object(helper, 'trusted_parents'), \
                 patch.object(helper, 'checked_file', side_effect=os.fstat):
                helper.update(self.value(), runtime, lock)
                self.assertEqual(
                    runtime.read_bytes(),
                    b'# retained\r\nOTHER=value\r\nSUIBA_NARRATION_GENERATION_ENABLED=false\n'
                    b'SUIBA_NARRATION_GENERATION_ENABLED_SUFFIX=untouched\n')
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
                for content in (b'SUIBA_NARRATION_GENERATION_ENABLED=false\nSUIBA_NARRATION_GENERATION_ENABLED=true\n',
                                b'export SUIBA_NARRATION_GENERATION_ENABLED=false\n',
                                b'OTHER=unterminated'):
                    runtime.write_bytes(content)
                    runtime.chmod(0o600)
                    with self.assertRaises(ValueError):
                        helper.update(self.value(), runtime, lock)
                    self.assertEqual(runtime.read_bytes(), content)

    def test_errors_and_success_never_echo_input(self):
        for error in (None, ValueError('false')):
            stdin = io.TextIOWrapper(io.BytesIO(json.dumps(self.value()).encode()))
            with patch.object(helper.os, 'geteuid', return_value=0), \
                 patch.object(helper.sys, 'argv', ['helper']), \
                 patch.object(helper.sys, 'stdin', stdin), \
                 patch.object(helper, 'update', side_effect=error), \
                 patch('sys.stdout', new_callable=io.StringIO) as out, \
                 patch('sys.stderr', new_callable=io.StringIO) as err:
                self.assertEqual(helper.main(), int(error is not None))
                self.assertNotIn('false', out.getvalue() + err.getvalue())

    def test_ssh_route_and_workflow_shape(self):
        app = HERE.parents[1]
        repo = app.parent
        workflow = (repo/'.github/workflows/suiba-narration-runtime.yml').read_text()
        for text in ("github.ref == 'refs/heads/main'",
                     "inputs.confirmation == 'UPDATE-NARRATION-RUNTIME'",
                     "vars.SUIBA_PROD_CONTROL_ENABLED == 'true'",
                     'environment: sakura-vps', 'group: suiba-production-control',
                     "default: 'false'", 'stopped window only'):
            self.assertIn(text, workflow)
        source = (app/'docker/ssh-narration-runtime.sh').read_text()
        self.assertIn("'sudo -n -- /usr/local/sbin/suiba-narration-runtime' >/dev/null 2>/dev/null", source)
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
value = json.load(sys.stdin)
assert value == {'SUIBA_NARRATION_GENERATION_ENABLED':os.environ['SUIBA_NARRATION_GENERATION_ENABLED']}
assert sys.argv[-1] == 'sudo -n -- /usr/local/sbin/suiba-narration-runtime'
sys.exit(int(os.environ['MOCK_EXIT']))
""")
            for path in fixture.iterdir():
                path.chmod(0o755)
            env = {**os.environ, 'PATH': str(fixture)+':'+os.environ['PATH'],
                   'RUNNER_TEMP': folder, 'VPS_HOST': 'offline.invalid', 'VPS_PORT': '22',
                   'VPS_USER': 'suiba-deploy', 'VPS_SSH_KEY': 'dummy',
                   'VPS_KNOWN_HOSTS': 'dummy',
                   'NARRATION_RUNTIME_CONFIRMATION': 'UPDATE-NARRATION-RUNTIME', **self.value()}
            for code in ('0', '1'):
                result = subprocess.run(['bash', str(app/'docker/ssh-narration-runtime.sh')],
                                        env={**env, 'MOCK_EXIT': code},
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, int(code))
                self.assertEqual(list(root.glob('suiba-narration-runtime.*')), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
