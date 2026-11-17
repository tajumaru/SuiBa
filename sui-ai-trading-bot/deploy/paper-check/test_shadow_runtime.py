"""Offline helper and approval/SSH route regressions; dummy values only."""
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
spec = importlib.util.spec_from_file_location('shadow_runtime', HERE/'shadow-runtime.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class ShadowRuntimeTests(unittest.TestCase):
    def value(self):
        return dict(zip(helper.KEYS, ('false', 'offline_dummy_value')))

    def test_payload_is_exact_bounded_and_injection_safe(self):
        self.assertEqual(helper.payload(json.dumps(self.value())), self.value())
        for raw in ('{}', '[]', '{"SUIBA_SHADOW_ENABLED":"false","SUIBA_SHADOW_ENABLED":"true"}',
                    'x'*8193, json.dumps({**self.value(), 'OTHER': 'x'})):
            with self.assertRaises((ValueError, TypeError)):
                helper.payload(raw)
        for field, values in ((helper.KEYS[0], (True, '', 'TRUE')),
                              (helper.KEYS[1], ('', 'x\nOTHER=x', '${OTHER}', 'x y', '"x"', 'x'*4097))):
            for value in values:
                with self.assertRaises(ValueError):
                    helper.payload(json.dumps({**self.value(), field: value}))

    def test_updates_preserve_other_lines_metadata_and_refuse_conflicts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            runtime, lock = root/'runtime.env', root/'lock'
            runtime.write_bytes(b'# retained\r\nOTHER=value\r\nSUIBA_SHADOW_ENABLED=true\nSUIBA_SHADOW_API_KEY=old_dummy\n')
            lock.touch()
            for path in (runtime, lock):
                path.chmod(0o600)
            before = runtime.stat()
            # Temp parent and uid are intentionally untrusted on a developer machine;
            # production ownership checks are tested separately below.
            with patch.object(helper, 'trusted_parents'), patch.object(helper, 'checked_file', side_effect=os.fstat):
                helper.update(self.value(), runtime, lock)
                self.assertEqual(runtime.read_bytes(), b'# retained\r\nOTHER=value\r\nSUIBA_SHADOW_ENABLED=false\nSUIBA_SHADOW_API_KEY=offline_dummy_value\n')
                self.assertEqual((runtime.stat().st_uid, runtime.stat().st_gid, runtime.stat().st_mode),
                                 (before.st_uid, before.st_gid, before.st_mode))
                with lock.open('rb') as peer:
                    fcntl.flock(peer, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    original = runtime.read_bytes()
                    with self.assertRaises(BlockingIOError):
                        helper.update(self.value(), runtime, lock)
                    self.assertEqual(runtime.read_bytes(), original)
                for content in (b'SUIBA_SHADOW_ENABLED=false\nSUIBA_SHADOW_ENABLED=true\n',
                                b'export SUIBA_SHADOW_API_KEY=old\n', b'OTHER=unterminated'):
                    runtime.write_bytes(content)
                    with self.assertRaises(ValueError):
                        helper.update(self.value(), runtime, lock)
                    self.assertEqual(runtime.read_bytes(), content)
                runtime.write_bytes(b'OTHER=value\n')
                helper.update(self.value(), runtime, lock)
                self.assertTrue(runtime.read_bytes().startswith(b'OTHER=value\n'))
                runtime.unlink()
                runtime.symlink_to(lock)
                with self.assertRaises(OSError):
                    helper.update(self.value(), runtime, lock)
            self.assertFalse(list(root.glob('.shadow-runtime-*')))

    def test_untrusted_file_and_parent_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'runtime.env'
            path.touch(mode=0o644)
            with path.open('rb') as source:
                with self.assertRaises(ValueError):
                    helper.checked_file(source.fileno())
            with self.assertRaises(ValueError):
                helper.trusted_parents(path)  # /tmp is writable by others

    def test_errors_and_success_never_echo_input(self):
        for error in (None, ValueError('offline_dummy_value')):
            with patch.object(helper.os, 'geteuid', return_value=0), patch.object(helper.sys, 'argv', ['helper']), \
                 patch.object(helper.sys, 'stdin', io.TextIOWrapper(io.BytesIO(json.dumps(self.value()).encode()))), \
                 patch.object(helper, 'update', side_effect=error), \
                 patch('sys.stdout', new_callable=io.StringIO) as out, patch('sys.stderr', new_callable=io.StringIO) as err:
                self.assertEqual(helper.main(), int(error is not None))
                self.assertNotIn('offline_dummy_value', out.getvalue()+err.getvalue())

    def test_ssh_route_sends_stdin_and_withholds_remote_output(self):
        app = HERE.parents[1]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fixture = root/'bin'
            fixture.mkdir()
            (fixture/'ssh-keygen').write_text('#!/bin/sh\nexit 0\n')
            (fixture/'ssh').write_text("""#!/usr/bin/python3
import json, os, sys
value = json.load(sys.stdin)
assert value == {k:os.environ[k] for k in ('SUIBA_SHADOW_ENABLED','SUIBA_SHADOW_API_KEY')}
assert sys.argv[-1] == 'sudo -n -- /usr/local/sbin/suiba-shadow-runtime'
print(value['SUIBA_SHADOW_API_KEY'])
print(value['SUIBA_SHADOW_API_KEY'], file=sys.stderr)
sys.exit(int(os.environ['MOCK_EXIT']))
""")
            for path in fixture.iterdir():
                path.chmod(0o755)
            env = {**os.environ, 'PATH': str(fixture)+':'+os.environ['PATH'],
                   'RUNNER_TEMP': folder, 'VPS_HOST': 'offline.invalid', 'VPS_PORT': '22',
                   'VPS_USER': 'suiba-deploy', 'VPS_SSH_KEY': 'dummy', 'VPS_KNOWN_HOSTS': 'dummy',
                   'SHADOW_RUNTIME_CONFIRMATION': 'UPDATE-SHADOW-RUNTIME', **self.value()}
            for code in ('0', '1'):
                result = subprocess.run(['bash', str(app/'docker/ssh-shadow-runtime.sh')],
                                        env={**env, 'MOCK_EXIT': code}, capture_output=True, text=True)
                self.assertEqual(result.returncode, int(code))
                self.assertNotIn('offline_dummy_value', result.stdout+result.stderr)
                self.assertEqual(list(root.glob('suiba-shadow-runtime.*')), [])
            result = subprocess.run(['bash', str(app/'docker/ssh-shadow-runtime.sh')],
                                    env={**env, 'SHADOW_RUNTIME_CONFIRMATION': 'wrong'},
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)

    def test_installer_pins_and_approval_route(self):
        app = HERE.parents[1]
        repo = app.parent
        workflow = (repo/'.github/workflows/suiba-shadow-runtime.yml').read_text()
        for text in ("github.ref == 'refs/heads/main'", "inputs.confirmation == 'UPDATE-SHADOW-RUNTIME'",
                     "vars.SUIBA_PROD_CONTROL_ENABLED == 'true'", 'environment: sakura-vps',
                     'group: suiba-production-control', "default: 'false'", '${{ secrets.SUIBA_SHADOW_API_KEY }}'):
            self.assertIn(text, workflow)
        source = (app/'docker/ssh-shadow-runtime.sh').read_text()
        self.assertIn("'sudo -n -- /usr/local/sbin/suiba-shadow-runtime' >/dev/null 2>/dev/null", source)
        self.assertNotIn('GITHUB_OUTPUT', source)
        self.assertNotIn('GITHUB_STEP_SUMMARY', source)
        self.assertIn('set +x', source)
        setup = (HERE.parent/'broker/setup-ci-approval.sh').read_text()
        want = setup.split('for want in ', 1)[1].split(';', 1)[0]
        for key in helper.KEYS:
            self.assertIn(key, want)
            self.assertIn('|'+key, setup)
        template = setup.split("else\n  printf '%s\\n'", 1)[1].split('fi', 1)[0]
        self.assertNotIn('SUIBA_SHADOW', template)


if __name__ == '__main__':
    unittest.main(verbosity=2)
