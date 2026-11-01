import importlib.util
import contextlib
import os
import time
import uuid
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('controller.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class FakeBroker:
    @staticmethod
    @contextlib.contextmanager
    def directory(path):
        if os.name == 'nt': yield None
        else:
            fd = os.open(path, os.O_RDONLY|os.O_DIRECTORY)
            try: yield fd
            finally: os.close(fd)
    decode = staticmethod(json.loads)
    read_trusted = staticmethod(lambda path: path.read_bytes())
    @staticmethod
    def atomic(path, value):
        temp = path.with_name(path.name+'.'+uuid.uuid4().hex)
        temp.write_text(json.dumps(value))
        temp.replace(path)


def initialize(ctl):
    FakeBroker.STATE = ctl.state
    record = {'id': 'a'*32, 'status': 'in_progress', 'admitted': True,
              'cutoff': int(time.time()*1000)+1800000, 'controller': {'pid': 99999999, 'start': '0', 'boot': str(uuid.UUID(int=0))}}
    (ctl.state/record['id']).mkdir(exist_ok=True)
    ctl.record = ctl.state/'run.json'
    ctl.record.write_text(json.dumps(record))
    ctl.run_id = record['id']
    ctl.terminate = lambda record: True
    ctl.exited = lambda record: True
    return record


class StopTests(unittest.TestCase):
    def setUp(self):
        if os.name == 'nt':
            flags = patch.object(os, 'O_NOFOLLOW', 0, create=True)
            flags.start(); self.addCleanup(flags.stop)
            @contextlib.contextmanager
            def local_lock(*args, **kwargs): yield
            self.local_lock = patch.object(c.Controller, 'locked', local_lock)
            self.local_lock.start()
            self.addCleanup(self.local_lock.stop)

    def test_normal_api_failure_docker_hang_oom_and_db_failure(self):
        for failure in (None, 'api', 'stop', 'daemon', 'oom', 'db'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
                ctl = object.__new__(c.Controller)
                ctl.b, ctl.state = FakeBroker, Path(root)
                ctl.record = Path(root)/'run.json'
                initialize(ctl)
                calls = []
                class Docker:
                    def call(self, args, **kwargs):
                        calls.append(args)
                        if failure == 'daemon' or (failure == 'stop' and args[0] == 'stop'):
                            raise TimeoutError()
                        return ''
                ctl.docker = Docker()
                def api(*args):
                    calls.append(['api'])
                    if failure == 'api':
                        raise TimeoutError()
                ctl.api = api
                ctl.inspect = lambda: {'State': {'Running': False, 'ExitCode': 0, 'OOMKilled': failure == 'oom'}}
                ctl.maintenance = lambda value: calls.append(['maintenance', value])
                class Helper:
                    def helper(self, *args):
                        if failure == 'db':
                            raise RuntimeError()
                ctl.helper = lambda: (Helper(), 'fixture')
                ctl.verify_sui = lambda: None
                good = ctl.stop()
                self.assertEqual(good, failure in (None, 'api'))
                self.assertTrue(any(a[0] == 'stop' for a in calls))
                self.assertIn(['maintenance', True], calls)
                receipt = json.loads((Path(root)/'stop.json').read_text())
                self.assertEqual(receipt['status'], 'clean_stopped' if good else 'failed_state_unknown')

    def test_health_starting_healthy_unhealthy_timeout(self):
        for outcome in ('healthy', 'unhealthy', 'timeout'):
            ctl = object.__new__(c.Controller)
            values = iter(['starting', 'healthy' if outcome == 'healthy' else 'unhealthy'])
            calls = []
            ctl.inspect = lambda: {'State': {'Running': True, 'OOMKilled': False, 'Health': {'Status': next(values)}}, 'RestartCount': 0}
            ctl.api = lambda *a: calls.append(a) or {'startReady': True}
            with patch.object(c.time, 'monotonic', side_effect=[0, 0, 61] if outcome == 'timeout' else [0, 0, 1]), patch.object(c.time, 'time', return_value=0), patch.object(c.time, 'sleep'):
                if outcome == 'healthy':
                    self.assertTrue(ctl.wait_ready(100000)['startReady'])
                    self.assertEqual(len(calls), 1)
                else:
                    with self.assertRaises(RuntimeError): ctl.wait_ready(100000)
                    self.assertEqual(calls, [])

    def test_release_timeout_retires_helper_before_relatch(self):
        for failure in ('start', 'daemon', None):
            with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
                ctl = object.__new__(c.Controller)
                ctl.b, ctl.state = FakeBroker, Path(root)
                initialize(ctl)
                FakeBroker.DATA = 'fixture-data'
                events = []
                class Docker:
                    def call(self, args, **kwargs):
                        events.append(args[0])
                        if args[0] == 'start' and failure:
                            raise TimeoutError()
                        if args[0] == 'rm' and failure == 'daemon':
                            raise TimeoutError()
                        if args[0] == 'inspect':
                            return '[{"State":{"Running":false,"ExitCode":0,"OOMKilled":false}}]'
                        return ''
                ctl.docker = Docker()
                class Helper:
                    def helper(self, *args): events.append('relatch')
                ctl.helper = lambda: (Helper(), 'fixture')
                if failure:
                    with self.assertRaises(TimeoutError): ctl.maintenance(False)
                else: ctl.maintenance(False)
                if failure == 'daemon':
                    with self.assertRaises(TimeoutError): ctl.maintenance(True)
                    self.assertNotIn('relatch', events)
                    self.assertFalse(json.loads((Path(root)/'release-helper.json').read_text())['retired'])
                else:
                    ctl.maintenance(True)
                    self.assertLess(events.index('rm'), events.index('relatch'))
                    self.assertTrue(json.loads((Path(root)/'release-helper.json').read_text())['retired'])
                # The delayed start target is removed, rather than an untracked
                # running helper able to unlink the newly restored latch.
                self.assertIn('create', events)
                self.assertIn('rm', events)

    def test_termination_failure_and_survival_are_latched(self):
        for failure in ('signal', 'alive'):
            with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
                ctl = object.__new__(c.Controller)
                ctl.b, ctl.state = FakeBroker, Path(root)
                record = initialize(ctl)
                ctl.exited = lambda r: failure != 'alive'
                def terminate(record): raise TimeoutError()
                ctl.terminate = terminate
                ctl.docker = type('Docker', (), {'call': lambda *args, **kwargs: ''})()
                ctl.api = lambda *a: None
                ctl.inspect = lambda: {'State': {'Running': False, 'ExitCode': 0, 'OOMKilled': False}}
                ctl.maintenance = lambda value: None
                ctl.helper = lambda: (type('Helper', (), {'helper': lambda *a: None})(), 'fixture')
                ctl.verify_sui = lambda: None
                self.assertFalse(ctl.stop())
                self.assertEqual(json.loads((ctl.state/'stop.json').read_text())['status'], 'failed_state_unknown')
                # Later successful cleanup must not erase the signal failure.
                ctl.terminate = lambda r: True
                ctl.exited = lambda r: True
                self.assertFalse(ctl.stop())
                for operation in ('unlatch', 'worker-start', 'arm', 'paper-start'):
                    with self.assertRaises(RuntimeError): ctl.guard(operation, lambda: self.fail('mutation admitted after stop'))

    def test_self_stop_is_pending_until_post_stop_confirms_exit(self):
        with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
            ctl = object.__new__(c.Controller)
            ctl.b, ctl.state = FakeBroker, Path(root)
            record = initialize(ctl)
            record['controller']['pid'] = os.getpid()
            ctl.b.atomic(ctl.record, record)
            ctl.exited = lambda r: False
            ctl.docker = type('Docker', (), {'call': lambda *a, **k: ''})()
            ctl.api = lambda *a: None
            ctl.inspect = lambda: {'State': {'Running': False, 'ExitCode': 0, 'OOMKilled': False}}
            ctl.maintenance = lambda value: None
            ctl.helper = lambda: (type('Helper', (), {'helper': lambda *a: None})(), 'fixture')
            ctl.verify_sui = lambda: None
            self.assertTrue(ctl.stop(own=True, source='normal'))
            self.assertEqual(json.loads((ctl.state/'stop.json').read_text())['status'], 'worker_stopped_pending_controller_exit')
            record['status'] = 'finishing'; ctl.b.atomic(ctl.record, record)
            ctl.exited = lambda r: True
            ctl.quiescent = lambda: None
            self.assertTrue(ctl.stop(source='post-stop'))
            self.assertEqual(ctl.current()['status'], 'completed')
            self.assertEqual(json.loads((ctl.state/'stop.json').read_text())['status'], 'clean_stopped')

    @unittest.skipIf(os.name == 'nt', 'actual flock is tested in Linux CI')
    def test_stop_lock_failure_preserves_receipt_and_blocks_reentry(self):
        with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
            ctl = object.__new__(c.Controller)
            ctl.b, ctl.state = FakeBroker, Path(root)
            record = initialize(ctl)
            ctl.b.atomic(ctl.state/'stop.json', {'id': record['id'], 'status':'stopping_state_unknown'})
            original = ctl.locked
            @contextlib.contextmanager
            def no_wait(name, **kwargs):
                with original(name, wait=0): yield
            with original('stop'), patch.object(ctl, 'locked', no_wait):
                self.assertFalse(ctl.stop())
            self.assertEqual(json.loads((ctl.state/'stop.json').read_text())['status'], 'stopping_state_unknown')
            self.assertTrue(ctl.faults(record))
            with self.assertRaises(RuntimeError): ctl.guard('worker-start', lambda: self.fail('unexpected action'))

    def test_stale_stop_cannot_write_new_run(self):
        with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
            ctl = object.__new__(c.Controller)
            ctl.b, ctl.state = FakeBroker, Path(root)
            initialize(ctl)
            with self.assertRaises(RuntimeError): ctl.stop(expected='b'*32)
            self.assertFalse((ctl.state/'stop.json').exists())

    def test_rejected_preflight_does_not_touch_ordinary_paper(self):
        with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
            ctl = object.__new__(c.Controller)
            ctl.b, ctl.state = FakeBroker, Path(root)
            ctl.record = Path(root)/'run.json'
            self.assertTrue(ctl.stop())
            record = initialize(ctl)
            record['status'] = 'completed'
            ctl.record.write_text(json.dumps(record))
            self.assertTrue(ctl.stop())


if __name__ == '__main__':
    unittest.main(verbosity=2)
