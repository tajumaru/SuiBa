"""Offline contracts for the read-only paper-check monitor; no SSH or writes."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('paper_observe_status', HERE/'paper-observe-status.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

RUN = {'id': 'a'*32, 'status': 'in_progress', 'duration': '6h'}


def payload(**overrides):
    # The real controller status() shape: full run record, fault latch,
    # stop receipt, admission evidence. No worker/watchdog/controller fields.
    base = {'run': dict(RUN), 'requires_review': False, 'stop': None,
            'admission_failure': None, 'admission_failures': []}
    base.update(overrides)
    return base


class CombineTests(unittest.TestCase):
    def test_running_run_is_ok(self):
        result = p.combine(payload(), 2000)
        self.assertEqual(result['verdict'], 'ok')
        self.assertEqual(result['run_id'], 'a'*32)
        self.assertEqual(result['duration'], '6h')

    def test_failed_run_and_review_flag_require_attention(self):
        failed = payload(run={**RUN, 'status': 'failed_requires_review'}, requires_review=True)
        self.assertEqual(p.combine(failed, 2000)['reasons'], ['RUN_FAILED_REQUIRES_REVIEW'])
        flagged = payload(run={**RUN, 'status': 'completed'}, requires_review=True)
        self.assertEqual(p.combine(flagged, 2000)['reasons'], ['RUN_FAILED_REQUIRES_REVIEW'])

    def test_latch_during_an_admitted_run_is_not_the_current_runs_fault(self):
        self.assertEqual(p.combine(payload(requires_review=True), 2000)['verdict'], 'ok')
        finishing = payload(run={**RUN, 'status': 'finishing'}, requires_review=True)
        self.assertEqual(p.combine(finishing, 2000)['verdict'], 'ok')
        completed = payload(run={**RUN, 'status': 'completed'}, requires_review=True)
        self.assertEqual(p.combine(completed, 2000)['reasons'], ['RUN_FAILED_REQUIRES_REVIEW'])

    def test_no_run_record_is_quiet_unless_the_latch_is_set(self):
        result = p.combine(payload(run=None), 2000)
        self.assertEqual(result['verdict'], 'no_run')
        self.assertEqual(result['reasons'], [])
        latched = p.combine(payload(run=None, requires_review=True), 2000)
        self.assertEqual(latched['reasons'], ['RUN_FAILED_REQUIRES_REVIEW'])

    def test_unread_and_invalid_payloads_are_attention_with_fixed_codes(self):
        self.assertEqual(p.combine(None, 2000, read_ok=False)['reasons'], ['PAPER_STATUS_UNAVAILABLE'])
        for bad in (payload(run={**RUN, 'id': 'x'}), payload(run={**RUN, 'status': 'bogus'}),
                    payload(requires_review='yes'), payload(run={**RUN, 'duration': '1h'}),
                    'not a dict'):
            self.assertEqual(p.combine(bad, 2000)['reasons'], ['PAPER_STATUS_INVALID'], bad)

    def test_read_rejects_duplicates_nan_and_oversize(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'response'
            for data in ('{"at":1,"at":2}', '{"at":NaN}', '{"at":Infinity}', 'x'*65537):
                path.write_text(data)
                with self.assertRaises(Exception): p.read(path)


class WorkflowTests(unittest.TestCase):
    def test_both_jobs_are_gated_and_notifications_never_receive_host_credentials(self):
        source = (HERE.parent.parent/'.github/workflows/suiba-paper-monitor.yml').read_text(encoding='utf-8')
        self.assertIn("cron: '2,32 * * * *'", source)
        self.assertIn("cron: '12,42 * * * *'", source)
        self.assertIn("cron: '22,52 * * * *'", source)
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
                    for event, confirmation in (('schedule', ''), ('workflow_dispatch', 'CHECK-PAPER-MONITOR'), ('workflow_dispatch', 'wrong')):
                        for previous in ('success', 'failure', 'skipped'):
                            expr = expression
                            context = {'vars.SUIBA_PAPER_MONITOR_ENABLED': enabled, 'github.ref': ref,
                                       'github.event_name': event, 'inputs.confirmation': confirmation,
                                       'needs.check.result': previous}
                            for key, value in context.items(): expr = expr.replace(key, repr(value))
                            expr = ' '.join(expr.replace('always()', 'True').replace('&&', ' and ').replace('||', ' or ').split())
                            tree = ast.parse(expr, mode='eval')
                            self.assertTrue(all(isinstance(node, (ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.Compare,
                                                                 ast.Eq, ast.NotEq, ast.Constant)) for node in ast.walk(tree)))
                            actual = eval(compile(tree, '<workflow-gate>', 'eval'), {'__builtins__': {}})
                            expected = enabled == 'true' and ref == 'refs/heads/main' and (event == 'schedule' or confirmation == 'CHECK-PAPER-MONITOR')
                            if name == 'notify': expected = expected and previous != 'skipped'
                            self.assertEqual(actual, expected)


@unittest.skipIf(os.name == 'nt', 'mocked Bash SSH pipeline runs on Linux')
class SshTests(unittest.TestCase):
    def run_script(self, status, ssh_exit=0):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'bin').mkdir(); (root/'runner').mkdir()
            (root/'status').write_text(json.dumps(status))
            (root/'calls').write_text('')
            (root/'bin/ssh-keygen').write_text('#!/bin/sh\nprintf "SECRET_FIXTURE_KEY_OUTPUT"\n')
            (root/'bin/ssh').write_text('''#!/usr/bin/python3
import os,sys,json
command=sys.argv[-1]
request=sys.stdin.read()
with open(os.environ['MOCK_CALLS'],'a') as out: out.write(json.dumps({'command':command,'request':request})+'\\n')
sys.stderr.write('SECRET_FIXTURE_SSH_ERROR')
if command=='sudo -n -- /usr/local/sbin/suiba-paper-observe':
    sys.stdout.write(open(os.environ['MOCK_STATUS']).read()); sys.exit(int(os.environ['MOCK_SSH_EXIT']))
sys.exit(77)
''')
            for command in (root/'bin').iterdir(): command.chmod(0o755)
            env = {**os.environ, 'PATH': str(root/'bin')+':'+os.environ['PATH'], 'RUNNER_TEMP': str(root/'runner'),
                   'VPS_HOST': 'fixture.invalid', 'VPS_USER': 'suiba-observe', 'VPS_PORT': '22',
                   'VPS_SSH_KEY': 'SECRET_FIXTURE_PRIVATE_KEY', 'VPS_KNOWN_HOSTS': 'SECRET_FIXTURE_HOSTS',
                   'PAPER_MONITOR_REPORT_FILE': str(root/'report'), 'MOCK_CALLS': str(root/'calls'),
                   'MOCK_STATUS': str(root/'status'), 'MOCK_SSH_EXIT': str(ssh_exit)}
            completed = subprocess.run(['/bin/bash', str(HERE/'ssh-paper-observe.sh')], env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertNotIn('SECRET_FIXTURE', completed.stdout+completed.stderr)
            self.assertEqual(list((root/'runner').iterdir()), [])
            calls = [json.loads(line) for line in (root/'calls').read_text().splitlines()]
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]['request'], '{"operation":"status"}')
            return json.loads((root/'report').read_text())

    def test_ok_observation(self):
        report = self.run_script(payload())
        self.assertEqual(report['verdict'], 'ok')
        self.assertEqual(report['run_status'], 'in_progress')

    def test_failed_run_observation(self):
        report = self.run_script(payload(run={**RUN, 'status': 'failed_requires_review'}, requires_review=True))
        self.assertEqual(report['verdict'], 'attention')
        self.assertEqual(report['reasons'], ['RUN_FAILED_REQUIRES_REVIEW'])

    def test_ssh_failure_is_unavailable_not_a_crash(self):
        report = self.run_script(payload(), ssh_exit=1)
        self.assertEqual(report['verdict'], 'attention')
        self.assertEqual(report['reasons'], ['PAPER_STATUS_UNAVAILABLE'])


if __name__ == '__main__':
    unittest.main()
