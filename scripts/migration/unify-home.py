#!/usr/bin/env python3
"""Merge an idle native Codex home into a live home and alias the old entry.

Default is a read-only plan. Never replaces a live destination database. The
source must have no Codex process, pending turn, job or queued work. Original
files (including config/auth) stay in a private backup; destination settings win.
"""
import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time

from common import database, digest, snapshot_database, write_json

TABLES = {
    'state_5.sqlite': ['thread_sections', 'projects', 'project_roots', 'project_idempotency_keys', 'threads', 'thread_dynamic_tools', 'thread_spawn_edges', 'thread_attachments', 'thread_read_receipts', 'guardian_review_feedback', 'rollout_migration_state', 'rollout_migration_skipped_rollouts'],
    'thread_history_1.sqlite': ['thread_turns', 'thread_items', 'thread_history_projection_state', 'thread_realtime_items'],
    'goals_1.sqlite': ['thread_goals', 'thread_goal_continuation_deferrals'],
    'memories_1.sqlite': ['stage1_outputs'],
}
IGNORED = {'_sqlx_migrations', 'sqlite_sequence', 'backfill_state', 'consolidation_progress'}
FOLDERS = ['sessions', 'archived_sessions', 'skills', 'rules', 'plugins', 'memories', 'shell_snapshots']


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def processes(home, proc=Path('/proc')):
    found = []
    for path in proc.iterdir():
        if not path.name.isdigit():
            continue
        try:
            if path.stat().st_uid != os.getuid() or (path / 'comm').read_text().strip() != 'codex':
                continue
            env = dict(entry.split('=', 1) for entry in (path / 'environ').read_text().split('\0') if '=' in entry)
            native = Path(env.get('CODEX_HOME') or str(Path(env.get('HOME', str(Path.home()))) / '.codex'))
            if native.resolve() == home.resolve():
                found.append(int(path.name))
        except (OSError, ValueError):
            continue
    return sorted(found)


def exchange(left, right):
    # One atomic rename: ~/.codex is never missing between directory and alias.
    libc = ctypes.CDLL(None, use_errno=True)
    fn = libc.renameat2
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    if fn(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def account(home):
    value = json.loads((home / 'auth.json').read_text())
    return (value.get('auth_mode'), value.get('tokens', {}).get('account_id') or value.get('OPENAI_API_KEY'))


def plan(source, target):
    source, target = Path(source).absolute(), Path(target).resolve()
    if source.resolve() == target:
        return {'alreadyUnified': True, 'source': str(source), 'target': str(target)}
    if source.is_symlink() or source in target.parents or target in source.parents:
        raise RuntimeError('源目录必须是独立的真实目录，不能包含目标目录或与其嵌套。')
    if source.stat().st_uid != os.getuid() or target.stat().st_uid != os.getuid():
        raise RuntimeError('只能统一当前用户拥有的目录。')
    if account(source) != account(target) or not account(source)[1]:
        raise RuntimeError('两个会话库的登录身份不同或无法确认，未合并。')
    with database(source / 'state_5.sqlite', True) as incoming, database(target / 'state_5.sqlite', True) as current:
        ids = {row[0] for row in incoming.execute('SELECT id FROM threads')}
        if ids & {row[0] for row in current.execute('SELECT id FROM threads')}:
            raise RuntimeError('会话 ID 重复，需先核对两份历史；未覆盖任何记录。')
        for (path,) in incoming.execute('SELECT rollout_path FROM threads'):
            relative = Path(path).resolve().relative_to(source.resolve())
            if not (source / relative).is_file():
                raise RuntimeError('原生索引引用的会话文件缺失。')
    counts = {}
    for filename, tables in TABLES.items():
        if not (source / filename).exists():
            continue
        if not (target / filename).exists():
            raise RuntimeError('目标缺少原生数据库：' + filename)
        with database(source / filename, True) as incoming, database(target / filename, True) as current:
            available = {r[0] for r in incoming.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for name in available:
                amount = incoming.execute('SELECT count(*) FROM ' + quote(name)).fetchone()[0]
                if name not in tables and name not in IGNORED and amount:
                    raise RuntimeError('发现尚未支持的非空原生状态：' + filename + '/' + name)
            for table in tables:
                if table not in available:
                    continue
                if incoming.execute('PRAGMA table_info(' + quote(table) + ')').fetchall() != current.execute('PRAGMA table_info(' + quote(table) + ')').fetchall():
                    raise RuntimeError('原生数据库结构不一致：' + table)
                counts[filename + '/' + table] = incoming.execute('SELECT count(*) FROM ' + quote(table)).fetchone()[0]
            if filename == 'thread_history_1.sqlite' and incoming.execute("SELECT count(*) FROM thread_turns WHERE status IN ('inProgress','in_progress')").fetchone()[0]:
                raise RuntimeError('源库仍有未结束轮次，不能迁移。')
            if filename == 'goals_1.sqlite' and incoming.execute("SELECT count(*) FROM thread_goals WHERE status='active'").fetchone()[0]:
                raise RuntimeError('源库仍有活动目标，不能迁移。')
    if (source / 'queue_1.sqlite').exists():
        with database(source / 'queue_1.sqlite', True) as queue:
            if queue.execute('SELECT count(*) FROM queued_items').fetchone()[0]:
                raise RuntimeError('源库仍有待处理输入，不能迁移。')
    # Rollout contents stay byte-for-byte identical: paging offsets remain valid.
    for folder in ('sessions', 'archived_sessions'):
        for file in (source / folder).rglob('*.jsonl'):
            destination = target / file.relative_to(source)
            if destination.exists() and digest(file) != digest(destination):
                raise RuntimeError('会话文件冲突，未覆盖：' + file.name)
    for folder in FOLDERS:
        if any(file.is_symlink() for file in (source / folder).rglob('*')):
            raise RuntimeError('来源含需人工检查的符号链接：' + folder)
    return {'source': str(source), 'target': str(target), 'threadIds': sorted(ids), 'rows': counts,
            'sourceProcesses': processes(source), 'retainTargetSettings': True, 'sourceConfigBackedUp': True}


def append_history(source, target):
    for name in ('session_index.jsonl', 'history.jsonl'):
        original = source / name
        if not original.exists():
            continue
        lock = target / (name + '.lock') if name == 'session_index.jsonl' else target / name
        with lock.open('a+b') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            file = target / name
            existing = set(file.read_bytes().splitlines()) if file.exists() else set()
            with file.open('ab') as out:
                for line in original.read_bytes().splitlines():
                    if line and line not in existing:
                        json.loads(line)
                        out.write(line + b'\n'); existing.add(line)


def unify(source, target, backup):
    report = plan(source, target)
    if report.get('alreadyUnified'):
        return report
    if report['sourceProcesses']:
        raise RuntimeError('源库仍有 Codex 进程：' + ', '.join(map(str, report['sourceProcesses'])) + '；请确认空闲后停止该库的原生 daemon，再重试。')
    source, target, backup = Path(report['source']), Path(report['target']), Path(backup).absolute()
    if backup.exists():
        raise RuntimeError('备份路径已存在，请使用新的路径。')
    if source in backup.parents or target in backup.parents:
        raise RuntimeError('备份必须位于两个会话库之外。')
    backup.mkdir(parents=True, mode=0o700)
    if backup.stat().st_dev != source.stat().st_dev:
        raise RuntimeError('原目录归档需位于同一文件系统，未执行统一。')
    report['phase'] = 'preparing'; report['backup'] = str(backup)
    write_json(backup / 'report.json', report)
    # Prove atomic exchange support before touching any original database.
    left, right = backup / 'exchange-a', backup / 'exchange-b'
    left.mkdir(); right.symlink_to(target)
    exchange(left, right); exchange(left, right); right.unlink(); left.rmdir()
    for filename in TABLES:
        for home, name in [(source, 'source'), (target, 'target-before')]:
            if (home / filename).exists():
                snapshot_database(home / filename, backup / name / filename)
    conflicts, created = [], []
    for folder in FOLDERS:
        for file in sorted((source / folder).rglob('*')):
            destination = target / file.relative_to(source)
            if file.is_symlink():
                raise RuntimeError('来源含需人工检查的符号链接：' + str(file.relative_to(source)))
            if not file.is_file():
                continue
            if destination.exists():
                if folder not in ('sessions', 'archived_sessions') and digest(file) != digest(destination):
                    conflicts.append(str(file.relative_to(source)))
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with file.open('rb') as incoming, destination.open('xb') as out:
                shutil.copyfileobj(incoming, out)
            shutil.copystat(file, destination)
            created.append((destination, digest(file)))
    connection = sqlite3.connect(target / 'state_5.sqlite', timeout=30)
    connection.execute('PRAGMA foreign_keys=ON')
    aliases = {'state_5.sqlite': 'main'}
    original = backup / 'original-home'
    switched = False
    try:
        for i, filename in enumerate(TABLES):
            if filename == 'state_5.sqlite' or not (source / filename).exists():
                continue
            alias = 'db' + str(i); aliases[filename] = alias
            connection.execute('ATTACH DATABASE ? AS ' + alias, (str(target / filename),))
        connection.execute('BEGIN IMMEDIATE')
        for filename, alias in aliases.items():
            with database(backup / 'source' / filename, True) as incoming:
                available = {r[0] for r in incoming.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                for table in TABLES[filename]:
                    if table not in available:
                        continue
                    info = incoming.execute('PRAGMA table_info(' + quote(table) + ')').fetchall()
                    columns = [r[1] for r in info]; keys = [i for i, r in enumerate(info) if r[5]]
                    for raw in incoming.execute('SELECT * FROM ' + quote(table)):
                        row = list(raw)
                        if table == 'threads':
                            index = columns.index('rollout_path')
                            row[index] = str(target / Path(row[index]).resolve().relative_to(source.resolve()))
                        name = alias + '.' + quote(table)
                        prior = connection.execute('SELECT * FROM ' + name + ' WHERE ' + ' AND '.join(quote(columns[i]) + '=?' for i in keys), [row[i] for i in keys]).fetchone()
                        if prior is not None:
                            if tuple(row) != prior:
                                raise RuntimeError('原生记录冲突，未覆盖：' + table)
                            continue
                        connection.execute('INSERT INTO ' + name + '(' + ','.join(map(quote, columns)) + ') VALUES (' + ','.join('?' for _ in columns) + ')', row)
            if connection.execute('PRAGMA ' + alias + '.foreign_key_check').fetchall():
                raise RuntimeError('原生关联记录校验失败：' + filename)
        if processes(source):
            raise RuntimeError('源库重新启动了 Codex，已取消切换；请重新核对运行状态。')
        # The old directory becomes the backup while the public entry instantly
        # becomes an alias. The live destination DB inode and writers stay intact.
        original.symlink_to(target)
        exchange(source, original); switched = True
        connection.commit()
    except BaseException:
        connection.rollback()
        if switched:
            exchange(source, original)
        if original.is_symlink():
            original.unlink()
        for file, fingerprint in created:
            if file.is_file() and digest(file) == fingerprint:
                file.unlink()
        raise
    finally:
        connection.close()
    append_history(original, target)
    report.update(phase='unified', sharedRealPath=str(source.resolve()), retainedFileConflicts=conflicts, finishedAt=time.time())
    write_json(backup / 'report.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--backup', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(); os.umask(0o077)
    if args.apply and not args.backup:
        parser.error('--apply requires --backup')
    try:
        result = unify(args.source, args.target, args.backup) if args.apply else plan(args.source, args.target)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        parser.exit(1, str(error) + '\n')
