import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodexRpc, type RpcOptions } from './rpc.ts'
import { discoverCodexHomes } from './session-sources.ts'
import { array, BridgeError, record, string } from './errors.ts'

type Source = { home: string; key: number; rpc: CodexRpc; lists: Map<string, unknown[]>; version: number }
type RouterOptions = { discover?: () => Promise<string[]>; create?: (home: string) => Promise<CodexRpc>; discoveryMs?: number }

/** Route native IDs to their original home. No JSONL copying, database merging,
 * or global CODEX_HOME changes: running terminal clients keep owning their turns. */
export class SessionRouter extends CodexRpc {
  private primary: RpcOptions
  private routing: RouterOptions
  private sources = new Map<string, Source>()
  private owners = new Map<string, CodexRpc>()
  private requestRoutes = new Map<string, { rpc: CodexRpc; id: string | number }>()
  private discovering?: Promise<void>
  private discoveredAt = 0
  private listing = new Map<string, Promise<unknown>>()
  private foreignReadAt = new Map<string, number>()
  private foreignReads = new Map<string, Promise<void>>()
  private sourceSequence = 0
  private closed = false

  constructor(options: RpcOptions, routing: RouterOptions = {}) { super(options); this.primary = options; this.routing = routing }
  override forThread(id: string): CodexRpc { return this.owners.get(id) || this }

  private async refreshSources() {
    if (this.closed || Date.now() - this.discoveredAt < (this.routing.discoveryMs ?? 5000)) return
    if (this.discovering) return this.discovering
    this.discovering = (async () => {
      const homes = await (this.routing.discover?.() || discoverCodexHomes(this.home || this.primary.cwd))
      for (const home of homes) {
        if (this.sources.size >= 8) break
        if (this.closed || home === this.home || this.sources.has(home)) continue
        const rpc = await (this.routing.create?.(home) || this.createSource(home))
        if (this.closed) { await rpc.dispose(); break }
        const source: Source = { home, key: ++this.sourceSequence, rpc, lists: new Map(), version: 0 }
        this.sources.set(home, source)
        rpc.on('notification', value => this.forward(source, record(value)))
        rpc.on('request', value => this.forward(source, record(value), true))
        // A foreign engine outage must never interrupt the primary engine's tasks.
        rpc.on('disconnected', () => {
          for (const [key, rows] of source.lists) source.lists.set(key, rows.map(row => ({ ...record(row), status: { type: 'notLoaded' } })))
          for (const [key, route] of this.requestRoutes) if (route.rpc === rpc) this.requestRoutes.delete(key)
          this.emit('sourceDisconnected', { ids: [...this.owners].filter(([, owner]) => owner === rpc).map(([id]) => id) })
        })
      }
      this.discoveredAt = Date.now()
    })().finally(() => { this.discovering = undefined })
    return this.discovering
  }

  private async createSource(home: string) {
    const socketPath = resolve(home, 'app-server-control/app-server-control.sock')
    const shared = (await stat(socketPath).catch(() => null))?.isSocket()
    const daemon = shared ? record(await readFile(resolve(home, 'app-server-daemon/daemon.pid'), 'utf8').then(JSON.parse).catch(() => ({}))) : {}
    return new CodexRpc({ ...this.primary, ...(shared ? { socketPath, enginePid: Number(daemon.pid) || undefined, socketFallback: true } : { socketPath: undefined, enginePid: undefined }),
      env: { ...this.primary.env, CODEX_HOME: home }, timeoutMs: 5000 })
  }

  private forward(source: Source, message: Record<string, unknown>, request = false) {
    if (this.closed) return
    const params = record(message.params), id = string(params.threadId) || string(record(params.thread).id)
    if (message.method === 'serverRequest/resolved') {
      const key = `source:${source.key}:${JSON.stringify(params.requestId)}`
      if (this.requestRoutes.delete(key)) this.emit('notification', { ...message, params: { ...params, requestId: key } })
      return
    }
    // Account/config notifications belong to their own engine, not the main account UI.
    if (!id) return
    const owner = this.owners.get(id)
    if (owner && owner !== source.rpc) return
    this.owners.set(id, source.rpc)
    if (request) {
      if (typeof message.id !== 'string' && typeof message.id !== 'number') return
      const key = `source:${source.key}:${JSON.stringify(message.id)}`
      this.requestRoutes.set(key, { rpc: source.rpc, id: message.id })
      this.emit('request', { ...message, id: key })
    } else this.emit('notification', message)
  }

  private async sourceList(rpc: CodexRpc, params: Record<string, unknown>) {
    await rpc.start()
    const rows: unknown[] = [], cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const input = { ...params, ...(cursor ? { cursor } : {}) }
      const result = record(await (rpc === this ? super.call('thread/list', input) : rpc.call('thread/list', input)))
      rows.push(...array(result.data))
      cursor = string(result.nextCursor) || undefined
      if (cursor && cursors.has(cursor)) throw new BridgeError('CLI_PROTOCOL', 'CLI 返回了重复的会话列表游标', 502)
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return rows
  }

  private async listSources(params: Record<string, unknown>) {
    // The bridge consumes the entire directory; native paging stays inside each
    // source so opaque cursors from different engines can never be mixed.
    const key = JSON.stringify(params)
    const existing = this.listing.get(key)
    if (existing) return existing
    const operation = (async () => {
      const rows = await this.sourceList(this, params), seen = new Set<string>(), result: unknown[] = []
      // Primary IDs win over a duplicate copied history. Mutations never jump
      // to a different source merely because that copy has a newer timestamp.
      for (const row of rows) {
        const id = string(record(row).id); if (!id) continue
        seen.add(id); this.owners.set(id, this); result.push(row)
      }
      // Discover/read other homes in the background: a stale or slow terminal
      // must not hold up the main conversation's first paint or a new message.
      if (params.archived) await this.refreshForeign(params).catch(() => {})
      else void this.refreshForeign(params).catch(() => {})
      for (const source of this.sources.values()) for (const row of source.lists.get(key) || []) {
        const id = string(record(row).id); if (!id || seen.has(id) || this.owners.get(id) === this) continue
        const owner = this.owners.get(id)
        if (owner && owner !== source.rpc) continue
        seen.add(id); this.owners.set(id, source.rpc); result.push(row)
      }
      return { data: result, nextCursor: null }
    })().finally(() => this.listing.delete(key))
    this.listing.set(key, operation)
    return operation
  }

  private async refreshForeign(params: Record<string, unknown>) {
    const key = JSON.stringify(params)
    if (this.foreignReads.has(key)) return this.foreignReads.get(key)
    if (this.closed || Date.now() - (this.foreignReadAt.get(key) || 0) < 5000) return
    this.foreignReadAt.set(key, Date.now())
    const operation = (async () => {
      await this.refreshSources()
      let changed = false
      await Promise.all([...this.sources.values()].map(async source => {
        try {
          const version = source.version
          const rows = await this.sourceList(source.rpc, params)
          if (this.closed) return
          if (source.version !== version) { this.foreignReadAt.delete(key); return }
          if (JSON.stringify(rows) !== JSON.stringify(source.lists.get(key))) changed = true
          source.lists.set(key, rows)
        } catch { /* Keep the last readable directory; primary sessions stay usable. */ }
      }))
      if (changed && !this.closed) this.emit('sourcesChanged')
    })().finally(() => this.foreignReads.delete(key))
    this.foreignReads.set(key, operation)
    return operation
  }

  private rememberMutation(rpc: CodexRpc, id: string, method: string, params: Record<string, unknown>) {
    if (!['thread/archive', 'thread/unarchive', 'thread/name/set'].includes(method)) return
    for (const source of this.sources.values()) {
      if (source.rpc !== rpc) continue
      source.version++
      const known = [...source.lists.values()].flat().find(row => record(row).id === id)
      for (const [key, rows] of source.lists) {
        if (method === 'thread/name/set') source.lists.set(key, rows.map(row => record(row).id === id ? { ...record(row), name: params.name } : row))
        else {
          const archived = method === 'thread/archive', filtered = rows.filter(row => record(row).id !== id)
          if (Boolean(JSON.parse(key).archived) === archived && known) filtered.push({ ...record(known), archived })
          source.lists.set(key, filtered)
        }
        this.foreignReadAt.delete(key)
      }
    }
  }

  override async call(method: string, params: object = {}): Promise<unknown> {
    if (method === 'thread/list') return this.listSources(record(params))
    const id = string(record(params).threadId), rpc = this.forThread(id)
    if (rpc === this) return super.call(method, params)
    await rpc.start()
    const result = await rpc.call(method, params)
    this.rememberMutation(rpc, id, method, record(params))
    const created = string(record(record(result).thread).id)
    if (created && !this.owners.has(created)) this.owners.set(created, rpc)
    return result
  }

  override respond(id: string | number, result: object) {
    const route = typeof id === 'string' ? this.requestRoutes.get(id) : undefined
    if (route) { this.requestRoutes.delete(String(id)); route.rpc.respond(route.id, result) }
    else if (typeof id === 'string' && id.startsWith('source:')) throw new BridgeError('REQUEST_EXPIRED', '原终端的请求已过期，请刷新会话', 409)
    else super.respond(id, result)
  }
  override rejectRequest(id: string | number, message: string) {
    const route = typeof id === 'string' ? this.requestRoutes.get(id) : undefined
    if (route) { this.requestRoutes.delete(String(id)); route.rpc.rejectRequest(route.id, message) }
    else if (typeof id === 'string' && id.startsWith('source:')) throw new BridgeError('REQUEST_EXPIRED', '原终端的请求已过期，请刷新会话', 409)
    else super.rejectRequest(id, message)
  }
  override async dispose() {
    this.closed = true
    await this.discovering?.catch(() => {})
    await Promise.all([...this.sources.values()].map(source => source.rpc.dispose()))
    this.sources.clear(); this.requestRoutes.clear()
    await super.dispose()
  }
}
