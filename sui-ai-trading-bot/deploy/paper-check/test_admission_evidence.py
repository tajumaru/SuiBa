"""Offline admission evidence contracts; no Worker, Docker or service mutation."""
import contextlib
import importlib.util
import json
import os
import runpy
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('controller', HERE/'controller.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class AdmissionEvidenceTests(unittest.TestCase):
    def fixture(self, root):
        root = Path(root)
        ctl = object.__new__(c.Controller)
        ctl.state, ctl.record = root, root/'run.json'
        def atomic(path, value): path.write_text(json.dumps(value), encoding='utf-8')
        @contextlib.contextmanager
        def regular(path):
            with open(path, 'rb') as stream: yield stream
        def read_trusted(path, maximum=65536):
            raw = path.read_bytes()
            if len(raw) > maximum: raise ValueError('fixture size limit')
            return raw
        ctl.b = SimpleNamespace(STATE=root, atomic=atomic, decode=json.loads,
            read_trusted=read_trusted,
            directory=lambda path: contextlib.nullcontext(), regular=regular)
        ctl.locked = lambda *args, **kwargs: contextlib.nullcontext()
        ctl.faults = lambda record: False
        (root/'lock').touch()
        policy = root/'policy.json'
        atomic(policy, {'enabled': True, 'mode': 'sui-30m'})
        return ctl, policy

    def test_quiescent_refusal_records_observed_timer_without_creating_a_run(self):
        with tempfile.TemporaryDirectory() as root:
            ctl, policy = self.fixture(root)
            with patch.object(c, 'POLICY', policy), patch.object(c.subprocess, 'check_output',
                    return_value=b'ActiveState=active\nJob=0\n'):
                with self.assertRaises(c.AdmissionRejected) as failure: ctl.admit_session()
            self.assertEqual(failure.exception.code, 'ADMISSION_QUIESCENT')
            evidence = ctl.admission_failure()
            self.assertEqual(evidence['observed'], {'unit': c.TIMER, 'active_state': 'active', 'job_pending': False})
            self.assertFalse(ctl.record.exists())
            self.assertEqual(ctl.status()['admission_failure'], evidence)
            self.assertEqual(ctl.diagnose_locked()['admission_failure'], evidence)
            self.assertFalse((ctl.state/'paper-check.json').exists())

    @unittest.skipIf(os.name == 'nt', 'real Linux flock')
    def test_existing_retry_permit_is_preserved_and_exposed_by_diagnose(self):
        with tempfile.TemporaryDirectory() as root:
            ctl, _ = self.fixture(root)
            record = {'id': 'a'*32, 'status': 'failed_requires_review'}
            ctl.record.write_text(json.dumps(record))
            (ctl.state/record['id']).mkdir()
            permit = ctl.state/record['id']/'retry-approved.json'
            permit.write_text(json.dumps({'id': record['id']}))
            ctl.current = lambda: record
            ctl.diagnose_locked = lambda: {'run': record, 'stop': {'status': 'clean_stopped'}, 'requires_review': False}
            with self.assertRaises(c.AdmissionRejected) as failure: ctl.approve_retry(record['id'])
            self.assertEqual(failure.exception.code, 'RETRY_ALREADY_APPROVED')
            evidence = ctl.diagnose()['admission_failure']
            self.assertTrue(evidence['observed']['permit_exists'])
            self.assertEqual(ctl.status()['admission_failure'], evidence)
            self.assertEqual(json.loads(permit.read_text()), {'id': record['id']})

    def test_error_text_and_invalid_evidence_never_escape(self):
        with tempfile.TemporaryDirectory() as root:
            ctl, policy = self.fixture(root)
            ctl.take_start_request = lambda: (_ for _ in ()).throw(RuntimeError('SECRET_FIXTURE'))
            with patch.object(c, 'POLICY', policy):
                with self.assertRaises(c.AdmissionRejected): ctl.admit_session()
            self.assertNotIn('SECRET_FIXTURE', json.dumps(ctl.status()))
            ctl.b.atomic(ctl.state/'admission-failure.json', {'secret': 'SECRET_FIXTURE'})
            self.assertEqual(ctl.admission_failure(), {'code': 'ADMISSION_EVIDENCE_INVALID'})

    def test_ssh_reason_filter_accepts_only_exact_allowlisted_codes(self):
        helper = HERE.parents[1]/'docker/paper-fixed-reason.py'
        scope = {}
        exec(compile(helper.read_text(), str(helper), 'exec'), {'__name__': 'test'}, scope)
        self.assertEqual(scope['CODES'], c.ADMISSION_CODES)
        with tempfile.TemporaryDirectory() as root:
            errors = Path(root)/'stderr'
            for raw, expected in [('PAPER_CHECK_REASON=RETRY_ALREADY_APPROVED\nSECRET_FIXTURE', 'RETRY_ALREADY_APPROVED\n'),
                                  ('PAPER_CHECK_REASON=SECRET_FIXTURE', ''),
                                  ('PAPER_CHECK_REASON=RETRY_ALREADY_APPROVED payload', ''),
                                  ('x'*8193, '')]:
                errors.write_text(raw)
                result = subprocess.run([sys.executable, str(helper), str(errors)], capture_output=True, text=True, check=True)
                self.assertEqual(result.stdout, expected)
                self.assertNotIn('SECRET_FIXTURE', result.stderr)

    def test_two_different_refusals_remain_in_order_and_diagnostics(self):
        with tempfile.TemporaryDirectory() as root:
            ctl, policy = self.fixture(root)
            with patch.object(c, 'POLICY', policy), patch.object(c.subprocess, 'check_output',
                    return_value=b'ActiveState=active\nJob=0\n'):
                with self.assertRaises(c.AdmissionRejected): ctl.admit_session()
                first = ctl.admission_failure()
                ctl.take_start_request = lambda: (_ for _ in ()).throw(RuntimeError('SECRET_FIXTURE'))
                with self.assertRaises(c.AdmissionRejected): ctl.admit_session()
            latest = ctl.admission_failure()
            expected = [first, latest]
            self.assertEqual([v['code'] for v in expected], ['ADMISSION_QUIESCENT', 'ADMISSION_START_REQUEST'])
            self.assertEqual(json.loads((ctl.state/'admission-failures.json').read_text()), expected)
            for report in (ctl.status(), ctl.diagnose_locked()):
                self.assertEqual(report['admission_failure'], latest)
                self.assertEqual(report['admission_failures'], expected)
                self.assertNotIn('SECRET_FIXTURE', json.dumps(report))
            renderer = runpy.run_path(str(HERE.parents[1]/'docker/paper-fixed-reason.py'))
            lines = renderer['admission_history_summary'](expected+[{'secret': 'SECRET_FIXTURE'}])
            text = '\n'.join(lines)
            self.assertLess(text.index('ADMISSION_QUIESCENT'), text.index('ADMISSION_START_REQUEST'))
            self.assertNotIn('SECRET_FIXTURE', text)

    def test_sixth_refusal_drops_only_the_oldest_and_keeps_the_byte_limit(self):
        codes = ['ADMISSION_POLICY', 'ADMISSION_LOCK', 'ADMISSION_START_REQUEST',
                 'ADMISSION_ABORT_INHIBIT', 'ADMISSION_QUIESCENT', 'ADMISSION_FRESH_GATE']
        with tempfile.TemporaryDirectory() as root:
            ctl, _ = self.fixture(root)
            for i, code in enumerate(codes):
                with patch.object(c.time, 'time', return_value=i+1):
                    with self.assertRaises(c.AdmissionRejected):
                        with ctl.admission_evidence('admit'):
                            ctl.admission_step(code)
                            raise RuntimeError('SECRET_FIXTURE')
            history = ctl.status()['admission_failures']
            self.assertEqual([v['code'] for v in history], codes[1:])
            self.assertEqual(ctl.admission_failure(), history[-1])
            self.assertLessEqual((ctl.state/'admission-failures.json').stat().st_size, 4096)
            # A valid but large old entry cannot force a higher read limit.
            large = {**history[0], 'at': int('9'*3900)}
            ctl.b.atomic(ctl.state/'admission-failures.json', [large])
            for _ in range(5):
                with self.assertRaises(c.AdmissionRejected):
                    with ctl.admission_evidence('admit'):
                        raise RuntimeError('SECRET_FIXTURE')
            bounded = ctl.admission_failures()
            self.assertNotIn(large, bounded)
            self.assertEqual(len(bounded), 5)
            self.assertLessEqual((ctl.state/'admission-failures.json').stat().st_size, 4096)

    def test_corrupt_history_never_breaks_admission_or_status(self):
        for corruption in ('{broken', '{"secret":"SECRET_FIXTURE"}', '[{"secret":"SECRET_FIXTURE"}]', '['+' '*4096+']'):
            with self.subTest(corruption=corruption[:12]), tempfile.TemporaryDirectory() as root:
                ctl, policy = self.fixture(root)
                path = ctl.state/'admission-failures.json'
                path.write_text(corruption)
                with patch.object(c, 'POLICY', policy), patch.object(c.subprocess, 'check_output',
                        return_value=b'ActiveState=active\nJob=0\n'):
                    with self.assertRaises(c.AdmissionRejected) as failure: ctl.admit_session()
                self.assertEqual(failure.exception.code, 'ADMISSION_QUIESCENT')
                latest = ctl.admission_failure()
                self.assertEqual(ctl.status()['admission_failures'], [latest])
                # A subsequent broken history also falls back without requiring a new failure.
                path.write_text(corruption)
                self.assertEqual(ctl.status()['admission_failures'], [latest])
                self.assertEqual(ctl.diagnose_locked()['admission_failures'], [latest])
                ctl.b.Broker = lambda **kwargs: SimpleNamespace(check_paper_session=lambda: None)
                ctl.quiescent = lambda: None
                ctl.identity = lambda pid: ({'pid': 42, 'start': '0', 'boot': '00000000-0000-0000-0000-000000000000'}, 'S')
                with patch.object(c, 'POLICY', policy): record, _, _ = ctl.admit_session()
                self.assertEqual(record['status'], 'in_progress')
                self.assertEqual(ctl.status()['admission_failures'], [latest])
                self.assertEqual(ctl.status()['admission_failure'], latest)
                self.assertNotIn('SECRET_FIXTURE', json.dumps(ctl.status()))


if __name__ == '__main__': unittest.main(verbosity=2)
