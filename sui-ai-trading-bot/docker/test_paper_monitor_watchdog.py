"""Offline contracts for the paper monitor watchdog; mocked gh, no network."""
import ast
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent
WORKFLOWS = HERE.parent.parent/'.github/workflows'
WATCHDOG = (WORKFLOWS/'suiba-paper-monitor-watchdog.yml').read_text(encoding='utf-8')
SCRIPT = (HERE/'paper-monitor-watchdog.sh').read_text(encoding='utf-8')
MONITOR = (WORKFLOWS/'suiba-paper-monitor.yml').read_text(encoding='utf-8')


def stamp(minutes_ago):
    moment = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def run_record(minutes_ago, event='schedule', status='completed'):
    return {'event': event, 'status': status, 'created_at': stamp(minutes_ago)}


class WorkflowTests(unittest.TestCase):
    def test_watchdog_shape_and_minimal_permissions(self):
        self.assertIn("cron: '9,29,49 * * * *'", WATCHDOG)
        self.assertIn('workflow_dispatch:', WATCHDOG)
        self.assertIn('group: suiba-paper-monitor-watchdog', WATCHDOG)
        self.assertIn('cancel-in-progress: false', WATCHDOG)
        # No host environment, no host credentials, no Issue writes: the
        # watchdog's only possible effect is one monitor dispatch.
        self.assertNotIn('environment:', WATCHDOG)
        self.assertNotIn('secrets.VPS_', WATCHDOG)
        self.assertNotIn('issues: write', WATCHDOG)
        job = WATCHDOG.split('  watchdog:\n', 1)[1]
        self.assertIn('actions: write', job)
        self.assertIn('persist-credentials: false', job)
        self.assertIn('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}', job)
        self.assertIn('bash sui-ai-trading-bot/docker/paper-monitor-watchdog.sh', job)

    def test_gate_follows_the_monitor_gate_variable(self):
        job = WATCHDOG.split('  watchdog:\n', 1)[1]
        expression = re.search(r'    if: >-\n((?:      [^\n]+\n)+)', job).group(1)
        for enabled in ('true', 'false', ''):
            for ref in ('refs/heads/main', 'refs/heads/feature'):
                for event in ('schedule', 'workflow_dispatch', 'push'):
                    expr = expression
                    context = {'vars.SUIBA_PAPER_MONITOR_ENABLED': enabled, 'github.ref': ref,
                               'github.event_name': event}
                    for key, value in context.items(): expr = expr.replace(key, repr(value))
                    expr = ' '.join(expr.replace('&&', ' and ').replace('||', ' or ').split())
                    tree = ast.parse(expr, mode='eval')
                    self.assertTrue(all(isinstance(node, (ast.Expression, ast.BoolOp, ast.And, ast.Or,
                                                          ast.Compare, ast.Eq, ast.Constant)) for node in ast.walk(tree)))
                    actual = eval(compile(tree, '<watchdog-gate>', 'eval'), {'__builtins__': {}})
                    expected = enabled == 'true' and ref == 'refs/heads/main' and event in ('schedule', 'workflow_dispatch')
                    self.assertEqual(actual, expected, (enabled, ref, event))

    def test_script_contract_and_monitor_input_it_depends_on(self):
        # The watchdog depends on the monitor's fixed confirmation input
        # and its serializing concurrency group staying exactly as-is.
        self.assertIn('- CHECK-PAPER-MONITOR', MONITOR)
        self.assertIn('group: suiba-paper-monitor', MONITOR)
        self.assertIn('suiba-paper-monitor.yml', SCRIPT)
        self.assertIn('confirmation=CHECK-PAPER-MONITOR', SCRIPT)
        self.assertIn('threshold_seconds=2700', SCRIPT)
        self.assertIn('per_page=20', SCRIPT)
        self.assertIn('"in_progress", "queued"', SCRIPT)
        self.assertIn('"schedule"', SCRIPT)
        # At most one dispatch per watchdog run, by construction.
        self.assertEqual(SCRIPT.count('gh workflow run'), 1)
        self.assertNotIn('issues', SCRIPT)


@unittest.skipIf(os.name == 'nt', 'mocked Bash gh pipeline runs on Linux')
class ScriptTests(unittest.TestCase):
    def run_script(self, runs, gh_exit=0):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'bin').mkdir()
            (root/'runs').write_text(json.dumps({'workflow_runs': runs}))
            (root/'calls').write_text('')
            (root/'bin/gh').write_text('''#!/usr/bin/python3
import os,sys,json
if sys.argv[1]=='api':
    if int(os.environ['MOCK_GH_EXIT']): sys.exit(int(os.environ['MOCK_GH_EXIT']))
    sys.stdout.write(open(os.environ['MOCK_RUNS']).read()); sys.exit(0)
if sys.argv[1]=='workflow':
    with open(os.environ['MOCK_CALLS'],'a') as out: out.write(json.dumps(sys.argv[1:])+'\\n')
    sys.exit(0)
sys.exit(77)
''')
            (root/'bin/gh').chmod(0o755)
            env = {**os.environ, 'PATH': str(root/'bin')+':'+os.environ['PATH'],
                   'GH_TOKEN': 'SECRET_FIXTURE_TOKEN',
                   'PAPER_MONITOR_WATCHDOG_REPOSITORY': 'tajumaru/SuiBa',
                   'MOCK_RUNS': str(root/'runs'), 'MOCK_CALLS': str(root/'calls'),
                   'MOCK_GH_EXIT': str(gh_exit)}
            completed = subprocess.run(['/bin/bash', str(HERE/'paper-monitor-watchdog.sh')],
                                       env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertNotIn('SECRET_FIXTURE', completed.stdout+completed.stderr)
            return [json.loads(line) for line in (root/'calls').read_text().splitlines() if line]

    def test_recent_schedule_is_left_alone(self):
        self.assertEqual(self.run_script([run_record(5)]), [])

    def test_stale_schedule_dispatches_exactly_once(self):
        calls = self.run_script([run_record(120)])
        self.assertEqual(len(calls), 1)
        argv = calls[0]
        self.assertEqual(argv[:2], ['workflow', 'run'])
        self.assertIn('suiba-paper-monitor.yml', argv)
        self.assertIn('confirmation=CHECK-PAPER-MONITOR', argv)
        self.assertEqual(argv[argv.index('--ref')+1], 'main')

    def test_active_run_blocks_dispatch_even_when_stale(self):
        runs = [run_record(180), run_record(150, status='in_progress')]
        self.assertEqual(self.run_script(runs), [])
        runs = [run_record(180), run_record(150, status='queued')]
        self.assertEqual(self.run_script(runs), [])

    def test_recent_dispatch_blocks_a_second_dispatch(self):
        runs = [run_record(120), run_record(10, event='workflow_dispatch')]
        self.assertEqual(self.run_script(runs), [])

    def test_no_history_at_all_dispatches_once(self):
        self.assertEqual(len(self.run_script([])), 1)

    def test_unreadable_history_is_a_silent_no_op(self):
        self.assertEqual(self.run_script([run_record(120)], gh_exit=1), [])


if __name__ == '__main__':
    unittest.main()
