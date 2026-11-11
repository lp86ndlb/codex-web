import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Workspace } from './workspace.ts'
import { JsonStore } from './storage.ts'
import { BridgeError } from './errors.ts'
import type { WorkspaceInfo } from '../shared/types.ts'

const schema = z.object({ version: z.literal(1), workspaces: z.array(z.object({
  id: z.string(), name: z.string(), path: z.string(), createdAt: z.number(),
})) })

export class WorkspaceCatalog {
  private store: JsonStore<z.infer<typeof schema>>
  private entries: WorkspaceInfo[] = []
  private initial?: Workspace
  constructor(file: string, initial?: Workspace) {
    this.initial = initial
    this.store = new JsonStore(file, { version: 1, workspaces: [] }, value => schema.parse(value))
  }
  async initialize() {
    this.entries = (await this.store.read()).workspaces
    if (this.initial && !this.find(this.initial.root)) await this.add(this.initial.root)
  }
  list() { return this.entries.map(entry => ({ ...entry })) }
  find(path: string) {
    return this.entries.filter(entry => new Workspace(entry.path).contains(path)).sort((a, b) => b.path.length - a.path.length)[0]
  }
  get(id: string): Workspace {
    const entry = this.entries.find(entry => entry.id === id)
    if (!entry) throw new BridgeError('WORKSPACE_MISSING', '请先选择一个已添加的工作区', 404)
    return new Workspace(entry.path)
  }
  forPath(path: string): Workspace {
    const entry = this.find(path)
    if (!entry) throw new BridgeError('OUTSIDE_WORKSPACE', '请先在工作区列表中添加此目录', 403)
    return new Workspace(entry.path)
  }
  async add(path: string, name?: string): Promise<WorkspaceInfo> {
    if (!isAbsolute(path)) throw new BridgeError('ABSOLUTE_PATH', '请输入项目的绝对路径，例如 /home/用户名/projects/app')
    let canonical: string
    try { canonical = await realpath(resolve(path)); if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory') }
    catch { throw new BridgeError('PATH_MISSING', '目录不存在或无法访问，请检查路径', 404) }
    const entry = await this.store.update(data => {
      const existing = data.workspaces.find(entry => entry.path === canonical)
      if (existing) return existing
      const value = { id: randomUUID(), name: name?.trim() || basename(canonical) || canonical, path: canonical, createdAt: Date.now() }
      data.workspaces.push(value); return value
    })
    this.entries = (await this.store.read()).workspaces
    return entry
  }
  async rename(id: string, name: string) {
    await this.store.update(data => {
      const entry = data.workspaces.find(entry => entry.id === id)
      if (!entry) throw new BridgeError('WORKSPACE_MISSING', '工作区不存在', 404)
      entry.name = name.trim()
    })
    this.entries = (await this.store.read()).workspaces
  }
  /** Native session cwd identifies its workspace, even when a parent was added earlier. */
  async recover(paths: string[]) {
    const missing = [...new Set(paths)].filter(path => isAbsolute(path) && !this.entries.some(entry => entry.path === path))
    if (!missing.length) return
    await this.store.update(data => {
      for (const path of missing) if (!data.workspaces.some(entry => entry.path === path)) {
        data.workspaces.push({ id: randomUUID(), name: basename(path) || path, path, createdAt: Date.now() })
      }
    })
    this.entries = (await this.store.read()).workspaces
  }
}
