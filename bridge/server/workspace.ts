import { realpath, readdir, readFile, stat, lstat, open } from 'node:fs/promises'
import { relative, resolve, isAbsolute, sep, extname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BridgeError } from './errors.ts'
import type { Change, FileEntry } from '../shared/types.ts'

const exec = promisify(execFile)
const hidden = new Set(['node_modules', 'dist', 'target', 'vendor', 'upstream'])
const privatePreviewPaths = new Set(['.data', '.git', '.codex', '.ssh', '.aws', '.azure', '.config', '.docker', '.gnupg', '.kube', '.pki', 'node_modules'])
const privatePreviewNames = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials', '.bash_history', '.zsh_history'])
const previewLimit = 512 * 1024
const privateKeyHeader = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/
const previewLanguages: Record<string, string> = {
  '.md': 'markdown', '.mdx': 'markdown', '.json': 'json', '.jsonc': 'json', '.ts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'jsx', '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.sh': 'bash',
  '.bash': 'bash', '.css': 'css', '.html': 'html', '.svg': 'xml', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml', '.rs': 'rust', '.go': 'go', '.sql': 'sql', '.txt': 'text', '.log': 'text',
}

function privatePreviewSegment(segment: string): boolean {
  const name = segment.toLowerCase()
  return privatePreviewPaths.has(name) || privatePreviewNames.has(name) || /^\.env(?:[.-]|$)/i.test(name)
    || /^\.?((credentials?|secrets?|tokens?|passwords?|auth)(\.(json|ya?ml|toml|ini|cfg|conf|txt|xml))?|id_(rsa|dsa|ecdsa|ed25519)(\..*)?)$/i.test(name)
    || /\.(pem|key|p12|pfx|kdbx)$/i.test(name)
}

export class Workspace {
  private static referenceIndexes = new Map<string, { at: number; files: FileEntry[] }>()
  root: string
  constructor(root: string) { this.root = root }

  contains(path: string): boolean {
    const rel = relative(this.root, path)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  }

  async directory(path = '.'): Promise<string> {
    let canonical: string
    try { canonical = await realpath(resolve(this.root, path)) }
    catch { throw new BridgeError('PATH_MISSING', '目录不存在，请检查工作区路径', 404) }
    if (!this.contains(canonical)) throw new BridgeError('OUTSIDE_WORKSPACE', '路径必须位于当前选择的工作区内', 403)
    if (!(await stat(canonical)).isDirectory()) throw new BridgeError('NOT_DIRECTORY', '请选择一个目录')
    return canonical
  }

  private async safeFile(path: string): Promise<string> {
    const requested = resolve(this.root, path)
    const canonical = await realpath(requested).catch(() => { throw new BridgeError('FILE_MISSING', '文件不存在', 404) })
    if (!this.contains(canonical)) throw new BridgeError('OUTSIDE_WORKSPACE', '不能读取工作区之外的文件', 403)
    const segments = relative(this.root, canonical).split(sep)
    if (segments.some(segment => segment.startsWith('.') || segment === 'node_modules')) {
      throw new BridgeError('PRIVATE_FILE', '文件浏览器不展示隐藏配置及运行数据', 403)
    }
    return canonical
  }

  async files(path = '.'): Promise<FileEntry[]> {
    const dir = await this.directory(path)
    if (relative(this.root, dir).split(sep).some(segment => segment.startsWith('.') && segment !== '')) {
      throw new BridgeError('PRIVATE_FILE', '文件浏览器不展示隐藏目录', 403)
    }
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => !entry.name.startsWith('.') && !hidden.has(entry.name) && !entry.isSymbolicLink())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 500).map(entry => ({ name: entry.name, path: relative(this.root, resolve(dir, entry.name)), directory: entry.isDirectory() }))
  }

  async references(query = ''): Promise<FileEntry[]> {
    let index = Workspace.referenceIndexes.get(this.root)
    if (!index || Date.now() - index.at > 30_000) {
      const files: FileEntry[] = []; const directories = ['.']
      for (let i = 0; i < directories.length && i < 256 && files.length < 5000; i++) {
        const rows = await this.files(directories[i]).catch(() => [] as FileEntry[])
        for (const row of rows) {
          if (row.directory) { if (row.path.split(sep).length < 8) directories.push(row.path) }
          else files.push(row)
        }
      }
      index = { at: Date.now(), files }
      if (Workspace.referenceIndexes.size >= 16) Workspace.referenceIndexes.delete(Workspace.referenceIndexes.keys().next().value!)
      Workspace.referenceIndexes.set(this.root, index)
    }
    const needle = query.slice(0, 200).toLocaleLowerCase()
    return index.files.filter(row => row.path.toLocaleLowerCase().includes(needle)).slice(0, 80)
  }

  async file(path: string): Promise<string> {
    const file = await this.safeFile(path)
    return this.readTextFile(file)
  }

  /** Preview and desktop opening use the same real-path and sensitive-path restrictions. */
  private async previewTarget(path: string): Promise<{ canonical: string; path: string; kind: 'file' | 'directory' }> {
    const requested = resolve(this.root, path)
    if (!this.contains(requested)) throw new BridgeError('OUTSIDE_WORKSPACE', '不能读取工作区之外的文件', 403)
    const segments = relative(this.root, requested).split(sep).filter(Boolean)
    if (segments.some(privatePreviewSegment)) throw new BridgeError('PRIVATE_FILE', '不能预览凭据、私钥或应用运行数据', 403)
    // Reject links at every level, including an in-workspace alias to a sensitive directory.
    let current = this.root
    for (const segment of segments) {
      current = resolve(current, segment)
      const info = await lstat(current).catch(() => { throw new BridgeError('FILE_MISSING', '文件不存在', 404) })
      if (info.isSymbolicLink()) throw new BridgeError('SYMLINK_FILE', '请使用工作区内文件的真实路径，暂不预览符号链接', 403)
    }
    const canonical = await realpath(requested).catch(() => { throw new BridgeError('FILE_MISSING', '文件不存在', 404) })
    if (!this.contains(canonical)) throw new BridgeError('OUTSIDE_WORKSPACE', '不能读取工作区之外的文件', 403)
    const canonicalPath = relative(this.root, canonical) || '.'
    if (canonicalPath.split(sep).some(privatePreviewSegment)) throw new BridgeError('PRIVATE_FILE', '不能预览凭据、私钥或应用运行数据', 403)
    const info = await stat(canonical)
    if (info.isDirectory()) return { canonical, path: canonicalPath, kind: 'directory' }
    if (!info.isFile()) throw new BridgeError('NOT_FILE', '请选择普通文件或目录')
    return { canonical, path: canonicalPath, kind: 'file' }
  }

  /** Explicit document links may open safe dotfiles without exposing them in the browser/index. */
  async preview(path: string): Promise<{ path: string; kind: 'file' | 'directory'; text?: string; language?: string }> {
    const target = await this.previewTarget(path)
    if (target.kind === 'directory') return { path: target.path, kind: 'directory' }
    const text = await this.readTextFile(target.canonical)
    if (privateKeyHeader.test(text)) throw new BridgeError('PRIVATE_FILE', '不能预览私钥内容', 403)
    return { path: target.path, kind: 'file', text, language: previewLanguages[extname(target.canonical).toLowerCase()] || 'text' }
  }

  /** Resolve a local desktop target without loading large or binary files into the server. */
  async localOpenTarget(path: string): Promise<string> {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw new BridgeError('LOCAL_PATH', '请选择工作区内的本地文件或目录')
    const target = await this.previewTarget(path)
    if (target.kind === 'file') {
      // Scan the same bounded range as text previews, including disguised private-key files.
      const file = await open(target.canonical, 'r')
      try {
        const prefix = Buffer.alloc(Math.min((await file.stat()).size, previewLimit))
        let offset = 0
        while (offset < prefix.length) {
          const { bytesRead } = await file.read(prefix, offset, prefix.length - offset, offset)
          if (!bytesRead) break
          offset += bytesRead
        }
        if (privateKeyHeader.test(prefix.subarray(0, offset).toString('utf8'))) {
          throw new BridgeError('PRIVATE_FILE', '不能打开私钥内容', 403)
        }
      } finally { await file.close() }
    }
    return target.canonical
  }

  private async readTextFile(file: string): Promise<string> {
    const info = await stat(file)
    if (!info.isFile()) throw new BridgeError('NOT_FILE', '请选择普通文件')
    if (info.size > previewLimit) throw new BridgeError('FILE_LARGE', '文件超过 512 KB，请在编辑器中查看')
    const contents = await readFile(file)
    if (contents.length > previewLimit) throw new BridgeError('FILE_LARGE', '文件超过 512 KB，请在编辑器中查看')
    if (contents.includes(0)) throw new BridgeError('BINARY_FILE', '暂不预览二进制文件')
    return contents.toString('utf8')
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await exec('git', ['--no-pager', ...args], {
      cwd, timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    })
    return result.stdout
  }

  async changes(path = '.'): Promise<{ branch: string; changes: Change[]; git: boolean }> {
    const cwd = await this.directory(path)
    let top: string
    try { top = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim() }
    catch { return { branch: '', changes: [], git: false } }
    if (!this.contains(await realpath(top))) throw new BridgeError('OUTSIDE_REPO', 'Git 仓库根目录位于授权工作区之外', 403)
    const [branch, output] = await Promise.all([
      this.git(cwd, ['branch', '--show-current']),
      this.git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    ])
    const rows = output.split('\0'); const changes: Change[] = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (!row) continue
      const status = row.slice(0, 2)
      const file = relative(this.root, resolve(top, row.slice(3)))
      if (status.includes('R') || status.includes('C')) i++
      if (!file.split(sep).some(segment => segment.startsWith('.') || hidden.has(segment))) changes.push({ path: file, status: status.trim() })
    }
    return { branch: branch.trim() || 'HEAD', changes: changes.slice(0, 300), git: true }
  }

  async diff(cwdInput: string, path: string): Promise<string> {
    const cwd = await this.directory(cwdInput)
    const changes = await this.changes(cwd)
    const selected = changes.changes.find(change => change.path === path)
    if (!selected) throw new BridgeError('NO_CHANGE', '文件已无改动，请刷新列表', 404)
    if (selected.status === '??') {
      const content = await this.file(path)
      return `--- /dev/null\n+++ b/${path}\n` + content.split('\n').map(line => '+' + line).join('\n')
    }
    // Deleted files are valid diff targets; realpath must not be required for them.
    const target = resolve(this.root, path)
    if (!this.contains(target)) throw new BridgeError('OUTSIDE_WORKSPACE', '文件不在工作区内', 403)
    const args = ['--no-ext-diff', '--no-textconv', '--', relative(cwd, target)]
    let hasHead = true
    try { await this.git(cwd, ['rev-parse', '--verify', 'HEAD']) } catch { hasHead = false }
    const diff = hasHead ? await this.git(cwd, ['diff', 'HEAD', ...args])
      : (await this.git(cwd, ['diff', '--cached', ...args])) + (await this.git(cwd, ['diff', ...args]))
    return diff.slice(0, 200_000)
  }
}
