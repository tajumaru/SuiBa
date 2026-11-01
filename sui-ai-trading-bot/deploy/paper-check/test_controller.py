import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('controller.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class FakeBroker:
    decode = staticmethod(json.loads)
    read_trusted = staticmethod(lambda path: path.read_bytes())
    @staticmethod
    def atomic(path, value):
        path.write_text(json.dumps(value))


class StopTests(unittest.TestCase):
    def test_normal_api_failure_docker_hang_oom_and_db_failure(self):
        for failure in (None, 'api', 'stop', 'daemon', 'oom', 'db'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
                ctl = object.__new__(c.Controller)
                ctl.b, ctl.state = FakeBroker, Path(root)
                ctl.record = Path(root)/'run.json'
                ctl.record.write_text('{"status":"in_progress"}')
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

    def test_rejected_preflight_does_not_touch_ordinary_paper(self):
        with tempfile.TemporaryDirectory(prefix='paper-check-test-', dir=Path(__file__).parent) as root:
            ctl = object.__new__(c.Controller)
            ctl.b, ctl.state = FakeBroker, Path(root)
            ctl.record = Path(root)/'run.json'
            self.assertTrue(ctl.stop())
            ctl.record.write_text('{"status":"completed"}')
            self.assertTrue(ctl.stop())


if __name__ == '__main__':
    unittest.main(verbosity=2)
