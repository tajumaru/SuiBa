"""Public export contracts: no live DB, remote SSH, Worker, or service calls."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


e = load('snapshot_export', HERE/'export_snapshot.py')
c = load('controller', HERE/'controller.py')
client = load('public_package', HERE.parents[1]/'docker/public-snapshot-package.py')
SECRET = 'SECRET_FIXTURE_TOKEN_DO_NOT_EXPORT'
NOW_MS = int(time.time() * 1000)


class ExportTests(unittest.TestCase):
    def test_host_stop_codes_survive_the_public_event_export(self):
        for code in ('EXTERNAL_STOP', 'WORKER_OOM', 'WORKER_EXITED', 'WORKER_EXITED_CLEAN', 'UNKNOWN'):
            with self.subTest(code=code):
                self.assertEqual(e.sanitize('operation_events', {'kind': 'STOP', 'code': code})['code'], code)

    def test_shadow_sanitize(self):
        raw = {'cycleId': 'private-cycle', 'status': 'OK', 'action': 'BUY',
               'confidence': .8, 'model': SECRET, 'promptVersion': 'shadow-s1-v1',
               'ruleAction': 'WAIT', 'selectedRule': 'NO_SIGNAL', 'conditionCount': 2,
               'candleTimestamp': 300, 'calledAt': 600000, 'latencyMs': 10,
               'usage': {'inputTokens': 10, 'outputTokens': 5, 'cost': 0, 'secret': SECRET},
               'snapshot': {'evidence': {'inputs': {'price': 2}, 'thresholds': {'oversold': 30}},
                            'candles': [SECRET], 'settings': {'key': SECRET}},
               'prompt': SECRET, 'apiKey': SECRET,
               'rationale': {'text': SECRET, 'refs': [
                   {'type': 'book', 'key': 'bid', 'value': 1.99},
                   {'type': 'condition', 'key': 'emaUp', 'value': True},
                   {'type': 'book', 'key': SECRET, 'value': 1},
                   {'type': SECRET, 'key': 'bid', 'value': 1},
                   {'type': 'book', 'key': 'ask', 'value': SECRET}]}}
        out = e.sanitize('shadow_decisions', raw)
        self.assertNotIn(SECRET, json.dumps(out))
        for key in ('model', 'snapshot', 'settings', 'prompt', 'apiKey'):
            self.assertNotIn(key, out)
        self.assertEqual(out['promptVersion'], 'shadow-s1-v1')
        self.assertEqual(out['price'], 2)
        self.assertEqual(out['rationale'], {'refs': [{'type': 'book', 'key': 'bid', 'value': 1.99}]})
        self.assertEqual(e.sanitize('shadow_decisions', out, public=True), out)
        raw['promptVersion'] = SECRET
        self.assertNotIn('promptVersion', e.sanitize('shadow_decisions', raw))
        self.assertIn('shadow_decisions', e.TABLES)

    def test_shadow_owner_approved_model_and_prompt_version_allowlists(self):
        for model in ('gpt-5.4-nano', 'gpt-5.4-mini', 'arbitrary-secret-model'):
            out = e.sanitize('shadow_decisions', {'status': 'OK', 'model': model, 'promptVersion': 'shadow-openai-nano-v1'})
            self.assertEqual(out.get('model'), model if model == 'gpt-5.4-nano' else None)
            self.assertEqual(out['promptVersion'], 'shadow-openai-nano-v1')
            self.assertEqual(e.sanitize('shadow_decisions', out, public=True), out)
        self.assertNotIn('promptVersion', e.sanitize('shadow_decisions', {'promptVersion': 'unknown'}))
        for code in ('SHADOW_API_KEY_MISSING', 'OPENAI_REFUSAL', 'OPENAI_RATE_LIMITED'):
            self.assertEqual(e.sanitize('shadow_decisions', {'status': 'ERROR', 'reasonCode': code})['reasonCode'], code)

    def fixture(self, root, wal=False):
        root = Path(root)
        path = root/'bot.sqlite'
        db = sqlite3.connect(path)
        if wal: db.execute('PRAGMA journal_mode=WAL')
        records = {
            'shadow_decisions': {'cycleId': 'cycle', 'status': 'OK', 'action': 'BUY', 'model': SECRET, 'promptVersion': 'shadow-s1-v1', 'rationale': {'text': SECRET, 'refs': []}},
            'strategy_decisions': {'action': 'BUY', 'reason': SECRET, 'apiKey': SECRET, 'stopLossPct': 0.12345,
                'analysisContext': {'cycleId': 'cycle', 'runningAtAnalysis': True},
                'evidence': {'version': 1, 'candleTimestamp': 300, 'evaluatedAt': 600000, 'selectedRule': 'BUY_SIGNAL',
                    'thresholds': {'oversold': 30, 'secret': SECRET}, 'conditions': {'emaUp': True, SECRET: True},
                    'inputs': {'price': 1, 'current': {'rsi': 40, 'secret': SECRET}}}},
            'technical_indicators': {'rsi': 40, 'secret': SECRET},
            'operation_candidates': {'orderId': 'order-'+SECRET, 'side': 'BUY', 'finalAction': 'BUY', 'minProfitUsdc': '0.12345', 'requestedInputAtomic': '1000000', 'reason': SECRET},
            'paper_orders': {'side': 'BUY', 'status': 'FILLED', 'quote': {'amountIn': '1000000', 'route': [SECRET], 'headers': {'Authorization': SECRET}}},
            'paper_trades': {'orderId': 'order-'+SECRET, 'side': 'SELL', 'fee': 0.01, 'realizedProfitUsdc': '1.2', 'costs': {'gasUsdc': '0.01', 'secret': SECRET}},
            'operation_events': {'kind': 'STOP', 'code': SECRET, 'payload': SECRET},
            'cycle_audits': {'cycleId': 'cycle', 'phase': 'END', 'candidateId': 'candidate'},
            'bot_settings': {'token': SECRET}, 'bot_runtime_state': {'token': SECRET}, 'auth_sessions': {'token': SECRET},
        }
        for table, value in records.items():
            db.execute(f'CREATE TABLE {table}(id TEXT PRIMARY KEY,timestamp INTEGER,json TEXT)')
            row_id = {'shadow_decisions': 'cycle', 'strategy_decisions': 'cycle', 'technical_indicators': 'cycle', 'operation_candidates': 'candidate', 'paper_orders': 'order-'+SECRET, 'paper_trades': 'order-'+SECRET}.get(table, table)
            db.execute(f'INSERT INTO {table} VALUES(?,?,?)', (row_id, NOW_MS, json.dumps(value)))
        db.commit()
        if not wal: db.close()
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            archive.add(path, arcname='./bot.sqlite')
            if wal: archive.add(str(path)+'-wal', arcname='./bot.sqlite-wal')
            raw = SECRET.encode()
            member = tarfile.TarInfo('./auth.json'); member.size = len(raw)
            archive.addfile(member, io.BytesIO(raw))
        if wal: db.close()
        raw = stream.getvalue()
        record = {'id': 'a'*32, 'status': 'completed', 'started': NOW_MS, 'duration': '6h', 'sha': 'b'*40,
                  'backup': {'file': 'paper-check-'+'c'*32+'.tar', 'sha256': hashlib.sha256(raw).hexdigest()}, 'secret': SECRET}
        return raw, record

    def test_manifest_mismatch_is_rejected_before_archive_parsing(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw, record = self.fixture(tmp)
            record['backup']['sha256'] = '0'*64
            with self.assertRaises(e.ExportError) as error: e.build_export(io.BytesIO(raw), record)
            self.assertEqual(error.exception.code, 'EXPORT_MANIFEST_MISMATCH')

    def test_only_allowlisted_tables_and_fields_are_exported_and_join_ids_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw, record = self.fixture(tmp)
            package = e.build_export(io.BytesIO(raw), record)
            zip_path = Path(tmp)/'public.zip'; zip_path.write_bytes(package)
            output = Path(tmp)/'public'
            self.assertEqual(client.unpack(zip_path, output), 1)
            self.assertEqual({p.name for p in output.iterdir()}, {'manifest.json', 'SUI_USDC.sqlite'})
            self.assertNotIn(SECRET.encode(), b''.join(p.read_bytes() for p in output.iterdir()))
            db = sqlite3.connect(output/'SUI_USDC.sqlite')
            try:
                self.assertEqual({r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}, set(e.TABLES))
                decision_id, decision = db.execute('SELECT id,json FROM strategy_decisions').fetchone()
                self.assertEqual(decision_id, db.execute('SELECT id FROM technical_indicators').fetchone()[0])
                self.assertEqual(decision_id, db.execute('SELECT id FROM shadow_decisions').fetchone()[0])
                self.assertNotIn('thresholds', json.loads(decision)['evidence'])
                self.assertNotIn('stopLossPct', json.loads(decision))
                candidate = json.loads(db.execute('SELECT json FROM operation_candidates').fetchone()[0])
                self.assertNotIn('minProfitUsdc', candidate)
                self.assertEqual(candidate['orderId'], db.execute('SELECT id FROM paper_orders').fetchone()[0])
                self.assertEqual(json.loads(db.execute('SELECT json FROM operation_events').fetchone()[0])['code'], 'REDACTED')
            finally: db.close()
            manifest = json.loads((output/'manifest.json').read_text())
            self.assertEqual(manifest['scope'], 'PRE_RUN_BACKUP_PUBLIC_EXTRACT')
            self.assertEqual(manifest['sourceArchiveSha256'], record['backup']['sha256'])
            self.assertEqual(manifest['version'], 2)
            self.assertEqual(manifest['window']['to'] - manifest['window']['from'], e.WINDOW_MS)
            self.assertLessEqual(manifest['window']['from'], NOW_MS)
            self.assertGreaterEqual(manifest['window']['to'], NOW_MS)

    def test_export_keeps_window_rows_and_excludes_older_history_under_row_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root/'bot.sqlite'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE shadow_decisions(id TEXT PRIMARY KEY,timestamp INTEGER,json TEXT)')
            db.execute('CREATE INDEX shadow_decisions_timestamp ON shadow_decisions(timestamp)')
            old_at = NOW_MS - e.WINDOW_MS - 1
            raw = json.dumps({'status': 'OK', 'action': 'WAIT'})
            # The former unbounded loop trips ROW_LIMIT on this history before
            # reaching the current row. The indexed window query reads one row.
            db.executemany('INSERT INTO shadow_decisions VALUES(?,?,?)',
                           ((f'old-{index}', old_at, raw) for index in range(e.ROW_LIMIT + 1)))
            db.execute('INSERT INTO shadow_decisions VALUES(?,?,?)', ('current', NOW_MS, raw))
            db.commit(); db.close()
            legacy = sqlite3.connect(path)
            try:
                with self.assertRaises(e.ExportError) as error:
                    total_rows = 0
                    for _ in legacy.execute('SELECT id,timestamp,json FROM shadow_decisions ORDER BY timestamp,id'):
                        total_rows += 1
                        e.check(total_rows <= e.ROW_LIMIT, 'EXPORT_LIMIT_EXCEEDED')
                self.assertEqual(error.exception.code, 'EXPORT_LIMIT_EXCEEDED')
                self.assertEqual(total_rows, e.ROW_LIMIT + 1)
            finally:
                legacy.close()
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w') as archive:
                archive.add(path, arcname='./bot.sqlite')
            archive_raw = stream.getvalue()
            record = {'id': 'a'*32, 'status': 'completed', 'started': NOW_MS, 'duration': '24h',
                      'backup': {'sha256': hashlib.sha256(archive_raw).hexdigest()}}
            with patch.object(e.time, 'time', return_value=NOW_MS / 1000):
                package = e.build_export(io.BytesIO(archive_raw), record)
            with zipfile.ZipFile(io.BytesIO(package)) as archive:
                manifest = json.loads(archive.read('manifest.json'))
                exported_path = root/'exported.sqlite'
                exported_path.write_bytes(archive.read('SUI_USDC.sqlite'))
            exported = sqlite3.connect(exported_path)
            try:
                rows = exported.execute('SELECT id,timestamp FROM shadow_decisions').fetchall()
            finally:
                exported.close()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0], (e.identifier('current'), NOW_MS))
            self.assertEqual(manifest['files']['SUI_USDC.sqlite']['rows']['shadow_decisions'], 1)
            self.assertEqual(manifest['window'], {'from': NOW_MS - e.WINDOW_MS, 'to': NOW_MS})
            self.assertLess(len(package), e.EXPORT_LIMIT)

    def test_episode_summary_survives_sanitization(self):
        event = {'kind': 'STOP', 'code': 'PAPER_RECOVERY_EXHAUSTED', 'fatal': False,
                 'episode': {'startedAt': 1000, 'endedAt': 183000, 'durationMs': 182000,
                             'failures': 3, 'lastFailureAt': 61000, 'outcome': 'EXHAUSTED',
                             'tally': {'DeepBook Indexer/UPSTREAM_NETWORK_FAILED': 2,
                                       'Sui gRPC/SUI_READ_FAILED': 1},
                             'note': SECRET},
                 'details': {'reasonDetail': SECRET}}
        out = e.sanitize('operation_events', event)
        self.assertEqual(out['code'], 'PAPER_RECOVERY_EXHAUSTED')
        self.assertEqual(out['episode'], {'startedAt': 1000, 'endedAt': 183000,
            'durationMs': 182000, 'failures': 3, 'lastFailureAt': 61000,
            'outcome': 'EXHAUSTED', 'tally': {'DeepBook Indexer/UPSTREAM_NETWORK_FAILED': 2,
            'Sui gRPC/SUI_READ_FAILED': 1}})
        self.assertNotIn(SECRET, json.dumps(out))
        for closing in ('PAPER_NETWORK_RECOVERED', 'PROCESS_RESTART_STOPPED', 'PAPER_NETWORK_PAUSED'):
            kept = e.sanitize('operation_events', {'kind': 'CONTROL', 'code': closing})
            self.assertEqual(kept['code'], closing)

    def test_malformed_episode_is_dropped_but_the_event_survives(self):
        event = {'kind': 'CONTROL', 'code': 'PAPER_NETWORK_RECOVERED',
                 'episode': {'startedAt': 'soon', 'outcome': 'WEIRD',
                             'tally': {'bad key': 1, 'MarketData/CANDLE_STALE': 'many',
                                       'DeepBook Indexer/UPSTREAM_TIMEOUT': 2}}}
        out = e.sanitize('operation_events', event)
        self.assertEqual(out['kind'], 'CONTROL')
        self.assertEqual(out['code'], 'PAPER_NETWORK_RECOVERED')
        self.assertEqual(out.get('episode'), {'tally': {'DeepBook Indexer/UPSTREAM_TIMEOUT': 2}})
        gone = e.sanitize('operation_events', {'kind': 'BOOT', 'code': 'PROCESS_RESTART_STOPPED',
                                               'episode': 'not-a-dict'})
        self.assertNotIn('episode', gone)

    def test_episode_summary_reaches_the_exported_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root/'bot.sqlite'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE operation_events(id TEXT PRIMARY KEY,timestamp INTEGER,json TEXT)')
            event = {'timestamp': NOW_MS, 'kind': 'STOP', 'code': 'PAPER_RECOVERY_EXHAUSTED',
                     'episode': {'startedAt': 1000, 'endedAt': 183000, 'durationMs': 182000,
                                 'failures': 1, 'lastFailureAt': 3000, 'outcome': 'EXHAUSTED',
                                 'tally': {'MarketData/SPREAD_TOO_WIDE': 1}}}
            db.execute('INSERT INTO operation_events VALUES(?,?,?)', ('event-1', NOW_MS, json.dumps(event)))
            db.commit(); db.close()
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w') as archive:
                archive.add(path, arcname='./bot.sqlite')
            raw = stream.getvalue()
            record = {'id': 'a'*32, 'status': 'completed', 'started': NOW_MS, 'duration': '24h',
                      'sha': 'b'*40, 'backup': {'file': 'paper-check-'+'c'*32+'.tar',
                      'sha256': hashlib.sha256(raw).hexdigest()}}
            package = e.build_export(io.BytesIO(raw), record)
            with zipfile.ZipFile(io.BytesIO(package)) as archive:
                out_path = root/'exported.sqlite'
                out_path.write_bytes(archive.read('SUI_USDC.sqlite'))
                exported = sqlite3.connect(out_path)
                row = json.loads(exported.execute('SELECT json FROM operation_events').fetchone()[0])
                exported.close()
            self.assertEqual(row['episode']['outcome'], 'EXHAUSTED')
            self.assertEqual(row['episode']['tally'], {'MarketData/SPREAD_TOO_WIDE': 1})
            self.assertEqual(row['episode']['lastFailureAt'], 3000)

    def test_wal_is_recovered_only_in_the_disposable_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw, record = self.fixture(tmp, wal=True)
            result = e.build_export(io.BytesIO(raw), record)
            with zipfile.ZipFile(io.BytesIO(result)) as archive:
                manifest = json.loads(archive.read('manifest.json'))
            self.assertEqual(manifest['files']['SUI_USDC.sqlite']['rows']['paper_trades'], 1)

    def test_active_run_export_performs_no_worker_service_or_latch_operation(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw, record = self.fixture(tmp)
            record['status'] = 'in_progress'
            archive = Path(tmp)/record['backup']['file']; archive.write_bytes(raw)
            ctl = object.__new__(c.Controller)
            ctl.current = lambda: record
            @contextlib.contextmanager
            def regular(path):
                with open(path, 'rb') as stream: yield stream.fileno()
            ctl.b = SimpleNamespace(BACKUPS=Path(tmp), regular=regular, read_trusted=lambda path, maximum: path.read_bytes())
            forbidden = lambda *args, **kwargs: self.fail('live operation called')
            ctl.docker = SimpleNamespace(call=forbidden)
            ctl.helper = ctl.system = ctl.api = ctl.maintenance = ctl.stop = forbidden
            before = {p.name: p.read_bytes() for p in Path(tmp).iterdir()}
            with patch.object(c, 'EXPORT_PROGRAM', HERE/'export_snapshot.py'):
                self.assertTrue(ctl.export_snapshot().startswith(b'PK'))
            self.assertEqual(before, {p.name: p.read_bytes() for p in Path(tmp).iterdir()})

    def test_tar_links_and_traversal_are_rejected(self):
        for name, kind in (('../bot.sqlite', tarfile.REGTYPE), ('bot.sqlite', tarfile.SYMTYPE)):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w') as archive:
                member = tarfile.TarInfo(name); member.type = kind; member.linkname = '/secret'
                archive.addfile(member)
            raw = stream.getvalue()
            record = {'id': 'a'*32, 'status': 'completed', 'backup': {'sha256': hashlib.sha256(raw).hexdigest()}}
            with self.assertRaises(e.ExportError) as error: e.build_export(io.BytesIO(raw), record)
            self.assertEqual(error.exception.code, 'EXPORT_ARCHIVE_INVALID')

    def test_client_rejects_tampering_and_does_not_publish_partial_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw, record = self.fixture(tmp)
            original = zipfile.ZipFile(io.BytesIO(e.build_export(io.BytesIO(raw), record)))
            package = Path(tmp)/'tampered.zip'
            with zipfile.ZipFile(package, 'w') as target:
                for name in original.namelist(): target.writestr(name, original.read(name)+(b'bad' if name.endswith('.sqlite') else b''))
            destination = Path(tmp)/'public'
            with self.assertRaises(ValueError): client.unpack(package, destination)
            self.assertFalse(destination.exists())

    def test_workflow_is_gated_and_public_artifact_retention_is_seven_days(self):
        workflow = HERE.parents[2]/'.github/workflows/suiba-paper-export.yml'
        text = workflow.read_text()
        for value in ("environment: sakura-vps", "vars.SUIBA_PAPER_EXPORT_ENABLED == 'true'", "github.ref == 'refs/heads/main'", "retention-days: 7", "if-no-files-found: error"):
            self.assertIn(value, text)
        self.assertNotIn('always()', text)

    @unittest.skipIf(os.name == 'nt', 'mocked Bash pipeline runs on Linux')
    def test_fixed_ssh_request_artifact_boundary_and_safe_errors(self):
        for outcome in ('success', 'mismatch', 'unknown'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                raw, record = self.fixture(tmp)
                package = root/'source.zip'; package.write_bytes(e.build_export(io.BytesIO(raw), record))
                (root/'bin').mkdir(); (root/'runner').mkdir()
                (root/'bin/ssh-keygen').write_text('#!/bin/sh\nexit 0\n')
                (root/'bin/ssh').write_text('''#!/usr/bin/python3
import json,os,sys
with open(os.environ['MOCK_CALLS'],'w') as out: json.dump({'command':sys.argv[-1], 'request':sys.stdin.read()},out)
outcome=os.environ['MOCK_OUTCOME']
if outcome != 'success':
    sys.stderr.write('SECRET_FIXTURE_TOKEN_DO_NOT_EXPORT\\nPAPER_EXPORT_REASON='+('EXPORT_MANIFEST_MISMATCH' if outcome=='mismatch' else 'SECRET_FIXTURE_TOKEN_DO_NOT_EXPORT')+'\\n')
    sys.exit(1)
sys.stdout.buffer.write(open(os.environ['MOCK_PACKAGE'],'rb').read())
''')
                for path in (root/'bin').iterdir(): path.chmod(0o755)
                env = {**os.environ, 'PATH': str(root/'bin')+':'+os.environ['PATH'], 'RUNNER_TEMP': str(root/'runner'),
                    'VPS_HOST': 'fixture.invalid', 'VPS_USER': 'suiba-deploy', 'VPS_PORT': '22',
                    'VPS_SSH_KEY': SECRET, 'VPS_KNOWN_HOSTS': SECRET, 'PAPER_EXPORT_CONFIRMATION': 'EXPORT-PAPER-PUBLIC',
                    'GITHUB_STEP_SUMMARY': str(root/'summary'), 'MOCK_CALLS': str(root/'calls'),
                    'MOCK_OUTCOME': outcome, 'MOCK_PACKAGE': str(package)}
                result = subprocess.run(['/bin/bash', str(HERE.parents[1]/'docker/ssh-paper-export.sh')],
                    env=env, capture_output=True, text=True, timeout=15)
                calls = json.loads((root/'calls').read_text())
                self.assertEqual(calls['command'], 'sudo -n -- /usr/local/sbin/suiba-paper-check')
                self.assertEqual(json.loads(calls['request']), {'operation': 'export-snapshot'})
                self.assertNotIn(SECRET, result.stdout+result.stderr)
                if outcome == 'success':
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual({p.name for p in (root/'runner').iterdir()}, {'suiba-public-export'})
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(list((root/'runner').iterdir()), [])
                    if outcome == 'mismatch': self.assertIn('EXPORT_MANIFEST_MISMATCH', result.stderr)


class ProdLiveExportTests(unittest.TestCase):
    def live_fixture(self, root):
        root = Path(root)
        path = root/'bot.sqlite'
        db = sqlite3.connect(path)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA wal_autocheckpoint=0')
        records = {
            'strategy_decisions': {'action': 'WAIT', 'reason': SECRET, 'stopLossPct': 0.12345,
                'evidence': {'version': 1, 'candleTimestamp': 300, 'evaluatedAt': 600000, 'selectedRule': 'NO_SIGNAL',
                    'thresholds': {'oversold': 30, 'secret': SECRET}, 'conditions': {'emaUp': True},
                    'inputs': {'price': 1, 'current': {'rsi': 40, 'secret': SECRET}}}},
            'bot_settings': {'token': SECRET}, 'auth_sessions': {'token': SECRET},
        }
        for table, value in records.items():
            db.execute(f'CREATE TABLE {table}(id TEXT PRIMARY KEY,timestamp INTEGER,json TEXT)')
            db.execute(f'INSERT INTO {table} VALUES(?,?,?)', ('row-'+table, NOW_MS, json.dumps(value)))
        db.commit()
        pair = sqlite3.connect(root/'bot.sqlite.WAL_USDC.sqlite')
        pair.execute('CREATE TABLE paper_trades(id TEXT PRIMARY KEY,timestamp INTEGER,json TEXT)')
        pair.execute('INSERT INTO paper_trades VALUES(?,?,?)',
                     ('trade-1', NOW_MS, json.dumps({'side': 'SELL', 'fee': 0.01, 'secret': SECRET})))
        pair.commit(); pair.close()
        record = {'id': 'd'*32, 'status': 'in_progress', 'started': NOW_MS, 'sha': 'b'*40, 'secret': SECRET}
        return db, record

    def snapshot_stream(self, root):
        root = Path(root)
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            archive.add(root/'bot.sqlite', arcname='./bot.sqlite')
            if (root/'bot.sqlite-wal').exists():
                archive.add(root/'bot.sqlite-wal', arcname='./bot.sqlite-wal')
            archive.add(root/'bot.sqlite.WAL_USDC.sqlite', arcname='./bot.sqlite.WAL_USDC.sqlite')
        return stream.getvalue()

    def build(self, root, record):
        raw = self.snapshot_stream(root)
        return e.build_live_export(io.BytesIO(raw), record, hashlib.sha256(raw).hexdigest())

    def test_live_export_uses_prod_scope_and_the_same_allowlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            db, record = self.live_fixture(tmp)
            try: package = self.build(tmp, record)
            finally: db.close()
            zip_path = Path(tmp)/'prod.zip'; zip_path.write_bytes(package)
            output = Path(tmp)/'public'
            self.assertEqual(client.unpack(zip_path, output), 2)
            self.assertEqual({p.name for p in output.iterdir()}, {'manifest.json', 'SUI_USDC.sqlite', 'WAL_USDC.sqlite'})
            self.assertNotIn(SECRET.encode(), b''.join(p.read_bytes() for p in output.iterdir()))
            manifest = json.loads((output/'manifest.json').read_text())
            self.assertEqual(manifest['scope'], 'PROD_LIVE_PUBLIC_EXTRACT')
            self.assertEqual(manifest['run'], {'id': 'd'*32, 'status': 'in_progress', 'pair': 'SUI_USDC',
                                               'mode': 'PAPER', 'started': NOW_MS, 'sha': 'b'*40})
            sui = sqlite3.connect(output/'SUI_USDC.sqlite')
            try:
                decision = json.loads(sui.execute('SELECT json FROM strategy_decisions').fetchone()[0])
                self.assertNotIn('thresholds', decision['evidence'])
                self.assertNotIn('stopLossPct', decision)
            finally: sui.close()
            wal = sqlite3.connect(output/'WAL_USDC.sqlite')
            try: self.assertEqual(wal.execute('SELECT count(*) FROM paper_trades').fetchone()[0], 1)
            finally: wal.close()

    def test_live_export_rejects_a_record_that_is_not_a_running_prod_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            db, record = self.live_fixture(tmp)
            try:
                for patch in ({'status': 'completed'}, {'status': 'failed_requires_review'}, {'id': 'x'*32}):
                    with self.assertRaises(e.ExportError) as error: self.build(tmp, {**record, **patch})
                    self.assertEqual(error.exception.code, 'EXPORT_RUN_INVALID')
                raw = self.snapshot_stream(tmp)
                with self.assertRaises(e.ExportError) as error:
                    e.build_live_export(io.BytesIO(raw), record, 'not-a-digest')
                self.assertEqual(error.exception.code, 'EXPORT_ARCHIVE_INVALID')
            finally: db.close()

    def test_client_rejects_a_tampered_prod_run_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            db, record = self.live_fixture(tmp)
            try: package = self.build(tmp, record)
            finally: db.close()
            original = zipfile.ZipFile(io.BytesIO(package))
            manifest = json.loads(original.read('manifest.json'))
            manifest['run']['status'] = 'completed'
            forged = Path(tmp)/'forged.zip'
            with zipfile.ZipFile(forged, 'w') as target:
                for name in original.namelist():
                    target.writestr(name, json.dumps(manifest) if name == 'manifest.json' else original.read(name))
            with self.assertRaises(Exception): client.unpack(forged, Path(tmp)/'public')

    def controller(self, record, volume):
        ctl = object.__new__(c.ProductionController)
        ctl.current = lambda: record
        ctl.b = SimpleNamespace(DATA='fixture-data', decode=lambda raw: json.loads(raw),
                                read_trusted=lambda path, maximum: path.read_bytes())
        ctl.docker = SimpleNamespace(call=lambda args, timeout=None: json.dumps(
            [{'Name': 'fixture-data', 'Mountpoint': str(volume)}]))
        forbidden = lambda *args, **kwargs: self.fail('live operation called')
        ctl.helper = ctl.system = ctl.api = ctl.maintenance = ctl.stop = forbidden
        return ctl

    def test_prod_snapshot_copies_the_live_db_and_never_touches_the_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            volume = Path(tmp)/'volume'; volume.mkdir()
            db, record = self.live_fixture(volume)
            # Data-bearing files only: the -shm WAL index is volatile shared
            # memory that any extra reader (including the worker's own
            # dashboard reads) updates; the database and WAL must not move.
            data_files = lambda: {p.name: p.read_bytes() for p in volume.iterdir() if not p.name.endswith('-shm')}
            before = data_files()
            ctl = self.controller(record, volume)
            with patch.object(c, 'EXPORT_PROGRAM', HERE/'export_snapshot.py'):
                package = ctl.export_prod_snapshot()
            self.assertTrue(package.startswith(b'PK'))
            # The writer connection stayed open the whole time and every data
            # file (database and its un-checkpointed WAL) is byte-identical.
            self.assertEqual(before, data_files())
            db.close()
            zip_path = Path(tmp)/'prod.zip'; zip_path.write_bytes(package)
            output = Path(tmp)/'public'
            self.assertEqual(client.unpack(zip_path, output), 2)
            manifest = json.loads((output/'manifest.json').read_text())
            self.assertEqual(manifest['scope'], 'PROD_LIVE_PUBLIC_EXTRACT')
            sui = sqlite3.connect(output/'SUI_USDC.sqlite')
            try: self.assertEqual(sui.execute('SELECT count(*) FROM strategy_decisions').fetchone()[0], 1)
            finally: sui.close()

    def test_prod_snapshot_refuses_when_production_is_not_running(self):
        with tempfile.TemporaryDirectory() as tmp:
            volume = Path(tmp)/'volume'; volume.mkdir()
            db, record = self.live_fixture(volume)
            db.close()
            ctl = self.controller({**record, 'status': 'completed'}, volume)
            with patch.object(c, 'EXPORT_PROGRAM', HERE/'export_snapshot.py'):
                with self.assertRaises(c.SnapshotExportRejected) as error: ctl.export_prod_snapshot()
            self.assertEqual(error.exception.code, 'EXPORT_PROD_NOT_RUNNING')
            self.assertIn('EXPORT_PROD_NOT_RUNNING', c.EXPORT_CODES)

    def test_prod_review_workflow_is_gated_observe_only_and_windowed(self):
        workflow = HERE.parents[2]/'.github/workflows/suiba-prod-review.yml'
        text = workflow.read_text()
        for value in ("environment: sakura-vps-observe", "vars.SUIBA_PROD_REVIEW_ENABLED == 'true'",
                      "github.ref == 'refs/heads/main'", "cron: '17 15 * * *'", "ssh-prod-export.sh",
                      "--since", "--until", "suiba-run-review", "retention-days: 1", "if-no-files-found: error"):
            self.assertIn(value, text)
        self.assertNotIn('always()', text)
        self.assertNotIn('environment: sakura-vps\n', text)

    @unittest.skipIf(os.name == 'nt', 'mocked Bash pipeline runs on Linux')
    def test_fixed_prod_ssh_request_artifact_boundary_and_safe_errors(self):
        for outcome in ('success', 'not_running'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                db, record = self.live_fixture(root)
                try: package = self.build(root, record)
                finally: db.close()
                source = root/'source.zip'; source.write_bytes(package)
                (root/'bin').mkdir(); (root/'runner').mkdir()
                (root/'bin/ssh-keygen').write_text('#!/bin/sh\nexit 0\n')
                (root/'bin/ssh').write_text('''#!/usr/bin/python3
import json,os,sys
with open(os.environ['MOCK_CALLS'],'w') as out: json.dump({'command':sys.argv[-1], 'request':sys.stdin.read()},out)
if os.environ['MOCK_OUTCOME'] != 'success':
    sys.stderr.write('SECRET_FIXTURE_TOKEN_DO_NOT_EXPORT\\nPAPER_EXPORT_REASON=EXPORT_PROD_NOT_RUNNING\\n')
    sys.exit(1)
sys.stdout.buffer.write(open(os.environ['MOCK_PACKAGE'],'rb').read())
''')
                for path in (root/'bin').iterdir(): path.chmod(0o755)
                env = {**os.environ, 'PATH': str(root/'bin')+':'+os.environ['PATH'], 'RUNNER_TEMP': str(root/'runner'),
                    'VPS_HOST': 'fixture.invalid', 'VPS_USER': 'suiba-observe', 'VPS_PORT': '22',
                    'VPS_SSH_KEY': SECRET, 'VPS_KNOWN_HOSTS': SECRET, 'PROD_EXPORT_CONFIRMATION': 'EXPORT-PROD-PUBLIC',
                    'GITHUB_STEP_SUMMARY': str(root/'summary'), 'MOCK_CALLS': str(root/'calls'),
                    'MOCK_OUTCOME': outcome, 'MOCK_PACKAGE': str(source)}
                result = subprocess.run(['/bin/bash', str(HERE.parents[1]/'docker/ssh-prod-export.sh')],
                    env=env, capture_output=True, text=True, timeout=15)
                calls = json.loads((root/'calls').read_text())
                self.assertEqual(calls['command'], 'sudo -n -- /usr/local/sbin/suiba-paper-observe')
                self.assertEqual(json.loads(calls['request']), {'operation': 'export-prod-snapshot'})
                self.assertNotIn(SECRET, result.stdout+result.stderr)
                if outcome == 'success':
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual({p.name for p in (root/'runner').iterdir()}, {'suiba-prod-export'})
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(list((root/'runner').iterdir()), [])
                    self.assertIn('EXPORT_PROD_NOT_RUNNING', result.stderr)


if __name__ == '__main__': unittest.main(verbosity=2)
