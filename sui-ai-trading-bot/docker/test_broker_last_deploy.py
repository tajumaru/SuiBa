"""Offline contracts for the broker public-result reader; no SSH or writes."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent
SHA = 'a' * 40
AT = 1794000000


def mirror(**overrides):
    base = {'version': 1, 'status': 'failed',
            'code': 'PAPER_CHECK_RECONCILIATION_REQUIRED', 'sha': SHA, 'at': AT}
    base.update(overrides)
    return json.dumps(base)


@unittest.skipIf(os.name == 'nt', 'mocked Bash SSH pipeline runs on Linux')
class SshTests(unittest.TestCase):
    def run_script(self, mirror_text=None, ssh_exit=0, user='suiba-deploy'):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'bin').mkdir(); (root/'runner').mkdir()
            if mirror_text is not None:
                (root/'mirror').write_text(mirror_text)
            (root/'calls').write_text('')
            (root/'bin/ssh-keygen').write_text('#!/bin/sh\nprintf "SECRET_FIXTURE_KEY_OUTPUT"\n')
            (root/'bin/ssh').write_text('''#!/usr/bin/python3
import os,sys
command=sys.argv[-1]
with open(os.environ['MOCK_CALLS'],'a') as out: out.write(command+'\\n')
sys.stderr.write('SECRET_FIXTURE_SSH_ERROR')
if command!='cat /opt/suiba/last-deploy.json':
    sys.exit(77)
exit_code=int(os.environ['MOCK_SSH_EXIT'])
if exit_code!=0:
    sys.exit(exit_code)
mirror=os.environ.get('MOCK_MIRROR','')
if not mirror or not os.path.exists(mirror):
    sys.exit(1)
sys.stdout.write(open(mirror).read())
''')
            for command in (root/'bin').iterdir(): command.chmod(0o755)
            env = {**os.environ, 'PATH': str(root/'bin')+':'+os.environ['PATH'], 'RUNNER_TEMP': str(root/'runner'),
                   'VPS_HOST': 'fixture.invalid', 'VPS_USER': user, 'VPS_PORT': '22',
                   'VPS_SSH_KEY': 'SECRET_FIXTURE_PRIVATE_KEY', 'VPS_KNOWN_HOSTS': 'SECRET_FIXTURE_HOSTS',
                   'MOCK_CALLS': str(root/'calls'),
                   'MOCK_MIRROR': str(root/'mirror') if mirror_text is not None else '',
                   'MOCK_SSH_EXIT': str(ssh_exit)}
            completed = subprocess.run(['/bin/bash', str(HERE/'ssh-broker-last-deploy.sh')],
                                       env=env, capture_output=True, text=True, timeout=15)
            self.assertNotIn('SECRET_FIXTURE', completed.stdout+completed.stderr)
            self.assertEqual(list((root/'runner').iterdir()), [])
            calls = (root/'calls').read_text().splitlines()
            return completed, calls

    def assert_rejected(self, completed, calls, mirror_text=None):
        self.assertNotEqual(completed.returncode, 0, completed.stdout+completed.stderr)
        self.assertNotIn('Broker last deploy:', completed.stdout)
        if mirror_text:
            self.assertNotIn(mirror_text, completed.stdout+completed.stderr)
        self.assertEqual(calls, ['cat /opt/suiba/last-deploy.json'])

    def test_failed_deploy_line(self):
        completed, calls = self.run_script(mirror())
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout,
                         'Broker last deploy: status=failed, '
                         'code=PAPER_CHECK_RECONCILIATION_REQUIRED, '
                         f'SHA={SHA}, at={AT}\n')
        self.assertEqual(calls, ['cat /opt/suiba/last-deploy.json'])

    def test_prepared_deploy_line_with_null_fields(self):
        completed, calls = self.run_script(mirror(status='prepared_stopped', code=None, sha=None))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout,
                         f'Broker last deploy: status=prepared_stopped, code=none, SHA=none, at={AT}\n')
        self.assertEqual(calls, ['cat /opt/suiba/last-deploy.json'])

    def test_ssh_failure_is_rejected(self):
        completed, calls = self.run_script(mirror(), ssh_exit=255)
        self.assert_rejected(completed, calls)

    def test_missing_mirror_is_rejected(self):
        completed, calls = self.run_script(None)
        self.assert_rejected(completed, calls)

    def test_non_deploy_user_is_refused_before_any_ssh(self):
        completed, calls = self.run_script(mirror(), user='suiba-observe')
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(calls, [])

    def test_malformed_mirrors_are_rejected(self):
        bad = [
            'not json',
            '[1, 2]',
            mirror(version=2),
            mirror(version='1'),
            mirror(version=True),
            json.dumps({**json.loads(mirror()), 'extra': 1}),
            json.dumps({k: v for k, v in json.loads(mirror()).items() if k != 'at'}),
            mirror(status='ok'),
            mirror(code='lower_case'),
            mirror(code='AB'),
            mirror(code=123),
            mirror(sha='A' * 40),
            mirror(sha='a' * 39),
            mirror(at=0),
            mirror(at=-5),
            mirror(at=str(AT)),
            mirror(at=1.5),
            mirror(at=True),
            'x' * 5000,
        ]
        for text in bad:
            with self.subTest(text=text[:60]):
                completed, calls = self.run_script(text)
                self.assert_rejected(completed, calls, text)


class WorkflowShapeTests(unittest.TestCase):
    def test_wrapper_and_step_are_fixed_and_conditional(self):
        wrapper = (HERE/'ssh-broker-last-deploy.sh').read_text(encoding='utf-8')
        self.assertIn("'cat /opt/suiba/last-deploy.json'", wrapper)
        self.assertIn('[[ $VPS_USER == suiba-deploy ]]', wrapper)
        self.assertNotIn('sudo -n', wrapper)
        source = (HERE.parent.parent/'.github/workflows/suiba-paper-deploy-cycle.yml').read_text(encoding='utf-8')
        self.assertIn('id: deploy', source)
        self.assertIn("if: ${{ !cancelled() && steps.deploy.outcome == 'failure' }}", source)
        self.assertIn('ssh-broker-last-deploy.sh', source)
        self.assertIn('Broker last deploy: unavailable', source)
        deploy_at = source.index('id: deploy')
        show_at = source.index('Show the broker public result')
        diagnose_at = source.index('Diagnose a failed deploy')
        self.assertTrue(deploy_at < show_at < diagnose_at)


if __name__ == '__main__':
    unittest.main()
