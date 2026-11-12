import { EventEmitter } from 'node:events'
import type { Approval, ApprovalPolicy, Bootstrap, Mode, StreamEvent, ThreadSummary, ThreadView, Preferences, SkillInfo, QueuedMessage, ThreadGoal } from '../shared/types.ts'
import { CodexRpc } from './rpc.ts'
import { Workspace } from './workspace.ts'
import { WorkspaceCatalog } from './catalog.ts'
import { TodoNotePlugin, todoTools } from './todo-note.ts'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PreferencesStore } from './preferences.ts'
import { AttachmentStore } from './attachments.ts'
import { sessionOwners } from './session-access.ts'
import { GenuiStore, genuiInstructions, genuiSkillPath, genuiTool, genuiValidateTool } from './genui.ts'
import { choiceInstructions } from './choice-instructions.ts'
import { RunHistory, quotaChange, quotaSnapshot, type QuotaSnapshot } from './run-history.ts'
import { applyNotification, projectThread } from './projection.ts'
import { array, BridgeError, record, string } from './errors.ts'
import { recoveryPolicy, hasRecoveryOutput } from './auto-recovery.ts'
import { SessionContextStore } from './session-context.ts'

interface PendingRequest { wireId: string | number; approval: Approval; params: Record<string, unknown> }
interface RecoverySource { input?: MessageInput; sourceTurnId: string; retryTurnId?: string; attempt: number; failure: string; blocked?: boolean; starting?: boolean; timer?: ReturnType<typeof setTimeout> }
export interface MessageInput { text: string; model?: string; effort?: string; mode: Mode; approvalPolicy?: ApprovalPolicy; collaborationMode?: 'default' | 'plan'; steer?: boolean; attachments?: string[]; skills?: string[]; clientMessageId?: string }

/** Native Codex owns history; this instance owns only live UI projections and unresolved prompts. */
export class Bridge extends EventEmitter {
  rpc: CodexRpc
  catalog: WorkspaceCatalog
  plugin: TodoNotePlugin
  preferences: PreferencesStore
  attachments: AttachmentStore
  genui: GenuiStore
  metrics: RunHistory
  codexHome: string
  readonly dataDirectory: string
  readonly sharedHistory: boolean
  threads = new Map<string, ThreadView>()
  private summaries = new Map<string, ThreadSummary>()
  private pending = new Map<string, PendingRequest>()
  private loaded = new Set<string>()
  private opening = new Map<string, Promise<ThreadView>>()
  private submitting = new Set<string>()
  private submissionDone = new Map<string, Promise<void>>()
  private creating = 0
  private queued: (QueuedMessage & { input: MessageInput })[] = []
  private draining = new Set<string>()
  private renderTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private revisions = new Map<string, number>()
  private sent = new Map<string, ThreadView>()
  private ownedTurns = new Set<string>()
  private fresh = new Set<string>()
  private summaryTimer?: ReturnType<typeof setTimeout>
  private refreshPromise?: Promise<ThreadSummary[]>
  private listReadAt = 0
  private reading = new Map<string, Promise<ThreadView>>()
  private readAt = new Map<string, number>()
  private todoMcpThreads = new Set<string>()
  private todoLinksActive = new Set<string>()
  private todoRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly todoMcpName: string
  private httpOrigin = ''
  private modePresets: Record<string, unknown>[] | null = null
  private quotaPending = new Map<string, QuotaSnapshot>()
  private quotaStarts = new Map<string, QuotaSnapshot>()
  private metadataWrites = new Set<Promise<void>>()
  private reconciliationTimer?: ReturnType<typeof setTimeout>
  private reconciling = new Map<string, Promise<ThreadView | undefined>>()
  private reconciledAt = new Map<string, number>()
  private reconciliationEpoch = 0
  private disposed = false
  private autoRecoveries = new Map<string, RecoverySource>()
  private sessionContexts: SessionContextStore
  private observedContexts = new Set<string>()

  constructor(rpc: CodexRpc, workspace: Workspace | WorkspaceCatalog, codexHome: string, dataDirectory = dirname(codexHome), sharedHistory = false) {
    super(); this.rpc = rpc; this.codexHome = codexHome; this.dataDirectory = dataDirectory; this.sharedHistory = sharedHistory
    this.catalog = workspace instanceof Workspace ? new WorkspaceCatalog(resolve(dataDirectory, 'workspaces.json'), workspace) : workspace
    this.plugin = new TodoNotePlugin(resolve(dataDirectory, 'plugins/todo-note'))
    this.todoMcpName = `cweb_note_${createHash('sha256').update(resolve(dataDirectory)).digest('hex').slice(0, 10)}`
    this.preferences = new PreferencesStore(resolve(dataDirectory, 'preferences.json'))
    this.attachments = new AttachmentStore(resolve(dataDirectory, 'attachments'))
    this.genui = new GenuiStore(resolve(dataDirectory, 'plugins/genui'))
    this.metrics = new RunHistory(resolve(dataDirectory, 'run-history'))
    this.sessionContexts = new SessionContextStore(resolve(dataDirectory, 'session-context.json'))
    rpc.on('notification', message => this.notification(record(message)))
    rpc.on('request', message => this.request(record(message)))
    rpc.on('status', runtime => this.publish({ type: 'runtime', runtime }))
    rpc.on('disconnected', () => {
      for (const id of this.autoRecoveries.keys()) this.cancelRecovery(id)
      if (!this.disposed) for (const id of this.observedContexts) { void this.sessionContexts.invalidate(id); void this.sessionContexts.invalidate(`${id}:live`) }
      this.observedContexts.clear()
      this.reconciliationEpoch++
      if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer)
      this.reconciliationTimer = undefined; this.reconciling.clear(); this.reconciledAt.clear()
      this.modePresets = null
      this.loaded.clear(); this.pending.clear(); this.ownedTurns.clear(); this.fresh.clear(); this.sent.clear(); this.reading.clear(); this.readAt.clear(); this.todoMcpThreads.clear(); this.todoLinksActive.clear(); this.listReadAt = 0
      this.publish({ type: 'approvals', approvals: [] })
      for (const thread of this.threads.values()) {
        if (thread.status === 'inProgress') {
          thread.status = 'interrupted'; thread.turnId = null
          thread.error = 'CLI 连接已中断，执行结果未知。重新连接后查看会话记录'
          this.changed(thread)
        }
      }
    })
  }

  private publish(event: StreamEvent) { this.emit('event', event) }
  setHttpPort(port: number) { this.httpOrigin = `http://127.0.0.1:${port}` }
  get workspace() { return this.catalog.get(this.catalog.list()[0]?.id || '') }
  get active() { return this.queued.length > 0 || this.creating > 0 || this.submitting.size > 0 || this.opening.size > 0 || [...this.threads.values()].some(thread => thread.turnId) }
  async initialize() { await this.catalog.initialize(); await this.plugin.initialize() }
  private async projectHistory(value: unknown) {
    const thread = projectThread(await this.hydrateHistory(value))
    try { return await this.metrics.enrich(thread) }
    catch { thread.error ||= '本地任务统计暂时无法读取；CLI 对话记录仍可正常查看和继续。'; return thread }
  }
  private async hydrateHistory(value: unknown): Promise<Record<string, unknown>> {
    const raw = record(value)
    if (raw.historyMode !== 'paginated') {
      if (!array(raw.turns).length && string(raw.id)) return record(record(await this.rpc.call('thread/read', { threadId: raw.id, includeTurns: true })).thread)
      return raw
    }
    const turns: unknown[] = []; let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = record(await this.rpc.call('thread/turns/list', { threadId: raw.id, limit: 100, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) }))
      turns.push(...array(page.data)); cursor = string(page.nextCursor) || undefined
      if (cursor && seen.has(cursor)) throw new BridgeError('CLI_PROTOCOL', 'CLI 返回了重复的历史分页游标', 502)
      if (cursor) seen.add(cursor)
    } while (cursor)
    return { ...raw, turns }
  }
  private async captureQuota(): Promise<QuotaSnapshot | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([this.rpc.call('account/rateLimits/read', {}).then(quotaSnapshot).catch(() => undefined), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1200) })]) }
    finally { clearTimeout(timer) }
  }
  private saveRunMetadata(thread: ThreadView, turnId: string) {
    const before = this.quotaStarts.get(`${thread.id}:${turnId}`); this.quotaStarts.delete(`${thread.id}:${turnId}`)
    const work = (async () => {
      await this.metrics.save(thread)
      if (!before) return
      const quota = quotaChange(before, await this.captureQuota()); const latest = this.threads.get(thread.id)
      if (!latest || !quota) return
      const updated = { ...latest, runs: latest.runs?.map(run => run.id === turnId ? { ...run, quota } : run) }
      this.changed(updated); await this.metrics.save(updated)
    })().catch(() => {
      const latest = this.threads.get(thread.id)
      if (latest) this.changed({ ...latest, error: '本地任务统计保存失败；对话记录仍由 CLI 保存。' })
    }).finally(() => this.metadataWrites.delete(work))
    this.metadataWrites.add(work)
  }
  private async collaborationModes() {
    if (!this.modePresets) {
      try { this.modePresets = array(record(await this.rpc.call('collaborationMode/list', {})).data).map(record) }
      catch { this.modePresets = [] }
    }
    return this.modePresets
  }
  async goal(id: string, patch?: { objective?: string; status?: 'active' | 'paused'; tokenBudget?: number | null }, clear = false): Promise<{ goal: ThreadGoal | null }> {
    if (!this.summaries.has(id)) await this.refreshList(true)
    if (!this.summaries.has(id)) throw new BridgeError('THREAD_MISSING', '会话不存在或已归档', 404)
    try {
      if (clear) { await this.rpc.call('thread/goal/clear', { threadId: id, origin: 'user' }); return { goal: null } }
      const value = record(await this.rpc.call(patch ? 'thread/goal/set' : 'thread/goal/get', { threadId: id, ...(patch ? { ...patch, origin: 'user' } : {}) }))
      return { goal: value.goal ? value.goal as ThreadGoal : null }
    } catch (error) {
      if (/method not found|unknown method|unsupported|not supported/i.test(error instanceof Error ? error.message : '')) throw new BridgeError('GOAL_UNAVAILABLE', '当前 Codex CLI 尚未提供目标功能，请升级 CLI 后重试', 409)
      throw error
    }
  }
  async accountStatus() {
    const [accountResult, limitsResult] = await Promise.allSettled([
      this.rpc.call('account/read', { refreshToken: false }), this.rpc.call('account/rateLimits/read', {}),
    ])
    const account = accountResult.status === 'fulfilled' ? record(record(accountResult.value).account) : {}
    const raw = limitsResult.status === 'fulfilled' ? record(limitsResult.value) : {}
    const byId = Object.values(record(raw.rateLimitsByLimitId)).map(record)
    const rows = byId.length ? byId : raw.rateLimits ? [record(raw.rateLimits)] : []
    return { accountType: string(account.type), planType: string(account.planType), limits: rows.map(row => ({
      limitName: string(row.limitName) || string(row.limitId) || 'Codex', primary: row.primary || null, secondary: row.secondary || null, credits: row.credits || null,
    })), ...(limitsResult.status === 'rejected' ? { error: '当前登录方式或引擎未提供额度信息' } : {}) }
  }
  async addWorkspace(path: string, name?: string) {
    const entry = await this.catalog.add(path, name)
    this.publish({ type: 'workspaces', workspaces: this.catalog.list() }); return entry
  }
  async renameWorkspace(id: string, name: string) {
    await this.catalog.rename(id, name)
    this.publish({ type: 'workspaces', workspaces: this.catalog.list() })
  }
  async setPlugin(enabled: boolean) {
    await this.plugin.setEnabled(enabled)
    this.publish({ type: 'plugins', plugins: { todoNote: enabled } })
  }
  approvals(): Approval[] { return [...this.pending.values()].map(value => value.approval) }
  queue(): QueuedMessage[] { return this.queued.map(({ input, ...value }) => value) }
  async updatePreferences(patch: Partial<Preferences>) {
    if (patch.autoRecovery === false) for (const id of this.autoRecoveries.keys()) this.cancelRecovery(id)
    if (patch.genui !== undefined) await this.preferences.setSkill(genuiSkillPath, patch.genui)
    const snapshot = await this.preferences.update(patch)
    this.publish({ type: 'preferences', ...snapshot }); return snapshot
  }
  async skills(workspaceId?: string, refresh = false): Promise<{ skills: SkillInfo[]; errors: string[] }> {
    const cwd = workspaceId ? await this.catalog.get(workspaceId).directory() : this.codexHome
    await this.rpc.start()
    const result = record(await this.rpc.call('skills/list', { cwds: [cwd], forceReload: refresh }))
    const usage = await this.preferences.skillUsage()
    const disabled = await this.preferences.disabledSkills()
    const entries = array(result.data).map(record).filter(entry => entry.cwd === cwd)
    const nativeSkills = entries.flatMap(entry => array(entry.skills).map(raw => {
      const skill = record(raw); const path = string(skill.path)
      return { name: string(skill.name), description: string(record(skill.interface).shortDescription) || string(skill.shortDescription) || string(skill.description),
        path, scope: string(skill.scope), enabled: skill.enabled !== false && !disabled.includes(path), uses: usage[path]?.uses || 0, lastUsed: usage[path]?.lastUsed || 0 }
    }))
    const preferences = (await this.preferences.snapshot()).preferences
    return { skills: [...nativeSkills, { name: 'genui', description: '在回答中生成可交互的图表、表单、函数图与会话面板 · dsh-genui 适配', path: genuiSkillPath, scope: 'cweb', enabled: preferences.genui && !disabled.includes(genuiSkillPath), uses: usage[genuiSkillPath]?.uses || 0, lastUsed: usage[genuiSkillPath]?.lastUsed || 0 }], errors: entries.flatMap(entry => array(entry.errors).map(error => string(record(error).message))) }
  }
  async setSkill(workspaceId: string | undefined, path: string, enabled: boolean) {
    const list = await this.skills(workspaceId)
    if (!list.skills.some(skill => skill.path === path)) throw new BridgeError('SKILL_MISSING', 'Skill 不在当前工作区的可用列表中', 404)
    await this.preferences.setSkill(path, enabled)
    if (path === genuiSkillPath) await this.updatePreferences({ genui: enabled })
    for (const [id, thread] of this.threads) if (!thread.turnId && !this.submitting.has(id)) await this.release(id)
    return this.skills(workspaceId, true)
  }
  private async skillConfig(cwd: string) {
    const disabled = await this.preferences.disabledSkills()
    if (!disabled.length) return {}
    // Retain native disables when applying cweb's per-thread override.
    const list = await this.skills(this.catalog.find(cwd)?.id)
    return { 'skills.config': list.skills.filter(skill => !skill.enabled).map(skill => ({ path: skill.path, enabled: false })) }
  }
  private async owner(id: string) {
    if (!this.sharedHistory || this.ownedTurns.has(id) || this.fresh.has(id)) return undefined
    if (this.rpc.sharedEngine) {
      const result = record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false }))
      return record(record(result.thread).status).type === 'active' ? this.rpc.enginePid || 1 : undefined
    }
    return (await sessionOwners(this.codexHome, this.rpc.pid)).get(id)
  }
  private async assertAvailable(id: string) {
    const pid = await this.owner(id)
    if (pid) throw new BridgeError('SESSION_IN_USE', '这个会话的任务仍在另一端执行。任务结束后可直接在网页继续，无需关闭整个终端。', 409)
  }
  private async hasTodoMcp(id: string) {
    try {
      const status = record(await this.rpc.call('mcpServerStatus/list', { threadId: id, serverName: this.todoMcpName, detail: 'toolsAndAuthOnly' }))
      const server = array(status.data).map(record).find(value => value.name === this.todoMcpName && record(value.serverInfo).name === 'cweb-todo-note')
      const tools = record(server?.tools)
      return Boolean(tools.todo_note_read && tools.todo_note_update && tools.todo_note_complete)
    } catch { return false }
  }
  async handoff(id: string) { await this.assertAvailable(id); return this.open(id, true) }
  async connectTodo(id: string, allowQueue = false) {
    if (!this.plugin.enabled) throw new BridgeError('PLUGIN_DISABLED', '待办便签已停用', 409)
    await this.assertAvailable(id)
    if (await this.plugin.supportsTools(id)) return this.open(id, true)
    if (this.loaded.has(id)) await this.release(id, allowQueue)
    const result = record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false }))
    if (record(record(result.thread).status).type !== 'notLoaded') {
      if (await this.hasTodoMcp(id)) return this.open(id, true)
      const thread = this.threads.get(id) || await this.open(id)
      if (thread.todoTools !== 'waiting') this.changed({ ...thread, todoTools: 'waiting' })
      return this.threads.get(id)!
    }
    return this.open(id, true)
  }
  async release(id: string, allowQueue = false) {
    if (!this.loaded.has(id)) return
    if (this.threads.get(id)?.turnId || this.submitting.has(id) || (!allowQueue && this.queued.some(row => row.threadId === id))) throw new BridgeError('BUSY', '当前会话仍在执行或排队，请先停止任务', 409)
    await this.rpc.call('thread/unsubscribe', { threadId: id })
    this.loaded.delete(id); this.fresh.delete(id); this.todoMcpThreads.delete(id)
  }
  async archives(): Promise<ThreadSummary[]> {
    await this.rpc.start(); const threads: ThreadSummary[] = []; let cursor: string | undefined
    do {
      const result = record(await this.rpc.call('thread/list', { archived: true, limit: 100, sortKey: 'updated_at', modelProviders: [], sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], ...(cursor ? { cursor } : {}) }))
      threads.push(...array(result.data).map(projectThread).map(({ id, title, cwd, updatedAt }) => ({ id, title, cwd, updatedAt })))
      cursor = string(result.nextCursor) || undefined
    } while (cursor)
    return threads
  }
  async restore(id: string) {
    await this.assertAvailable(id)
    if (!(await this.archives()).some(thread => thread.id === id)) throw new BridgeError('THREAD_MISSING', '归档会话不存在', 404)
    await this.rpc.call('thread/unarchive', { threadId: id }); await this.refreshList(true)
  }
  async compact(id: string) {
    const thread = await this.open(id, true)
    if (thread.turnId) throw new BridgeError('BUSY', '请等当前任务结束后再压缩上下文', 409)
    await this.rpc.call('thread/compact/start', { threadId: id })
  }
  async enqueue(id: string, input: MessageInput) {
    await this.assertAvailable(id)
    await this.open(id)
    if (this.queued.length >= 30) throw new BridgeError('QUEUE_FULL', '最多排队 30 条消息，请等待或移除部分消息')
    this.queued.push({ id: randomUUID(), threadId: id, text: input.text, attachmentCount: input.attachments?.length || 0, input: { ...input, steer: false } })
    this.publish({ type: 'queue', queue: this.queue() }); this.drainQueue(id)
  }
  async requestTodoLink(id: string, input: MessageInput) {
    if (!this.plugin.enabled) throw new BridgeError('PLUGIN_DISABLED', '待办便签已停用', 409)
    if (this.todoLinksActive.has(id)) return
    const existing = this.queued.find(row => row.threadId === id && row.kind === 'todo-link')
    if (existing) { if (existing.error) { delete existing.error; this.publish({ type: 'queue', queue: this.queue() }); this.drainQueue(id) } return }
    await this.open(id)
    if (this.todoLinksActive.has(id) || this.queued.some(row => row.threadId === id && row.kind === 'todo-link')) return
    if (this.queued.length >= 30) throw new BridgeError('QUEUE_FULL', '最多排队 30 条消息，请等待或移除部分消息', 409)
    this.queued.push({ id: randomUUID(), threadId: id, text: input.text, attachmentCount: 0, kind: 'todo-link', input: { ...input, steer: false } })
    this.publish({ type: 'queue', queue: this.queue() }); this.drainQueue(id)
  }
  changeQueue(id: string, retry = false) {
    const row = this.queued.find(row => row.id === id)
    if (!row) throw new BridgeError('QUEUE_MISSING', '排队消息已发送或移除', 404)
    if (retry) { delete row.error; this.drainQueue(row.threadId) } else this.queued = this.queued.filter(row => row.id !== id)
    this.publish({ type: 'queue', queue: this.queue() })
  }
  private retryTodoLink(id: string) {
    if (this.todoRetryTimers.has(id)) return
    const timer = setTimeout(() => { this.todoRetryTimers.delete(id); this.drainQueue(id) }, 5000)
    timer.unref(); this.todoRetryTimers.set(id, timer)
  }
  private drainQueue(id: string) {
    setImmediate(() => {
      const row = this.queued.find(row => row.threadId === id)
      if (!row || row.error || this.draining.has(id) || this.submitting.has(id) || this.threads.get(id)?.turnId) return
      if (this.rpc.status.state !== 'ready') { if (row.kind === 'todo-link') this.retryTodoLink(id); return }
      this.draining.add(id)
      let waiting = false; let sent = false
      void (async () => {
        if (row.kind === 'todo-link') {
          if (!this.plugin.enabled) throw new BridgeError('PLUGIN_DISABLED', '待办便签已停用', 409)
          if (await this.plugin.linked(id)) { this.queued = this.queued.filter(value => value !== row); this.publish({ type: 'queue', queue: this.queue() }); return }
          try {
            const access = await this.connectTodo(id, true)
            if (access.todoTools === 'waiting') { waiting = true; this.retryTodoLink(id); return }
          } catch (error) {
            if (error instanceof BridgeError && ['SESSION_IN_USE', 'BUSY', 'CLI_OFFLINE'].includes(error.code)) { waiting = true; this.retryTodoLink(id); return }
            throw error
          }
          if (!this.queued.includes(row)) return
          this.todoLinksActive.add(id)
        }
        this.queued = this.queued.filter(value => value !== row); sent = true
        this.publish({ type: 'queue', queue: this.queue() })
        this.cancelRecovery(id)
        await this.submitMessage(id, row.input, undefined, undefined, false)
      })().catch(error => {
        this.todoLinksActive.delete(id)
        if (sent || this.queued.includes(row)) {
          this.queued = this.queued.filter(value => value !== row)
          this.queued.unshift({ ...row, error: error instanceof Error ? error.message : String(error) })
          this.publish({ type: 'queue', queue: this.queue() })
        }
      }).finally(() => { this.draining.delete(id); if (!waiting) this.drainQueue(id) })
    })
  }
  list(): ThreadSummary[] { return [...this.summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt) }
  snapshot(id: string) { return this.sent.get(id) }

  /** Check only the native current turn. Silence, idle and notLoaded are never
   * evidence that a turn finished, and no recovery path starts/stops work. */
  async reconcile(id: string, force = false): Promise<ThreadView | undefined> {
    const pending = this.reconciling.get(id)
    if (pending) return pending
    const before = this.threads.get(id)
    if (this.disposed || this.rpc.status.state !== 'ready' || !before?.turnId || before.status !== 'inProgress') return before
    if (!force && this.reconciledAt.has(id) && Date.now() - this.reconciledAt.get(id)! < 15_000) return before
    this.reconciledAt.set(id, Date.now())
    const epoch = this.reconciliationEpoch; const revision = before.revision; const turnId = before.turnId
    const current = () => !this.disposed && this.reconciliationEpoch === epoch && this.threads.get(id)?.turnId === turnId && this.threads.get(id)?.revision === revision
    const operation = (async () => {
      try {
        const raw = record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread)
        if (!current()) return this.threads.get(id)
        let turn: Record<string, unknown> | undefined
        if (raw.historyMode === 'legacy') {
          // Legacy CLI history has no per-turn pagination. Only use its full
          // snapshot when native execution is no longer active.
          if (record(raw.status).type === 'active') return this.threads.get(id)
          const legacy = record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: true })).thread)
          turn = array(legacy.turns).map(record).find(value => value.id === turnId)
        } else {
          let cursor: string | undefined
          for (let page = 0; page < 2 && current(); page++) {
            const params = { threadId: id, limit: 4, sortDirection: 'desc', ...(cursor ? { cursor } : {}) }
            const result = record(await this.rpc.call('thread/turns/list', { ...params, itemsView: 'summary' }))
            const turns = array(result.data).map(record)
            // Another native turn may have started without its notification.
            // Never retire the old projection and accidentally drain its queue
            // over a different running native turn.
            if (turns.some(value => value.id !== turnId && value.status === 'inProgress')) return this.threads.get(id)
            turn = turns.find(value => value.id === turnId)
            if (turn) {
              if (['completed', 'failed', 'interrupted'].includes(string(turn.status))) {
                const full = record(await this.rpc.call('thread/turns/list', { ...params, itemsView: 'full' }))
                const fullTurns = array(full.data).map(record)
                if (fullTurns.some(value => value.id !== turnId && value.status === 'inProgress')) return this.threads.get(id)
                turn = fullTurns.find(value => value.id === turnId)
              }
              break
            }
            const next = string(result.nextCursor)
            if (!next || next === cursor) break
            cursor = next
          }
        }
        if (!current() || !turn || !['completed', 'failed', 'interrupted'].includes(string(turn.status))) return this.threads.get(id)
        // Replace only this turn's native items. Keep other turns, local runtime
        // metadata and observed timestamps; a revision change invalidates this
        // entire read rather than overwriting a newer streaming notification.
        const native = projectThread({ ...raw, turns: [turn] })
        const known = new Map(before.items.map(item => [item.id, item]))
        const recovered = native.items.map(item => {
          const old = known.get(item.id)
          if (!item.timestamp && old?.timestamp) { item.timestamp = old.timestamp; item.timeSource = old.timeSource }
          return old && JSON.stringify(old) === JSON.stringify(item) ? old : item
        })
        const first = before.items.findIndex(item => item.turnId === turnId)
        const items = before.items.filter(item => item.turnId !== turnId)
        items.splice(first < 0 ? items.length : first, 0, ...recovered)
        const next = applyNotification({ ...before, items }, 'turn/completed', { turn, threadId: id })
        this.changed(next); this.settleTurn(next, turnId, string(turn.status))
        return next
      } catch { return this.threads.get(id) }
    })().finally(() => { if (this.reconciling.get(id) === operation) this.reconciling.delete(id) })
    this.reconciling.set(id, operation)
    return operation
  }

  async reconcileActive(force = false) {
    await Promise.allSettled([...this.threads.values()].filter(thread => thread.turnId && thread.status === 'inProgress').map(thread => this.reconcile(thread.id, force)))
  }

  private scheduleReconciliation() {
    if (this.disposed || this.reconciliationTimer || this.rpc.status.state !== 'ready' || ![...this.threads.values()].some(thread => thread.turnId && thread.status === 'inProgress')) return
    this.reconciliationTimer = setTimeout(() => {
      this.reconciliationTimer = undefined
      void this.reconcileActive().finally(() => this.scheduleReconciliation())
    }, 15_000)
    this.reconciliationTimer.unref()
  }

  /** One idempotent settlement path for a native event or read-only recovery. */
  private settleTurn(thread: ThreadView, turnId: string, status: string) {
    if (!turnId || this.threads.get(thread.id)?.turnId) return
    const source = this.autoRecoveries.get(thread.id)
    if (source && (thread.choicePending || this.approvals().some(approval => approval.threadId === thread.id))) source.blocked = true
    this.saveRunMetadata(thread, turnId)
    this.ownedTurns.delete(thread.id); this.todoLinksActive.delete(thread.id)
    for (const [key, request] of this.pending) if (request.approval.threadId === thread.id && (!request.approval.turnId || request.approval.turnId === turnId)) this.pending.delete(key)
    this.publish({ type: 'approvals', approvals: this.approvals() })
    if (status === 'failed') {
      let paused = false
      for (const row of this.queued) if (row.threadId === thread.id && !row.error) { row.error = '前一任务失败，点击重试继续'; paused = true }
      if (paused) this.publish({ type: 'queue', queue: this.queue() })
    }
    const last = thread.items.filter(item => item.type === 'agentMessage').at(-1)
    if (last?.text.includes('dsh-ui')) void this.genui.capture(thread.id, last.text).then(panels => { if (panels.length) this.publish({ type: 'genui', threadId: thread.id, panels }) }).catch(() => {})
    if (status === 'completed') this.drainQueue(thread.id)
    void this.considerRecovery(thread.id, turnId, status).catch(() => {
      const source = this.autoRecoveries.get(thread.id)
      if (source) this.recoveryState(thread.id, source, 'manual', '无法安全检查自动恢复条件，请手动检查后继续。')
    })
    if (this.sharedHistory) {
      const timer = setTimeout(() => { if (!this.disposed) void this.release(thread.id).catch(() => {}) }, 500)
      timer.unref()
    }
  }

  private cancelRecovery(id: string) {
    const source = this.autoRecoveries.get(id)
    if (source?.timer) clearTimeout(source.timer)
    this.autoRecoveries.delete(id)
    const thread = this.threads.get(id)
    if (thread?.recovery) this.changed({ ...thread, recovery: null, error: thread.status === 'failed' ? thread.error || source?.failure || null : thread.error })
    if (source) source.input = undefined
  }

  private recoveryState(id: string, source: RecoverySource, state: 'scheduled' | 'retrying' | 'manual' | 'recovered', message: string) {
    if (this.autoRecoveries.get(id) !== source) return
    const thread = this.threads.get(id)
    if (!thread) return
    this.changed({ ...thread, recovery: { state, attempt: source.attempt, maxAttempts: 1, sourceTurnId: source.sourceTurnId,
      ...(source.retryTurnId ? { retryTurnId: source.retryTurnId } : {}), message },
      error: state === 'manual' ? thread.error || source.failure || message : null })
    if (state === 'manual') { source.input = undefined; this.autoRecoveries.delete(id) }
  }

  private async considerRecovery(id: string, turnId: string, status: string) {
    const source = this.autoRecoveries.get(id)
    if (!source || ![source.sourceTurnId, source.retryTurnId].includes(turnId)) return
    if (status !== 'failed') {
      if (status === 'completed' && source.attempt && this.threads.get(id)?.recovery?.state === 'retrying') this.recoveryState(id, source, 'manual', '重试轮次已结束，未收到可见回复，请检查会话后继续。')
      else { if (source.timer) clearTimeout(source.timer); this.autoRecoveries.delete(id); source.input = undefined }
      return
    }
    source.failure = this.threads.get(id)?.error || source.failure || '模型连接失败'
    if (source.attempt >= 1) { this.recoveryState(id, source, 'manual', '已安全重试一次，仍未恢复，请检查错误后手动继续。'); return }
    const preferences = (await this.preferences.snapshot()).preferences
    if (this.autoRecoveries.get(id) !== source) return
    if (!preferences.autoRecovery) { this.cancelRecovery(id); return }
    const thread = this.threads.get(id)!
    const decision = recoveryPolicy(thread, turnId, source.blocked || this.approvals().some(approval => approval.threadId === id))
    if (!decision.allowed || !source.input) { this.recoveryState(id, source, 'manual', decision.message); return }
    this.recoveryState(id, source, 'scheduled', `${decision.message}；将在 2 秒后安全重试一次。`)
    source.timer = setTimeout(() => { source.timer = undefined; void this.retrySafely(id, source) }, 2000)
    source.timer.unref()
  }

  private async retrySafely(id: string, source: RecoverySource) {
    const eligible = () => {
      const valid = !this.disposed && this.rpc.status.state === 'ready' && this.autoRecoveries.get(id) === source && !this.submitting.has(id) &&
        this.threads.get(id)?.status === 'failed' && !this.threads.get(id)?.turnId && this.threads.get(id)?.runs?.at(-1)?.id === source.sourceTurnId
      if (!valid && !this.disposed && this.autoRecoveries.get(id) === source) this.recoveryState(id, source, 'manual', '会话状态已变化，未自动重发，请检查后继续。')
      return valid
    }
    try {
      if (!eligible()) return
      if (!(await this.preferences.snapshot()).preferences.autoRecovery) { this.cancelRecovery(id); return }
      if (!eligible()) return
      const before = this.threads.get(id)!, revision = before.revision
      const native = await this.failedRecoveryTurn(id, source)
      if (!eligible()) return
      if (this.threads.get(id)!.revision !== revision) {
        this.recoveryState(id, source, 'manual', 'CLI 记录或会话状态已变化，未自动重发，请检查后继续。'); return
      }
      const current = this.threads.get(id)!
      const decision = recoveryPolicy({ ...current, items: native.items, choicePending: current.choicePending || native.choicePending, error: native.error || current.error || source.failure }, source.sourceTurnId, source.blocked || this.approvals().some(approval => approval.threadId === id))
      if (!decision.allowed || !source.input) { this.recoveryState(id, source, 'manual', decision.message); return }
      source.attempt = 1
      const input = { ...source.input, clientMessageId: randomUUID(), steer: false }
      this.recoveryState(id, source, 'retrying', '正在安全重试一次；原失败记录已保留。')
      await this.submitMessage(id, input, undefined, source)
    } catch {
      this.recoveryState(id, source, 'manual', '无法确认安全重试已提交，未继续重发，请检查会话后手动继续。')
    }
  }

  private async failedRecoveryTurn(id: string, source: RecoverySource): Promise<ThreadView> {
    const raw = record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread)
    if (record(raw.status).type === 'active') throw new BridgeError('RECOVERY_ACTIVE', 'CLI 仍有活动任务，未重复提交', 409)
    const turns = raw.historyMode === 'legacy'
      ? array(record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: true })).thread).turns).map(record)
      : array(record(await this.rpc.call('thread/turns/list', { threadId: id, limit: 4, sortDirection: 'desc', itemsView: 'full' })).data).map(record).reverse()
    const latest = turns.at(-1)
    if (latest?.id !== source.sourceTurnId || latest.status !== 'failed' || turns.some(turn => turn.status === 'inProgress') || !Array.isArray(latest.items) || latest.itemsView && latest.itemsView !== 'full') throw new BridgeError('RECOVERY_CHANGED', 'CLI 尚未确认原任务失败，未重复提交', 409)
    const projected = projectThread({ ...raw, turns: [latest] })
    if (!projected.items.some(item => item.type === 'userMessage')) throw new BridgeError('RECOVERY_INCOMPLETE', 'CLI 未提供完整失败轮次，未重复提交', 409)
    return projected
  }

  private changed(thread: ThreadView) {
    thread.revision = (this.revisions.get(thread.id) || 0) + 1
    this.revisions.set(thread.id, thread.revision)
    this.threads.set(thread.id, thread)
    this.scheduleReconciliation()
    this.summaries.set(thread.id, { id: thread.id, title: thread.title, cwd: thread.cwd, updatedAt: thread.updatedAt, status: thread.status, attention: thread.choicePending || this.approvals().some(approval => approval.threadId === thread.id) })
    // State is already committed; this timer only batches browser paint notifications.
    if (!this.renderTimers.has(thread.id)) this.renderTimers.set(thread.id, setTimeout(() => {
      this.renderTimers.delete(thread.id)
      const latest = this.threads.get(thread.id)
      if (latest) {
        const old = this.sent.get(thread.id)
        if (!old) this.publish({ type: 'thread', thread: latest })
        else {
          const previous = new Map(old.items.map(item => [item.id, item]))
          const items = latest.items.filter(item => previous.get(item.id) !== item)
          const orderChanged = latest.items.length !== old.items.length || latest.items.some((item, index) => old.items[index]?.id !== item.id)
          const changes: Record<string, unknown> = {}
          for (const key of Object.keys(latest) as (keyof ThreadView)[]) if (!['id', 'revision', 'items'].includes(key) && latest[key] !== old[key]) changes[key] = latest[key] ?? null
          this.publish({ type: 'threadPatch', id: latest.id, baseRevision: old.revision, revision: latest.revision, items, changes, ...(orderChanged ? { order: latest.items.map(item => item.id) } : {}) })
        }
        this.sent.set(thread.id, latest)
      }
      if (!this.summaryTimer) this.summaryTimer = setTimeout(() => { this.summaryTimer = undefined; this.publish({ type: 'threads', threads: this.list() }) }, 1000)
    }, 100))
  }

  async bootstrap(): Promise<Omit<Bootstrap, 'token'>> {
    await this.initialize()
    await this.rpc.start()
    const [modelsResult, accountResult] = await Promise.allSettled([
      this.rpc.call('model/list', { limit: 100 }), this.rpc.call('account/read', { refreshToken: false }),
    ])
    await this.refreshList()
    const modes = await this.collaborationModes()
    const models = modelsResult.status === 'fulfilled' ? array(record(modelsResult.value).data).map(value => {
      const model = record(value)
      return { id: string(model.model) || string(model.id), label: string(model.displayName) || string(model.model),
        efforts: array(model.supportedReasoningEfforts).map(value => string(record(value).reasoningEffort)) }
    }) : []
    const account = accountResult.status === 'fulfilled' ? record(record(accountResult.value).account) : {}
    return { capabilities: { fileReferences: true, filePreview: true, externalFileOpening: true, planning: modes.some(mode => mode.mode === 'plan'), goals: true, turnMetrics: true, nativeAsyncQuestions: true, messageEditing: true, clientMessageIds: true, turnReconciliation: true, progressStatus: true, safeAutoRecovery: true, onDemandImages: true, contextDedup: true }, ...await this.preferences.snapshot(), queue: this.queue(), root: this.catalog.list()[0]?.path || '', workspaces: this.catalog.list(), plugins: { todoNote: this.plugin.enabled }, codexHome: this.codexHome, sharedHistory: this.sharedHistory, sharedEngine: this.rpc.sharedEngine, runtime: this.rpc.status, models,
      account: string(account.type) || '未检测到登录；自定义供应商可使用环境变量', threads: this.list() }
  }

  async refreshList(force = false): Promise<ThreadSummary[]> {
    if (this.refreshPromise) return this.refreshPromise
    if (!force && Date.now() - this.listReadAt < 5000) return this.list()
    this.refreshPromise = this.readList().finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }
  private async readList(): Promise<ThreadSummary[]> {
    await this.rpc.start()
    let cursor: string | undefined
    const next = new Map<string, ThreadSummary>()
    do {
      const result = record(await this.rpc.call('thread/list', { limit: 100, sortKey: 'updated_at', modelProviders: [], useStateDbOnly: this.listReadAt > 0, sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], ...(cursor ? { cursor } : {}) }))
      for (const raw of array(result.data)) {
        const thread = projectThread(raw)
        const runtime = record(record(raw).status)
        const known = this.summaries.get(thread.id)
        if (thread.id) next.set(thread.id, { id: thread.id, title: thread.title, cwd: thread.cwd, updatedAt: thread.updatedAt,
          status: runtime.type === 'active' ? 'inProgress' : known?.status === 'inProgress' ? 'idle' : known?.status || thread.status,
          attention: array(runtime.activeFlags).some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(string(flag))) })
      }
      cursor = string(result.nextCursor) || undefined
    } while (cursor)
    for (const thread of this.threads.values()) if (this.loaded.has(thread.id)) next.set(thread.id, { id: thread.id, title: thread.title, cwd: thread.cwd, updatedAt: thread.updatedAt, status: thread.status, attention: thread.choicePending || next.get(thread.id)?.attention })
    const previousList = JSON.stringify(this.list()); const previousWorkspaces = JSON.stringify(this.catalog.list())
    this.summaries = next; this.listReadAt = Date.now()
    await this.catalog.recover([...next.values()].map(thread => thread.cwd))
    if (previousWorkspaces !== JSON.stringify(this.catalog.list())) this.publish({ type: 'workspaces', workspaces: this.catalog.list() })
    if (previousList !== JSON.stringify(this.list())) this.publish({ type: 'threads', threads: this.list() })
    return this.list()
  }

  async create(cwd: string, model?: string): Promise<ThreadView> {
    this.creating++
    try { return await this.createThread(cwd, model) }
    finally { this.creating-- }
  }

  private async createThread(cwd: string, model?: string): Promise<ThreadView> {
    await this.initialize()
    const directory = await this.catalog.forPath(cwd).directory(cwd)
    await this.rpc.start()
    const options = await this.preferences.options()
    if (options.mode === 'danger-full-access') options.approvalPolicy = 'never'
    if (model !== undefined) options.model = model
    const preferences = (await this.preferences.snapshot()).preferences
    const response = record(await this.rpc.call('thread/start', {
      cwd: directory, sandbox: options.mode, approvalPolicy: options.approvalPolicy, approvalsReviewer: 'user',
      ...(options.model ? { model: options.model } : {}),
      dynamicTools: [...(this.plugin.enabled ? todoTools : []), ...(preferences.genui ? [genuiTool, genuiValidateTool] : [])],
      config: { 'sandbox_workspace_write.exclude_tmpdir_env_var': true, 'sandbox_workspace_write.exclude_slash_tmp': true, ...await this.skillConfig(directory) },
    }))
    const thread = projectThread(response.thread)
    if (!thread.id) throw new BridgeError('CLI_PROTOCOL', 'Codex 未返回会话编号', 502)
    thread.model = string(response.model) || thread.model
    await this.preferences.setOptions(thread.id, { ...options, model: thread.model || options.model })
    this.publish({ type: 'preferences', ...await this.preferences.snapshot() })
    if (this.plugin.enabled) await this.plugin.register(thread.id)
    this.loaded.add(thread.id); this.fresh.add(thread.id); this.changed(thread)
    return thread
  }

  async open(id: string, activate = false): Promise<ThreadView> {
    await this.rpc.start()
    const externalOwner = await this.owner(id)
    if (activate && externalOwner) await this.assertAvailable(id)
    const known = this.threads.get(id)
    if (known && this.loaded.has(id) && !externalOwner && (!this.rpc.sharedEngine || this.ownedTurns.has(id) || this.fresh.has(id))) return await this.reconcile(id) || known
    if (!activate) {
      const pending = this.reading.get(id)
      if (pending) return pending
      if (known && !known.error && (known.externalOwner || undefined) === externalOwner && Date.now() - (this.readAt.get(id) || 0) < 1500) return known
      const operation = this.readHistory(id, externalOwner).finally(() => this.reading.delete(id))
      this.reading.set(id, operation); return operation
    }
    const opening = this.opening.get(id)
    if (opening) return opening
    const operation = this.resume(id).finally(() => this.opening.delete(id))
    this.opening.set(id, operation)
    return operation
  }

  private async readHistory(id: string, externalOwner?: number): Promise<ThreadView> {
    if (!this.summaries.has(id)) await this.refreshList(true)
    if (!this.summaries.has(id)) throw new BridgeError('THREAD_MISSING', '会话不存在或已归档', 404)
    const result = record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false }))
    const thread = await this.projectHistory(result.thread)
    thread.todoTools = this.threads.get(id)?.todoTools
    thread.recovery = this.threads.get(id)?.recovery
    thread.contextUsage ||= this.threads.get(id)?.contextUsage
    if (['scheduled', 'retrying'].includes(thread.recovery?.state || '')) thread.error = null
    const known = new Map(this.threads.get(id)?.items.map(item => [item.id, item]))
    thread.items = thread.items.map(item => { const old = known.get(item.id); return old && JSON.stringify(old) === JSON.stringify(item) ? old : item })
    thread.externalOwner = externalOwner
    try { await this.catalog.forPath(thread.cwd).directory(thread.cwd) }
    catch { thread.error = '工作区目录暂时不可用，历史记录仍可查看。恢复原目录后可继续执行。' }
    thread.turnId = null
    if (thread.status === 'inProgress') thread.status = 'idle'
    this.readAt.set(id, Date.now()); this.changed(thread); return thread
  }

  private async resume(id: string): Promise<ThreadView> {
    if (!this.summaries.has(id)) await this.refreshList(true)
    const summary = this.summaries.get(id)
    if (!summary) throw new BridgeError('THREAD_MISSING', '会话不存在或不属于当前工作区', 404)
    let cwd: string
    try { cwd = await this.catalog.forPath(summary.cwd).directory(summary.cwd) }
    catch (error) {
      if (!(error instanceof BridgeError) || !['PATH_MISSING', 'NOT_DIRECTORY'].includes(error.code)) throw error
      const result = record(await this.rpc.call('thread/read', { threadId: id, includeTurns: true }))
      const history = await this.projectHistory(result.thread)
      history.error = '工作区目录暂时不可用，历史记录仍可查看。恢复原目录后可继续执行。'
      this.changed(history); return history
    }
    const nativeTodo = await this.plugin.supportsTools(id)
    const useMcp = this.plugin.enabled && !nativeTodo && Boolean(this.httpOrigin)
    const before = useMcp ? record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread).status : null
    const initialStatus = string(record(before).type)
    const config: Record<string, unknown> = await this.skillConfig(cwd)
    if (useMcp) config[`mcp_servers.${this.todoMcpName}`] = {
      command: process.execPath,
      args: [fileURLToPath(new URL('../plugins/todo-note/mcp.mjs', import.meta.url))],
      env: { CWEB_TODO_SESSION_ID: id, CWEB_TODO_ORIGIN: this.httpOrigin, CWEB_TODO_DATA_DIRECTORY: this.dataDirectory },
      startup_timeout_sec: 5,
      // Match the existing cweb dynamic tools; this applies only to the
      // session-scoped local note server, not the user's other MCP servers.
      default_tools_approval_mode: 'approve',
    }
    const result = record(await this.rpc.call('thread/resume', {
      threadId: id, cwd, excludeTurns: true, sandbox: (await this.preferences.options(id)).mode, approvalPolicy: (await this.preferences.options(id)).approvalPolicy, approvalsReviewer: 'user',
      config,
    }))
    const thread = await this.projectHistory(result.thread)
    thread.recovery = this.threads.get(id)?.recovery
    thread.contextUsage ||= this.threads.get(id)?.contextUsage
    if (['scheduled', 'retrying'].includes(thread.recovery?.state || '')) thread.error = null
    thread.model = string(result.model) || thread.model
    this.todoMcpThreads.delete(id)
    if (this.plugin.enabled && nativeTodo) thread.todoTools = 'native'
    else if (useMcp) {
      // A loaded thread keeps its existing config. Check the live connection
      // rather than claiming that a resume override was applied.
      const tries = initialStatus === 'notLoaded' ? 8 : 1
      for (let i = 0; i < tries; i++) {
        if (await this.hasTodoMcp(id)) { this.todoMcpThreads.add(id); break }
        if (i + 1 < tries) await new Promise(resolve => setTimeout(resolve, 200))
      }
      thread.todoTools = this.todoMcpThreads.has(id) ? 'mcp' : 'waiting'
    } else if (this.plugin.enabled) thread.todoTools = 'waiting'
    if (this.rpc.sharedEngine && record(record(result.thread).status).type !== 'active') {
      thread.turnId = null
      if (thread.status === 'inProgress') thread.status = 'idle'
    }
    this.loaded.add(id); this.changed(thread)
    return thread
  }

  async message(id: string, input: MessageInput, edit?: { itemId: string; turnId: string }): Promise<void> {
    this.cancelRecovery(id)
    return this.submitMessage(id, input, edit)
  }

  private async submitMessage(id: string, input: MessageInput, edit?: { itemId: string; turnId: string }, recovery?: RecoverySource, eligibleForRecovery = true): Promise<void> {
    if (this.submitting.has(id) && !this.ownedTurns.has(id) && ['completed', 'interrupted', 'failed'].includes(this.threads.get(id)?.status || '')) {
      await this.submissionDone.get(id)
    }
    if (this.submitting.has(id)) throw new BridgeError('BUSY', '消息正在提交，请稍候', 409)
    this.submitting.add(id)
    let finish!: () => void
    const promise = new Promise<void>(resolve => { finish = resolve })
    this.submissionDone.set(id, promise)
    let reverted = false
    try {
      let thread = await this.open(id, true)
      await this.catalog.forPath(thread.cwd).directory(thread.cwd)
      const options = { ...await this.preferences.options(id), mode: input.mode,
        ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.collaborationMode ? { collaborationMode: input.collaborationMode } : {}),
        ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}) }
      if (options.mode === 'danger-full-access') options.approvalPolicy = 'never'
      const skillPaths = [...new Set(input.skills || [])]
      const available = skillPaths.length ? (await this.skills(this.catalog.find(thread.cwd)?.id)).skills : []
      const selectedSkills = skillPaths.map(path => {
        const skill = available.find(skill => skill.path === path && skill.enabled)
        if (!skill) throw new BridgeError('SKILL_MISSING', '选择的 Skill 已停用或不可用，请重新选择')
        return { type: 'skill', name: skill.name, path: skill.path }
      })
      const preferences = (await this.preferences.snapshot()).preferences
      const nativeInput = [{ type: 'text', text: input.text }, ...await this.attachments.input(input.attachments || [], { imageMode: preferences.imageInputMode }), ...selectedSkills]
      if (input.steer && !edit) {
        if (!thread.turnId) throw new BridgeError('NOT_RUNNING', '当前任务已经结束，可以发送新消息', 409)
        await this.rpc.call('turn/steer', { threadId: id, expectedTurnId: thread.turnId, input: nativeInput, ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}) })
        await this.preferences.recordSkills(skillPaths)
        return
      }
      if (thread.turnId && !edit) throw new BridgeError('BUSY', '任务正在执行，请使用补充指令或先停止', 409)
      let collaborationMode: Record<string, unknown> | undefined
      if (options.collaborationMode) {
        const preset = (await this.collaborationModes()).find(mode => mode.mode === options.collaborationMode)
        if (!preset) throw new BridgeError('PLAN_UNAVAILABLE', '当前 Codex CLI 未提供这个模式，请切回执行模式后重试', 409)
        const model = options.model || thread.model || string(preset.model)
        if (!model) throw new BridgeError('MODEL_MISSING', '请先选择一个可用模型，再使用规划模式')
        collaborationMode = { mode: options.collaborationMode, settings: { model, reasoning_effort: options.effort || preset.reasoning_effort || null, developer_instructions: null } }
      }
      if (edit) {
        // Validate everything before stopping work or touching native history.
        const native = await this.hydrateHistory(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread)
        if (native.historyMode === 'legacy') throw new BridgeError('EDIT_UNAVAILABLE', '这个会话使用旧版记录格式，当前 CLI 不支持原地回退；可以复制消息，新格式会话支持直接编辑。', 409)
        const turn = array(native.turns).map(record).find(turn => turn.id === edit.turnId)
        const firstUser = array(turn?.items).map(record).find(item => item.type === 'userMessage')
        if (!turn || firstUser?.id !== edit.itemId) throw new BridgeError('EDIT_STALE', '待编辑的消息已变化，请刷新会话后再试。', 409)
        if (thread.turnId) {
          await this.rpc.call('turn/interrupt', { threadId: id, turnId: thread.turnId })
          const deadline = Date.now() + 10_000
          while (this.threads.get(id)?.turnId && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
          if (this.threads.get(id)?.turnId) throw new BridgeError('EDIT_RUNNING', '当前任务尚未停止，记录未回退。请等任务停止后重试。', 409)
        }
        const backup = thread.turnId ? await this.hydrateHistory(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread) : native
        const backupDirectory = resolve(this.dataDirectory, 'edit-backups')
        await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
        await writeFile(resolve(backupDirectory, `${randomUUID()}.json`), JSON.stringify({ threadId: id, beforeTurnId: edit.turnId, createdAt: Date.now(), thread: backup }), { mode: 0o600, flag: 'wx' })
        const response = record(await this.rpc.call('thread/revert', { threadId: id, beforeTurnId: edit.turnId }))
        await Promise.all([this.sessionContexts.invalidate(id), this.sessionContexts.invalidate(`${id}:live`)])
        reverted = true
        thread = await this.projectHistory(response.thread)
        thread.model ||= this.threads.get(id)?.model || ''; thread.todoTools = this.threads.get(id)?.todoTools
        this.changed(thread)
        this.queued = this.queued.filter(row => row.threadId !== id); this.publish({ type: 'queue', queue: this.queue() })
        await this.metrics.save(thread)
      }
      const note = await this.plugin.contextParts(id, this.todoMcpThreads.has(id) ? this.todoMcpName : undefined)
      if (!this.observedContexts.has(id)) {
        await Promise.all([this.sessionContexts.invalidate(id), this.sessionContexts.invalidate(`${id}:live`)])
        this.observedContexts.add(id)
      }
      const context = [note.instructions, preferences.genui ? genuiInstructions : '', choiceInstructions, 'To show a workspace screenshot or image in cweb, include a Markdown image with its absolute or workspace-relative file path. PNG, JPEG, WebP, GIF and AVIF are rendered locally; prefer this to returning only a filename.', 'Keep the user informed with brief, plain-language progress updates describing observable actions and their results. Match the conversation language. Do not expose internal reasoning.'].filter(Boolean).join('\n\n')
      const inject = (text: string) => this.rpc.call('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }] })
      if (context) await this.sessionContexts.ensure(id, context, () => inject(context))
      if (note.snapshot) await this.sessionContexts.ensure(`${id}:live`, note.snapshot, () => inject(note.snapshot))
      const quota = await this.captureQuota(); if (quota) this.quotaPending.set(id, quota)
      if (recovery) {
        const current = () => this.threads.get(id)
        const valid = () => this.autoRecoveries.get(id) === recovery && !this.disposed && !current()?.turnId && current()?.status === 'failed' && current()?.runs?.at(-1)?.id === recovery.sourceTurnId
        const beforeCheck = (await this.preferences.snapshot()).preferences
        if (!valid() || !beforeCheck.autoRecovery) throw new BridgeError('AUTO_RECOVERY_CANCELLED', '自动重试已取消', 409)
        const native = await this.failedRecoveryTurn(id, recovery)
        const beforeCommit = (await this.preferences.snapshot()).preferences
        if (!valid() || !beforeCommit.autoRecovery || !recoveryPolicy({ ...current()!, items: native.items, choicePending: current()?.choicePending || native.choicePending, error: native.error || recovery.failure }, recovery.sourceTurnId, recovery.blocked || this.approvals().some(approval => approval.threadId === id)).allowed) throw new BridgeError('AUTO_RECOVERY_CANCELLED', '自动重试条件已变化', 409)
        recovery.starting = true
      }
      if (!recovery && eligibleForRecovery && preferences.autoRecovery) this.autoRecoveries.set(id, { input: structuredClone({ ...input, ...options, model: options.model || thread.model, steer: false }), sourceTurnId: '', attempt: 0, failure: '', starting: true })
      this.ownedTurns.add(id)
      try { const response = record(await this.rpc.call('turn/start', {
        threadId: id, input: nativeInput, cwd: thread.cwd, ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
        approvalPolicy: options.approvalPolicy, approvalsReviewer: 'user',
        sandboxPolicy: input.mode === 'danger-full-access' ? { type: 'dangerFullAccess' } : input.mode === 'read-only' ? { type: 'readOnly', networkAccess: false }
          : { type: 'workspaceWrite', writableRoots: [thread.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
      })); this.fresh.delete(id)
        const turnId = string(record(response.turn).id)
        const source = this.autoRecoveries.get(id)
        if (source && !source.sourceTurnId) source.sourceTurnId = turnId
        let latest = this.threads.get(id)
        if (recovery && latest?.runs?.some(run => run.id === turnId)) {
          recovery.retryTurnId = turnId
          latest = { ...latest, runs: latest.runs.map(run => run.id === turnId ? { ...run, recoveryOf: recovery.sourceTurnId } : run) }
          this.changed(latest)
        }
        // The native acknowledgement can precede turn/started. Fence repeat sends
        // immediately, without reviving a turn that already completed in the stream.
        if (latest && turnId && this.ownedTurns.has(id) && latest.turnId !== turnId) this.changed({ ...latest, turnId, status: 'inProgress', error: null })
      } catch (error) { this.ownedTurns.delete(id); this.quotaPending.delete(id); if (!this.autoRecoveries.get(id)?.sourceTurnId) this.cancelRecovery(id); throw error }
      await this.preferences.setOptions(id, options); await this.preferences.recordSkills(skillPaths)
      this.publish({ type: 'preferences', ...await this.preferences.snapshot() })
    } catch (error) {
      if (reverted) throw new BridgeError('EDIT_REVERTED', `对话已回退，新消息未确认发送。请检查记录后恢复草稿重试：${error instanceof Error ? error.message : 'CLI 请求失败'}`, 502)
      throw error
    } finally { this.submitting.delete(id); this.submissionDone.delete(id); finish(); this.drainQueue(id) }
  }

  async interrupt(id: string): Promise<void> {
    this.cancelRecovery(id)
    this.queued = this.queued.filter(row => row.threadId !== id)
    this.publish({ type: 'queue', queue: this.queue() })
    const thread = await this.open(id)
    if (thread.turnId) await this.rpc.call('turn/interrupt', { threadId: id, turnId: thread.turnId })
  }

  async rename(id: string, title: string): Promise<void> {
    await this.assertAvailable(id)
    const thread = await this.open(id)
    await this.rpc.call('thread/name/set', { threadId: id, name: title })
    // Native progress can arrive while the name request is awaiting its reply.
    // Apply only the title to the latest view, retaining questions and timing.
    this.changed({ ...(this.threads.get(id) || thread), title })
  }

  async archive(id: string): Promise<void> {
    this.cancelRecovery(id)
    await this.assertAvailable(id)
    const thread = await this.open(id)
    if (thread.turnId) throw new BridgeError('BUSY', '请先停止当前任务再归档', 409)
    await this.rpc.call('thread/archive', { threadId: id })
    this.loaded.delete(id); this.threads.delete(id); this.summaries.delete(id)
    this.sent.delete(id); this.readAt.delete(id)
    this.publish({ type: 'threads', threads: this.list() })
  }

  answer(id: string, decision: 'accept' | 'decline' | 'cancel', answers: Record<string, string[]> = {}): void {
    const pending = this.pending.get(id)
    if (!pending) throw new BridgeError('REQUEST_EXPIRED', '此请求已处理或已失效', 409)
    const method = pending.approval.method
    if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
      const response: Record<string, { answers: string[] }> = {}
      for (const question of pending.approval.questions) {
        if (decision === 'accept' && !answers[question.id]?.some(answer => answer.trim())) {
          throw new BridgeError('ANSWER_REQUIRED', '请回答所有问题')
        }
        response[question.id] = { answers: decision === 'accept' ? answers[question.id] : [] }
      }
      this.rpc.respond(pending.wireId, { answers: response })
    } else if (method === 'item/permissions/requestApproval') {
      this.rpc.respond(pending.wireId, { permissions: decision === 'accept' ? record(pending.params.permissions) : {}, scope: 'turn' })
    } else this.rpc.respond(pending.wireId, { decision })
    this.pending.delete(id)
    this.publish({ type: 'approvals', approvals: this.approvals() })
  }

  private notification(message: Record<string, unknown>) {
    const method = string(message.method); const params = record(message.params)
    if (method === 'serverRequest/resolved') {
      this.pending.delete(JSON.stringify(params.requestId))
      this.publish({ type: 'approvals', approvals: this.approvals() }); return
    }
    const id = string(params.threadId)
    if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') { this.publish({ type: 'goal', threadId: id, goal: method.endsWith('/cleared') ? null : params.goal as ThreadGoal }); return }
    if (method === 'thread/closed') { this.loaded.delete(id); this.todoMcpThreads.delete(id); return }
    if (method === 'thread/reverted') {
      this.cancelRecovery(id)
      void this.sessionContexts.invalidate(id); void this.sessionContexts.invalidate(`${id}:live`)
      this.readAt.delete(id)
      if (!this.submitting.has(id)) void this.readHistory(id).catch(() => {})
      return
    }
    if (method === 'thread/compacted' || ['item/started', 'item/completed'].includes(method) && record(params.item).type === 'contextCompaction') {
      void this.sessionContexts.invalidate(id); void this.sessionContexts.invalidate(`${id}:live`)
    }
    if (method === 'thread/archived') {
      this.loaded.delete(id); this.threads.delete(id); this.summaries.delete(id)
      this.publish({ type: 'threads', threads: this.list() }); return
    }
    const thread = this.threads.get(id)
    if (!thread) return
    if (method === 'turn/completed' || method === 'error' && params.willRetry !== true) {
      const source = this.autoRecoveries.get(id)
      if (source && (thread.choicePending || this.approvals().some(approval => approval.threadId === id))) source.blocked = true
    }
    const eventTurn = method === 'turn/completed' ? string(record(params.turn).id) : method === 'error' ? string(params.turnId) : ''
    if (eventTurn && thread.turnId && thread.turnId !== eventTurn) return
    if (eventTurn && !thread.turnId) {
      const latest = thread.runs?.at(-1)
      if (!latest || latest.id !== eventTurn) return
      if (latest.status !== 'inProgress') {
        if (method !== 'turn/completed' || !['completed', 'failed', 'interrupted'].includes(string(record(params.turn).status))) return
        // A permanent error can settle a turn before its final native metadata
        // arrives. Enrich that same latest run without settling/draining again.
        const turn = record(params.turn)
        const next = applyNotification(thread, method, { ...params, turn: { ...turn,
          startedAt: turn.startedAt ?? (latest.startedAt ? latest.startedAt / 1000 : null),
          completedAt: turn.completedAt ?? (latest.completedAt ? latest.completedAt / 1000 : null),
          durationMs: turn.durationMs ?? latest.durationMs,
        } })
        this.changed(next); this.saveRunMetadata(next, eventTurn); return
      }
    }
    let next = applyNotification(thread, method, params)
    const recovery = this.autoRecoveries.get(id)
    if (method === 'turn/started' && recovery) {
      const started = string(record(params.turn).id)
      if (!recovery.starting && started !== (recovery.retryTurnId || recovery.sourceTurnId)) {
        if (recovery.timer) clearTimeout(recovery.timer)
        recovery.input = undefined; this.autoRecoveries.delete(id); next = { ...next, recovery: null }
      } else if (recovery.attempt) {
        recovery.retryTurnId = started
        next = { ...next, recovery: { state: 'retrying', attempt: 1, maxAttempts: 1, sourceTurnId: recovery.sourceTurnId, retryTurnId: started, message: '正在安全重试一次；原失败记录已保留。' },
          runs: next.runs?.map(run => run.id === started ? { ...run, recoveryOf: recovery.sourceTurnId } : run) }
      } else recovery.sourceTurnId = started
      recovery.starting = false
    } else if (recovery?.attempt && recovery.retryTurnId === string(params.turnId) && hasRecoveryOutput(method, params)) {
      recovery.input = undefined
      next = { ...next, recovery: { state: 'recovered', attempt: 1, maxAttempts: 1, sourceTurnId: recovery.sourceTurnId, retryTurnId: recovery.retryTurnId, message: '已恢复模型响应；任务仍按实际状态继续。' } }
    }
    if (next !== thread) this.changed(next)
    if (method === 'thread/tokenUsage/updated' && next.runs?.some(run => run.id === params.turnId && run.status !== 'inProgress')) this.saveRunMetadata(next, string(params.turnId))
    if (method === 'turn/started') {
      const quota = this.quotaPending.get(id); this.quotaPending.delete(id)
      if (quota) this.quotaStarts.set(`${id}:${string(record(params.turn).id)}`, quota)
    }
    if (method === 'turn/completed') this.settleTurn(next, string(record(params.turn).id), string(record(params.turn).status))
    else if (method === 'error' && params.willRetry !== true && thread.turnId && !next.turnId) this.settleTurn(next, thread.turnId, 'failed')
  }

  private request(message: Record<string, unknown>) {
    const wireId = message.id
    if (typeof wireId !== 'number' && typeof wireId !== 'string') return
    const params = record(message.params); const method = string(message.method)
    const threadId = string(params.threadId)
    const recovery = this.autoRecoveries.get(threadId)
    if (recovery) recovery.blocked = true
    if (method === 'item/tool/call' && this.threads.has(threadId)) {
      const run = async () => {
        if (!['render_ui', 'validate_dsh_ui'].includes(string(params.tool))) return this.plugin.call(threadId, string(params.tool), params.arguments)
        if (!(await this.preferences.snapshot()).preferences.genui) throw new BridgeError('PLUGIN_DISABLED', 'GenUI 已停用')
        if (params.tool === 'validate_dsh_ui') return this.genui.validate(params.arguments)
        const result = await this.genui.render(threadId, params.arguments)
        this.publish({ type: 'genui', threadId, panels: result.panels }); return result.message
      }
      void run()
        .then(text => ({ contentItems: [{ type: 'inputText', text }], success: true }),
          error => ({ contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }], success: false }))
        .then(result => {
          try { this.rpc.respond(wireId, result) }
          catch { /* A disconnect can retire the request while its durable write finishes. */ }
        })
      return
    }
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput']
    if (!supported.includes(method) || !this.threads.has(threadId)) {
      if (method === 'mcpServer/elicitation/request') this.rpc.respond(wireId, { action: 'decline', content: null })
      else this.rpc.rejectRequest(wireId, `This local client does not support ${method}`)
      const thread = this.threads.get(threadId)
      if (thread) this.changed({ ...thread, error: `当前网页不支持交互 ${method}，已拒绝该请求` })
      return
    }
    const id = JSON.stringify(wireId)
    const approval: Approval = {
      id, method, threadId, turnId: string(params.turnId), reason: string(params.reason),
      command: string(params.command), cwd: string(params.cwd),
      detail: method === 'item/permissions/requestApproval' ? JSON.stringify(params.permissions, null, 2)
        : string(params.grantRoot) || (params.networkApprovalContext ? JSON.stringify(params.networkApprovalContext, null, 2) : ''),
      questions: array(params.questions).map(value => {
        const q = record(value)
        return { id: string(q.id), header: string(q.header), question: string(q.question), isSecret: q.isSecret === true,
          options: array(q.options).map(value => ({ label: string(record(value).label), description: string(record(value).description) })) }
      }),
    }
    this.pending.set(id, { wireId, approval, params })
    this.publish({ type: 'approvals', approvals: this.approvals() })
  }

  async dispose() {
    for (const id of this.autoRecoveries.keys()) this.cancelRecovery(id)
    this.disposed = true; this.reconciliationEpoch++
    if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer)
    this.reconciliationTimer = undefined; this.reconciling.clear(); this.reconciledAt.clear()
    await Promise.all([...this.metadataWrites])
    await this.metrics.flush()
    await this.rpc.dispose()
    await this.sessionContexts.flush()
    await this.plugin.flush()
    await this.preferences.snapshot()
    for (const timer of this.renderTimers.values()) clearTimeout(timer)
    for (const timer of this.todoRetryTimers.values()) clearTimeout(timer)
    if (this.summaryTimer) clearTimeout(this.summaryTimer)
    this.renderTimers.clear()
    this.removeAllListeners()
  }
}
