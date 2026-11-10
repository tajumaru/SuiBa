"""Offline contracts for the production monitor watchdog; mocked gh, no network."""
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
WATCHDOG = (WORKFLOWS/'suiba-production-monitor-watchdog.yml').read_text(encoding='utf-8')
SCRIPT = (HERE/'production-monitor-watchdog.sh').read_text(encoding='utf-8')
MONITOR = (WORKFLOWS/'suiba-production-monitor.yml').read_text(encoding='utf-8')


def stamp(minutes_ago):
    moment = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def run_record(minutes_ago, event='schedule', status='completed'):
    return {'event': event, 'status': status, 'created_at': stamp(minutes_ago)}


class WorkflowTests(unittest.TestCase):
    def test_watchdog_shape_and_minimal_permissions(self):
        self.assertIn("cron: '4,24,44 * * * *'", WATCHDOG)
        self.assertIn('workflow_dispatch:', WATCHDOG)
        self.assertIn('group: suiba-production-monitor-watchdog', WATCHDOG)
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
        self.assertIn('bash sui-ai-trading-bot/docker/production-monitor-watchdog.sh', job)

    def test_gate_follows_the_monitor_gate_variable(self):
        job = WATCHDOG.split('  watchdog:\n', 1)[1]
        expression = re.search(r'    if: >-\n((?:      [^\n]+\n)+)', job).group(1)
        for enabled in ('true', 'false', ''):
            for ref in ('refs/heads/main', 'refs/heads/feature'):
                for event in ('schedule', 'workflow_dispatch', 'push'):
                    expr = expression
                    context = {'vars.SUIBA_PROD_MONITOR_ENABLED': enabled, 'github.ref': ref,
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
        self.assertIn('- CHECK-PROD-MONITOR', MONITOR)
        self.assertIn('group: suiba-production-monitor', MONITOR)
        self.assertIn('suiba-production-monitor.yml', SCRIPT)
        self.assertIn('confirmation=CHECK-PROD-MONITOR', SCRIPT)
        self.assertIn('threshold_seconds=2700', SCRIPT)
        self.assertEqual(SCRIPT.count('gh workflow run'), 1)
        self.assertEqual(re.findall(r'^  (\w+): (read|write)$', WATCHDOG, re.M), [('contents', 'read')])
        self.assertEqual(re.findall(r'^      ([\w-]+): (read|write)$', WATCHDOG, re.M), [('contents', 'read'), ('actions', 'write')])

    def test_schedule_has_no_minute_collisions(self):
        for workflow in WORKFLOWS.glob('*.yml'):
            if workflow.name == 'suiba-production-monitor-watchdog.yml':
                continue
            for field in re.findall(r"""^\s*- cron:\s*['"]([^ ]+)""", workflow.read_text(encoding='utf-8'), re.M):
                # Fail closed if a new schedule introduces a range or step.
                self.assertTrue(all(m.isdigit() for m in field.split(',')), workflow.name)
                self.assertTrue({4, 24, 44}.isdisjoint(map(int, field.split(','))), workflow.name)


@unittest.skipIf(os.name == 'nt', 'mocked Bash gh pipeline runs on Linux')
class ScriptTests(unittest.TestCase):
    def run_script(self, runs, gate='true', failure='', race=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            gh = root/'gh'
            gh.write_text("""#!/usr/bin/python3
import json, os, sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

root = Path(os.environ['FIXTURE'])
args = sys.argv[1:]
with (root/'calls').open('a') as log:
    print(json.dumps(args), file=log)
if args[0] == 'workflow':
    sys.exit(0)
url = urlsplit(args[1])
assert url.path == 'repos/example/repo/actions/workflows/suiba-production-monitor.yml/runs'
query = parse_qs(url.query)
key = 'event' if 'event' in query else 'status'
value, = query[key]
failure = os.environ['FAILURE']
if failure == value:
    sys.exit(1)
if failure == 'json':
    print('{')
    sys.exit(0)
runs = json.loads((root/'runs').read_text())
matches = sorted((r for r in runs if r[key] == value), key=lambda r:r['created_at'], reverse=True)
if os.environ['RACE'] == '1' and value == 'queued':
    seen = root/'checked'
    if seen.exists():
        matches = [{'status':'queued'}]
    seen.touch()
print(json.dumps({'workflow_runs':matches[:1], 'total_count':len(matches)}))
""")
            gh.chmod(0o755)
            (root/'runs').write_text(json.dumps(runs))
            (root/'calls').touch()
            env = {**os.environ, 'PATH': tmp+':'+os.environ['PATH'], 'FIXTURE': tmp,
                   'GH_TOKEN': 'SECRET_FIXTURE', 'SUIBA_PROD_MONITOR_ENABLED': gate,
                   'PROD_MONITOR_WATCHDOG_REPOSITORY': 'example/repo',
                   'FAILURE': failure, 'RACE': str(int(race))}
            proc = subprocess.run(['bash', str(HERE/'production-monitor-watchdog.sh')],
                                  env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(proc.returncode, 0)
            self.assertNotIn('SECRET_FIXTURE', proc.stdout+proc.stderr)
            calls = [json.loads(line) for line in (root/'calls').read_text().splitlines()]
            if gate != 'true':
                self.assertEqual(calls, [])
            return [args for args in calls if args[0] == 'workflow']

    def test_disabled_gate_makes_no_api_calls(self):
        for gate in ('false', ''):
            self.assertEqual(self.run_script([run_record(90)], gate=gate), [])

    def test_either_recent_event_blocks(self):
        for event in ('schedule', 'workflow_dispatch'):
            self.assertEqual(self.run_script([run_record(90), run_record(44, event)]), [])

    def test_threshold_dispatches_once_with_confirmation(self):
        for event in ('schedule', 'workflow_dispatch'):
            self.assertEqual(self.run_script([run_record(45, event)]), [[
                'workflow', 'run', 'suiba-production-monitor.yml', '--repo', 'example/repo',
                '--ref', 'main', '-f', 'confirmation=CHECK-PROD-MONITOR']])

    def test_older_active_run_blocks(self):
        for status in ('queued', 'in_progress', 'pending', 'requested', 'waiting'):
            self.assertEqual(self.run_script([run_record(60), run_record(120, status=status)]), [])

    def test_no_history_or_invalid_record_blocks(self):
        for runs in ([], [dict(run_record(120), created_at='invalid')], [run_record(120, status='unknown')]):
            self.assertEqual(self.run_script(runs), [])

    def test_api_failure_or_invalid_json_blocks(self):
        for failure in ('schedule', 'workflow_dispatch', 'waiting', 'json'):
            self.assertEqual(self.run_script([run_record(120)], failure=failure), [])

    def test_new_queue_at_final_check_blocks(self):
        self.assertEqual(self.run_script([run_record(120)], race=True), [])


if __name__ == '__main__':
    unittest.main()
