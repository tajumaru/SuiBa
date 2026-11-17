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
        self.assertIn('Type START-PROD, STOP-PROD or ROLLBACK-PROD', self.source)
        self.assertEqual(self.source.count('inputs:'), 1)
        # The rollback target rides in its own optional input; the
        # confirmation word alone never names a release.
        self.assertIn('target_sha:', self.source)
        self.assertNotIn('duration', self.source)

    def assert_gate(self, block, context, expected_fn):
        expression = re.search(r'    if: (.+)\n', block).group(1)
        expr = expression
        for key, value in context.items(): expr = expr.replace(key, repr(value))
        expr = ' '.join(expr.replace('&&', ' and ').split())
        tree = ast.parse(expr, mode='eval')
        self.assertTrue(all(isinstance(node, (ast.Expression, ast.BoolOp, ast.And, ast.Compare,
                                             ast.Eq, ast.Constant)) for node in ast.walk(tree)))
        actual = eval(compile(tree, '<workflow-gate>', 'eval'), {'__builtins__': {}})
        self.assertEqual(actual, expected_fn(context))

    def test_both_jobs_are_gated_approved_and_serialized(self):
        self.assertIn('group: suiba-production-control', self.source)
        self.assertIn('cancel-in-progress: false', self.source)
        self.assertEqual(self.source.count('environment: sakura-vps'), 3)
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

    def test_followup_steps_surface_failure_detail(self):
        start = job_block(self.source, 'prod-start')
        self.assertIn('timeout-minutes: 8', start)
        self.assertIn('PROD_FOLLOWUP_MODE: start', start)
        self.assertIn('run: python3 sui-ai-trading-bot/docker/production-followup.py', start)
        stop = job_block(self.source, 'prod-stop')
        self.assertIn('id: stop', stop)
        self.assertIn("if: steps.stop.outputs.outcome == 'completed'", stop)
        self.assertIn('PROD_FOLLOWUP_MODE: stop', stop)
        self.assertIn('run: python3 sui-ai-trading-bot/docker/production-followup.py', stop)
        for block in (start, stop):
            for secret in ('VPS_HOST', 'VPS_USER', 'VPS_PORT', 'VPS_SSH_KEY', 'VPS_KNOWN_HOSTS'):
                self.assertIn(f'{secret}: ${{{{ secrets.{secret} }}}}', block)

    def test_rollback_prepare_rebuilds_the_target_without_approval(self):
        block = job_block(self.source, 'rollback-prepare')
        # No Environment and no secrets: this job only builds, like
        # DEPLOY-PAPER's package step, so a failure changes nothing.
        self.assertNotIn('environment:', block)
        self.assertNotIn('secrets.', block)
        self.assertIn('ref: ${{ inputs.target_sha }}', block)
        self.assertIn('git merge-base --is-ancestor "$TARGET_SHA" FETCH_HEAD', block)
        self.assertIn('docker/verify-vps-offline.mjs', block)
        self.assertIn('docker/check-image-archive.py', block)
        self.assertIn('archive_sha256: ${{ steps.package.outputs.archive_sha256 }}', block)
        self.assertIn('name: vps-rollback', block)
        for enabled in ('true', 'false', ''):
            for ref in ('refs/heads/main', 'refs/heads/feature'):
                for confirmation in ('ROLLBACK-PROD', 'START-PROD', 'wrong', ''):
                    context = {'vars.SUIBA_PROD_CONTROL_ENABLED': enabled, 'github.ref': ref,
                               'inputs.confirmation': confirmation}
                    self.assert_gate(block, context,
                                     lambda c: c['vars.SUIBA_PROD_CONTROL_ENABLED'] == 'true'
                                     and c['github.ref'] == 'refs/heads/main'
                                     and c['inputs.confirmation'] == 'ROLLBACK-PROD')

    def test_rollback_job_is_gated_approved_and_reuses_the_wrapper(self):
        block = job_block(self.source, 'prod-rollback')
        self.assertIn('needs: rollback-prepare', block)
        self.assertIn('environment: sakura-vps', block)
        self.assertIn('run: bash sui-ai-trading-bot/docker/ssh-prod-rollback.sh', block)
        self.assertIn('PROD_ROLLBACK_CONFIRMATION: ${{ inputs.confirmation }}', block)
        self.assertIn('ROLLBACK_SHA: ${{ inputs.target_sha }}', block)
        self.assertIn('ARCHIVE_SHA256: ${{ needs.rollback-prepare.outputs.archive_sha256 }}', block)
        self.assertIn('ROLLBACK_CI_RUN: ${{ github.run_id }}', block)
        self.assertIn('PROD_FOLLOWUP_MODE: stop', block)
        self.assertIn('run: python3 sui-ai-trading-bot/docker/production-followup.py', block)
        for secret in ('VPS_HOST', 'VPS_USER', 'VPS_PORT', 'VPS_SSH_KEY', 'VPS_KNOWN_HOSTS'):
            self.assertIn(f'{secret}: ${{{{ secrets.{secret} }}}}', block)
        for control in ('true', 'false', ''):
            for broker in ('true', 'false', ''):
                for ref in ('refs/heads/main', 'refs/heads/feature'):
                    for confirmation in ('ROLLBACK-PROD', 'STOP-PROD', 'wrong', ''):
                        context = {'vars.SUIBA_PROD_CONTROL_ENABLED': control,
                                   'vars.SUIBA_BROKER_ENABLED': broker, 'github.ref': ref,
                                   'inputs.confirmation': confirmation}
                        self.assert_gate(block, context,
                                         lambda c: c['vars.SUIBA_PROD_CONTROL_ENABLED'] == 'true'
                                         and c['vars.SUIBA_BROKER_ENABLED'] == 'true'
                                         and c['github.ref'] == 'refs/heads/main'
                                         and c['inputs.confirmation'] == 'ROLLBACK-PROD')


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
        self.assertIn('echo "outcome=$outcome" >> "$GITHUB_OUTPUT"', source)

    def test_rollback_wrapper_is_fixed(self):
        source = (HERE/'ssh-prod-rollback.sh').read_text(encoding='utf-8')
        self.assertIn('[[ ${PROD_ROLLBACK_CONFIRMATION:-} == ROLLBACK-PROD ]]', source)
        self.assertIn('[[ $VPS_USER == suiba-deploy ]]', source)
        # The rollback speaks to the deploy broker, never to the
        # paper-check controller that start/stop use.
        self.assertIn("'sudo -n -- /usr/local/sbin/suiba-deploy'", source)
        self.assertNotIn('/usr/local/sbin/suiba-paper-check', source)
        self.assertIn('{"operation":"rollback","sha":"%s","archive_sha256":"%s","image_id":"%s","ci_run":%s}', source)
        self.assertIn('/var/lib/suiba-incoming/$ROLLBACK_SHA/image.tar.gz', source)
        self.assertIn('\\"status\\": \\"prepared_stopped\\"', source)
        self.assertIn('PROD_ROLLBACK_FAILED (connection or response details withheld)', source)
        self.assertIn('-o StrictHostKeyChecking=yes', source)
        self.assertIn('-o IdentitiesOnly=yes', source)
        self.assertIn('-o PasswordAuthentication=no', source)
        self.assertIn('paper-fixed-reason.py', source)
        # Every forwarded value is shape-validated before any SSH.
        for pattern in ('[[ ${ROLLBACK_SHA:-} =~ ^[0-9a-f]{40}$ ]]',
                        '[[ ${ARCHIVE_SHA256:-} =~ ^[0-9a-f]{64}$ ]]',
                        '[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]]'):
            self.assertIn(pattern, source)


@unittest.skipIf(os.name == 'nt', 'mocked Bash SSH pipeline runs on Linux')
class SshTests(unittest.TestCase):
    def run_script(self, script, env_extra, response=None, ssh_exit=0, expect_failure=False, github_output=False):
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
            if github_output: env['GITHUB_OUTPUT'] = str(root/'gh-output')
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
            if github_output:
                output = (root/'gh-output').read_text() if (root/'gh-output').exists() else ''
                return completed, calls, summary, output
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

    def test_stop_reports_outcome_for_the_followup_step(self):
        for response, outcome in (('{"status": "completed"}\n', 'completed'),
                                  ('{"status": "not_started"}\n', 'not_started')):
            _, _, summary, output = self.run_script('ssh-prod-stop.sh', {'PROD_STOP_CONFIRMATION': 'STOP-PROD'},
                                                    response=response, github_output=True)
            self.assertEqual(output, f'outcome={outcome}\n')
            self.assertIn(f'- Stop: `{outcome}`', summary)

    def test_stop_refuses_wrong_confirmation_response_and_ssh_failure(self):
        _, calls, _ = self.run_script('ssh-prod-stop.sh', {'PROD_STOP_CONFIRMATION': 'START-PROD'},
                                      response='{"status": "completed"}\n', expect_failure=True)
        self.assertEqual(calls, [])
        for response, ssh_exit in (('{"status": "accepted"}\n', 0), ('{"status": "failed_requires_review"}\n', 0), (None, 1)):
            _, calls, _ = self.run_script('ssh-prod-stop.sh', {'PROD_STOP_CONFIRMATION': 'STOP-PROD'},
                                          response=response, ssh_exit=ssh_exit, expect_failure=True)
            self.assertEqual(len(calls), 1)

    ROLLBACK_SHA = 'a'*40
    ROLLBACK_ARCHIVE_SHA256 = 'b'*64
    ROLLBACK_IMAGE_ID = 'sha256:'+'c'*64

    def run_rollback_script(self, env_extra, response=None, broker_exit=0, scp_exit=0,
                            expect_failure=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'bin').mkdir(); (root/'runner').mkdir()
            (root/'calls').write_text('')
            if response is not None: (root/'response').write_text(response)
            (root/'archive.tar.gz').write_bytes(b'fixture-archive')
            (root/'image-id.txt').write_text(self.ROLLBACK_IMAGE_ID+'\n')
            (root/'bin/ssh-keygen').write_text('#!/bin/sh\nprintf "SECRET_FIXTURE_KEY_OUTPUT"\n')
            (root/'bin/ssh').write_text('''#!/usr/bin/python3
import os,sys,json
command=sys.argv[-1]
request=sys.stdin.read()
kind='broker' if command.startswith('sudo -n') else 'mkdir'
with open(os.environ['MOCK_CALLS'],'a') as out: out.write(json.dumps({'kind':kind,'command':command,'request':request})+'\\n')
sys.stderr.write('SECRET_FIXTURE_SSH_ERROR')
if kind=='broker':
    if os.path.exists(os.environ['MOCK_RESPONSE']):
        sys.stdout.write(open(os.environ['MOCK_RESPONSE']).read())
    sys.exit(int(os.environ['MOCK_BROKER_EXIT']))
sys.exit(0)
''')
            (root/'bin/scp').write_text('''#!/usr/bin/python3
import os,sys,json
with open(os.environ['MOCK_CALLS'],'a') as out: out.write(json.dumps({'kind':'scp','args':sys.argv[1:]})+'\\n')
sys.stderr.write('SECRET_FIXTURE_SCP_ERROR')
sys.exit(int(os.environ['MOCK_SCP_EXIT']))
''')
            for command in (root/'bin').iterdir(): command.chmod(0o755)
            env = {**os.environ, 'PATH': str(root/'bin')+':'+os.environ['PATH'], 'RUNNER_TEMP': str(root/'runner'),
                   'VPS_HOST': 'fixture.invalid', 'VPS_USER': 'suiba-deploy', 'VPS_PORT': '22',
                   'VPS_SSH_KEY': 'SECRET_FIXTURE_PRIVATE_KEY', 'VPS_KNOWN_HOSTS': 'SECRET_FIXTURE_HOSTS',
                   'GITHUB_STEP_SUMMARY': str(root/'summary'), 'MOCK_CALLS': str(root/'calls'),
                   'MOCK_RESPONSE': str(root/'response'), 'MOCK_BROKER_EXIT': str(broker_exit),
                   'MOCK_SCP_EXIT': str(scp_exit),
                   'PROD_ROLLBACK_CONFIRMATION': 'ROLLBACK-PROD', 'ROLLBACK_SHA': self.ROLLBACK_SHA,
                   'ARCHIVE_SHA256': self.ROLLBACK_ARCHIVE_SHA256, 'ROLLBACK_CI_RUN': '43400000000',
                   'ROLLBACK_ARCHIVE_FILE': str(root/'archive.tar.gz'),
                   'ROLLBACK_IMAGE_FILE': str(root/'image-id.txt'), **env_extra}
            completed = subprocess.run(['/bin/bash', str(HERE/'ssh-prod-rollback.sh')],
                                       env=env, capture_output=True, text=True, timeout=30)
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

    def test_rollback_transfers_then_sends_the_fixed_request(self):
        response = '{"status": "prepared_stopped", "sha": "%s"}\n' % self.ROLLBACK_SHA
        _, calls, summary = self.run_rollback_script({}, response=response)
        self.assertEqual([call['kind'] for call in calls], ['mkdir', 'scp', 'broker'])
        self.assertIn(f'/var/lib/suiba-incoming/{self.ROLLBACK_SHA}', calls[0]['command'])
        self.assertTrue(calls[1]['args'][-1].endswith(f'/var/lib/suiba-incoming/{self.ROLLBACK_SHA}/image.tar.gz'))
        self.assertEqual(calls[2]['command'], 'sudo -n -- /usr/local/sbin/suiba-deploy')
        self.assertEqual(json.loads(calls[2]['request']),
                         {'operation': 'rollback', 'sha': self.ROLLBACK_SHA,
                          'archive_sha256': self.ROLLBACK_ARCHIVE_SHA256,
                          'image_id': self.ROLLBACK_IMAGE_ID, 'ci_run': 43400000000})
        self.assertIn('- Rollback: `prepared_stopped`', summary)
        self.assertIn(f'- SHA: `{self.ROLLBACK_SHA}`', summary)

    def test_rollback_refuses_bad_inputs_before_any_ssh(self):
        for extra in ({'PROD_ROLLBACK_CONFIRMATION': 'STOP-PROD'},
                      {'PROD_ROLLBACK_CONFIRMATION': ''},
                      {'ROLLBACK_SHA': 'xyz'},
                      {'ROLLBACK_SHA': 'A'*40},
                      {'ARCHIVE_SHA256': 'b'*63},
                      {'ROLLBACK_CI_RUN': '0'},
                      {'ROLLBACK_CI_RUN': '-1'},
                      {'VPS_USER': 'ubuntu'}):
            _, calls, _ = self.run_rollback_script(extra, expect_failure=True)
            self.assertEqual(calls, [], extra)

    def test_rollback_refuses_wrong_sha_response_broker_failure_and_scp_failure(self):
        wrong_sha = '{"status": "prepared_stopped", "sha": "%s"}\n' % ('d'*40)
        _, calls, _ = self.run_rollback_script({}, response=wrong_sha, expect_failure=True)
        self.assertEqual([call['kind'] for call in calls], ['mkdir', 'scp', 'broker'])
        _, calls, _ = self.run_rollback_script({}, response=None, broker_exit=1, expect_failure=True)
        self.assertEqual([call['kind'] for call in calls], ['mkdir', 'scp', 'broker'])
        # A failed transfer never reaches the broker.
        _, calls, _ = self.run_rollback_script({}, scp_exit=1, expect_failure=True)
        self.assertEqual([call['kind'] for call in calls], ['mkdir', 'scp'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
