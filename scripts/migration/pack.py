#!/usr/bin/env python3
"""Build a private Linux x86_64 cweb migration ZIP. Never upload it to Git."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import zipfile

from common import database, digest, snapshot_database, write_json


def copy(source, target):
    if not source.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, target, symlinks=True, dirs_exist_ok=True)
    else:
        shutil.copy2(source, target)


def snapshot_rollout(source, target):
    """Copy a bounded, complete JSONL prefix while the original agent keeps running."""
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open('rb') as incoming, target.open('wb') as output:
        remaining = os.fstat(incoming.fileno()).st_size
        while remaining:
            raw = incoming.readline(remaining)
            if not raw or not raw.endswith(b'\n'):
                break
            remaining -= len(raw)
            output.write(raw)


def codex_aliases(codex_home):
    default = Path.home() / '.codex'
    return [str(default)] if default.is_dir() and default.resolve() == codex_home.resolve() and default != codex_home else []


def snapshot(codex_home, data, target, developer):
    codex = target / 'codex'
    codex.mkdir(parents=True)
    # Back up SQLite through its API, including committed WAL content. Never copy
    # live database files with cp, nor carry IPC, locks, work queues or credentials.
    for name in ('state_5.sqlite', 'thread_history_1.sqlite', 'goals_1.sqlite', 'memories_1.sqlite'):
        if (codex_home / name).exists():
            snapshot_database(codex_home / name, codex / name)
    with database(codex / 'state_5.sqlite') as index:
        rows = index.execute('SELECT id,rollout_path FROM threads').fetchall()
        if developer not in {row[0] for row in rows}:
            raise RuntimeError('开发会话不在原生数据库中')
        index.execute('DELETE FROM remote_control_enrollments')
    count = 0
    for folder in ('sessions', 'archived_sessions'):
        for source in sorted((codex_home / folder).rglob('*.jsonl')):
            snapshot_rollout(source, codex / source.relative_to(codex_home))
            count += 1
    for _, path in rows:
        if not (codex / Path(path).resolve().relative_to(codex_home.resolve())).is_file():
            raise RuntimeError('会话索引引用的历史缺失: ' + Path(path).name)
    for name in ('skills', 'plugins', 'memories', 'config.toml', 'AGENTS.md', 'models_cache.json'):
        copy(codex_home / name, codex / name)
    for name in ('session_index.jsonl', 'history.jsonl'):
        if (codex_home / name).exists():
            snapshot_rollout(codex_home / name, codex / name)
    for name in ('attachments', 'plugins', 'run-history', 'edit-backups', 'preferences.json', 'workspaces.json', 'history-import.json', 'session-context.json', 'submission-receipts.json'):
        copy(data / name, target / 'data' / name)
    # Credentials must not sneak in through plugin caches or other copied trees.
    for path in target.rglob('*'):
        if path.is_symlink():
            raise RuntimeError('运行数据中包含需要人工处理的符号链接: ' + str(path.relative_to(target)))
        if path.name in ('auth.json', 'credentials.json', 'token.json') or path.suffix in ('.key', '.pem'):
            raise RuntimeError('运行数据中发现凭据文件，未生成迁移包: ' + str(path.relative_to(target)))
    return {'sessionFiles': count, 'indexedThreads': len(rows)}


def pack(root, codex_home, data, node, dist, output, developer):
    if platform.machine() != 'x86_64':
        raise RuntimeError('当前打包器只验证了 Linux x86_64')
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise RuntimeError('输出已存在，请换一个文件名，避免覆盖旧备份')
    with tempfile.TemporaryDirectory(prefix='cweb-package-', dir=output.parent) as temporary:
        stage = Path(temporary) / 'cweb'
        stage.mkdir()
        names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
        for name in filter(None, names):
            copy(root / name, stage / name)
        copy(root / '.git', stage / '.git')
        # Keep repository history; discard this machine's key path/SSH overrides.
        for key in ('core.sshCommand', 'remote.origin.pushurl'):
            subprocess.run(['git', 'config', '--local', '--unset-all', key], cwd=stage, check=False)
        with (stage / '.git/info/exclude').open('a') as excludes:
            excludes.write('\n# Private portable-package entry points and developer handoff\n/codex-portable\n/继续开发会话.sh\n/先读我-迁移说明.md\n/MIGRATION_HANDOFF.md\n')
        copy(root / 'bridge/node_modules', stage / 'bridge/node_modules')
        copy(dist, stage / 'bridge/dist')
        # Selected top-level screenshots and review notes referenced by old replies.
        for source in (root / '.cache').glob('*'):
            if source.is_file() and source.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.md'):
                copy(source, stage / '.cache' / source.name)
        runtime = stage / '.runtime'
        node_root = node.parent.parent
        copy(node, runtime / 'bin/node')
        copy(node_root / 'LICENSE', runtime / 'LICENSE')
        copy(node_root / 'lib/node_modules/npm', runtime / 'lib/node_modules/npm')
        if (node_root / 'git/usr/bin/git').is_file() and (node_root / 'bin/git').is_file():
            copy(node_root / 'git', runtime / 'git')
            copy(node_root / 'bin/git', runtime / 'bin/git')
        for name, target in [('npm', '../lib/node_modules/npm/bin/npm-cli.js'), ('npx', '../lib/node_modules/npm/bin/npx-cli.js')]:
            (runtime / 'bin' / name).symlink_to(target)
        private = stage / '.migration'
        private.mkdir(mode=0o700)
        state = Path(temporary) / 'snapshot'
        state.mkdir(mode=0o700)
        counts = snapshot(codex_home, data, state, developer)
        print('已取得原生会话和 cweb 数据快照: ' + json.dumps(counts), flush=True)
        with tarfile.open(private / 'snapshot.tar.gz', 'w:gz', compresslevel=3) as archive:
            for path in sorted(state.rglob('*')):
                if path.is_file():
                    archive.add(path, arcname=str(path.relative_to(state)), recursive=False)
        (stage / 'codex-portable').write_text('#!/usr/bin/env bash\nset -euo pipefail\nCWEB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\nexec bash "$CWEB_DIR/scripts/migration/run.sh" --cli "$@"\n')
        (stage / '继续开发会话.sh').write_text('#!/usr/bin/env bash\nset -euo pipefail\nCWEB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\nexec bash "$CWEB_DIR/codex-portable" resume --cd "$CWEB_DIR" ' + developer + '\n')
        for name in ('codex-portable', '继续开发会话.sh'):
            (stage / name).chmod(0o700)
        copy(root / 'docs/migration-package.md', stage / '先读我-迁移说明.md')
        # Generate current handoff metadata instead of carrying an obsolete
        # first-migration note from a previous machine's cache.
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip()
        (stage / 'MIGRATION_HANDOFF.md').write_text(
            '# cweb 开发会话交接\n\n'
            '这是当前代码和原生历史的私人迁移快照，不要从头重建。\n\n'
            '- 开发会话：`' + developer + '`；使用网页或 `bash 继续开发会话.sh` 接续。\n'
            '- 源码提交：`' + commit + '`；快照时间见 `.migration/manifest.json`。\n'
            '- 首次运行 `bash cweb`，恢复后新开 Bash 验证 `cweb doctor` 与 `codex resume`。\n'
            '- `.migration/codex` 是活动原生会话库，不是可删除的临时目录。\n'
            '- 请先读 `docs/migration-lessons.md`、`docs/migration-package.md` 和本会话待办。\n'
            '- 本机是否通过验收以当前实测为准；原机结果不能替代新机验证。\n'
            '- 修改前 Git 备份；保留运行任务，前端可独立发布；任务完成提交用户确认。\n')
        manifest = {'format': 1, 'architecture': 'x86_64', 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'sourceRoot': str(root), 'sourceHome': str(Path.home()), 'sourceCodexHome': str(codex_home), 'sourceNodeRoot': str(node_root), 'developerThread': developer, 'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(), 'nodeVersion': subprocess.check_output([str(node), '--version']).decode().strip(), 'codexVersion': '0.169.0', 'counts': counts, 'excluded': ['auth.json', 'SSH keys', 'IPC/PID/locks', 'pending execution queues', 'browser profile/localStorage', 'other workspace project files', 'temporary system files and most build/test caches'], 'sha256': {}, 'symlinks': {}, 'executables': []}
        manifest['sourceCodexAliases'] = codex_aliases(codex_home)
        for path in sorted(stage.rglob('*')):
            name = str(path.relative_to(stage))
            if path.is_symlink():
                target = os.readlink(path)
                (path.parent / target).resolve().relative_to(stage.resolve())
                manifest['symlinks'][name] = target
            elif path.is_file():
                manifest['sha256'][name] = digest(path)
                if path.stat().st_mode & 0o111:
                    manifest['executables'].append(name)
        write_json(private / 'manifest.json', manifest)
        partial = output.with_suffix('.zip.partial')
        try:
            with zipfile.ZipFile(partial, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
                for path in sorted(stage.rglob('*')):
                    if path.is_file() and not path.is_symlink():
                        archive.write(path, 'cweb/' + str(path.relative_to(stage)), compress_type=zipfile.ZIP_STORED if path.name.endswith('.tar.gz') else zipfile.ZIP_DEFLATED)
            with zipfile.ZipFile(partial) as archive:
                bad = archive.testzip()
                if bad:
                    raise RuntimeError('ZIP 校验失败: ' + bad)
            partial.chmod(0o600)
            partial.replace(output)
        finally:
            if partial.exists():
                partial.unlink()
        checksum = digest(output)
        output.with_suffix('.zip.sha256').write_text(checksum + '  ' + output.name + '\n')
        write_json(output.with_suffix('.summary.json'), {**counts, 'zip': str(output), 'bytes': output.stat().st_size, 'sha256': checksum, 'developerThread': developer, 'createdAt': manifest['createdAt']})
        print('迁移包已生成并通过 ZIP 校验: ' + str(output), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--codex-home', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))))
    parser.add_argument('--data', type=Path)
    parser.add_argument('--dist', type=Path)
    parser.add_argument('--node', type=Path, default=Path(shutil.which('node') or '/usr/bin/node'))
    parser.add_argument('--developer-thread', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    pack(args.root.resolve(), args.codex_home.resolve(), (args.data or args.root / 'bridge/.data').resolve(), args.node.resolve(), (args.dist or args.root / 'bridge/dist').resolve(), args.output.resolve(), args.developer_thread)


if __name__ == '__main__':
    main()
