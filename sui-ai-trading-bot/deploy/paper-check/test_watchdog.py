"""Offline watchdog checks: no Worker, Docker, sudo or systemd is launched."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watchdog', Path(__file__).with_name('watchdog.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


def healthy():
    status = {'run': {'id': 'a'*32, 'status': 'in_progress', 'started': 1000000, 'stopped': None,
                     'sha': 'e'*40, 'stage': 'monitoring', 'admitted': True},
              'controller_alive': True, 'requires_review': False,
              'worker': {'running': True, 'maintenance': False, 'databaseHealthy': True, 'ledgerOk': True, 'paper': True}}
    evidence = {'service_active': True, 'cutoffs_quiet': True,
                'container': {'running': True, 'oom': False, 'restarts': 0, 'restart': 'no', 'health': 'healthy', 'exit': 0},
                'progress': {'at': 1999, 'status': 'monitoring', 'pair': 'SUI_USDC', 'market_last_success': 1999000},
                'memory_kib': 1024*1024, 'disk_bytes': 30*1024**3, 'disk_inodes': 200000,
                'backup_ok': True, 'lifecycle': 'running', 'latch': False}
    return status, evidence


class WatchdogTests(unittest.TestCase):
    def test_healthy_and_intentionally_stopped_are_normal(self):
        s, e = healthy()
        self.assertEqual(w.assess(s, e, 2000), ('ok', [], 'a'*32))
        s['run'].update(status='completed', stage='stopped')
        s.update(controller_alive=False, worker=None)
        e['container'].update(running=False, health=None)
        e.update(lifecycle='clean', latch=True)
        self.assertEqual(w.assess(s, e, 2000), ('ok', [], 'a'*32))

    def test_not_started_is_silent_and_does_not_query_the_host(self):
        host = SimpleNamespace(status=lambda: {'run': None, 'requires_review': False},
                               collect=lambda *args: self.fail('host reads before first run'))
        result = w.check(host, 2000)
        self.assertEqual(result, {'at': 2000, 'verdict': 'not_started', 'reasons': [], 'run_id': None})
        for value, expected in ((result, ''), ({**result, 'verdict': 'ok'}, 'SUIBA_WATCHDOG_OK\n')):
            out = io.StringIO(); written = []
            with patch.object(w.os, 'geteuid', return_value=0), patch.object(w.sys, 'argv', ['watchdog']), \
                 patch.object(w, 'Host', return_value=host), patch.object(w, 'check', return_value=value), \
                 patch.object(w, 'record', side_effect=written.append), contextlib.redirect_stdout(out):
                self.assertEqual(w.main(), 0)
            self.assertEqual(out.getvalue(), expected)
            self.assertEqual(written, [value])

    def test_each_safety_observation_has_a_fixed_reason_and_never_recovers(self):
        changes = (
            ('controller_alive', False, None, 'CONTROLLER_NOT_RUNNING'),
            ('requires_review', True, None, 'REVIEW_REQUIRED'),
            ('worker', {'reachable': False, 'reason': 'WORKER_UNREACHABLE'}, None, 'WORKER_UNREACHABLE'),
            ('worker', {}, None, 'WORKER_STATE_INVALID'),
            ('running', False, 'worker', 'TRADING_STOPPED'),
            ('maintenance', True, 'worker', 'MAINTENANCE_ENABLED'),
            ('databaseHealthy', False, 'worker', 'DATABASE_UNHEALTHY'),
            ('ledgerOk', False, 'worker', 'LEDGER_UNHEALTHY'),
            ('paper', False, 'worker', 'NOT_PAPER'),
        )
        for key, value, parent, code in changes:
            with self.subTest(code=code):
                s, e = healthy(); (s[parent] if parent else s)[key] = value
                before = copy.deepcopy((s, e))
                verdict, reasons, _ = w.assess(s, e, 2000)
                self.assertEqual(verdict, 'attention'); self.assertIn(code, reasons)
                self.assertEqual((s, e), before)
        for key, value, code in (
            ('service_active', False, 'PROD_SERVICE_INACTIVE'), ('cutoffs_quiet', False, 'CUTOFF_NOT_QUIET'),
            ('progress', {}, 'PROGRESS_STALE'), ('memory_kib', 0, 'HOST_MEMORY_LOW_OR_UNKNOWN'),
            ('disk_bytes', 0, 'HOST_DISK_LOW_OR_UNKNOWN'), ('disk_inodes', 0, 'HOST_DISK_LOW_OR_UNKNOWN'),
            ('backup_ok', False, 'BACKUP_UNCONFIRMED'), ('lifecycle', 'clean', 'LIFECYCLE_UNCONFIRMED'),
            ('latch', True, 'MAINTENANCE_ENABLED'), ('container', None, 'CONTAINER_UNAVAILABLE'),
        ):
            with self.subTest(code=code):
                s, e = healthy(); e[key] = value
                self.assertIn(code, w.assess(s, e, 2000)[1])
        for key, value, code in (
            ('running', False, 'CONTAINER_STOPPED'), ('oom', True, 'CONTAINER_OOM'),
            ('restarts', 1, 'RESTART_POLICY_OR_COUNT'), ('restart', 'always', 'RESTART_POLICY_OR_COUNT'),
            ('health', 'unhealthy', 'CONTAINER_UNHEALTHY'),
        ):
            s, e = healthy(); e['container'][key] = value
            self.assertIn(code, w.assess(s, e, 2000)[1])

    def test_stopped_without_latch_and_failed_runs_need_attention(self):
        s, e = healthy()
        s['run'].update(status='failed_requires_review', stage='monitoring')
        s.update(controller_alive=False, worker=None, requires_review=True)
        e['container']['running'] = False
        e.update(lifecycle='clean', latch=False)
        reasons = w.assess(s, e, 2000)[1]
        self.assertTrue({'RUN_FAILED', 'REVIEW_REQUIRED', 'STOPPED_WITHOUT_LATCH'} <= set(reasons))

    def test_clock_boundaries_nan_and_stale_progress_fail_closed(self):
        for at in (1909, 2001, float('nan'), float('inf'), True, None):
            s, e = healthy(); e['progress']['at'] = at
            self.assertIn('PROGRESS_STALE', w.assess(s, e, 2000)[1])
        for last in (1909999, 2000001, float('nan'), float('inf'), True, None):
            s, e = healthy(); e['progress']['market_last_success'] = last
            self.assertIn('MARKET_STALE', w.assess(s, e, 2000)[1])
        s, e = healthy(); e['progress'].update(at=1910, market_last_success=1910000)
        self.assertEqual(w.assess(s, e, 2000)[0], 'ok')

    def test_preparation_has_a_bounded_grace_not_a_lease_or_recovery(self):
        s, e = healthy(); s['run'].update(started=1990000, stage='worker-start'); s['worker'] = None
        e.pop('progress'); e.pop('backup_ok'); e['container'].update(running=False, health=None)
        self.assertEqual(w.assess(s, e, 2000)[0], 'ok')
        self.assertIn('STARTUP_STALLED', w.assess(s, e, 2171)[1])

    def test_wrapper_failure_and_untrusted_payloads_never_echo_details(self):
        def fail(): raise TimeoutError('SECRET_FIXTURE')
        result = w.check(SimpleNamespace(status=fail), 2000)
        self.assertEqual(result['reasons'], ['STATUS_UNAVAILABLE'])
        for status in ({}, {'run': 'SECRET_FIXTURE', 'requires_review': False},
                       {'run': None, 'requires_review': 'SECRET_FIXTURE'}):
            host = SimpleNamespace(status=lambda: status, collect=lambda *args: {})
            result = w.check(host, 2000)
            self.assertEqual(result['reasons'], ['STATUS_INVALID'])
            self.assertNotIn('SECRET_FIXTURE', json.dumps(result))

    def test_no_prior_result_is_read_and_repeated_checks_are_independent(self):
        s, e = healthy()
        host = SimpleNamespace(status=lambda: s, collect=lambda *args: e)
        with patch.object(w, 'STATE', Path('/must-not-be-read')), patch.object(Path, 'read_text', side_effect=AssertionError('previous result read')):
            first = w.check(host, 2000)
            s['worker'] = {'reachable': False, 'reason': 'WORKER_UNREACHABLE'}
            self.assertIn('WORKER_UNREACHABLE', w.check(host, 2000)['reasons'])
            s['worker'] = healthy()[0]['worker']
            self.assertEqual(w.check(host, 2000), first)

    def test_status_uses_only_the_existing_su_sudo_wrapper_with_fixed_json(self):
        host = w.Host()
        calls = []
        def command(args, request=None):
            calls.append((args, request)); return b'{"run":null,"requires_review":false}'
        host.command = command
        self.assertEqual(host.status(), {'run': None, 'requires_review': False})
        self.assertEqual(calls, [(('/usr/bin/su', '-s', '/bin/sh', 'suiba-deploy', '-c',
                                  '/usr/bin/sudo -n -- /usr/local/sbin/suiba-paper-check'), b'{"operation":"prod-status"}')])

    def test_host_collection_has_only_read_operations_and_never_returns_raw_errors(self):
        s, _ = healthy(); calls = []
        def command(args, request=None):
            calls.append(args)
            raise subprocess.CalledProcessError(1, args, output=b'SECRET_FIXTURE')
        host = w.Host(); host.command = command
        with patch.object(w, 'read_json', side_effect=OSError('SECRET_FIXTURE')), \
             patch.object(Path, 'read_text', side_effect=OSError('SECRET_FIXTURE')):
            result = host.collect(s, 2000)
        self.assertEqual(result, {})
        self.assertEqual(calls, [('/usr/bin/systemctl', 'show', w.SERVICE, *w.CUTOFFS, '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Job'),
                                 ('/usr/bin/docker', 'inspect', w.CONTAINER), ('/usr/bin/docker', 'volume', 'inspect', w.DATA)])

    @unittest.skipIf(os.name == 'nt', 'Linux no-follow and dirfd semantics')
    def test_host_collection_reads_current_generation_metadata_without_writes(self):
        s, _ = healthy()
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)/w.DATA/'_data'; source.mkdir(parents=True)
            host = w.Host()
            def command(args, request=None):
                if args[0] == '/usr/bin/systemctl':
                    return '\n\n'.join('Id='+name+'\nLoadState=loaded\nActiveState='+('active' if name == w.SERVICE else 'inactive')+'\nJob=' for name in (w.SERVICE, *w.CUTOFFS)).encode()
                if args[1] == 'inspect':
                    return json.dumps([{'State': {'Running': True, 'OOMKilled': False, 'ExitCode': 0, 'Health': {'Status': 'healthy'}},
                                        'RestartCount': 0, 'HostConfig': {'RestartPolicy': {'Name': 'no'}}}]).encode()
                return json.dumps([{'Name': w.DATA, 'Mountpoint': str(source)}]).encode()
            host.command = command
            generation = [1999]
            def read(path, **kwargs):
                if str(path).endswith('progress.json'):
                    return healthy()[1]['progress'], SimpleNamespace(st_mtime=generation[0])
                if str(path).endswith('prod.json'):
                    return {'id': 'a'*32, 'started': 1000000, 'backup': {'file': 'paper-check-'+'b'*32+'.tar', 'sha256': 'e'*64}}, None
                self.assertEqual(str(path), 'bot.sqlite.lifecycle.json')
                self.assertEqual(kwargs['owner'], 1000)
                self.assertIsInstance(kwargs['directory_fd'], int)
                return {'mode': 'PAPER', 'state': 'running'}, None
            archive = SimpleNamespace(st_mode=0o100600, st_uid=0, st_nlink=1, st_size=100, st_mtime=1500)
            space = SimpleNamespace(f_bavail=30*1024**3, f_frsize=1, f_favail=200000)
            before = sorted(Path(tmp).rglob('*'))
            with patch.object(w, 'read_json', side_effect=read), patch.object(Path, 'read_text', return_value='MemAvailable: 1048576 kB\n'), \
                 patch.object(Path, 'lstat', return_value=archive), patch.object(os, 'statvfs', return_value=space):
                evidence = host.collect(s, 2000)
                self.assertEqual(w.assess(s, evidence, 2000)[0], 'ok')
                generation[0] = 999
                self.assertNotIn('progress', host.collect(s, 2000))
            self.assertEqual(before, sorted(Path(tmp).rglob('*')))

    @unittest.skipIf(os.name == 'nt', 'Linux no-follow and dirfd semantics')
    def test_bounded_file_reader_rejects_symlinks_and_oversized_payloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); good = root/'good.json'
            good.write_text('{"ok":true}'); good.chmod(0o600)
            self.assertEqual(w.read_json(good, owner=os.geteuid())[0], {'ok': True})
            link = root/'link'; link.symlink_to(good)
            with self.assertRaises(OSError): w.read_json(link, owner=os.geteuid())
            with self.assertRaises(ValueError): w.read_json(good, owner=os.geteuid(), maximum=2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
