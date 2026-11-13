"""Offline response/SSH contracts. Never contacts a VPS or creates an Issue."""
import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('production_status', HERE/'production-status.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def combine(status, watch, now, prod_read=True, watch_read=True):
    status = {**status, 'watchdog': {'record': watch if watch_read else None,
              'code': None if watch_read else 'WATCHDOG_RECORD_MISSING'}}
    return p.combine(status, now, prod_read)


def healthy(now=2000):
    status = {'run': {'id': 'a'*32, 'status': 'in_progress', 'started': 1000000,
                     'stopped': None, 'sha': 'e'*40, 'stage': 'monitoring', 'admitted': True},
              'controller_alive': True, 'requires_review': False,
              'worker': {'running': True, 'maintenance': False, 'databaseHealthy': True, 'ledgerOk': True, 'paper': True}}
    watch = {'at': int(now)-1, 'verdict': 'ok', 'reasons': [], 'run_id': 'a'*32}
    return status, watch


class ShapeTests(unittest.TestCase):
    def test_current_consistent_observations_are_normal(self):
        status, watch = healthy()
        result = combine(status, watch, 2000)
        self.assertEqual(result, {'at': 2000, 'verdict': 'ok', 'reasons': [], 'run_id': 'a'*32,
                                  'prod_state': 'in_progress', 'watchdog_at': 1999})
        status['run'].update(status='completed', stage='stopped', stopped=1900000)
        status.update(controller_alive=False, worker=None)
        self.assertEqual(combine(status, watch, 2000)['verdict'], 'ok')

    def test_not_started_never_creates_an_alert_even_when_private_record_cannot_be_read(self):
        status = {'run': None, 'requires_review': False}
        for watch, read in ((None, False), (healthy()[1], True)):
            result = combine(status, watch, 2000, watch_read=read)
            self.assertEqual(result['verdict'], 'not_started')
            self.assertEqual(result['reasons'], [])

    def test_unavailable_or_invalid_data_never_becomes_healthy(self):
        status, watch = healthy()
        for prod_read, watch_read, code in ((False, True, 'PROD_STATUS_UNAVAILABLE'),):
            result = combine(status, watch, 2000, prod_read, watch_read)
            self.assertEqual(result['verdict'], 'attention'); self.assertIn(code, result['reasons'])
        for mutate in (lambda s: s.update(requires_review='SECRET_FIXTURE'),
                       lambda s: s['run'].update(id='SECRET_FIXTURE'),
                       lambda s: s['worker'].update(running=1),
                       lambda s: s.update(worker={'reachable': 0, 'reason': 'WORKER_UNREACHABLE'}),
                       lambda s: s.update(secret='SECRET_FIXTURE')):
            bad = copy.deepcopy(status); mutate(bad)
            result = combine(bad, watch, 2000)
            self.assertEqual(result['reasons'], ['PROD_STATUS_INVALID'])
            self.assertNotIn('SECRET_FIXTURE', json.dumps(result))
        for bad in ({**watch, 'reasons': ['SECRET_FIXTURE'], 'verdict': 'attention'},
                    {**watch, 'at': True}, {**watch, 'verdict': 'attention'}, {**watch, 'extra': 'SECRET_FIXTURE'}):
            self.assertIn('PROD_STATUS_INVALID', combine(status, bad, 2000)['reasons'])

    def test_stale_future_and_different_run_records_require_review(self):
        status, watch = healthy()
        for at in (1099, 2061, 10**50):
            result = combine(status, {**watch, 'at': at}, 2000)
            self.assertIn('WATCHDOG_STALE', result['reasons'])
            self.assertTrue(result['watchdog_at'] is None or result['watchdog_at'] <= 2060)
        self.assertEqual(combine(status, {**watch, 'at': 1100}, 2000)['verdict'], 'ok')
        self.assertIn('WATCHDOG_RUN_MISMATCH', combine(status, {**watch, 'run_id': 'b'*32}, 2000)['reasons'])
        self.assertIn('STATUS_INCONSISTENT', combine(status, {'at': 2000, 'run_id': None, 'verdict': 'not_started', 'reasons': []}, 2000)['reasons'])

    def test_live_status_can_raise_attention_even_if_last_watchdog_was_normal(self):
        status, watch = healthy()
        status['worker'] = {'reachable': False, 'reason': 'WORKER_UNREACHABLE'}
        self.assertIn('WORKER_UNREACHABLE', combine(status, watch, 2000)['reasons'])
        status.update(controller_alive=False, worker=None)
        self.assertIn('CONTROLLER_NOT_RUNNING', combine(status, watch, 2000)['reasons'])
        status['run']['status'] = 'failed_requires_review'; status['requires_review'] = True
        self.assertTrue({'REVIEW_REQUIRED', 'RUN_FAILED'} <= set(combine(status, watch, 2000)['reasons']))

    def test_failure_summary_is_projected_into_the_report(self):
        status, watch = healthy()
        status['run'].update(status='failed_requires_review', stage='backup')
        status.update(controller_alive=False, worker=None, requires_review=True)
        failure = {'status': 'failed_requires_review', 'stage': 'worker-readiness',
                   'code': 'BACKUP_UNCONFIRMED', 'http_status': 503, 'backup': 'unconfirmed'}
        status['failure'] = failure
        result = combine(status, watch, 2000)
        self.assertEqual(result['verdict'], 'attention')
        self.assertTrue({'REVIEW_REQUIRED', 'RUN_FAILED'} <= set(result['reasons']))
        self.assertEqual(result['failure'], failure)

    def test_midrun_failure_summary_is_projected_into_the_report(self):
        # The mid-run shape the close-out now persists: stage
        # monitoring (the session ran for hours), the worker's
        # own stop reason as the code, no HTTP status. It passes
        # the same strict projection unchanged.
        status, watch = healthy()
        status['run'].update(status='failed_requires_review', stage='monitoring')
        status.update(controller_alive=False, worker=None, requires_review=True)
        failure = {'status': 'failed_requires_review', 'stage': 'monitoring',
                   'code': 'UPSTREAM_HTTP_500', 'http_status': None, 'backup': 'unconfirmed'}
        status['failure'] = failure
        result = combine(status, watch, 2000)
        self.assertEqual(result['verdict'], 'attention')
        self.assertTrue({'REVIEW_REQUIRED', 'RUN_FAILED'} <= set(result['reasons']))
        self.assertEqual(result['failure'], failure)

    def test_malformed_failure_summary_is_invalid(self):
        status, watch = healthy()
        status['run'].update(status='failed_requires_review', stage='backup')
        status.update(controller_alive=False, worker=None, requires_review=True)
        good = {'status': 'failed_requires_review', 'stage': 'worker-readiness',
                'code': 'BACKUP_UNCONFIRMED', 'http_status': 503, 'backup': 'unconfirmed'}
        for mutate in (lambda f: f.update(extra='SECRET_FIXTURE'),
                       lambda f: f.update(status='completed'),
                       lambda f: f.update(stage='SECRET_FIXTURE'),
                       lambda f: f.update(code='not a code'),
                       lambda f: f.update(http_status=99),
                       lambda f: f.update(http_status='503'),
                       lambda f: f.update(backup='SECRET_FIXTURE'),
                       lambda f: f.pop('code')):
            bad = copy.deepcopy(status); bad['failure'] = copy.deepcopy(good); mutate(bad['failure'])
            result = combine(bad, watch, 2000)
            self.assertEqual(result['reasons'], ['PROD_STATUS_INVALID'])
            self.assertNotIn('SECRET_FIXTURE', json.dumps(result))
            self.assertNotIn('failure', result)
        # The summary belongs to a run; without one it is invalid too.
        result = combine({'run': None, 'requires_review': False, 'failure': good}, watch, 2000)
        self.assertEqual(result['reasons'], ['PROD_STATUS_INVALID'])

    def test_missing_or_invalid_optional_record_uses_live_production_state(self):
        status, _ = healthy()
        for code in ('WATCHDOG_RECORD_MISSING', 'WATCHDOG_RECORD_INVALID'):
            status['watchdog'] = {'record': None, 'code': code}
            self.assertEqual(p.combine(status, 2000)['verdict'], 'ok')
            bad = copy.deepcopy(status); bad['worker']['running'] = False
            self.assertIn('TRADING_STOPPED', p.combine(bad, 2000)['reasons'])
            bad = copy.deepcopy(status); bad['requires_review'] = True
            self.assertIn('REVIEW_REQUIRED', p.combine(bad, 2000)['reasons'])
            self.assertEqual(p.combine({'run': None, 'requires_review': False, 'watchdog': status['watchdog']}, 2000)['verdict'], 'not_started')

    def test_reader_rejects_duplicate_keys_nonfinite_and_large_responses(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'response'
            for data in ('{"at":1,"at":2}', '{"at":NaN}', '{"at":Infinity}', 'x'*65537):
                path.write_text(data)
                with self.assertRaises(Exception): p.read(path)

    def test_closed_reason_allowlist_covers_host_checker_codes(self):
        source = ast.parse((HERE.parent/'deploy/paper-check/watchdog.py').read_text(encoding='utf-8'))
        strings = {node.value for node in ast.walk(source) if isinstance(node, ast.Constant) and isinstance(node.value, str)}
        host_codes = {s for s in strings if s.isupper() and '_' in s} - {
            'SUI_USDC', 'WATCHDOG_INVALID_EVIDENCE', 'DOCKER_HOST', 'DOCKER_CONFIG', 'STATUS_COMMAND',
            'SUIBA_WATCHDOG_', 'SUIBA_WATCHDOG_RECORD_FAILED'}
        self.assertTrue(host_codes <= p.HOST_REASONS, host_codes - p.HOST_REASONS)

    def test_both_workflow_jobs_are_gated_and_notifications_never_receive_host_credentials(self):
        source = (HERE.parent.parent/'.github/workflows/suiba-production-monitor.yml').read_text(encoding='utf-8')
        self.assertIn("cron: '7,37 * * * *'", source)
        self.assertIn("cron: '17,47 * * * *'", source)
        self.assertIn("cron: '27,57 * * * *'", source)
        self.assertIn('workflow_dispatch:', source)
        self.assertIn('cancel-in-progress: false', source)
        self.assertIn('environment: sakura-vps-observe', source)
        self.assertNotIn('environment: sakura-vps\n', source)
        check = source.split('  check:\n', 1)[1].split('  notify:\n', 1)[0]
        notify = source.split('  notify:\n', 1)[1]
        self.assertNotIn('issues: write', check)
        self.assertIn('issues: write', notify)
        self.assertNotIn('secrets.VPS_', notify)
        self.assertIn("process.env.OBSERVATION_OUTCOME === 'success'", check)
        # The port must stay a variable: as a secret, "22" poisons job outputs.
        self.assertIn('VPS_PORT: ${{ vars.SUIBA_OBSERVE_VPS_PORT }}', check)
        self.assertNotIn('secrets.VPS_PORT', source)
        for block, name in ((check, 'check'), (notify, 'notify')):
            expression = re.search(r'    if: >-\n((?:      [^\n]+\n)+)', block).group(1)
            for enabled in ('true', 'false', ''):
                for ref in ('refs/heads/main', 'refs/heads/feature'):
                    for event, confirmation in (('schedule', ''), ('workflow_dispatch', 'CHECK-PROD-MONITOR'), ('workflow_dispatch', 'wrong')):
                        for previous in ('success', 'failure', 'skipped'):
                            expr = expression
                            context = {'vars.SUIBA_PROD_MONITOR_ENABLED': enabled, 'github.ref': ref,
                                       'github.event_name': event, 'inputs.confirmation': confirmation,
                                       'needs.check.result': previous}
                            for key, value in context.items(): expr = expr.replace(key, repr(value))
                            expr = ' '.join(expr.replace('always()', 'True').replace('&&', ' and ').replace('||', ' or ').split())
                            tree = ast.parse(expr, mode='eval')
                            self.assertTrue(all(isinstance(node, (ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.Compare,
                                                                 ast.Eq, ast.NotEq, ast.Constant)) for node in ast.walk(tree)))
                            actual = eval(compile(tree, '<workflow-gate>', 'eval'), {'__builtins__': {}})
                            expected = enabled == 'true' and ref == 'refs/heads/main' and (event == 'schedule' or confirmation == 'CHECK-PROD-MONITOR')
                            if name == 'notify': expected = expected and previous != 'skipped'
                            self.assertEqual(actual, expected)


@unittest.skipIf(os.name == 'nt', 'mocked Bash SSH pipeline runs on Linux')
class SshTests(unittest.TestCase):
    def run_script(self, status, watch, prod_exit=0, watch_exit=0, user='suiba-deploy', expect_failure=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'bin').mkdir(); (root/'runner').mkdir()
            status = {**status, 'watchdog': {'record': watch if watch_exit == 0 else None, 'code': None if watch_exit == 0 else 'WATCHDOG_RECORD_INVALID'}}
            (root/'prod').write_text(json.dumps(status)); (root/'watch').write_text(json.dumps(watch))
            (root/'calls').write_text('')
            (root/'bin/ssh-keygen').write_text('#!/bin/sh\nprintf "SECRET_FIXTURE_KEY_OUTPUT"\n')
            (root/'bin/ssh').write_text('''#!/usr/bin/python3
import os,sys,json
command=sys.argv[-1]
request='' if '-n' in sys.argv else sys.stdin.read()
with open(os.environ['MOCK_CALLS'],'a') as out: out.write(json.dumps({'command':command,'request':request,'args':sys.argv[1:]})+'\\n')
sys.stderr.write('SECRET_FIXTURE_SSH_ERROR')
if command in ('sudo -n -- /usr/local/sbin/suiba-paper-check', 'sudo -n -- /usr/local/sbin/suiba-paper-observe'):
    sys.stdout.write(open(os.environ['MOCK_PROD']).read()); sys.exit(int(os.environ['MOCK_PROD_EXIT']))
sys.exit(77)
''')
            for command in (root/'bin').iterdir(): command.chmod(0o755)
            env = {**os.environ, 'PATH': str(root/'bin')+':'+os.environ['PATH'], 'RUNNER_TEMP': str(root/'runner'),
                   'VPS_HOST': 'fixture.invalid', 'VPS_USER': user, 'VPS_PORT': '22',
                   'VPS_SSH_KEY': 'SECRET_FIXTURE_PRIVATE_KEY', 'VPS_KNOWN_HOSTS': 'SECRET_FIXTURE_HOSTS',
                   'PRODUCTION_REPORT_FILE': str(root/'report'), 'MOCK_CALLS': str(root/'calls'),
                   'MOCK_PROD': str(root/'prod'), 'MOCK_WATCH': str(root/'watch'),
                   'MOCK_PROD_EXIT': str(prod_exit), 'MOCK_WATCH_EXIT': str(watch_exit)}
            completed = subprocess.run(['/bin/bash', str(HERE/'ssh-prod-status.sh')], env=env, capture_output=True, text=True, timeout=15)
            self.assertNotIn('SECRET_FIXTURE', completed.stdout+completed.stderr)
            self.assertEqual(list((root/'runner').iterdir()), [])
            calls = [json.loads(line) for line in (root/'calls').read_text().splitlines() if line.strip()]
            if expect_failure:
                self.assertNotEqual(completed.returncode, 0)
                return completed, calls
            self.assertEqual(completed.returncode, 0)
            return json.loads((root/'report').read_text()), calls

    def test_only_fixed_read_only_commands_with_pinned_ssh_options_are_sent(self):
        import time
        status, watch = healthy(time.time())
        result, calls = self.run_script(status, watch)
        self.assertEqual(result['verdict'], 'ok')
        self.assertEqual([call['command'] for call in calls], ['sudo -n -- /usr/local/sbin/suiba-paper-check'])
        self.assertEqual(json.loads(calls[0]['request']), {'operation': 'prod-status'})
        for call in calls:
            self.assertIn('StrictHostKeyChecking=yes', call['args'])
            self.assertIn('IdentitiesOnly=yes', call['args'])
            self.assertIn('PasswordAuthentication=no', call['args'])

    def test_observe_identity_uses_the_observe_entrypoint(self):
        import time
        status, watch = healthy(time.time())
        result, calls = self.run_script(status, watch, user='suiba-observe')
        self.assertEqual(result['verdict'], 'ok')
        self.assertEqual([call['command'] for call in calls], ['sudo -n -- /usr/local/sbin/suiba-paper-observe'])
        self.assertEqual(json.loads(calls[0]['request']), {'operation': 'prod-status'})
        for call in calls:
            self.assertIn('StrictHostKeyChecking=yes', call['args'])
            self.assertIn('IdentitiesOnly=yes', call['args'])
            self.assertIn('PasswordAuthentication=no', call['args'])

    def test_unknown_user_is_refused_before_any_ssh(self):
        import time
        status, watch = healthy(time.time())
        completed, calls = self.run_script(status, watch, user='ubuntu', expect_failure=True)
        self.assertEqual(calls, [])

    def test_invalid_optional_record_uses_live_status_and_failed_ssh_is_attention(self):
        import time
        status, watch = healthy(time.time())
        result, _ = self.run_script(status, watch, watch_exit=1)
        self.assertEqual(result['verdict'], 'ok')
        result, _ = self.run_script(status, watch, prod_exit=1)
        self.assertEqual(result['reasons'], ['PROD_STATUS_UNAVAILABLE'])
        result, _ = self.run_script({'run': None, 'requires_review': False}, None, watch_exit=1)
        self.assertEqual(result['verdict'], 'not_started')


if __name__ == '__main__':
    unittest.main(verbosity=2)
