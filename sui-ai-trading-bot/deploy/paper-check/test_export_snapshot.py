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


class ExportTests(unittest.TestCase):
    def fixture(self, root, wal=False):
        root = Path(root)
        path = root/'bot.sqlite'
        db = sqlite3.connect(path)
        if wal: db.execute('PRAGMA journal_mode=WAL')
        records = {
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
            row_id = {'strategy_decisions': 'cycle', 'technical_indicators': 'cycle', 'operation_candidates': 'candidate', 'paper_orders': 'order-'+SECRET, 'paper_trades': 'order-'+SECRET}.get(table, table)
            db.execute(f'INSERT INTO {table} VALUES(?,?,?)', (row_id, 600000, json.dumps(value)))
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
        record = {'id': 'a'*32, 'status': 'completed', 'started': 700000, 'duration': '6h', 'sha': 'b'*40,
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
            db.execute(f'INSERT INTO {table} VALUES(?,?,?)', ('row-'+table, 600000, json.dumps(value)))
        db.commit()
        pair = sqlite3.connect(root/'bot.sqlite.WAL_USDC.sqlite')
        pair.execute('CREATE TABLE paper_trades(id TEXT PRIMARY KEY,timestamp INTEGER,json TEXT)')
        pair.execute('INSERT INTO paper_trades VALUES(?,?,?)',
                     ('trade-1', 600000, json.dumps({'side': 'SELL', 'fee': 0.01, 'secret': SECRET})))
        pair.commit(); pair.close()
        record = {'id': 'd'*32, 'status': 'in_progress', 'started': 700000, 'sha': 'b'*40, 'secret': SECRET}
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
                                               'mode': 'PAPER', 'started': 700000, 'sha': 'b'*40})
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
