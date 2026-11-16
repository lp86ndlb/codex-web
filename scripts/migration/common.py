"""Portable archive helpers; Python stdlib only (Ubuntu 24.04 includes Python 3)."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from contextlib import contextmanager


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.writing')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


@contextmanager
def database(path, readonly=False):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + ('?mode=ro' if readonly else ''), uri=True, timeout=30)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def snapshot_database(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    with database(source, True) as original, database(target) as copied:
        original.backup(copied, pages=512, sleep=0.05)
        if copied.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('数据库校验失败: ' + str(target))


class Paths:
    def __init__(self, mappings):
        self.mapping = dict(mappings)
        # Replace all roots in one pass: a destination must never be rewritten twice.
        self.pattern = re.compile('(?:' + '|'.join(re.escape(p) for p in sorted(self.mapping, key=len, reverse=True)) + r')(?=$|[/\s\x22\x27\x60<>):,;\]\\])')

    def text(self, value):
        return self.pattern.sub(lambda match: self.mapping[match.group()], value)

    def json(self, value):
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.json(item) for item in value]
        if isinstance(value, dict):
            return {self.text(key): self.json(item) for key, item in value.items()}
        return value


def rewrite_jsonl(path, paths, offsets=None):
    """Keep every full record and translate byte offsets used by native pagination."""
    target = path.with_name(path.name + '.writing')
    translated = {0: 0}
    old_offset = new_offset = count = 0
    with path.open('rb') as source, target.open('wb') as output:
        for raw in source:
            value = paths.json(json.loads(raw))
            changed = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
            output.write(changed)
            old_offset += len(raw)
            new_offset += len(changed)
            count += 1
            if offsets is None or old_offset in offsets:
                translated[old_offset] = new_offset
    target.replace(path)
    return translated, count


def safe_extract(archive, destination):
    """Our state archive has regular files/dirs only; reject links and traversal."""
    destination = destination.resolve()
    for item in archive.getmembers():
        path = (destination / item.name).resolve()
        try:
            path.relative_to(destination)
        except ValueError:
            raise RuntimeError('迁移快照含不安全的路径: ' + item.name)
        if not (item.isfile() or item.isdir()):
            raise RuntimeError('迁移快照含不安全的路径: ' + item.name)
    archive.extractall(destination)
