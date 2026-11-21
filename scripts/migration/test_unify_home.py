import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('unify_home', Path(__file__).with_name('unify-home.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class UnifyHomeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.source, self.target, self.backup = [self.root / name for name in ['default', 'portable', 'backup']]
        for home, key in [(self.source, 'source'), (self.target, 'target')]:
            home.mkdir()
            (home / 'auth.json').write_text(json.dumps({'auth_mode': 'chatgpt', 'tokens': {'account_id': 'same-account'}}))
            (home / 'config.toml').write_text('model = "' + key + '"\n')
            (home / 'sessions').mkdir()
            rollout = home / 'sessions' / (key + '.jsonl')
            rollout.write_bytes(b'{"type":"history","text":"preserve bytes"}\n')
            (home / 'session_index.jsonl').write_text(json.dumps({'id': key, 'thread_name': key}) + '\n')
            with sqlite3.connect(home / 'state_5.sqlite') as db:
                db.executescript('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, name TEXT, archived INTEGER); CREATE TABLE thread_sections (id TEXT PRIMARY KEY,name TEXT);')
                db.execute('INSERT INTO threads VALUES(?,?,?,?)', (key, str(rollout), key, 1 if key == 'source' else 0))
                db.execute('INSERT INTO thread_sections VALUES(?,?)', ('pinned', 'Pinned'))
            with sqlite3.connect(home / 'thread_history_1.sqlite') as db:
                db.execute('CREATE TABLE thread_turns (thread_id TEXT PRIMARY KEY, status TEXT, rollout_byte_offset INTEGER, encrypted BLOB)')
                db.execute('INSERT INTO thread_turns VALUES(?,?,?,?)', (key, 'completed', 7, b'\x00\xffnative'))

    def tearDown(self):
        self.directory.cleanup()

    def test_both_entries_share_ids_paging_names_and_future_writes(self):
        inode = (self.target / 'state_5.sqlite').stat().st_ino
        live = sqlite3.connect(self.target / 'state_5.sqlite')
        try:
            result = module.unify(self.source, self.target, self.backup)
            self.assertEqual(result['phase'], 'unified')
            self.assertEqual(self.source.resolve(), self.target)
            self.assertEqual((self.target / 'state_5.sqlite').stat().st_ino, inode)
            self.assertEqual(live.execute('SELECT id,name,archived FROM threads ORDER BY id').fetchall(), [('source','source',1),('target','target',0)])
            with sqlite3.connect(self.source / 'state_5.sqlite') as via_default:
                via_default.execute("UPDATE threads SET name='renamed' WHERE id='source'")
            self.assertEqual(live.execute("SELECT name FROM threads WHERE id='source'").fetchone()[0], 'renamed')
            with sqlite3.connect(self.source / 'thread_history_1.sqlite') as history:
                self.assertEqual(history.execute("SELECT rollout_byte_offset,encrypted FROM thread_turns WHERE thread_id='source'").fetchone(), (7,b'\x00\xffnative'))
            self.assertEqual((self.target / 'sessions/source.jsonl').read_bytes(), (self.backup / 'original-home/sessions/source.jsonl').read_bytes())
            self.assertEqual((self.target / 'config.toml').read_text(), 'model = "target"\n')
            self.assertEqual((self.backup / 'original-home/config.toml').read_text(), 'model = "source"\n')
            self.assertTrue(module.unify(self.source, self.target, self.backup).get('alreadyUnified'))
        finally:
            live.close()

    def test_duplicate_ids_or_accounts_are_rejected_before_any_merge(self):
        with sqlite3.connect(self.target / 'state_5.sqlite') as db:
            db.execute("UPDATE threads SET id='source'")
        with self.assertRaisesRegex(RuntimeError, 'ID 重复'):
            module.unify(self.source, self.target, self.backup)
        self.assertFalse(self.backup.exists())
        (self.source / 'auth.json').write_text('{"auth_mode":"chatgpt","tokens":{"account_id":"different"}}')
        with self.assertRaisesRegex(RuntimeError, '登录身份不同'):
            module.plan(self.source, self.target)

    def test_active_process_or_turn_blocks_cutover(self):
        with patch.object(module, 'processes', return_value=[123]):
            with self.assertRaisesRegex(RuntimeError, '进程'):
                module.unify(self.source, self.target, self.backup)
        with sqlite3.connect(self.source / 'thread_history_1.sqlite') as db:
            db.execute("UPDATE thread_turns SET status='inProgress'")
        with self.assertRaisesRegex(RuntimeError, '未结束轮次'):
            module.unify(self.source, self.target, self.backup)
        self.assertFalse(self.source.is_symlink())

    def test_failed_alias_exchange_rolls_back_database_and_new_rollouts(self):
        original = module.exchange
        calls = 0
        def fail(left, right):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise OSError('simulated atomic exchange failure')
            return original(left, right)
        with patch.object(module, 'exchange', side_effect=fail):
            with self.assertRaises(OSError):
                module.unify(self.source, self.target, self.backup)
        self.assertFalse(self.source.is_symlink())
        self.assertFalse((self.target / 'sessions/source.jsonl').exists())
        with sqlite3.connect(self.target / 'state_5.sqlite') as db:
            self.assertEqual(db.execute('SELECT id FROM threads').fetchall(), [('target',)])


if __name__ == '__main__':
    unittest.main()
