"""Offline workflow/SSH contracts for production start/stop. Never contacts a VPS."""
import ast
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent
WORKFLOW = HERE.parent.parent/'.github/workflows/suiba-production-control.yml'


def job_block(source, name):
    block = source.split(f'  {name}:\n', 1)[1]
    return re.split(r'\n  [a-z][a-z0-9-]*:\n', block, maxsplit=1)[0]


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.source = WORKFLOW.read_text(encoding='utf-8')

    def test_only_a_confirmation_input_and_no_schedule(self):
        self.assertIn('workflow_dispatch:', self.source)
        self.assertNotIn('schedule:', self.source)
        self.assertIn('Type START-PROD or STOP-PROD', self.source)
        self.assertEqual(self.source.count('inputs:'), 1)
        self.assertNotIn('duration', self.source)

    def test_both_jobs_are_gated_approved_and_serialized(self):
        self.assertIn('group: suiba-production-control', self.source)
        self.assertIn('cancel-in-progress: false', self.source)
        self.assertEqual(self.source.count('environment: sakura-vps'), 2)
        self.assertNotIn('sakura-vps-observe', self.source)
        for name, word, wrapper, env_name in (
                ('prod-start', 'START-PROD', 'ssh-prod-start.sh', 'PROD_START_CONFIRMATION'),
                ('prod-stop', 'STOP-PROD', 'ssh-prod-stop.sh', 'PROD_STOP_CONFIRMATION')):
            block = job_block(self.source, name)
            self.assertIn('environment: sakura-vps', block)
            self.assertIn(f'run: bash sui-ai-trading-bot/docker/{wrapper}', block)
            self.assertIn(f'{env_name}: ${{{{ inputs.confirmation }}}}', block)
            for secret in ('VPS_HOST', 'VPS_USER', 'VPS_PORT', 'VPS_SSH_KEY', 'VPS_KNOWN_HOSTS'):
                self.assertIn(f'{secret}: ${{{{ secrets.{secret} }}}}', block)
            expression = re.search(r'    if: (.+)\n', block).group(1)
            for enabled in ('true', 'false', ''):
                for ref in ('refs/heads/main', 'refs/heads/feature'):
                    for confirmation in (word, 'START-PROD' if word == 'STOP-PROD' else 'STOP-PROD', 'wrong', ''):
                        expr = expression
                        context = {'vars.SUIBA_PROD_CONTROL_ENABLED': enabled, 'github.ref': ref,
                                   'inputs.confirmation': confirmation}
                        for key, value in context.items(): expr = expr.replace(key, repr(value))
                        expr = ' '.join(expr.replace('&&', ' and ').split())
                        tree = ast.parse(expr, mode='eval')
                        self.assertTrue(all(isinstance(node, (ast.Expression, ast.BoolOp, ast.And, ast.Compare,
                                                             ast.Eq, ast.Constant)) for node in ast.walk(tree)))
                        actual = eval(compile(tree, '<workflow-gate>', 'eval'), {'__builtins__': {}})
                        expected = enabled == 'true' and ref == 'refs/heads/main' and confirmation == word
                        self.assertEqual(actual, expected, (name, enabled, ref, confirmation))


class WrapperStaticTests(unittest.TestCase):
    def check_common(self, name, confirmation_env, word):
        source = (HERE/name).read_text(encoding='utf-8')
        self.assertIn(f'[[ ${{{confirmation_env}:-}} == {word} ]]', source)
        self.assertIn('[[ $VPS_USER == suiba-deploy ]]', source)
        self.assertIn("'sudo -n -- /usr/local/sbin/suiba-paper-check'", source)
        self.assertNotIn('suiba-paper-observe', source)
        self.assertIn('-o StrictHostKeyChecking=yes', source)
        self.assertIn('-o IdentitiesOnly=yes', source)
        self.assertIn('-o PasswordAuthentication=no', source)
        self.assertIn('paper-fixed-reason.py', source)
        return source

    def test_start_wrapper_is_fixed(self):
        source = self.check_common('ssh-prod-start.sh', 'PROD_START_CONFIRMATION', 'START-PROD')
        self.assertIn("""printf '%s\\n' '{"operation":"prod-start"}'""", source)
        self.assertIn("""[[ $(cat "$result") == '{"status": "accepted"}' ]]""", source)
        self.assertIn('PROD_START_FAILED (connection or response details withheld)', source)
        self.assertIn('timeout 60s ssh', source)

    def test_stop_wrapper_is_fixed(self):
        source = self.check_common('ssh-prod-stop.sh', 'PROD_STOP_CONFIRMATION', 'STOP-PROD')
        self.assertIn("""printf '%s\\n' '{"operation":"prod-stop"}'""", source)
        self.assertIn("""'{"status": "completed"}') outcome=completed ;;""", source)
        self.assertIn("""'{"status": "not_started"}') outcome=not_started ;;""", source)
        self.assertIn('PROD_STOP_FAILED (connection or response details withheld)', source)
        self.assertIn('timeout 300s ssh', source)


@unittest.skipIf(os.name == 'nt', 'mocked Bash SSH pipeline runs on Linux')
class SshTests(unittest.TestCase):
    def run_script(self, script, env_extra, response=None, ssh_exit=0, expect_failure=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'bin').mkdir(); (root/'runner').mkdir()
            (root/'calls').write_text('')
            if response is not None: (root/'response').write_text(response)
            (root/'bin/ssh-keygen').write_text('#!/bin/sh\nprintf "SECRET_FIXTURE_KEY_OUTPUT"\n')
            (root/'bin/ssh').write_text('''#!/usr/bin/python3
import os,sys,json
command=sys.argv[-1]
request=sys.stdin.read()
with open(os.environ['MOCK_CALLS'],'a') as out: out.write(json.dumps({'command':command,'request':request,'args':sys.argv[1:]})+'\\n')
sys.stderr.write('SECRET_FIXTURE_SSH_ERROR')
if os.path.exists(os.environ['MOCK_RESPONSE']):
    sys.stdout.write(open(os.environ['MOCK_RESPONSE']).read())
sys.exit(int(os.environ['MOCK_SSH_EXIT']))
''')
            for command in (root/'bin').iterdir(): command.chmod(0o755)
            env = {**os.environ, 'PATH': str(root/'bin')+':'+os.environ['PATH'], 'RUNNER_TEMP': str(root/'runner'),
                   'VPS_HOST': 'fixture.invalid', 'VPS_USER': 'suiba-deploy', 'VPS_PORT': '22',
                   'VPS_SSH_KEY': 'SECRET_FIXTURE_PRIVATE_KEY', 'VPS_KNOWN_HOSTS': 'SECRET_FIXTURE_HOSTS',
                   'GITHUB_STEP_SUMMARY': str(root/'summary'), 'MOCK_CALLS': str(root/'calls'),
                   'MOCK_RESPONSE': str(root/'response'), 'MOCK_SSH_EXIT': str(ssh_exit), **env_extra}
            completed = subprocess.run(['/bin/bash', str(HERE/script)], env=env, capture_output=True, text=True, timeout=20)
            self.assertNotIn('SECRET_FIXTURE', completed.stdout+completed.stderr)
            self.assertEqual(list((root/'runner').iterdir()), [])
            calls = [json.loads(line) for line in (root/'calls').read_text().splitlines() if line.strip()]
            summary = (root/'summary').read_text() if (root/'summary').exists() else ''
            self.assertNotIn('SECRET_FIXTURE', summary)
            if expect_failure:
                self.assertNotEqual(completed.returncode, 0)
            else:
                self.assertEqual(completed.returncode, 0, completed.stderr)
            return completed, calls, summary

    def test_start_sends_only_the_fixed_request_and_accepts_accepted(self):
        _, calls, summary = self.run_script('ssh-prod-start.sh', {'PROD_START_CONFIRMATION': 'START-PROD'},
                                            response='{"status": "accepted"}\n')
        self.assertEqual([call['command'] for call in calls], ['sudo -n -- /usr/local/sbin/suiba-paper-check'])
        self.assertEqual(json.loads(calls[0]['request']), {'operation': 'prod-start'})
        self.assertIn('StrictHostKeyChecking=yes', calls[0]['args'])
        self.assertIn('IdentitiesOnly=yes', calls[0]['args'])
        self.assertIn('PasswordAuthentication=no', calls[0]['args'])
        self.assertIn('- Start: `accepted`', summary)

    def test_start_refuses_wrong_confirmation_and_wrong_user_before_any_ssh(self):
        for extra in ({'PROD_START_CONFIRMATION': 'STOP-PROD'}, {'PROD_START_CONFIRMATION': ''},
                      {'PROD_START_CONFIRMATION': 'START-PROD '}):
            _, calls, _ = self.run_script('ssh-prod-start.sh', extra,
                                          response='{"status": "accepted"}\n', expect_failure=True)
            self.assertEqual(calls, [])
        for user in ('suiba-observe', 'ubuntu'):
            _, calls, _ = self.run_script('ssh-prod-start.sh',
                                          {'PROD_START_CONFIRMATION': 'START-PROD', 'VPS_USER': user},
                                          response='{"status": "accepted"}\n', expect_failure=True)
            self.assertEqual(calls, [])

    def test_start_refuses_unexpected_response_and_ssh_failure(self):
        for response, ssh_exit in (('{"status": "completed"}\n', 0), ('SECRET_FIXTURE_RESPONSE\n', 0), (None, 1)):
            _, calls, _ = self.run_script('ssh-prod-start.sh', {'PROD_START_CONFIRMATION': 'START-PROD'},
                                          response=response, ssh_exit=ssh_exit, expect_failure=True)
            self.assertEqual(len(calls), 1)

    def test_stop_accepts_completed_and_not_started(self):
        for response, outcome in (('{"status": "completed"}\n', 'completed'),
                                  ('{"status": "not_started"}\n', 'not_started')):
            _, calls, summary = self.run_script('ssh-prod-stop.sh', {'PROD_STOP_CONFIRMATION': 'STOP-PROD'},
                                                response=response)
            self.assertEqual([call['command'] for call in calls], ['sudo -n -- /usr/local/sbin/suiba-paper-check'])
            self.assertEqual(json.loads(calls[0]['request']), {'operation': 'prod-stop'})
            self.assertIn(f'- Stop: `{outcome}`', summary)

    def test_stop_refuses_wrong_confirmation_response_and_ssh_failure(self):
        _, calls, _ = self.run_script('ssh-prod-stop.sh', {'PROD_STOP_CONFIRMATION': 'START-PROD'},
                                      response='{"status": "completed"}\n', expect_failure=True)
        self.assertEqual(calls, [])
        for response, ssh_exit in (('{"status": "accepted"}\n', 0), ('{"status": "failed_requires_review"}\n', 0), (None, 1)):
            _, calls, _ = self.run_script('ssh-prod-stop.sh', {'PROD_STOP_CONFIRMATION': 'STOP-PROD'},
                                          response=response, ssh_exit=ssh_exit, expect_failure=True)
            self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
