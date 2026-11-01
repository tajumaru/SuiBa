import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

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
                good = ctl.stop()
                self.assertEqual(good, failure in (None, 'api'))
                self.assertTrue(any(a[0] == 'stop' for a in calls))
                self.assertIn(['maintenance', True], calls)
                receipt = json.loads((Path(root)/'stop.json').read_text())
                self.assertEqual(receipt['status'], 'clean_stopped' if good else 'failed_state_unknown')

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
