import io
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from common import Paths, database, digest, rewrite_jsonl, safe_extract, snapshot_database, write_json
from restore import restore
from pack import snapshot_rollout


class MigrationTests(unittest.TestCase):
    def test_path_boundaries_and_single_pass(self):
        paths = Paths([('/old/project', '/old/project/new location'), ('/old', '/new')])
        self.assertEqual(paths.text('/old/project/a /old/project-other /old/file'), '/old/project/new location/a /new/project-other /new/file')
        self.assertEqual(paths.text('/older/file'), '/older/file')

    def test_offsets_and_quoted_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rollout.jsonl'
            rows = [{'text': '/old/图片.png'}, {'text': 'hello'}]
            raw = [(json.dumps(row) + '\n').encode() for row in rows]
            path.write_bytes(b''.join(raw))
            offsets, count = rewrite_jsonl(path, Paths([('/old', '/new 中文 "quoted"')]))
            self.assertEqual(count, 2)
            with path.open('rb') as stream:
                stream.seek(offsets[len(raw[0])])
                self.assertEqual(json.loads(stream.readline()), rows[1])
            self.assertEqual(json.loads(path.read_text().splitlines()[0])['text'], '/new 中文 "quoted"/图片.png')

    def test_live_sqlite_backup_includes_wal(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'live.sqlite', Path(directory) / 'copy.sqlite'
            live = sqlite3.connect(source)
            live.execute('PRAGMA journal_mode=WAL')
            live.execute('CREATE TABLE example(value TEXT)')
            live.execute("INSERT INTO example VALUES ('latest')")
            live.commit()
            self.assertTrue(Path(str(source) + '-wal').exists())
            snapshot_database(source, target)
            with database(target) as copied:
                self.assertEqual(copied.execute('SELECT value FROM example').fetchone()[0], 'latest')
            live.close()

    def test_incomplete_rollout_record_is_not_copied(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'live.jsonl', Path(directory) / 'copy.jsonl'
            source.write_bytes(b'{"ok":true}\n{"part')
            snapshot_rollout(source, target)
            self.assertEqual(target.read_bytes(), b'{"ok":true}\n')

    def test_unsafe_tar_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = io.BytesIO()
            with tarfile.open(fileobj=payload, mode='w') as archive:
                item = tarfile.TarInfo('../outside')
                item.size = 1
                archive.addfile(item, io.BytesIO(b'x'))
            payload.seek(0)
            with tarfile.open(fileobj=payload) as archive:
                with self.assertRaises(RuntimeError):
                    safe_extract(archive, Path(directory))

    def test_corrupt_package_and_existing_data_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private = root / '.migration'
            private.mkdir()
            keep = root / 'bridge/.data/keep.txt'
            keep.parent.mkdir(parents=True)
            keep.write_text('existing user data')
            manifest = {'architecture':'x86_64','sha256':{},'executables':[],'symlinks':{}}
            write_json(private / 'manifest.json', manifest)
            with self.assertRaisesRegex(RuntimeError, '已有运行数据'):
                restore(root, False)
            self.assertEqual(keep.read_text(), 'existing user data')
            manifest['sha256']['bridge/.data/keep.txt'] = 'wrong-checksum'
            write_json(private / 'manifest.json', manifest)
            with self.assertRaisesRegex(RuntimeError, '校验失败'):
                restore(root, False)
            self.assertFalse((private / 'restore-stage').exists())
            self.assertEqual(keep.read_text(), 'existing user data')

    def test_restore_isolated_data_offsets_and_idempotency(self):
        with tempfile.TemporaryDirectory(prefix='迁移 quote " ') as directory:
            parent = Path(directory)
            root = parent / 'cweb'
            private = root / '.migration'
            private.mkdir(parents=True)
            source = parent / 'fixture'
            codex = source / 'codex'
            rollout = codex / 'sessions/rollout-test.jsonl'
            rollout.parent.mkdir(parents=True)
            first = b'{"type":"session_meta","payload":{"cwd":"/old/app"}}\n'
            last = b'{"type":"event_msg","payload":{"text":"/old/app/file.txt"}}\n'
            rollout.write_bytes(first + last)
            with database(codex / 'state_5.sqlite') as db:
                db.execute('CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT)')
                db.execute('INSERT INTO threads VALUES (?,?,?)', ('developer', '/old/.codex/sessions/rollout-test.jsonl', '/old/app'))
            with database(codex / 'thread_history_1.sqlite') as db:
                db.execute('CREATE TABLE thread_turns (thread_id TEXT,turn_id TEXT,rollout_byte_offset INTEGER,rollout_end_byte_offset INTEGER,status TEXT)')
                db.execute('INSERT INTO thread_turns VALUES (?,?,?,?,?)', ('developer','turn',len(first),len(first + last),'inProgress'))
                db.execute('CREATE TABLE thread_history_projection_state (thread_id TEXT,next_rollout_byte_offset INTEGER)')
                db.execute('INSERT INTO thread_history_projection_state VALUES (?,?)', ('developer',len(first + last)))
            write_json(source / 'data/workspaces.json', {'version':1,'workspaces':[{'name':'app','path':'/old/app'}]})
            # Uploaded "JSON" files may contain arbitrary bytes; never parse them.
            upload = source / 'data/attachments/id/file-malformed.json'
            upload.parent.mkdir(parents=True)
            upload.write_bytes(b'invalid JSON /old/app')
            with tarfile.open(private / 'snapshot.tar.gz', 'w:gz') as archive:
                for path in source.rglob('*'):
                    if path.is_file():
                        archive.add(path, arcname=str(path.relative_to(source)))
            write_json(private / 'manifest.json', {'architecture':'x86_64','sourceRoot':'/old/app','sourceCodexHome':'/old/.codex','sourceHome':'/old','sourceNodeRoot':'/old/node','developerThread':'developer','sha256':{'.migration/snapshot.tar.gz':digest(private / 'snapshot.tar.gz')},'executables':[],'symlinks':{}})
            with patch.dict(os.environ, {'HOME': str(parent / 'new-home')}):
                result = restore(root, use_target_login=False)
                self.assertEqual(result['sessions'], 1)
                self.assertFalse((parent / 'new-home/.codex').exists())
                self.assertEqual(restore(root, False), result)
            restored = private / 'codex/sessions/rollout-test.jsonl'
            with database(private / 'codex/thread_history_1.sqlite') as db:
                offset, end, status = db.execute('SELECT rollout_byte_offset,rollout_end_byte_offset,status FROM thread_turns').fetchone()
            with restored.open('rb') as stream:
                stream.seek(offset)
                self.assertEqual(json.loads(stream.readline())['payload']['text'], str(root) + '/file.txt')
            self.assertEqual(end, restored.stat().st_size)
            self.assertEqual(status, 'interrupted')
            self.assertEqual((root / 'bridge/.data/attachments/id/file-malformed.json').read_bytes(), upload.read_bytes())
            ready_before = (private / 'ready.json').read_bytes()
            moved = parent / 'moved'
            root.rename(moved)
            with self.assertRaises(RuntimeError):
                restore(moved, False)
            self.assertEqual((moved / '.migration/ready.json').read_bytes(), ready_before)


if __name__ == '__main__':
    unittest.main()
