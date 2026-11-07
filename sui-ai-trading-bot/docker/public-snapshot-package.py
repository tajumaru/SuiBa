"""Validate the public package before making an artifact directory visible."""
import hashlib
import json
from pathlib import Path
import re
import runpy
import sqlite3
import sys
import tempfile
import zipfile

scope = runpy.run_path(str(Path(__file__).parents[1]/'deploy/paper-check/export_snapshot.py'))
LIMIT, TABLES = scope['EXPORT_LIMIT'], scope['TABLES']
CODES = scope['ERROR_CODES'] | {'EXPORT_PROGRAM_INVALID'}


def unpack(package, destination):
    package, destination = Path(package), Path(destination)
    if package.stat().st_size > LIMIT or destination.exists(): raise ValueError()
    with zipfile.ZipFile(package) as archive:
        entries = archive.infolist()
        names = [e.filename for e in entries]
        if len(names) != len(set(names)) or not 2 <= len(names) <= 3: raise ValueError()
        if set(names) - {'manifest.json', 'SUI_USDC.sqlite', 'WAL_USDC.sqlite'}: raise ValueError()
        if sum(e.file_size for e in entries) > LIMIT+65536: raise ValueError()
        if archive.getinfo('manifest.json').file_size > 65536: raise ValueError()
        manifest = json.loads(archive.read('manifest.json'))
        if (type(manifest) is not dict or set(manifest) != {'version', 'scope', 'public', 'run', 'sourceArchiveSha256', 'files', 'omitted'} or
                type(manifest['version']) is not int or manifest['version'] != 1 or manifest['public'] is not True or
                manifest['scope'] != 'PRE_RUN_BACKUP_PUBLIC_EXTRACT' or
                type(manifest['sourceArchiveSha256']) is not str or not re.fullmatch(r'[a-f0-9]{64}', manifest['sourceArchiveSha256'])): raise ValueError()
        if manifest['omitted'] != ['settings', 'runtime', 'auth', 'market_candles', 'portfolio_snapshots', 'thresholds', 'free_text', 'raw_ids']: raise ValueError()
        if scope['public_run'](manifest['run']) != manifest['run']: raise ValueError()
        files = manifest['files']
        if type(files) is not dict or set(files) != set(names)-{'manifest.json'} or 'SUI_USDC.sqlite' not in files: raise ValueError()
        # Work in a new sibling directory. No unverified/partially written artifact is exposed.
        with tempfile.TemporaryDirectory(prefix='suiba-public-checked-', dir=destination.parent) as tmp:
            root = Path(tmp)
            for name, item in files.items():
                if type(item) is not dict or set(item) != {'sha256', 'bytes', 'rows'} or type(item['bytes']) is not int: raise ValueError()
                data = archive.read(name)
                if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']: raise ValueError()
                (root/name).write_bytes(data)
                db = sqlite3.connect((root/name).as_uri()+'?mode=ro', uri=True)
                try:
                    db.execute('PRAGMA trusted_schema=OFF')
                    schema = db.execute("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
                    if any(kind != 'table' or table not in TABLES for table, kind in schema): raise ValueError()
                    if type(item['rows']) is not dict or {t for t, _ in schema} != set(item['rows']): raise ValueError()
                    for table, _ in schema:
                        if [r[1] for r in db.execute(f'PRAGMA table_info({table})')] != ['id', 'timestamp', 'json']: raise ValueError()
                        count = 0
                        for row_id, at, raw in db.execute(f'SELECT id,timestamp,json FROM {table}'):
                            if type(row_id) is not str or not re.fullmatch(r'h:[a-f0-9]{64}', row_id) or type(at) is not int or not 0 <= at <= 2**53: raise ValueError()
                            value = json.loads(raw)
                            if scope['sanitize'](table, value, public=True) != value: raise ValueError()
                            count += 1
                            if count > scope['ROW_LIMIT']: raise ValueError()
                        if type(item['rows'][table]) is not int or count != item['rows'][table]: raise ValueError()
                finally: db.close()
            (root/'manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2)+'\n', encoding='utf-8')
            root.rename(destination)
    return len(files)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == 'reason':
            with open(sys.argv[2], 'rb') as source: raw = source.read(8193)
            codes = [line.removeprefix('PAPER_EXPORT_REASON=') for line in raw.decode('utf-8').splitlines() if line.startswith('PAPER_EXPORT_REASON=')]
            if len(raw) <= 8192 and len(codes) == 1 and codes[0] in CODES: print(codes[0])
        elif len(sys.argv) == 4 and sys.argv[1] == 'unpack':
            print('EXPORT_READY databases='+str(unpack(sys.argv[2], sys.argv[3])))
        else: raise ValueError()
    except Exception:
        print('EXPORT_PACKAGE_INVALID', file=sys.stderr)
        sys.exit(1)
