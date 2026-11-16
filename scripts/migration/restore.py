#!/usr/bin/env python3
"""Restore a portable cweb snapshot inside the extracted folder, never ~/.codex."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import tarfile
import time

from common import Paths, database, digest, rewrite_jsonl, safe_extract, write_json


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def rewrite_database(path, paths):
    with database(path) as connection:
        tables = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_sqlx_migrations'").fetchall()
        for (table,) in tables:
            columns = connection.execute('PRAGMA table_info(' + quoted(table) + ')').fetchall()
            fields = [row[1] for row in columns if row[2].upper() == 'TEXT']
            if not fields:
                continue
            query = 'SELECT rowid,' + ','.join(map(quoted, fields)) + ' FROM ' + quoted(table)
            # Keep SQLite BLOBs (including encrypted fields) untouched.
            for row in connection.execute(query).fetchall():
                changed = {}
                for key, value in zip(fields, row[1:]):
                    if not isinstance(value, str):
                        continue
                    try:
                        parsed = json.loads(value)
                        updated = paths.json(parsed)
                        replacement = json.dumps(updated, ensure_ascii=False, separators=(',', ':')) if updated != parsed else value
                    except (ValueError, TypeError):
                        replacement = paths.text(value)
                    if replacement != value:
                        changed[key] = replacement
                if changed:
                    connection.execute('UPDATE ' + quoted(table) + ' SET ' + ','.join(quoted(key) + '=?' for key in changed) + ' WHERE rowid=?', [*changed.values(), row[0]])


def relocate_history(codex, paths):
    history = codex / 'thread_history_1.sqlite'
    with database(codex / 'state_5.sqlite') as state, database(history) as projection:
        threads = dict(state.execute('SELECT rollout_path,id FROM threads'))
        count = 0
        for folder in ('sessions', 'archived_sessions'):
            for rollout in sorted((codex / folder).rglob('*.jsonl')):
                # The index has already been relocated to its final path, while files
                # are still in the transaction staging directory.
                final = paths.mapping['@codex-target'] + '/' + str(rollout.relative_to(codex))
                thread = threads.get(final)
                offsets = {0}
                turns = []
                cursor = None
                if thread:
                    turns = projection.execute('SELECT turn_id,rollout_byte_offset,rollout_end_byte_offset FROM thread_turns WHERE thread_id=?', (thread,)).fetchall()
                    cursor = projection.execute('SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id=?', (thread,)).fetchone()
                    offsets.update(value for row in turns for value in row[1:] if value is not None)
                    if cursor:
                        offsets.add(cursor[0])
                translated, _ = rewrite_jsonl(rollout, paths, offsets)
                # Native compaction can leave old byte offsets beyond a truncated
                # rollout. The projected items are still the only copy of some
                # older turns: never discard/rebuild that database. Missing span
                # offsets are nullable; keep the existing native cursor so CLI
                # can use its own reconciliation for such pre-existing cases.
                for turn, start, end in turns:
                    projection.execute('UPDATE thread_turns SET rollout_byte_offset=?,rollout_end_byte_offset=? WHERE thread_id=? AND turn_id=?', (translated.get(start), translated.get(end), thread, turn))
                if cursor and cursor[0] in translated:
                    projection.execute('UPDATE thread_history_projection_state SET next_rollout_byte_offset=? WHERE thread_id=?', (translated[cursor[0]], thread))
                count += 1
                if count % 25 == 0:
                    print('已重定位 {} 份会话记录。'.format(count), flush=True)
        # A copied process is not a live turn on this computer. Keep its messages;
        # do not replay pending user input, tools, or automatic goal continuations.
        interrupted = projection.execute("UPDATE thread_turns SET status='interrupted' WHERE status IN ('inProgress','in_progress')").rowcount
    goals = codex / 'goals_1.sqlite'
    if goals.exists():
        with database(goals) as connection:
            connection.execute("UPDATE thread_goals SET status='paused' WHERE status='active'")
    return count, interrupted


def fix_runtime(root, manifest):
    for name in manifest['executables']:
        path = root / name
        path.chmod(path.stat().st_mode | 0o700)
    for name, target in manifest['symlinks'].items():
        path = root / name
        try:
            (path.parent / target).resolve().relative_to(root)
        except ValueError:
            raise RuntimeError('外部符号链接不属于便携包: ' + name)
        if path.is_symlink() and os.readlink(path) == target:
            continue
        if path.exists() or path.is_symlink():
            raise RuntimeError('符号链接位置已被占用: ' + name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(target)


def restore(root, use_target_login=True):
    root = root.resolve()
    private = root / '.migration'
    manifest = json.loads((private / 'manifest.json').read_text())
    if platform.system() != 'Linux' or platform.machine() != manifest['architecture']:
        raise RuntimeError('此包需要 Linux ' + manifest['architecture'])
    ready = private / 'ready.json'
    if ready.exists():
        state = json.loads(ready.read_text())
        if state['root'] != str(root):
            raise RuntimeError('此副本已恢复到其他路径。请重新解压原 ZIP 到目标位置，避免覆盖恢复后产生的新会话。')
        return state
    print('首次恢复：校验迁移包并重定位会话，请稍候。', flush=True)
    for name, expected in manifest['sha256'].items():
        if digest(root / name) != expected:
            raise RuntimeError('文件校验失败，请重新解压: ' + name)
    fix_runtime(root, manifest)
    print('文件校验通过，准备恢复私有数据。', flush=True)
    codex_target = private / 'codex'
    data_target = root / 'bridge/.data'
    data_target.parent.mkdir(parents=True, exist_ok=True)
    # Do not overwrite even an empty existing data directory: it may be in use.
    journal = private / 'installing.json'
    if (codex_target.exists() or data_target.exists()) and not journal.exists():
        raise RuntimeError('目标已有运行数据，请解压到新的空目录。没有覆盖任何数据。')
    if journal.exists():
        pending = json.loads(journal.read_text())
        if pending['root'] != str(root):
            raise RuntimeError('未完成的恢复目录已移动，请重新解压 ZIP。')
        # A prior restore completed the expensive work; finish its atomic moves.
        work = private / 'restore-stage'
        for name, target in [('codex', codex_target), ('data', data_target)]:
            if not target.exists():
                (work / name).replace(target)
        state = pending['result']
    else:
        work = private / 'restore-stage'
        if work.exists():
            shutil.rmtree(work)
        work.mkdir(mode=0o700)
        with tarfile.open(private / 'snapshot.tar.gz', 'r:gz') as archive:
            safe_extract(archive, work)
        print('快照已解开，正在同步会话路径和分页索引。', flush=True)
        mappings = [(manifest['sourceRoot'], str(root)), (manifest['sourceCodexHome'], str(codex_target)), (manifest['sourceNodeRoot'], str(root / '.runtime')), (manifest['sourceHome'], str(Path.home()))]
        paths = Paths(mappings)
        # Used only for lookup, never included in the replacement regular expression.
        paths.mapping['@codex-target'] = str(codex_target)
        codex = work / 'codex'
        for path in codex.glob('*.sqlite'):
            rewrite_database(path, paths)
        count, interrupted = relocate_history(codex, paths)
        for base in (work / 'data', codex / 'skills', codex / 'plugins', codex / 'memories'):
            if not base.exists():
                continue
            for path in base.rglob('*'):
                if not path.is_file():
                    continue
                # Uploaded files are user payload, not path-bearing configuration.
                if base == work / 'data' and 'attachments' in path.relative_to(base).parts:
                    continue
                if path.suffix == '.json':
                    write_json(path, paths.json(json.loads(path.read_text())))
                elif path.suffix in ('.md', '.toml'):
                    path.write_text(paths.text(path.read_text()))
        for path in codex.glob('*.jsonl'):
            rewrite_jsonl(path, paths)
        # TOML escaping must also work for target folder names containing quotes.
        config = codex / 'config.toml'
        if config.exists():
            node = root / '.runtime/bin/node'
            import subprocess
            subprocess.run([str(node), str(root / 'scripts/migration/relocate-config.mjs'), str(config), json.dumps(mappings)], cwd=root, check=True)
        login_source = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'auth.json'
        login_copied = False
        if use_target_login and login_source.is_file() and login_source != codex_target / 'auth.json':
            shutil.copyfile(login_source, codex / 'auth.json')
            (codex / 'auth.json').chmod(0o600)
            login_copied = True
        missing = []
        workspaces = json.loads((work / 'data/workspaces.json').read_text())['workspaces']
        for entry in workspaces:
            if not Path(entry['path']).is_dir():
                missing.append({'name': entry['name'], 'path': entry['path']})
        for path in codex.glob('*.sqlite'):
            with database(path) as connection:
                if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('恢复后的数据库校验失败: ' + path.name)
        state = {'root': str(root), 'restoredAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'sessions': count, 'interruptedTurns': interrupted, 'developerThread': manifest['developerThread'], 'targetLoginReused': login_copied, 'externalWorkspacesNotCopied': missing}
        write_json(journal, {'root': str(root), 'result': state})
        codex.replace(codex_target)
        (work / 'data').replace(data_target)
    private.chmod(0o700)
    codex_target.chmod(0o700)
    data_target.chmod(0o700)
    write_json(ready, state)
    journal.unlink()
    shutil.rmtree(work, ignore_errors=True)
    print('已恢复 {} 份会话记录；原机运行数据和目标 ~/.codex 均未改写。'.format(state['sessions']))
    if not state['targetLoginReused']:
        print('首次使用前请运行 bash codex-portable login（也可使用自己的供应商环境变量）。')
    if state['externalWorkspacesNotCopied']:
        print('其他工作区的项目文件需另行搬运；路径见 .migration/ready.json。')
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--no-target-login', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    with (args.root / '.migration/restore.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        restore(args.root, not args.no_target_login)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        raise SystemExit('迁移恢复未完成: ' + str(error))
