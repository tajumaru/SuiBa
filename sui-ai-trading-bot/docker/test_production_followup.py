"""Offline contracts for the production control follow-up read.

The follow-up re-reads the monitor's combined report and prints the
failure summary PR #215 added to it. These tests pin the rendering
(the same lines production-notify.mjs puts in the alert Issue), the
strict shape validation, and the polling rules that keep a healthy
start/stop silent and a previous record's failure from being
re-reported as the current operation's.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location('production_followup', HERE/'production-followup.py')
FOLLOWUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FOLLOWUP)

RUN_ID = 'a1e70ca579d24d679055ad7c177bd7d7'
OLD_RUN_ID = 'fa320242aad145cb9ef25d50f2103969'


def report(state='in_progress', failure=None, run_id=RUN_ID):
    value = {'at': 1794480000, 'verdict': 'ok', 'reasons': [], 'run_id': run_id,
             'prod_state': state, 'watchdog_at': 1794480000}
    if failure is not None:
        value['failure'] = failure
        value['verdict'] = 'attention'
    return value


def failure(status='failed_requires_review', stage='preflight', code='RuntimeError',
            http_status=None, backup='unconfirmed'):
    return {'status': status, 'stage': stage, 'code': code,
            'http_status': http_status, 'backup': backup}


class FailureLinesTests(unittest.TestCase):
    def test_lines_match_the_alert_issue_wording(self):
        self.assertEqual(FOLLOWUP.failure_lines(failure()), [
            '- 失敗段階: `preflight`',
            '- 失敗コード: `RuntimeError`',
            '- バックアップ: 未確認',
        ])

    def test_http_line_only_when_a_status_exists(self):
        self.assertEqual(FOLLOWUP.failure_lines(failure(http_status=500)), [
            '- 失敗段階: `preflight`',
            '- 失敗コード: `RuntimeError`',
            '- HTTP状態: `500`',
            '- バックアップ: 未確認',
        ])

    def test_null_fields_render_as_unknown_and_backup_maps(self):
        lines = FOLLOWUP.failure_lines(failure(stage=None, code=None, backup='confirmed'))
        self.assertEqual(lines[0], '- 失敗段階: `unknown`')
        self.assertEqual(lines[1], '- 失敗コード: `unknown`')
        self.assertEqual(lines[-1], '- バックアップ: 確認済み')
        self.assertEqual(FOLLOWUP.failure_lines(failure(backup='unknown'))[-1], '- バックアップ: 不明')


class ParseReportTests(unittest.TestCase):
    def test_valid_report_with_and_without_failure(self):
        self.assertEqual(FOLLOWUP.parse_report(report()), ('in_progress', RUN_ID, None))
        state, run_id, parsed = FOLLOWUP.parse_report(report('failed_requires_review', failure()))
        self.assertEqual((state, run_id), ('failed_requires_review', RUN_ID))
        self.assertEqual(parsed['stage'], 'preflight')

    def test_malformed_reports_are_no_evidence(self):
        bad_failure = failure()
        bad_failure['detail'] = 'env'
        for value in (None, [], 'x', {}, {'at': 1},
                      report(failure=bad_failure),
                      report(failure=failure(stage='not-a-stage')),
                      report(failure=failure(code='9BAD')),
                      report(failure=failure(http_status=99)),
                      report(failure=failure(backup='maybe')),
                      report(run_id='not-hex'),
                      report(state='exploded')):
            self.assertIsNone(FOLLOWUP.parse_report(value), value)
        extra = report()
        extra['worker'] = {}
        self.assertIsNone(FOLLOWUP.parse_report(extra))


class RunStartTests(unittest.TestCase):
    def drive(self, reports, attempts=7):
        queue = list(reports)
        reads = []

        def read():
            reads.append(1)
            return queue.pop(0) if queue else reports[-1]

        sleeps, blocks = [], []
        result = FOLLOWUP.run('start', read, sleeps.append, blocks.append,
                              attempts=attempts, interval=15)
        return result, len(reads), sleeps, blocks

    def test_failure_on_a_later_poll_prints_once_and_stops(self):
        result, reads, sleeps, blocks = self.drive([
            report(),
            report('failed_requires_review', failure()),
            report('failed_requires_review', failure()),
        ])
        self.assertEqual(result, 0)
        self.assertEqual(reads, 2)
        self.assertEqual(sleeps, [15])
        self.assertEqual(blocks, [FOLLOWUP.failure_lines(failure())])

    def test_healthy_start_stays_silent_for_the_whole_window(self):
        result, reads, sleeps, blocks = self.drive([report()], attempts=3)
        self.assertEqual((result, reads, sleeps, blocks), (0, 3, [15, 15], []))

    def test_previous_closed_record_is_never_re_reported(self):
        # The first reads can still show the record the previous stop
        # closed (completed, with its failure). It is not this start's.
        result, reads, sleeps, blocks = self.drive([
            report('completed', failure(status='completed'), run_id=OLD_RUN_ID),
            report('completed', failure(status='completed'), run_id=OLD_RUN_ID),
            report(),
        ], attempts=3)
        self.assertEqual((result, blocks), (0, []))

    def test_run_seen_live_then_closed_with_failure_prints(self):
        result, reads, sleeps, blocks = self.drive([
            report(),
            report('completed', failure(status='completed')),
        ])
        self.assertEqual(reads, 2)
        self.assertEqual(blocks, [FOLLOWUP.failure_lines(failure(status='completed'))])

    def test_slow_failure_still_prints_at_the_last_poll(self):
        result, reads, sleeps, blocks = self.drive([
            report(),
            report('in_progress', failure(status='in_progress')),
        ], attempts=2)
        self.assertEqual(blocks, [FOLLOWUP.failure_lines(failure(status='in_progress'))])

    def test_unreadable_reports_are_pending_not_errors(self):
        result, reads, sleeps, blocks = self.drive([None, {'junk': 1}, report()], attempts=3)
        self.assertEqual((result, reads, blocks), (0, 3, []))


class RunStopTests(unittest.TestCase):
    def drive(self, value):
        reads, sleeps, blocks = [], [], []

        def read():
            reads.append(1)
            return value

        result = FOLLOWUP.run('stop', read, sleeps.append, blocks.append)
        return result, len(reads), sleeps, blocks

    def test_closed_failed_record_prints(self):
        result, reads, sleeps, blocks = self.drive(report('completed', failure(status='completed')))
        self.assertEqual((result, reads, sleeps), (0, 1, []))
        self.assertEqual(blocks, [FOLLOWUP.failure_lines(failure(status='completed'))])

    def test_healthy_closed_record_and_unclosed_record_stay_silent(self):
        for value in (report('completed'),
                      report('failed_requires_review', failure()),
                      report(),
                      None):
            self.assertEqual(self.drive(value)[3], [], value)


class ReadReportTests(unittest.TestCase):
    def stub(self, root, body):
        script = root/'ssh-prod-status.sh'
        script.write_text('#!/bin/sh\nprintf %s "$STUB_BODY" > "$PRODUCTION_REPORT_FILE"\n')
        return script

    def test_read_goes_through_the_status_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = self.stub(root, None)
            fixture = json.dumps(report('failed_requires_review', failure()))
            env = {'RUNNER_TEMP': tmp, 'STUB_BODY': fixture}
            with mock.patch.dict(os.environ, env), \
                    mock.patch.object(FOLLOWUP, 'STATUS_SCRIPT', script):
                self.assertEqual(FOLLOWUP.read_report(), json.loads(fixture))
            self.assertEqual(list(root.iterdir()), [script])

    def test_unparseable_or_missing_script_reads_as_no_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = self.stub(root, None)
            with mock.patch.dict(os.environ, {'RUNNER_TEMP': tmp, 'STUB_BODY': 'not json'}), \
                    mock.patch.object(FOLLOWUP, 'STATUS_SCRIPT', script):
                self.assertIsNone(FOLLOWUP.read_report())
            with mock.patch.dict(os.environ, {'RUNNER_TEMP': tmp}), \
                    mock.patch.object(FOLLOWUP, 'STATUS_SCRIPT', root/'absent.sh'):
                self.assertIsNone(FOLLOWUP.read_report())


class MainTests(unittest.TestCase):
    def test_invalid_mode_fails_closed(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(FOLLOWUP.main(), 1)
        with mock.patch.dict(os.environ, {'PROD_FOLLOWUP_MODE': 'restart'}):
            self.assertEqual(FOLLOWUP.main(), 1)

    def test_emit_block_writes_log_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = Path(tmp)/'summary'
            out = io.StringIO()
            with mock.patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(summary)}), \
                    mock.patch.object(sys, 'stdout', out):
                FOLLOWUP.emit_block(FOLLOWUP.failure_lines(failure()))
            block = ('### Failure detail (follow-up status read)\n'
                     '- 失敗段階: `preflight`\n'
                     '- 失敗コード: `RuntimeError`\n'
                     '- バックアップ: 未確認\n')
            self.assertEqual(out.getvalue(), block)
            self.assertEqual(summary.read_text(encoding='utf-8'), block)


if __name__ == '__main__':
    unittest.main(verbosity=2)
