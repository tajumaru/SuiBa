#!/usr/bin/python3
"""Fixed stdin-only shadow configuration updater. Never returns input or errors."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

RUNTIME = Path('/opt/suiba/shared/runtime.env')
LOCK = Path('/var/lib/suiba-deploy/lock')
KEYS = ('SUIBA_SHADOW_ENABLED', 'SUIBA_SHADOW_API_KEY')


def require(condition):
    if not condition:
        raise ValueError('refused')


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def payload(raw):
    require(len(raw) <= 8192)
    value = json.loads(raw, object_pairs_hook=pairs)
    require(type(value) is dict and set(value) == set(KEYS))
    require(value[KEYS[0]] in ('true', 'false'))
    # Literal single-line dotenv value: no interpolation, quotes or escapes.
    require(type(value[KEYS[1]]) is str and
            re.fullmatch(r'[A-Za-z0-9_-]{1,4096}', value[KEYS[1]]) is not None)
    return value


def trusted_parents(path):
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                not info.st_mode & 0o022)


def checked_file(fd):
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
            info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and
            info.st_nlink == 1)
    return info


def update(value, runtime=RUNTIME, lock=LOCK):
    trusted_parents(runtime)
    trusted_parents(lock)
    lockfd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        checked_file(lockfd)
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fd = os.open(runtime, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            info = checked_file(source.fileno())
            require(info.st_size <= 65536)
            original = source.read(65537)
        require(len(original) <= 65536)
        lines = original.splitlines(keepends=True)
        found = set()
        output = []
        for line in lines:
            # Reject ambiguous dotenv spellings rather than leaving a second value.
            name = line.split(b'=', 1)[0].strip().removeprefix(b'export ').strip()
            if name in [key.encode() for key in KEYS]:
                key = name.decode('ascii')
                require(key not in found and line.startswith(name + b'='))
                found.add(key)
                output.append((key + '=' + value[key] + '\n').encode())
            else:
                output.append(line)
        for key in KEYS:
            if key not in found:
                # Appending must not alter an unrelated unterminated line.
                require(not output or output[-1].endswith(b'\n'))
                output.append((key + '=' + value[key] + '\n').encode())
        name = None
        try:
            fd, name = tempfile.mkstemp(prefix='.shadow-runtime-', dir=runtime.parent)
            with os.fdopen(fd, 'wb') as target:
                os.fchown(target.fileno(), info.st_uid, info.st_gid)
                os.fchmod(target.fileno(), stat.S_IMODE(info.st_mode))
                target.write(b''.join(output))
                target.flush()
                os.fsync(target.fileno())
            current = runtime.lstat()
            require((current.st_dev, current.st_ino, current.st_mtime_ns, current.st_size) ==
                    (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size))
            os.replace(name, runtime)
            name = None
            directory = os.open(runtime.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if name is not None:
                os.unlink(name)
    finally:
        os.close(lockfd)


def main():
    try:
        require(os.geteuid() == 0 and len(sys.argv) == 1)
        update(payload(sys.stdin.buffer.read(8193)))
    except Exception:
        print('SHADOW_RUNTIME_REFUSED', file=sys.stderr)
        return 1
    print('SHADOW_RUNTIME_UPDATED')
    return 0


if __name__ == '__main__':
    sys.exit(main())
