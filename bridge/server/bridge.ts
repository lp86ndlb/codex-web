import { EventEmitter } from 'node:events'
import { withModelDefaults } from '../shared/session-options.ts'
import type { Approval, ApprovalPolicy, Bootstrap, Mode, StreamEvent, ThreadSummary, ThreadView, Preferences, SkillInfo, QueuedMessage, ThreadGoal, ModelOption, ServiceTierSelection } from '../shared/types.ts'
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
import { ConnectionDiagnostics } from './diagnostics.ts'
import { SubmissionJournal } from './submissions.ts'
import { parseElicitation, validateElicitation } from '../shared/elicitation.ts'
import { AccountUsage } from './account-usage.ts'
import { TeamService, teamTools, type TeamAdapter } from './team.ts'
import { WorkspaceTeams } from './workspace-teams.ts'
import { z } from 'zod'
import { teamRoute } from '../shared/team-topology.ts'
import { teamOutstanding } from '../shared/team.ts'

interface PendingRequest { wireId: string | number; approval: Approval; params: Record<string, unknown> }
interface RecoverySource { input?: MessageInput; sourceTurnId: string; retryTurnId?: string; attempt: number; failure: string; blocked?: boolean; starting?: boolean; timer?: ReturnType<typeof setTimeout> }
interface CompactOperation { previousTurns: Set<string>; turnId?: string; submitted: boolean }
interface HistoryWindow { cursor?: string; nativeCursor?: string; legacy?: unknown[]; legacyBefore?: number; consumed: Set<string>; expanded?: boolean; boundary?: string }
const HISTORY_PAGE_TURNS = 8
const HISTORY_INITIAL_TURNS = 2
export interface MessageInput { text: string; model?: string; effort?: string; serviceTier?: ServiceTierSelection; mode: Mode; approvalPolicy?: ApprovalPolicy; collaborationMode?: 'default' | 'plan'; steer?: boolean; attachments?: string[]; skills?: string[]; clientMessageId?: string; transientOptions?: boolean }

/** Native Codex owns history; this instance owns only live UI projections and unresolved prompts. */
export class Bridge extends EventEmitter {
  rpc: CodexRpc
  catalog: WorkspaceCatalog
  plugin: TodoNotePlugin
  preferences: PreferencesStore
  attachments: AttachmentStore
  genui: GenuiStore
  metrics: RunHistory
  diagnostics: ConnectionDiagnostics
  submissions: SubmissionJournal
  readonly team?: TeamService
  readonly workspaceTeams?: WorkspaceTeams
  private nativeTeamThreads = new Set<string>()
  private teamMcpThreads = new Set<string>()
  private teamLinks = new Map<string, Promise<boolean>>()
  private teamSetup?: Promise<void>
  private accountUsage: AccountUsage
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
  private listEpoch = 0
  private legacyScanTimer?: ReturnType<typeof setTimeout>
  private legacyScanAttempted = false
  private legacyDiscovered = new Map<string, ThreadSummary>()
  private listMutation = 0
  private listRemovedAt = new Map<string, number>()
  private reading = new Map<string, Promise<ThreadView>>()
  private readAt = new Map<string, number>()
  private historyWindows = new Map<string, HistoryWindow>()
  private historyPaging = new Map<string, Promise<ThreadView>>()
  private historyResets = new Set<string>()
  private historyEpochs = new Map<string, number>()
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
  private compactions = new Map<string, CompactOperation>()

  constructor(rpc: CodexRpc, workspace: Workspace | WorkspaceCatalog, codexHome: string, dataDirectory = dirname(codexHome), sharedHistory = false, features: { teamPilot?: boolean; workspaceTeams?: boolean } = {}) {
    super(); this.rpc = rpc; this.codexHome = codexHome; this.dataDirectory = dataDirectory; this.sharedHistory = sharedHistory
    if (features.teamPilot && sharedHistory) throw new BridgeError('TEAM_ISOLATION', '团队试验只允许独立的原生会话库', 403)
    this.catalog = workspace instanceof Workspace ? new WorkspaceCatalog(resolve(dataDirectory, 'workspaces.json'), workspace) : workspace
    this.plugin = new TodoNotePlugin(resolve(dataDirectory, 'plugins/todo-note'), count => this.publish({ type: 'todoCount', ...count }))
    this.todoMcpName = `cweb_note_${createHash('sha256').update(resolve(dataDirectory)).digest('hex').slice(0, 10)}`
    this.preferences = new PreferencesStore(resolve(dataDirectory, 'preferences.json'))
    this.attachments = new AttachmentStore(resolve(dataDirectory, 'attachments'))
    this.genui = new GenuiStore(resolve(dataDirectory, 'plugins/genui'))
    this.metrics = new RunHistory(resolve(dataDirectory, 'run-history'))
    this.diagnostics = new ConnectionDiagnostics(rpc)
    this.submissions = new SubmissionJournal(resolve(dataDirectory, 'submission-receipts.json'))
    this.accountUsage = new AccountUsage(rpc)
    this.sessionContexts = new SessionContextStore(resolve(dataDirectory, 'session-context.json'))
    if (features.teamPilot) this.team = new TeamService(resolve(dataDirectory, 'team-pilot.json'), this.teamAdapter())
    else if (features.workspaceTeams) this.workspaceTeams = new WorkspaceTeams(resolve(dataDirectory, 'teams'), this.catalog, id => this.teamAdapter(id))
    rpc.on('notification', message => this.notification(record(message)))
    rpc.on('request', message => this.request(record(message)))
    rpc.on('status', runtime => this.publish({ type: 'runtime', runtime }))
    rpc.on('sourcesChanged', () => { if (!this.disposed) void this.refreshList(true).catch(() => {}) })
    rpc.on('sourceDisconnected', ({ ids }: { ids: string[] }) => {
      if (this.disposed) return
      for (const id of ids) {
        this.teamMcpThreads.delete(id)
        this.loaded.delete(id); this.fresh.delete(id); this.ownedTurns.delete(id); this.readAt.delete(id)
        const thread = this.threads.get(id)
        if (thread) this.changed({ ...thread, turnId: null, status: thread.status === 'inProgress' ? 'interrupted' : thread.status,
          error: '该会话所在的 CLI 连接中断，执行结果待核对；其他会话仍可使用。' })
      }
      for (const [key, pending] of this.pending) if (ids.includes(pending.approval.threadId)) this.pending.delete(key)
      this.publish({ type: 'approvals', approvals: this.approvals() })
    })
    rpc.on('disconnected', () => {
      for (const id of this.compactions.keys()) this.finishCompact(id, false)
      for (const id of this.autoRecoveries.keys()) this.cancelRecovery(id)
      if (!this.disposed) for (const id of this.observedContexts) { void this.sessionContexts.invalidate(id); void this.sessionContexts.invalidate(`${id}:live`) }
      this.observedContexts.clear()
      this.reconciliationEpoch++
      if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer)
      this.reconciliationTimer = undefined; this.reconciling.clear(); this.reconciledAt.clear()
      this.modePresets = null
      this.listEpoch++
      if (this.legacyScanTimer) clearTimeout(this.legacyScanTimer)
      this.legacyScanTimer = undefined
      this.loaded.clear(); this.pending.clear(); this.ownedTurns.clear(); this.fresh.clear(); this.sent.clear(); this.reading.clear(); this.readAt.clear(); this.todoMcpThreads.clear(); this.teamMcpThreads.clear(); this.todoLinksActive.clear(); this.listReadAt = 0
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
  private get teamMcpName() { return `cweb_team_${createHash('sha256').update(`${resolve(this.dataDirectory)}:${this.httpOrigin}`).digest('hex').slice(0, 10)}` }
  setHttpPort(port: number) { this.httpOrigin = `http://127.0.0.1:${port}`; this.teamMcpThreads.clear() }
  get workspace() { return this.catalog.get(this.catalog.list()[0]?.id || '') }
  get active() { return this.compactions.size > 0 || this.queued.length > 0 || this.creating > 0 || this.submitting.size > 0 || this.opening.size > 0 || [...this.threads.values()].some(thread => thread.turnId && !thread.externalOwner) }
  private source(id: string) { return this.rpc.forThread?.(id) || this.rpc }
  async initialize() { await this.catalog.initialize(); await this.plugin.initialize(); await this.team?.initialize(); await this.workspaceTeams?.initialize() }
  private teamAdapter(workspaceId?: string): TeamAdapter {
    return {
      changed: revision => this.publish({ type: 'teamChanged', revision, ...(workspaceId ? { workspaceId } : {}) }),
      available: async member => {
        if (this.disposed) return '团队服务正在关闭'
        const thread = await this.open(member.threadId)
        if (resolve(thread.cwd) !== resolve(member.cwd) || workspaceId && this.catalog.find(thread.cwd)?.id !== workspaceId) return '会话工作区发生变化，暂停投递'
        if (thread.externalOwner) return '等待原终端释放会话'
        if (thread.choicePending || this.approvals().some(row => row.threadId === thread.id)) return '接收方正在等待用户答复'
        if (thread.turnId || this.compactions.has(thread.id) || this.submitting.has(thread.id) || this.queued.some(row => row.threadId === thread.id)) return '接收方忙碌，排在当前任务之后'
        if (workspaceId && !await this.connectTeam(thread.id)) return '等待原会话空闲后接入团队工具'
        return null
      },
      send: async (row, text, purpose) => {
        try {
          const options = await this.preferences.options(row.to)
          const deferToUserQueue = () => {
            if (this.queued.some(message => message.threadId === row.to) || this.draining.has(row.to)) throw new BridgeError('BUSY', '用户消息已排队，团队通信将在之后投递', 409)
          }
          await this.message(row.to, { ...options, ...(!workspaceId || purpose === 'review' ? { mode: 'read-only' as const, approvalPolicy: 'on-request' as const } : {}),
            text, steer: false, clientMessageId: row.deliveryId, transientOptions: true }, undefined, deferToUserQueue, purpose !== 'review' && !row.batchId)
        } catch (error) {
          if (error instanceof BridgeError && ['BUSY', 'SESSION_IN_USE'].includes(error.code)) {
            const receipt = await this.submissions.get(row.to, row.deliveryId)
            if (receipt?.state === 'rejected') await this.submissions.forget(row.deliveryId)
          }
          throw error
        }
      },
      receipt: async row => (await this.delivery(row.to, row.deliveryId)).state,
      createMember: async request => {
        const defaults = await this.preferences.options(), model = request.useDefaults ? defaults.model : request.model, effort = request.useDefaults ? defaults.effort : request.effort
        const result = record(await this.rpc.call('model/list', { limit: 100 }))
        const models = array(result.data).map(record), chosen = model ? models.find(m => string(m.model) === model || string(m.id) === model) : models.find(m => m.isDefault === true)
        if (model && !chosen || effort && chosen && !array(chosen.supportedReasoningEfforts).some(e => string(record(e).reasoningEffort) === effort)) throw new BridgeError('TEAM_MODEL', '所选模型或推理强度不可用，请修改申请配置', 400)
        const cwd = workspaceId ? this.catalog.get(workspaceId).root : this.catalog.list()[0]?.path
        if (!cwd) throw new BridgeError('WORKSPACE_MISSING', '请先选择工作区')
        const thread = await this.create(cwd, model, effort)
        await this.rename(thread.id, request.name)
        return { threadId: thread.id, cwd: thread.cwd, model: thread.model || model, effort }
      },
    }
  }
  async teamForWorkspace(workspaceId?: string) {
    if (this.team) {
      if (workspaceId && workspaceId !== this.catalog.list()[0]?.id) throw new BridgeError('TEAM_WORKSPACE', '团队试验只使用专用工作区', 403)
      return this.team
    }
    if (!this.workspaceTeams) throw new BridgeError('TEAM_DISABLED', '此服务尚未启用工作区团队', 404)
    if (!workspaceId) throw new BridgeError('TEAM_WORKSPACE', '请选择团队所属工作区', 400)
    return this.workspaceTeams.get(workspaceId)
  }
  async teamForThread(id: string) {
    if (this.team) return (await this.team.snapshot()).members.some(member => member.threadId === id) ? this.team : undefined
    return this.workspaceTeams?.forThread(id)
  }
  async teamAgentTool(token: string, name: string, args: unknown, workspaceId?: string) {
    if (this.team) return (await this.teamForWorkspace(workspaceId)).agentTool(token, name, args)
    if (this.workspaceTeams) return this.workspaceTeams.agentTool(token, name, args, workspaceId)
    throw new BridgeError('TEAM_TOKEN', '团队工具身份无效', 403)
  }
  async teamCandidates(workspaceId: string) {
    const team = await this.teamForWorkspace(workspaceId), state = await team.snapshot()
    const threads = await this.refreshList(true)
    const preferences = await this.preferences.snapshot()
    return Promise.all(threads.filter(row => this.catalog.find(row.cwd)?.id === workspaceId && !state.members.some(member => member.threadId === row.id)).map(async row => {
      const options = preferences.sessionOptions[row.id]
      const native = options ? {} : record(record(await this.rpc.call('thread/read', { threadId: row.id, includeTurns: false })).thread)
      return { threadId: row.id, title: row.title, model: options?.model || string(native.model) || this.threads.get(row.id)?.model || '',
        effort: options?.effort || string(native.reasoningEffort), busy: row.status === 'inProgress' || Boolean(this.threads.get(row.id)?.turnId) }
    }))
  }
  async importTeamMember(workspaceId: string, raw: unknown) {
    const input = z.object({ threadId: z.string().min(1).max(200), level: z.number().int().min(1).max(10), parentId: z.string().nullable(), groupId: z.string().nullable() }).strict().parse(raw)
    if (input.level > 1 && !input.parentId || input.level === 1 && (input.parentId || input.groupId)) throw new BridgeError('TEAM_GRAPH', '请选择有效的直属上级；最高负责人不属于其他分组', 400)
    const team = await this.teamForWorkspace(workspaceId)
    await this.refreshList(true)
    const summary = this.summaries.get(input.threadId)
    if (!summary || this.catalog.find(summary.cwd)?.id !== workspaceId) throw new BridgeError('TEAM_WORKSPACE', '只能加入当前工作区的已有会话', 403)
    const existing = await this.teamForThread(input.threadId)
    if (existing && existing !== team) throw new BridgeError('TEAM_WORKSPACE', '此会话已经属于其他工作区团队', 403)
    const native = record(record(await this.rpc.call('thread/read', { threadId: input.threadId, includeTurns: false })).thread)
    if (this.catalog.find(string(native.cwd))?.id !== workspaceId) throw new BridgeError('TEAM_WORKSPACE', '会话工作区已变化，请刷新后选择', 403)
    const options = (await this.preferences.snapshot()).sessionOptions[input.threadId]
    await team.register({ ...input, name: summary.title, cwd: string(native.cwd), role: input.level === 1 ? 'lead' : input.level === 2 ? 'manager' : 'worker',
      model: options?.model || string(native.model), effort: options?.effort || string(native.reasoningEffort), useDefaults: false })
    // Import is metadata-only. Tool configuration attaches on the next idle user turn or delivery.
    return team.snapshot()
  }
  async setupTeamPilot() {
    if (!this.team) throw new BridgeError('TEAM_DISABLED', '当前实例未启用隔离团队试验', 404)
    if (!this.teamSetup) this.teamSetup = (async () => {
      await this.initialize()
      const cwd = this.catalog.list()[0]?.path
      if (!cwd) throw new BridgeError('WORKSPACE_MISSING', '请先建立隔离测试工作区')
      for (const [role, name] of [['lead', '试验-负责人'], ['manager', '试验-项目主管'], ['worker', '试验-执行成员']] as const) {
        if ((await this.team!.snapshot()).members.some(row => row.role === role)) continue
        const thread = await this.create(cwd)
        await this.rename(thread.id, name)
        await this.team!.register({ threadId: thread.id, name, role, cwd })
      }
      await this.team!.enable(true)
    })().finally(() => { this.teamSetup = undefined })
    await this.teamSetup
    return this.team.snapshot()
  }
  async startTeamPilot(clientMessageId: string) {
    const state = await this.team?.snapshot()
    if (!state?.enabled || state.members.length < 3) throw new BridgeError('TEAM_PAUSED', '请先建立并开启至少三层的试验团队', 409)
    const lead = state.members.find(row => row.level === 1)!
    const roundTrip = (a: string, b: string) => !teamRoute(state, a, b).error && !teamRoute(state, b, a).error
    const manager = state.members.find(row => row.parentId === lead.threadId && roundTrip(lead.threadId, row.threadId) && state.members.some(child => child.parentId === row.threadId && roundTrip(row.threadId, child.threadId)))
    if (!manager) throw new BridgeError('TEAM_ROUTE', '演示需要负责人、直属主管与执行成员之间开放双向通信', 409)
    const receipt = await this.submissions.get(lead.threadId, clientMessageId)
    if (receipt) {
      if ((await this.delivery(lead.threadId, clientMessageId)).state === 'accepted') return { threadId: lead.threadId }
      throw new BridgeError(receipt.state === 'rejected' ? 'MESSAGE_REJECTED' : 'MESSAGE_RESULT_UNKNOWN', '演示提交已有记录，请进入负责人会话核对，未重复启动。', 409)
    }
    if (state.messages.some(row => teamOutstanding.has(row.state)) || state.memberRequests.some(row => ['pending', 'creating', 'uncertain'].includes(row.state))) throw new BridgeError('TEAM_PENDING', '先处理现有申请，再发起下一轮演示', 409)
    await this.message(lead.threadId, { ...await this.preferences.options(lead.threadId), mode: 'read-only', approvalPolicy: 'on-request', clientMessageId,
      text: `开始一次隔离团队演示。不要使用 shell、文件或网络工具。请用 team_propose_message，to=${manager.threadId}、kind=task、requestKey=${clientMessageId}，标题“计算 7+5”，正文简短写“请委派直属执行成员计算 7+5，再将结果逐级汇报给我。”。不要在任务正文重复工具说明、参数或审批规则。主管收到后派给自己的直属成员并关联消息，成员和主管都用 kind=result 逐级回复；只提出请求就结束本轮，等待系统处理，不轮询。负责人收到最终结果后给用户一句总结即可。` })
    return { threadId: lead.threadId }
  }
  private historyMetadata(window: HistoryWindow) { return { hasOlder: Boolean(window.cursor), ...(window.cursor ? { cursor: window.cursor } : {}) } }
  private historyEpoch(id: string) { return `${this.reconciliationEpoch}:${this.historyEpochs.get(id) || 0}` }
  private checkHistoryEpoch(id: string, epoch: string) {
    if (this.disposed || this.historyEpoch(id) !== epoch) throw new BridgeError('HISTORY_STALE', '历史记录已变化，请重新打开会话。', 409)
  }
  private async projectHistory(value: unknown, replace = false) {
    const raw = record(value), id = string(raw.id), baseline = this.threads.get(id)
    const epoch = this.historyEpoch(id)
    replace = this.historyResets.delete(id) || replace
    let window = !replace ? this.historyWindows.get(id) : undefined
    let turns: unknown[]
    if (raw.historyMode === 'paginated') {
      const page = record(await this.rpc.call('thread/turns/list', { threadId: id, limit: HISTORY_INITIAL_TURNS, sortDirection: 'desc', itemsView: 'full' }))
      this.checkHistoryEpoch(id, epoch)
      turns = array(page.data).slice().reverse()
      if (!replace) window = this.historyWindows.get(id) || window
      const boundary = string(record(turns[0]).id)
      if (!window || !window.expanded && window.boundary !== boundary) {
        const cursor = string(page.nextCursor) || undefined
        window = { ...(cursor ? { cursor: randomUUID(), nativeCursor: cursor } : {}), consumed: new Set(), boundary }
      }
    } else {
      // Older CLIs cannot page persisted turns. Keep the native snapshot in the
      // service, while projecting only the recent suffix to the browser.
      const legacy = array(raw.turns).length ? raw : record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: true })).thread)
      this.checkHistoryEpoch(id, epoch)
      const all = array(legacy.turns), start = Math.max(0, all.length - HISTORY_INITIAL_TURNS)
      turns = all.slice(start)
      if (!replace) window = this.historyWindows.get(id) || window
      const boundary = string(record(turns[0]).id)
      if (!window || !window.expanded && window.boundary !== boundary) window = { ...(start ? { cursor: randomUUID() } : {}), legacy: all, legacyBefore: start, consumed: new Set(), boundary }
      else { const first = window.expanded ? baseline?.runs?.[0]?.id : undefined, before = first ? all.findIndex(turn => record(turn).id === first) : start; window.legacy = all; window.legacyBefore = before < 0 ? start : before }
    }
    this.historyWindows.set(id, window)
    let thread = projectThread({ ...raw, turns })
    thread.history = this.historyMetadata(window)
    try { thread = await this.metrics.enrich(thread) }
    catch { thread.error ||= '本地任务统计暂时无法读取；CLI 对话记录仍可正常查看和继续。' }
    this.checkHistoryEpoch(id, epoch)
    const current = this.threads.get(id)
    const changedDuringRead = baseline && current && current.revision !== baseline.revision && (current.items !== baseline.items || current.turnId !== baseline.turnId)
    const known = !replace && (window.expanded || changedDuringRead) ? current : undefined
    if (known) {
      const incoming = new Set(thread.runs?.map(run => run.id)), oldRuns = known.runs || []
      const lastOverlap = oldRuns.findLastIndex(run => incoming.has(run.id))
      const prefix = window.expanded ? oldRuns.filter((run, index) => !incoming.has(run.id) && (lastOverlap < 0 || index < lastOverlap)) : []
      const suffix = lastOverlap < 0 ? [] : oldRuns.filter((run, index) => !incoming.has(run.id) && index > lastOverlap)
      const runs = [...prefix, ...(thread.runs || []), ...suffix]
      const byTurn = new Map<string, ThreadView['items']>()
      for (const item of known.items) { const key = item.turnId || ''; const rows = byTurn.get(key) || []; rows.push(item); byTurn.set(key, rows) }
      for (const run of thread.runs || []) byTurn.set(run.id, thread.items.filter(item => item.turnId === run.id))
      // A live notification received while the native page was in flight owns
      // the newer item/run state. It must not be overwritten by that old read.
      const liveChanged = baseline && known.revision !== baseline.revision && (known.items !== baseline.items || known.turnId !== baseline.turnId)
      if (liveChanged) {
        const before = new Map(baseline.items.map(item => [item.id, item]))
        for (const item of known.items) if (before.get(item.id) !== item) {
          const key = item.turnId || '', rows = byTurn.get(key) || [], index = rows.findIndex(row => row.id === item.id)
          if (index < 0) rows.push(item); else rows[index] = item
          byTurn.set(key, rows)
        }
        const previous = new Map(baseline.runs?.map(run => [run.id, run]))
        for (let i = 0; i < runs.length; i++) { const live = known.runs?.find(run => run.id === runs[i].id); if (live && previous.get(live.id) !== live) runs[i] = live }
        thread = { ...thread, status: known.status, turnId: known.turnId, progress: known.progress, error: known.error }
      }
      thread.items = runs.flatMap(run => byTurn.get(run.id) || [])
      thread.runs = runs
    }
    return thread
  }

  async olderHistory(id: string, cursor: string): Promise<ThreadView> {
    const epoch = this.historyEpoch(id)
    await this.rpc.start()
    let thread = this.threads.get(id) || await this.open(id)
    const workspace = this.catalog.forPath(thread.cwd)
    try { await workspace.directory(thread.cwd) }
    catch (error) { if (!(error instanceof BridgeError) || !['PATH_MISSING', 'NOT_DIRECTORY'].includes(error.code)) throw error }
    this.checkHistoryEpoch(id, epoch)
    const window = this.historyWindows.get(id)
    if (!window) throw new BridgeError('HISTORY_STALE', '历史分页状态已变化，请重新打开会话。', 409)
    if (window.consumed.has(cursor)) return this.threads.get(id) || thread
    if (cursor !== window.cursor) throw new BridgeError('HISTORY_CURSOR', '历史分页位置已变化，请重新读取当前会话。', 409)
    const key = `${id}:${cursor}`, pending = this.historyPaging.get(key)
    if (pending) return pending
    window.expanded = true
    const operation = (async () => {
      let turns: unknown[], next: string | undefined, before: number | undefined
      if (window.legacy) { before = Math.max(0, (window.legacyBefore || 0) - HISTORY_PAGE_TURNS); turns = window.legacy.slice(before, window.legacyBefore); next = before ? String(before) : undefined }
      else { const page = record(await this.rpc.call('thread/turns/list', { threadId: id, cursor: window.nativeCursor, limit: HISTORY_PAGE_TURNS, sortDirection: 'desc', itemsView: 'full' })); turns = array(page.data).slice().reverse(); next = string(page.nextCursor) || undefined; if (next && next === window.nativeCursor) throw new BridgeError('CLI_PROTOCOL', 'CLI 返回了重复的历史分页游标', 502) }
      if (this.historyWindows.get(id) !== window || this.historyResets.has(id)) throw new BridgeError('HISTORY_STALE', '历史记录已变化，请重新打开会话。', 409)
      this.checkHistoryEpoch(id, epoch)
      const older = await this.metrics.enrich(projectThread({ id, cwd: thread.cwd, turns })).catch(() => projectThread({ id, cwd: thread.cwd, turns }))
      this.checkHistoryEpoch(id, epoch)
      if (this.historyWindows.get(id) !== window || this.historyResets.has(id)) throw new BridgeError('HISTORY_STALE', '历史记录已变化，请重新打开会话。', 409)
      thread = this.threads.get(id) || thread
      const itemIds = new Set(thread.items.map(item => item.id)), runIds = new Set(thread.runs?.map(run => run.id))
      window.consumed.add(cursor); window.cursor = next ? randomUUID() : undefined; window.nativeCursor = next
      if (before !== undefined) window.legacyBefore = before
      const merged = { ...thread, items: [...older.items.filter(item => !itemIds.has(item.id)), ...thread.items], runs: [...(older.runs || []).filter(run => !runIds.has(run.id)), ...(thread.runs || [])], history: this.historyMetadata(window) }
      this.changed(merged); return merged
    })().finally(() => { this.historyPaging.delete(key) })
    this.historyPaging.set(key, operation); return operation
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
    try { return await Promise.race([this.rpc.call('account/rateLimits/read', { excludeResetCreditDetails: true }).then(quotaSnapshot).catch(() => undefined), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1200) })]) }
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
  accountStatus() { return this.accountUsage.read() }
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
    const rpc = this.source(id)
    if (rpc.sharedEngine) {
      const result = record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false }))
      return record(record(result.thread).status).type === 'active' ? rpc.enginePid || 1 : undefined
    }
    return (await sessionOwners(rpc === this.rpc ? this.codexHome : rpc.home || this.codexHome, rpc.pid)).get(id)
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
  private async hasTeamMcp(id: string) {
    try {
      const status = record(await this.rpc.call('mcpServerStatus/list', { threadId: id, serverName: this.teamMcpName, detail: 'toolsAndAuthOnly' }))
      const server = array(status.data).map(record).find(value => value.name === this.teamMcpName && record(value.serverInfo).name === 'cweb-team')
      return teamTools.every(tool => Boolean(record(server?.tools)[tool.name]))
    } catch { return false }
  }
  async connectTeam(id: string, ownSubmission = false): Promise<boolean> {
    if (this.nativeTeamThreads.has(id) || this.teamMcpThreads.has(id)) return true
    if (!this.httpOrigin || !await this.teamForThread(id)) return false
    const pending = this.teamLinks.get(id)
    if (pending) return pending
    const operation = (async () => {
      const unavailable = () => this.disposed || this.threads.get(id)?.turnId || this.compactions.has(id) || !ownSubmission && (this.submitting.has(id) || this.queued.some(row => row.threadId === id)) || this.approvals().some(row => row.threadId === id)
      if (unavailable() || await this.owner(id)) return false
      if (await this.hasTeamMcp(id)) { this.teamMcpThreads.add(id); return true }
      const before = record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread)
      if (unavailable() || record(before.status).type === 'active') return false
      if (this.loaded.has(id) || record(before.status).type !== 'notLoaded') {
        // Unsubscribe only while idle. Another native client may keep it loaded;
        // in that case wait rather than interrupting it or claiming tools exist.
        await this.rpc.call('thread/unsubscribe', { threadId: id })
        this.loaded.delete(id); this.fresh.delete(id); this.teamMcpThreads.delete(id); this.todoMcpThreads.delete(id)
        const after = record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread)
        if (record(after.status).type !== 'notLoaded') return false
      }
      if (unavailable()) return false
      await this.open(id, true)
      return this.teamMcpThreads.has(id)
    })().finally(() => this.teamLinks.delete(id))
    this.teamLinks.set(id, operation)
    return operation
  }
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
    if (this.compactions.has(id) || this.threads.get(id)?.turnId || this.submitting.has(id) || (!allowQueue && this.queued.some(row => row.threadId === id))) throw new BridgeError('BUSY', '当前会话仍在执行或排队，请先停止任务', 409)
    await this.rpc.call('thread/unsubscribe', { threadId: id })
    this.loaded.delete(id); this.fresh.delete(id); this.todoMcpThreads.delete(id); this.teamMcpThreads.delete(id)
  }
  async releaseToTerminal(id: string) {
    const thread = await this.open(id)
    await this.assertAvailable(id)
    await this.release(id)
    const source = this.source(id), home = source === this.rpc ? this.codexHome : source.home || this.codexHome
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    return `CODEX_HOME=${quote(home)} codex resume --cd ${quote(thread.cwd)} ${quote(id)}`
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
    this.legacyDiscovered.delete(id)
    await this.assertAvailable(id)
    if (!(await this.archives()).some(thread => thread.id === id)) throw new BridgeError('THREAD_MISSING', '归档会话不存在', 404)
    await this.rpc.call('thread/unarchive', { threadId: id }); await this.refreshList(true)
  }
  async compact(id: string) {
    this.cancelRecovery(id)
    if (this.compactions.has(id) || this.submitting.has(id) || this.queued.some(row => row.threadId === id)) throw new BridgeError('BUSY', '当前会话正在执行、提交或排队，请稍后压缩上下文', 409)
    const operation: CompactOperation = { previousTurns: new Set(this.threads.get(id)?.runs?.map(run => run.id)), submitted: false }
    this.compactions.set(id, operation)
    try {
      await this.open(id, true)
      const native = record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread)
      const thread = this.threads.get(id)
      if (this.disposed || this.compactions.get(id) !== operation || !thread || thread.turnId || thread.externalOwner || record(native.status).type === 'active' || this.submitting.has(id) || this.queued.some(row => row.threadId === id) || thread.choicePending || this.approvals().some(approval => approval.threadId === id)) throw new BridgeError('BUSY', '当前会话仍在执行或等待输入，请稍后压缩上下文', 409)
      operation.previousTurns = new Set(thread.runs?.map(run => run.id))
      this.changed({ ...thread, compacting: true, error: null })
      operation.submitted = true
      this.scheduleReconciliation()
      await this.rpc.call('thread/compact/start', { threadId: id })
    } catch (error) {
      // A request timeout may already have been accepted by the native engine.
      // Keep the reservation until a real lifecycle event/disconnect resolves it.
      if (this.compactions.get(id) === operation) {
        if (!(operation.submitted && error instanceof BridgeError && error.code === 'CLI_TIMEOUT')) this.finishCompact(id, !operation.submitted, operation.submitted)
        const thread = this.threads.get(id)
        if (thread) this.changed({ ...thread, error: error instanceof Error ? error.message : '上下文压缩请求失败' })
      }
      throw error
    }
  }
  private finishCompact(id: string, drain = true, failed = false) {
    if (!this.compactions.delete(id)) return
    const thread = this.threads.get(id)
    if (thread?.compacting) this.changed({ ...thread, compacting: false })
    if (failed) {
      for (const row of this.queued) if (row.threadId === id && !row.error) row.error = '上下文压缩未完成，请检查后重试'
      this.publish({ type: 'queue', queue: this.queue() })
    }
    if (drain && !this.disposed) this.drainQueue(id)
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
      if (!row || row.error || this.compactions.has(id) || this.draining.has(id) || this.submitting.has(id) || this.threads.get(id)?.turnId) return
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
  private needsHistoryTrim(thread: ThreadView) { return !this.historyWindows.get(thread.id)?.expanded && (thread.runs?.length || 0) > HISTORY_INITIAL_TURNS }
  // Patch recovery repairs an already-open reader's exact projection. Cold
  // opens use open()/readHistory() and have a separate recent-turn limit.
  snapshot(id: string) { return this.sent.get(id) }

  /** Check only the native current turn. Silence, idle and notLoaded are never
   * evidence that a turn finished, and no recovery path starts/stops work. */
  async reconcile(id: string, force = false): Promise<ThreadView | undefined> {
    if (this.compactions.get(id)?.submitted && !this.threads.get(id)?.turnId) return this.reconcileCompact(id, force)
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
    const ids = new Set([...this.threads.values()].filter(thread => thread.turnId && thread.status === 'inProgress').map(thread => thread.id))
    for (const [id, operation] of this.compactions) if (operation.submitted) ids.add(id)
    await Promise.allSettled([...ids].map(id => this.reconcile(id, force)))
  }

  private async reconcileCompact(id: string, force: boolean): Promise<ThreadView | undefined> {
    const pending = this.reconciling.get(id)
    if (pending) return pending
    const compact = this.compactions.get(id), before = this.threads.get(id)
    if (!compact?.submitted || !before || this.disposed || this.rpc.status.state !== 'ready') return before
    if (!force && this.reconciledAt.has(id) && Date.now() - this.reconciledAt.get(id)! < 15_000) return before
    this.reconciledAt.set(id, Date.now())
    const epoch = this.reconciliationEpoch, revision = before.revision
    const current = () => !this.disposed && epoch === this.reconciliationEpoch && this.compactions.get(id) === compact && this.threads.get(id)?.revision === revision
    const operation = (async () => {
      try {
        const raw = record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread)
        if (!current() || record(raw.status).type === 'active') return this.threads.get(id)
        const turns = raw.historyMode === 'legacy'
          ? array(record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: true })).thread).turns).map(record).reverse()
          : array(record(await this.rpc.call('thread/turns/list', { threadId: id, limit: 4, sortDirection: 'desc', itemsView: 'full' })).data).map(record)
        if (!current() || turns.some(turn => turn.status === 'inProgress')) return this.threads.get(id)
        const done = turns.find(turn => ['completed', 'failed', 'interrupted'].includes(string(turn.status)) &&
          (compact.turnId ? turn.id === compact.turnId : !compact.previousTurns.has(string(turn.id)) && array(turn.items).some(item => record(item).type === 'contextCompaction')))
        // idle/notLoaded or an unchanged historical turn is never sufficient.
        if (done) {
          this.finishCompact(id, done.status === 'completed', done.status !== 'completed')
          const latest = this.threads.get(id)
          if (latest) this.changed({ ...latest, error: done.status === 'failed' ? string(record(done.error).message) || '原生上下文压缩失败，请检查后重试' : null })
          void this.sessionContexts.invalidate(id); void this.sessionContexts.invalidate(`${id}:live`)
        }
      } catch { /* Keep unknown native work reserved; a later read can prove completion. */ }
      return this.threads.get(id)
    })().finally(() => { if (this.reconciling.get(id) === operation) this.reconciling.delete(id) })
    this.reconciling.set(id, operation)
    return operation
  }

  private scheduleReconciliation() {
    if (this.disposed || this.reconciliationTimer || this.rpc.status.state !== 'ready' || ![...this.threads.values()].some(thread => thread.turnId && thread.status === 'inProgress') && ![...this.compactions.values()].some(operation => operation.submitted)) return
    this.reconciliationTimer = setTimeout(() => {
      this.reconciliationTimer = undefined
      void this.reconcileActive().finally(() => this.scheduleReconciliation())
    }, 15_000)
    this.reconciliationTimer.unref()
  }

  /** One idempotent settlement path for a native event or read-only recovery. */
  private settleTurn(thread: ThreadView, turnId: string, status: string) {
    if (!turnId || this.threads.get(thread.id)?.turnId) return
    const compact = this.compactions.get(thread.id)
    if (compact?.turnId === turnId) {
      this.finishCompact(thread.id, false)
      void this.sessionContexts.invalidate(thread.id); void this.sessionContexts.invalidate(`${thread.id}:live`)
    }
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
    const models: ModelOption[] = modelsResult.status === 'fulfilled' ? array(record(modelsResult.value).data).map(value => {
      const model = record(value)
      const fastTier = array(model.serviceTiers).map(record).find(tier => tier.id === 'priority' || tier.id === 'fast')?.id
      return { id: string(model.model) || string(model.id), label: string(model.displayName) || string(model.model),
        efforts: array(model.supportedReasoningEfforts).map(value => string(record(value).reasoningEffort)),
        ...(model.isDefault === true ? { isDefault: true } : {}), ...(fastTier === 'priority' || fastTier === 'fast' ? { fastTier } : {}) }
    }) : []
    const account = accountResult.status === 'fulfilled' ? record(record(accountResult.value).account) : {}
    return { capabilities: { settingDefaults: true, teamMode: Boolean(this.workspaceTeams), teamPilot: Boolean(this.team), pagedHistory: true, diagnostics: true, durableMessages: true, mcpElicitation: true, nativeActions: true, fileReferences: true, filePreview: true, imagePreviewExperience: true, externalFileOpening: true, planning: modes.some(mode => mode.mode === 'plan'), goals: true, turnMetrics: true, nativeAsyncQuestions: true, messageEditing: true, clientMessageIds: true, turnReconciliation: true, progressStatus: true, safeAutoRecovery: true, onDemandImages: true, contextDedup: true, contextUsageMenu: true }, ...await this.preferences.snapshot(), queue: this.queue(), root: this.catalog.list()[0]?.path || '', workspaces: this.catalog.list(), plugins: { todoNote: this.plugin.enabled }, codexHome: this.codexHome, sharedHistory: this.sharedHistory, sharedEngine: this.rpc.sharedEngine, runtime: this.rpc.status, models,
      account: string(account.type) || '未检测到登录；自定义供应商可使用环境变量', threads: this.list() }
  }

  async refreshList(force = false): Promise<ThreadSummary[]> {
    if (this.refreshPromise) return this.refreshPromise
    if (!force && Date.now() - this.listReadAt < 5000) return this.list()
    this.refreshPromise = this.readList(true).then(value => { this.scheduleLegacyDiscovery(); return value }).finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }
  private scheduleLegacyDiscovery() {
    if (this.disposed || this.legacyScanAttempted || this.legacyScanTimer) return
    // Let bootstrap and the first recent-turn request paint before asking the
    // native engine for its slower JSONL scan-and-repair compatibility path.
    this.legacyScanTimer = setTimeout(() => {
      this.legacyScanTimer = undefined
      if (this.disposed || this.rpc.status.state !== 'ready') return
      this.legacyScanAttempted = true
      void this.readList(false).catch(() => { if (!this.disposed) this.diagnostics.add({ layer: 'bridge', level: 'warning', title: '旧会话目录协调未完成，现有会话列表仍可使用。' }) })
    }, 2000)
    this.legacyScanTimer.unref()
  }
  private async readList(useStateDbOnly: boolean): Promise<ThreadSummary[]> {
    await this.rpc.start()
    const epoch = this.listEpoch, mutation = this.listMutation
    let cursor: string | undefined
    const next = new Map<string, ThreadSummary>()
    const seen = new Set<string>()
    do {
      const result = record(await this.rpc.call('thread/list', { limit: 100, sortKey: 'updated_at', modelProviders: [], useStateDbOnly, sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], ...(cursor ? { cursor } : {}) }))
      if (this.disposed || epoch !== this.listEpoch) return this.list()
      for (const raw of array(result.data)) {
        const thread = projectThread(raw)
        const runtime = record(record(raw).status)
        const known = this.summaries.get(thread.id)
        if (thread.id) next.set(thread.id, { id: thread.id, title: thread.title, cwd: thread.cwd, updatedAt: thread.updatedAt,
          status: runtime.type === 'active' ? 'inProgress' : known?.status === 'inProgress' ? 'idle' : known?.status || thread.status,
          attention: array(runtime.activeFlags).some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(string(flag))) })
      }
      cursor = string(result.nextCursor) || undefined
      if (cursor && seen.has(cursor)) throw new BridgeError('CLI_PROTOCOL', 'CLI 返回了重复的会话列表游标', 502)
      if (cursor) seen.add(cursor)
    } while (cursor)
    for (const [id, removed] of this.listRemovedAt) if (removed > mutation) next.delete(id)
    if (!useStateDbOnly) {
      // A slow scan must not overwrite a newer rename/run/create or resurrect
      // a conversation archived after the scan began. It only fills gaps.
      for (const [id, summary] of next) if (!this.summaries.has(id)) this.legacyDiscovered.set(id, summary)
      for (const [id, summary] of this.summaries) next.set(id, summary)
    } else {
      for (const [id, summary] of this.legacyDiscovered) if (!next.has(id)) next.set(id, summary)
    }
    for (const thread of this.threads.values()) if (this.loaded.has(thread.id)) next.set(thread.id, { id: thread.id, title: thread.title, cwd: thread.cwd, updatedAt: thread.updatedAt, status: thread.status, attention: thread.choicePending || next.get(thread.id)?.attention })
    const previousList = JSON.stringify(this.list()); const previousWorkspaces = JSON.stringify(this.catalog.list())
    this.summaries = next; this.listReadAt = Date.now()
    await this.catalog.recover([...next.values()].map(thread => thread.cwd))
    if (this.disposed || epoch !== this.listEpoch) return this.list()
    if (previousWorkspaces !== JSON.stringify(this.catalog.list())) this.publish({ type: 'workspaces', workspaces: this.catalog.list() })
    if (previousList !== JSON.stringify(this.list())) this.publish({ type: 'threads', threads: this.list() })
    return this.list()
  }

  async create(cwd: string, model?: string, effort?: string): Promise<ThreadView> {
    this.creating++
    try { return await this.createThread(cwd, model, effort) }
    finally { this.creating-- }
  }

  async fork(id: string, beforeTurnId?: string): Promise<ThreadView> {
    const source = await this.open(id)
    if (source.turnId && !beforeTurnId) throw new BridgeError('BUSY', '当前话题正在执行，请选择历史位置分支，或等本轮结束。', 409)
    if (beforeTurnId && !source.items.some(item => item.turnId === beforeTurnId)) throw new BridgeError('FORK_BOUNDARY', '分支位置已变化，请重新选择。', 409)
    await this.catalog.forPath(source.cwd).directory(source.cwd)
    this.creating++
    try {
      const options = await this.preferences.options(id)
      const response = record(await this.rpc.call('thread/fork', { threadId: id, ...(beforeTurnId ? { beforeTurnId } : {}), deferGoalContinuation: true, excludeTurns: true, cwd: source.cwd, sandbox: options.mode, approvalPolicy: options.approvalPolicy, approvalsReviewer: 'user' }))
      const thread = await this.projectHistory(response.thread)
      if (!thread.id || thread.id === id) throw new BridgeError('CLI_PROTOCOL', 'CLI 未返回新的分支会话。请检查原生会话列表。', 502)
      thread.forkedFromId = id; thread.model = string(response.model) || source.model
      await this.preferences.setOptions(thread.id, options)
      this.changed(thread)
      try { await this.rename(thread.id, (source.title + ' · 分支').slice(0, 120)) } catch { /* The fork is valid even if an optional rename fails. */ }
      this.publish({ type: 'preferences', ...await this.preferences.snapshot() })
      return this.threads.get(thread.id)!
    } finally { this.creating-- }
  }

  async review(id: string, target: { type: 'uncommittedChanges' } | { type: 'baseBranch'; branch: string } | { type: 'commit'; sha: string } | { type: 'custom'; instructions: string }) {
    if (this.submitting.has(id) || this.compactions.has(id)) throw new BridgeError('BUSY', '请等当前操作完成后再审查。', 409)
    this.submitting.add(id); this.cancelRecovery(id)
    let claimed = false
    try {
      const thread = await this.open(id, true)
      if (thread.turnId) throw new BridgeError('BUSY', '请等本轮结束后再启动原生审查。', 409)
      this.ownedTurns.add(id); claimed = true
      const response = record(await this.rpc.call('review/start', { threadId: id, target, delivery: 'inline' }))
      const turn = record(response.turn), latest = this.threads.get(id)
      if (latest && string(turn.id) && this.ownedTurns.has(id) && !latest.runs?.some(run => run.id === turn.id && run.status !== 'inProgress')) this.changed({ ...latest, turnId: string(turn.id), status: 'inProgress', error: null })
      return this.threads.get(id)
    } catch (error) { if (claimed) this.ownedTurns.delete(id); throw error }
    finally { this.submitting.delete(id) }
  }

  private async createThread(cwd: string, model?: string, effort?: string): Promise<ThreadView> {
    await this.initialize()
    const directory = await this.catalog.forPath(cwd).directory(cwd)
    await this.rpc.start()
    const options = await this.preferences.options()
    if (this.team) { options.mode = 'read-only'; options.approvalPolicy = 'on-request' }
    if (options.mode === 'danger-full-access') options.approvalPolicy = 'never'
    if (model !== undefined) options.model = model
    if (effort !== undefined) options.effort = effort
    const preferences = (await this.preferences.snapshot()).preferences
    const workspaceTeam = this.workspaceTeams ? await this.workspaceTeams.get(this.catalog.find(directory)!.id) : undefined
    const requestedOptions = { ...options }
    Object.assign(options, withModelDefaults(options, preferences))
    const includeTeamTools = Boolean(this.team || workspaceTeam && (await workspaceTeam.snapshot()).enabled)
    const response = record(await this.rpc.call('thread/start', {
      cwd: directory, sandbox: options.mode, approvalPolicy: options.approvalPolicy, approvalsReviewer: 'user',
      ...(options.model ? { model: options.model } : {}),
      dynamicTools: [...(this.plugin.enabled ? todoTools : []), ...(preferences.genui ? [genuiTool, genuiValidateTool] : []), ...(includeTeamTools ? teamTools : [])],
      ...(this.team ? { sandbox: 'read-only', approvalPolicy: 'on-request', developerInstructions: '这是隔离团队试验，只处理文本，不运行 shell 或操作实际项目。按 team_members 返回的职责、箭头与层级通信，禁止越级。同层通信需双方直属上级审核。派发使用 team_propose_message；主标题简短、正文只写任务与验收条件，不重复工具协议。收到团队审核时只用 team_review_message 返回判断，不执行待审任务。新增成员用 team_request_member 请求用户批准，不能自行创建。可在一轮内提交多条独立子任务，全部提交后结束本轮，不轮询。' } : {}),
      config: { 'sandbox_workspace_write.exclude_tmpdir_env_var': true, 'sandbox_workspace_write.exclude_slash_tmp': true, ...(options.effort ? { model_reasoning_effort: options.effort } : {}), ...await this.skillConfig(directory) },
    }))
    const thread = projectThread(response.thread)
    if (!thread.id) throw new BridgeError('CLI_PROTOCOL', 'Codex 未返回会话编号', 502)
    if (includeTeamTools) this.nativeTeamThreads.add(thread.id)
    thread.model = string(response.model) || thread.model
    await this.preferences.setOptions(thread.id, requestedOptions)
    this.publish({ type: 'preferences', ...await this.preferences.snapshot() })
    if (this.plugin.enabled) await this.plugin.register(thread.id)
    this.loaded.add(thread.id); this.fresh.add(thread.id); this.changed(thread)
    return thread
  }

  async open(id: string, activate = false): Promise<ThreadView> {
    await this.rpc.start()
    if (!this.summaries.has(id) && !this.fresh.has(id)) await this.refreshList(true)
    const externalOwner = await this.owner(id)
    if (activate && externalOwner) await this.assertAvailable(id)
    const known = this.threads.get(id)
    if (known && this.loaded.has(id) && !externalOwner && (!this.source(id).sharedEngine || this.ownedTurns.has(id) || this.fresh.has(id))) {
      const current = await this.reconcile(id) || known
      if (activate || !this.needsHistoryTrim(current)) return current
    }
    if (!activate) {
      const pending = this.reading.get(id)
      if (pending) return pending
      if (known && !this.needsHistoryTrim(known) && !known.error && (known.externalOwner || undefined) === externalOwner && Date.now() - (this.readAt.get(id) || 0) < 1500) return known
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
    const epoch = this.historyEpoch(id)
    if (!this.summaries.has(id)) await this.refreshList(true)
    if (!this.summaries.has(id)) throw new BridgeError('THREAD_MISSING', '会话不存在或已归档', 404)
    const result = record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false }))
    this.checkHistoryEpoch(id, epoch)
    const thread = await this.projectHistory(result.thread)
    this.checkHistoryEpoch(id, epoch)
    thread.todoTools = this.threads.get(id)?.todoTools
    thread.recovery = this.threads.get(id)?.recovery
    thread.compacting = this.compactions.has(id)
    thread.contextUsage ||= this.threads.get(id)?.contextUsage
    if (['scheduled', 'retrying'].includes(thread.recovery?.state || '')) thread.error = null
    const known = new Map(this.threads.get(id)?.items.map(item => [item.id, item]))
    thread.items = thread.items.map(item => { const old = known.get(item.id); return old && JSON.stringify(old) === JSON.stringify(item) ? old : item })
    thread.externalOwner = externalOwner
    try { await this.catalog.forPath(thread.cwd).directory(thread.cwd) }
    catch { thread.error = '工作区目录暂时不可用，历史记录仍可查看。恢复原目录后可继续执行。' }
    this.checkHistoryEpoch(id, epoch)
    const current = this.threads.get(id)
    if (this.ownedTurns.has(id) && current?.turnId) { thread.turnId = current.turnId; thread.status = current.status; thread.progress = current.progress }
    else if (!externalOwner) { thread.turnId = null; if (thread.status === 'inProgress') thread.status = 'idle' }
    this.readAt.set(id, Date.now()); this.changed(thread); return thread
  }

  private async resume(id: string): Promise<ThreadView> {
    const epoch = this.historyEpoch(id)
    if (!this.summaries.has(id)) await this.refreshList(true)
    const summary = this.summaries.get(id)
    if (!summary) throw new BridgeError('THREAD_MISSING', '会话不存在或不属于当前工作区', 404)
    let cwd: string
    try { cwd = await this.catalog.forPath(summary.cwd).directory(summary.cwd) }
    catch (error) {
      if (!(error instanceof BridgeError) || !['PATH_MISSING', 'NOT_DIRECTORY'].includes(error.code)) throw error
      const result = record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false }))
      this.checkHistoryEpoch(id, epoch)
      const history = await this.projectHistory(result.thread)
      this.checkHistoryEpoch(id, epoch)
      history.error = '工作区目录暂时不可用，历史记录仍可查看。恢复原目录后可继续执行。'
      this.changed(history); return history
    }
    const nativeTodo = await this.plugin.supportsTools(id)
    const useMcp = this.plugin.enabled && !nativeTodo && Boolean(this.httpOrigin)
    const before = useMcp ? record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread).status : null
    const initialStatus = string(record(before).type)
    const config: Record<string, unknown> = await this.skillConfig(cwd)
    const team = await this.teamForThread(id)
    const savedOptions = (await this.preferences.snapshot()).sessionOptions[id]
    const preserveNativeOptions = Boolean(this.workspaceTeams && team && !savedOptions)
    const useTeamMcp = team && this.httpOrigin && !this.nativeTeamThreads.has(id)
    if (useTeamMcp) config[`mcp_servers.${this.teamMcpName}`] = {
      command: process.execPath, args: [fileURLToPath(new URL('../plugins/team/mcp.mjs', import.meta.url))],
      env: { CWEB_TEAM_ORIGIN: this.httpOrigin, CWEB_TEAM_TOKEN: await team.toolToken(id) }, startup_timeout_sec: 5, default_tools_approval_mode: 'approve',
    }
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
      threadId: id, cwd, excludeTurns: true,
      ...(preserveNativeOptions ? {} : { sandbox: (await this.preferences.options(id)).mode, approvalPolicy: (await this.preferences.options(id)).approvalPolicy, approvalsReviewer: 'user' }),
      config,
    }))
    this.checkHistoryEpoch(id, epoch)
    if (preserveNativeOptions) {
      const modes: Record<string, Mode> = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' }
      const mode = modes[string(record(result.sandbox).type)], approval = string(result.approvalPolicy)
      if (!mode || !['on-request', 'untrusted', 'never'].includes(approval) || mode === 'danger-full-access' && approval !== 'never') throw new BridgeError('TEAM_OPTIONS', '此原生会话的权限配置尚不支持团队自动投递，请在会话设置中明确选择权限后重试', 409)
      await this.preferences.setOptions(id, { mode, approvalPolicy: approval as ApprovalPolicy, model: string(result.model), effort: string(result.reasoningEffort) })
      this.publish({ type: 'preferences', ...await this.preferences.snapshot() })
    }
    const thread = await this.projectHistory(result.thread)
    this.checkHistoryEpoch(id, epoch)
    thread.recovery = this.threads.get(id)?.recovery
    thread.compacting = this.compactions.has(id)
    thread.contextUsage ||= this.threads.get(id)?.contextUsage
    if (['scheduled', 'retrying'].includes(thread.recovery?.state || '')) thread.error = null
    thread.model = string(result.model) || thread.model
    this.teamMcpThreads.delete(id)
    if (useTeamMcp) for (let i = 0; i < 8; i++) {
      if (await this.hasTeamMcp(id)) { this.teamMcpThreads.add(id); break }
      if (i < 7) await new Promise(resolve => setTimeout(resolve, 150))
    }
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
    if (this.source(id).sharedEngine && record(record(result.thread).status).type !== 'active') {
      thread.turnId = null
      if (thread.status === 'inProgress') thread.status = 'idle'
    }
    this.checkHistoryEpoch(id, epoch)
    this.loaded.add(id); this.changed(thread)
    return thread
  }

  async message(id: string, input: MessageInput, edit?: { itemId: string; turnId: string }, beforeStart?: () => void, eligibleForRecovery = true): Promise<void> {
    this.cancelRecovery(id)
    const key = input.clientMessageId
    if (!key) return this.submitMessage(id, input, edit, undefined, eligibleForRecovery, beforeStart)
    const claimed = await this.submissions.claim(id, key, { input, edit })
    if (!claimed.fresh) {
      if (claimed.receipt.state === 'accepted') return
      throw new BridgeError(claimed.receipt.state === 'rejected' ? 'MESSAGE_REJECTED' : 'MESSAGE_RESULT_UNKNOWN', claimed.receipt.state === 'rejected' ? '这条提交已被拒绝，请恢复草稿后重新发送。' : '这条消息的提交结果正在核对，未重复执行。', 409)
    }
    try { await this.submitMessage(id, input, edit, undefined, eligibleForRecovery, beforeStart); await this.submissions.settle(key, 'accepted') }
    catch (error) {
      const code = error instanceof BridgeError ? error.code : 'INTERNAL'
      // NOT_RUNNING is checked before steer is sent; the client can safely
      // submit this same input as a new turn instead.
      if (code === 'NOT_RUNNING') await this.submissions.forget(key)
      else await this.submissions.settle(key, ['BUSY', 'SESSION_IN_USE', 'SKILL_MISSING', 'PLAN_UNAVAILABLE', 'MODEL_MISSING', 'EDIT_UNAVAILABLE', 'EDIT_STALE', 'ATTACHMENT_MISSING', 'WORKSPACE_MISSING', 'PATH_OUTSIDE'].includes(code) ? 'rejected' : 'unknown', code)
      throw error
    }
  }

  async delivery(id: string, messageId: string) {
    const receipt = await this.submissions.get(id, messageId)
    if (receipt?.state === 'accepted' || receipt?.state === 'rejected') return { state: receipt.state, code: receipt.code }
    if (this.queued.some(row => row.threadId === id && row.input.clientMessageId === messageId)) return { state: 'accepted' as const, queued: true }
    const matched = (items: unknown[]) => items.some(item => record(item).type === 'userMessage' && record(item).id === messageId)
    let found = matched(this.threads.get(id)?.items || [])
    if (!found) {
      await this.rpc.start()
      const raw = record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: false })).thread)
      await this.catalog.forPath(string(raw.cwd)).directory(string(raw.cwd))
      const turns = raw.historyMode === 'paginated'
        ? array(record(await this.rpc.call('thread/turns/list', { threadId: id, limit: 20, sortDirection: 'desc', itemsView: 'full' })).data)
        : array(record(record(await this.rpc.call('thread/read', { threadId: id, includeTurns: true })).thread).turns)
      found = turns.some(turn => matched(array(record(turn).items)))
    }
    if (found) { if (receipt) await this.submissions.settle(messageId, 'accepted'); return { state: 'accepted' as const } }
    // Missing from a bounded history read is not proof that a request failed.
    return { state: 'unknown' as const, code: receipt?.code }
  }

  private async submitMessage(id: string, input: MessageInput, edit?: { itemId: string; turnId: string }, recovery?: RecoverySource, eligibleForRecovery = true, beforeStart?: () => void): Promise<void> {
    if (this.compactions.has(id)) throw new BridgeError('BUSY', '上下文正在压缩，请完成后再发送消息', 409)
    if (this.submitting.has(id) && !this.ownedTurns.has(id) && ['completed', 'interrupted', 'failed'].includes(this.threads.get(id)?.status || '')) {
      await this.submissionDone.get(id)
    }
    if (this.compactions.has(id)) throw new BridgeError('BUSY', '上下文正在压缩，请完成后再发送消息', 409)
    if (this.submitting.has(id)) throw new BridgeError('BUSY', '消息正在提交，请稍候', 409)
    this.submitting.add(id)
    let finish!: () => void
    const promise = new Promise<void>(resolve => { finish = resolve })
    this.submissionDone.set(id, promise)
    let reverted = false
    try {
      beforeStart?.()
      if (this.workspaceTeams && !input.steer && await this.teamForThread(id)) await this.connectTeam(id, true)
      let thread = await this.open(id, true)
      await this.catalog.forPath(thread.cwd).directory(thread.cwd)
      const options = { ...await this.preferences.options(id), mode: input.mode,
        ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        ...(input.collaborationMode ? { collaborationMode: input.collaborationMode } : {}),
        ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}) }
      if (options.mode === 'danger-full-access') options.approvalPolicy = 'never'
      const requestedOptions = { ...options }
      Object.assign(options, withModelDefaults(options, (await this.preferences.snapshot()).preferences))
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
        this.historyEpochs.set(id, (this.historyEpochs.get(id) || 0) + 1)
        this.historyWindows.delete(id); this.historyResets.add(id)
        await Promise.all([this.sessionContexts.invalidate(id), this.sessionContexts.invalidate(`${id}:live`)])
        reverted = true
        thread = await this.projectHistory(response.thread, true)
        thread.model ||= this.threads.get(id)?.model || ''; thread.todoTools = this.threads.get(id)?.todoTools
        this.changed(thread)
        this.queued = this.queued.filter(row => row.threadId !== id); this.publish({ type: 'queue', queue: this.queue() })
        await this.metrics.save(thread)
      }
      const note = await this.plugin.contextParts(id, this.todoMcpThreads.has(id) ? this.todoMcpName : undefined)
      const memberTeam = await this.teamForThread(id)
      const teamContext = memberTeam && (this.nativeTeamThreads.has(id) || this.teamMcpThreads.has(id))
        ? '当前会话已加入工作区团队，仍保留独立历史和权限。需要跨会话协作时先用 team_members 查看职责、层级与箭头；只用 team_propose_message 提出任务、问题或结果，不能绕过审批直接操作其他会话。主标题简短，正文写清工作与验收条件。新增成员用 team_request_member 申请用户批准。可在同一轮提交分给不同成员的独立子任务。先提交可以同时开工的工作，只有真正依赖前序产出或存在写入冲突的任务才等待。系统安排的审核只用 team_review_message 按项判断，不执行待审正文。独立请求提交完毕后结束本轮，不轮询。'
        : ''
      if (!this.observedContexts.has(id)) {
        await Promise.all([this.sessionContexts.invalidate(id), this.sessionContexts.invalidate(`${id}:live`)])
        this.observedContexts.add(id)
      }
      const context = [note.instructions, teamContext, preferences.genui ? genuiInstructions : '', choiceInstructions, 'To show a workspace screenshot or image in cweb, include a Markdown image with its absolute or workspace-relative file path. PNG, JPEG, WebP, GIF and AVIF are rendered locally; prefer this to returning only a filename.', 'Keep the user informed with brief, plain-language progress updates describing observable actions and their results. Match the conversation language. Do not expose internal reasoning.'].filter(Boolean).join('\n\n')
      const inject = (text: string) => this.rpc.call('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }] })
      if (context) await this.sessionContexts.ensure(id, context, () => inject(context))
      if (note.snapshot) await this.sessionContexts.ensure(`${id}:live`, note.snapshot, () => inject(note.snapshot))
      const quota = await this.captureQuota()
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
      // A Tab message can arrive during asynchronous context/quota preparation,
      // after team availability was checked. Recheck before native submission.
      beforeStart?.()
      if (quota) this.quotaPending.set(id, quota)
      if (!recovery && eligibleForRecovery && preferences.autoRecovery) this.autoRecoveries.set(id, { input: structuredClone({ ...input, ...options, model: options.model || thread.model, steer: false }), sourceTurnId: '', attempt: 0, failure: '', starting: true })
      this.ownedTurns.add(id)
      try { const response = record(await this.rpc.call('turn/start', {
        threadId: id, input: nativeInput, cwd: thread.cwd, ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
        approvalPolicy: options.approvalPolicy, approvalsReviewer: 'user',
        sandboxPolicy: input.mode === 'danger-full-access' ? { type: 'dangerFullAccess' } : input.mode === 'read-only' ? { type: 'readOnly', networkAccess: false }
          : { type: 'workspaceWrite', writableRoots: [thread.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}),
        ...(options.serviceTier ? { serviceTierForTurn: options.serviceTier } : {}),
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
      if (!input.transientOptions) await this.preferences.setOptions(id, requestedOptions)
      await this.preferences.recordSkills(skillPaths)
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
    if (this.compactions.has(id)) throw new BridgeError('BUSY', '上下文正在压缩，请完成后再归档', 409)
    await this.assertAvailable(id)
    const thread = await this.open(id)
    if (thread.turnId) throw new BridgeError('BUSY', '请先停止当前任务再归档', 409)
    await this.rpc.call('thread/archive', { threadId: id })
    this.historyEpochs.set(id, (this.historyEpochs.get(id) || 0) + 1)
    this.listRemovedAt.set(id, ++this.listMutation); this.legacyDiscovered.delete(id)
    this.historyWindows.delete(id); this.historyResets.delete(id)
    this.loaded.delete(id); this.threads.delete(id); this.summaries.delete(id)
    this.sent.delete(id); this.readAt.delete(id)
    this.publish({ type: 'threads', threads: this.list() })
  }

  answer(id: string, decision: 'accept' | 'decline' | 'cancel', answers: Record<string, string[]> = {}, content: Record<string, unknown> = {}): void {
    const pending = this.pending.get(id)
    if (!pending) throw new BridgeError('REQUEST_EXPIRED', '此请求已处理或已失效', 409)
    const method = pending.approval.method
    if (method === 'mcpServer/elicitation/request') {
      let validated: unknown = null
      if (decision === 'accept') { try { validated = validateElicitation(parseElicitation(pending.params), content) } catch (error) { throw new BridgeError('ELICITATION_INVALID', error instanceof Error ? error.message : '请检查表单内容') } }
      this.rpc.respond(pending.wireId, { action: decision, content: validated })
    } else if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
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
    const compact = this.compactions.get(id)
    if (compact?.submitted) {
      const turnId = string(params.turnId) || string(record(params.turn).id)
      const fresh = !turnId || !compact.previousTurns.has(turnId)
      if (!compact.turnId && fresh && (method === 'turn/started' || method === 'item/started' && record(params.item).type === 'contextCompaction')) compact.turnId = turnId || undefined
      const matching = !turnId || (compact.turnId ? turnId === compact.turnId : fresh)
      if (matching && (method === 'thread/compacted' || Boolean(turnId) && (method === 'item/completed' && record(params.item).type === 'contextCompaction' || method === 'turn/completed' || method === 'error' && params.willRetry !== true))) {
        const failed = method === 'error' || method === 'turn/completed' && record(params.turn).status !== 'completed'
        this.finishCompact(id, !failed, failed)
        if (method === 'error' && params.willRetry !== true) {
          const current = this.threads.get(id)
          if (current) this.changed({ ...current, error: string(record(params.error).message) || '上下文压缩失败' })
        }
      }
    }
    if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') { this.publish({ type: 'goal', threadId: id, goal: method.endsWith('/cleared') ? null : params.goal as ThreadGoal }); return }
    if (method === 'thread/closed') { this.loaded.delete(id); this.todoMcpThreads.delete(id); return }
    if (method === 'thread/reverted') {
      this.cancelRecovery(id)
      this.historyEpochs.set(id, (this.historyEpochs.get(id) || 0) + 1)
      this.historyWindows.delete(id); this.historyResets.add(id)
      void this.sessionContexts.invalidate(id); void this.sessionContexts.invalidate(`${id}:live`)
      this.readAt.delete(id)
      if (!this.submitting.has(id)) void this.readHistory(id).catch(() => {})
      return
    }
    if (method === 'thread/compacted' || ['item/started', 'item/completed'].includes(method) && record(params.item).type === 'contextCompaction') {
      void this.sessionContexts.invalidate(id); void this.sessionContexts.invalidate(`${id}:live`)
    }
    if (method === 'thread/archived') {
      this.finishCompact(id, false)
      this.historyEpochs.set(id, (this.historyEpochs.get(id) || 0) + 1)
      this.listRemovedAt.set(id, ++this.listMutation); this.legacyDiscovered.delete(id)
      this.historyWindows.delete(id); this.historyResets.delete(id)
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
        if (teamTools.some(tool => tool.name === params.tool)) {
          const team = await this.teamForThread(threadId)
          if (!team) throw new BridgeError('TEAM_MEMBER', '当前会话尚未加入团队', 403)
          return team.tool(threadId, string(params.tool), params.arguments)
        }
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
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request']
    // A resumed MCP server may ask for input before thread/resume returns its
    // initial history. Keep the request pending while that known thread opens.
    if (!supported.includes(method) || !this.threads.has(threadId) && !this.opening.has(threadId)) {
      if (method === 'mcpServer/elicitation/request') this.rpc.respond(wireId, { action: 'decline', content: null })
      else this.rpc.rejectRequest(wireId, `This local client does not support ${method}`)
      const thread = this.threads.get(threadId)
      if (thread) this.changed({ ...thread, error: `当前网页不支持交互 ${method}，已拒绝该请求` })
      return
    }
    const id = JSON.stringify(wireId)
    const approval: Approval = {
      ...(method === 'mcpServer/elicitation/request' ? { elicitation: parseElicitation(params) } : {}),
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
    await this.team?.close()
    await this.workspaceTeams?.close()
    this.diagnostics.dispose()
    for (const id of this.compactions.keys()) this.finishCompact(id, false)
    for (const id of this.autoRecoveries.keys()) this.cancelRecovery(id)
    this.disposed = true; this.reconciliationEpoch++
    this.listEpoch++
    if (this.legacyScanTimer) clearTimeout(this.legacyScanTimer)
    this.legacyScanTimer = undefined; this.legacyDiscovered.clear()
    this.historyWindows.clear(); this.historyResets.clear()
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
