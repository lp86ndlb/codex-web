import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path'
import { homedir } from 'node:os'
import { BridgeError } from './errors.ts'
import type { DirectoryListing } from '../shared/types.ts'

/** Local folder selection exposes directory names only. It grants no project/file access. */
export async function browseDirectories(input: { path?: string; hidden?: boolean; query?: string; offset?: number }): Promise<DirectoryListing> {
  const requested = input.path ?? homedir()
  if (!isAbsolute(requested) || requested.includes('\0')) throw new BridgeError('DIRECTORY_PATH', '请选择本机文件夹，或输入完整路径')
  try {
    const path = await realpath(requested)
    if (!(await stat(path)).isDirectory()) throw new BridgeError('NOT_DIRECTORY', '此路径不是文件夹')
    const query = (input.query || '').trim().toLocaleLowerCase()
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter(entry => (input.hidden || !entry.name.startsWith('.')) && (!query || entry.name.toLocaleLowerCase().includes(query)))
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    const directories: DirectoryListing['directories'] = []
    // Resolve link types in bounded batches; never recurse or read file contents.
    for (let i = 0; i < entries.length; i += 32) {
      const batch = await Promise.all(entries.slice(i, i + 32).map(async entry => {
        const target = resolve(path, entry.name)
        if (entry.isSymbolicLink() && !(await stat(target).catch(() => null))?.isDirectory()) return null
        return { name: entry.name, path: target, symlink: entry.isSymbolicLink() }
      }))
      for (const entry of batch) if (entry) directories.push(entry)
    }
    const breadcrumbs: DirectoryListing['breadcrumbs'] = []
    for (let cursor = path; ; cursor = dirname(cursor)) {
      breadcrumbs.unshift({ name: basename(cursor) || '文件系统', path: cursor })
      if (dirname(cursor) === cursor) break
    }
    const limit = 200; const offset = input.offset || 0
    return { path, parent: dirname(path) === path ? null : dirname(path), home: homedir(), root: parse(path).root,
      breadcrumbs, directories: directories.slice(offset, offset + limit), total: directories.length, offset, limit }
  } catch (error) {
    if (error instanceof BridgeError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') throw new BridgeError('DIRECTORY_DENIED', '没有权限打开这个文件夹，请选择其他位置', 403)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new BridgeError('DIRECTORY_MISSING', '文件夹不存在或已被移动，请重新选择', 404)
    throw new BridgeError('DIRECTORY_READ', '暂时无法读取这个文件夹，请重试', 500)
  }
}
