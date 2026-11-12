import type { AttachmentInfo, Item, ThreadView, RunMetrics } from '../shared/types.ts'
import { array, record, string } from './errors.ts'
import { describeCommand, describeTool } from '../shared/activity.ts'
import { hasPendingChoice } from '../shared/choices.ts'

const visibleLimit = 200_000
function bounded(value: unknown): string { return string(value).slice(-visibleLimit) }
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
export function projectRun(value: unknown): RunMetrics {
  const turn = record(value); const startedAt = positive(turn.startedAt); const completedAt = positive(turn.completedAt)
  const duration = typeof turn.durationMs === 'number' && turn.durationMs >= 0 ? turn.durationMs : startedAt && completedAt ? Math.max(0, (completedAt - startedAt) * 1000) : undefined
  return { id: string(turn.id), status: string(turn.status), ...(startedAt ? { startedAt: startedAt * 1000 } : {}), ...(completedAt ? { completedAt: completedAt * 1000 } : {}), ...(duration !== undefined ? { durationMs: duration } : {}) }
}

/** Codex items remain recognizable; unrecognized tools retain a readable JSON presentation. */
export function projectItem(value: unknown): Item {
  const raw = record(value)
  const type = string(raw.type)
  let text = string(raw.text)
  let attachments: AttachmentInfo[] = []; let skills: { name: string; path: string }[] = []
  if (type === 'userMessage') {
    skills = array(raw.content).map(record).filter(value => value.type === 'skill').map(value => ({ name: string(value.name), path: string(value.path) }))
    text = array(raw.content).map(value => {
      const content = string(record(value).text); const at = content.indexOf('<cweb_attachments>\n')
      if (at === -1) return content
      const end = content.indexOf('\n</cweb_attachments>', at)
      if (end === -1) return content
      try {
        const parsed = JSON.parse(content.slice(at + '<cweb_attachments>\n'.length, end))
        attachments = array(parsed).map(record).filter(row => /^[0-9a-f-]{36}$/.test(string(row.id))).map(row => ({ id: string(row.id), name: string(row.name), size: typeof row.size === 'number' ? row.size : 0,
          kind: row.kind === 'image' ? 'image' : 'file', url: `/api/attachments/${string(row.id)}/content` }))
        return content.slice(0, at).trimEnd()
      } catch { return content }
    }).filter(Boolean).join('\n')
  }
  const summaryParts = type === 'reasoning' ? array(raw.summary).map(value => typeof value === 'string' ? value : string(record(value).text)) : undefined
  if (type === 'reasoning') text = summaryParts!.filter(Boolean).join('\n\n')
  if (type === 'dynamicToolCall') text = array(raw.contentItems).map(value => string(record(value).text)).filter(Boolean).join('\n') || JSON.stringify(raw.arguments, null, 2) || ''
  if (type === 'mcpToolCall') text = string(record(raw.error).message) || array(record(raw.result).content).map(value => string(record(value).text)).filter(Boolean).join('\n') || ''
  if (!['agentMessage', 'userMessage', 'reasoning', 'commandExecution', 'fileChange', 'plan', 'dynamicToolCall', 'mcpToolCall'].includes(type)) {
    text = JSON.stringify(raw, null, 2)
  }
  return {
    id: string(raw.id), type, text: text.slice(-visibleLimit), status: string(raw.status) || (type === 'contextCompaction' ? positive(raw.completedAtMs) ? 'completed' : positive(raw.startedAtMs) ? 'inProgress' : '' : ''),
    ...(type === 'reasoning' ? { summaryParts } : {}),
    ...(type === 'agentMessage' && raw.phase ? { phase: string(raw.phase) } : {}),
    ...(type === 'agentMessage' && raw.delivery === 'async' ? { delivery: 'async' as const } : {}),
    ...(type === 'agentMessage' && Array.isArray(raw.questions) ? { questions: raw.questions.flatMap(value => {
      const question = record(value)
      if (!string(question.title).trim()) return []
      return [{ title: string(question.title), options: Array.isArray(question.options) ? question.options.filter((option): option is string => typeof option === 'string' && Boolean(option.trim())) : null }]
    }) } : {}),
    ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
    ...(positive(raw.completedAtMs) || positive(raw.startedAtMs) ? { timestamp: positive(raw.completedAtMs) || positive(raw.startedAtMs), timeSource: 'native' as const } : {}),
    ...(attachments.length ? { attachments } : {}), ...(skills.length ? { skills } : {}),
    ...(['dynamicToolCall', 'mcpToolCall'].includes(type) ? { tool: string(raw.tool), activity: describeTool(string(raw.tool)), ...(raw.tool === 'render_ui' && record(raw.arguments).spec ? { ui: record(raw.arguments).spec } : {}) } : {}),
    ...(type === 'commandExecution' ? {
      command: string(raw.command), output: bounded(raw.aggregatedOutput),
      activity: describeCommand(string(raw.command), array(raw.commandActions).map(value => { const row = record(value); return { type: string(row.type), name: string(row.name), path: string(row.path), query: string(row.query) } })),
      exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    } : {}),
    ...(type === 'fileChange' ? { changes: array(raw.changes).map(value => {
      const change = record(value)
      return { path: string(change.path), diff: bounded(change.diff), kind: string(record(change.kind).type) }
    }) } : {}),
  }
}

export function projectThread(value: unknown): ThreadView {
  const raw = record(value)
  const turns = array(raw.turns).map(record)
  const active = turns.find(turn => turn.status === 'inProgress')
  const last = turns.at(-1)
  const status = active ? 'inProgress' : last?.status
  const runs = turns.map(projectRun)
  const items = turns.flatMap((turn, index) => array(turn.items).map(value => {
    const item = projectItem(value); item.turnId = string(turn.id)
    const fallback = item.type === 'userMessage' ? runs[index].startedAt : runs[index].completedAt
    if (!item.timestamp && fallback) { item.timestamp = fallback; item.timeSource = 'turn' }
    return item
  }))
  return {
    id: string(raw.id), revision: 0, title: string(raw.name) || string(raw.preview) || '新会话',
    ...(raw.historyMode === 'legacy' || raw.historyMode === 'paginated' ? { historyMode: raw.historyMode } : {}),
    cwd: string(raw.cwd), model: string(raw.model),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now() / 1000,
    status: ['inProgress', 'completed', 'interrupted', 'failed'].includes(string(status))
      ? status as ThreadView['status'] : 'idle',
    turnId: active ? string(active.id) : null,
    progress: active ? (() => {
      const compact = items.findLast(item => item.turnId === active.id && item.type === 'contextCompaction' && item.status === 'inProgress')
      const lastEventAt = items.findLast(item => item.turnId === active.id && item.timestamp)?.timestamp || positive(active.startedAt) && Number(active.startedAt) * 1000 || Date.now()
      return { stage: compact ? 'compacting' as const : 'working' as const, updatedAt: compact?.timestamp || lastEventAt, lastEventAt }
    })() : undefined,
    items,
    choicePending: hasPendingChoice(items),
    plan: [], diff: '', tokens: 0, tokenUsageKnown: turns.length === 0, runs,
    error: last?.error ? string(record(last.error).message) : null,
  }
}

/** Pure notification fold used by live rendering and recorded protocol tests. */
export function applyNotification(thread: ThreadView, method: string, params: Record<string, unknown>): ThreadView {
  const now = Date.now()
  const incomingTurn = string(params.turnId) || string(record(params.turn).id)
  // Late terminal events from an older turn must not stop a newer submission.
  if (['turn/completed', 'error'].includes(method) && thread.turnId && incomingTurn && incomingTurn !== thread.turnId) return thread
  const latestRun = thread.runs?.at(-1)
  if (['turn/completed', 'error'].includes(method) && !thread.turnId && incomingTurn && latestRun && incomingTurn !== latestRun.id) return thread
  if (method === 'error' && !thread.turnId && incomingTurn === latestRun?.id && latestRun?.status !== 'inProgress') return thread
  const currentEvent = Boolean(thread.turnId && (!incomingTurn || incomingTurn === thread.turnId))
  const result = { ...thread, updatedAt: now / 1000 }
  const working = (stage: 'working' | 'compacting' = 'working') => {
    if (!currentEvent) return
    result.progress = { stage, updatedAt: thread.progress?.stage === stage ? thread.progress.updatedAt : now, lastEventAt: now }
    // A real output/progress event establishes recovery; old retry messages
    // must not remain visible throughout the rest of a successful turn.
    if (thread.progress?.stage === 'retrying') result.error = null
  }
  if (method === 'turn/started') {
    result.choicePending = false
    result.status = 'inProgress'; result.turnId = string(record(params.turn).id)
    result.error = null; result.plan = []; result.diff = ''
    result.progress = { stage: 'working', updatedAt: now, lastEventAt: now }
    const run = projectRun(params.turn)
    if (!run.startedAt) { run.startedAt = Date.now(); run.observed = true }
    if (thread.tokenUsageKnown) run.tokenBase = thread.tokens
    result.runs = [...(thread.runs || []).filter(value => value.id !== run.id), run]
  } else if (method === 'turn/completed') {
    const turn = record(params.turn)
    result.status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed'
    result.turnId = null
    result.progress = undefined
    result.choicePending = turn.status === 'completed' && hasPendingChoice(result.items)
    result.error = turn.error ? string(record(turn.error).message) : result.status === 'failed' ? thread.error : null
    const raw = projectRun(turn); const previous = thread.runs?.find(value => value.id === raw.id)
    const completedAt = raw.completedAt || Date.now(); const startedAt = raw.startedAt || previous?.startedAt
    const run = { ...previous, ...raw, completedAt, ...(startedAt ? { startedAt, durationMs: raw.durationMs ?? Math.max(0, completedAt - startedAt) } : {}) }
    result.runs = [...(thread.runs || []).filter(value => value.id !== run.id), run]
    result.items = thread.items.map(item => item.turnId === raw.id && item.status === 'inProgress' ? { ...item, status: result.status } : item)
  } else if (method === 'error') {
    result.error = string(record(params.error).message) || 'Codex 执行出错'
    if (params.willRetry === true) {
      if (!thread.turnId || thread.status !== 'inProgress') return thread
      const details = string(record(params.error).additionalDetails)
      result.progress = { stage: 'retrying', message: [result.error, details].filter(Boolean).join('\n').slice(0, 4000), updatedAt: now, lastEventAt: now,
        attempt: (thread.progress?.stage === 'retrying' ? thread.progress.attempt || 0 : 0) + 1 }
      result.error = null
    } else {
      result.status = 'failed'; result.turnId = null; result.progress = undefined; result.choicePending = false
      result.runs = thread.runs?.map(run => run.id === (incomingTurn || thread.turnId) ? { ...run, status: 'failed', completedAt: now, ...(run.startedAt ? { durationMs: Math.max(0, now - run.startedAt) } : {}) } : run)
      result.items = thread.items.map(item => item.turnId === (incomingTurn || thread.turnId) && item.status === 'inProgress' ? { ...item, status: 'failed' } : item)
    }
  } else if (method === 'thread/compacted') {
    if (!currentEvent) return thread
    working()
    result.items = thread.items.map(item => item.turnId === thread.turnId && item.type === 'contextCompaction' && item.status === 'inProgress' ? { ...item, status: 'completed' } : item)
  } else if (method === 'thread/name/updated') {
    result.title = string(params.threadName) || string(params.name) || result.title
  } else if (method === 'turn/diff/updated') {
    result.diff = bounded(params.diff)
  } else if (method === 'turn/plan/updated') {
    result.plan = array(params.plan).map(value => {
      const row = record(value); return { step: string(row.step), status: string(row.status) }
    })
  } else if (method === 'thread/tokenUsage/updated') {
    const usage = record(params.tokenUsage)
    const total = record(usage.total)
    result.tokens = typeof total.totalTokens === 'number' ? total.totalTokens : thread.tokens
    result.tokenUsageKnown = typeof total.totalTokens === 'number' || thread.tokenUsageKnown
    const turnId = string(params.turnId)
    result.runs = thread.runs?.map(run => run.id === turnId && run.tokenBase !== undefined ? { ...run, tokens: Math.max(0, result.tokens - run.tokenBase) } : run)
    const inputTokens = record(usage.last).inputTokens, windowTokens = usage.modelContextWindow
    if ((!turnId || turnId === (thread.turnId || thread.runs?.at(-1)?.id)) && typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens >= 0 && typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0) {
      result.contextUsage = { inputTokens, windowTokens, updatedAt: now }
    }
  } else if (method === 'item/started' || method === 'item/completed') {
    const item = projectItem(params.item)
    if (item.type === 'agentMessage') item.status = method === 'item/started' ? 'inProgress' : 'completed'
    if (!item.id) return thread
    const existing = result.items.findIndex(value => value.id === item.id)
    const known = existing < 0 ? undefined : result.items[existing]
    item.turnId = string(params.turnId) || known?.turnId || thread.turnId || undefined
    if (!item.timestamp) { item.timestamp = known?.timestamp || Date.now(); item.timeSource = known?.timeSource || 'observed' }
    if (method === 'item/completed' && item.type === 'reasoning' && !item.text && existing !== -1) {
      item.text = result.items[existing].text; item.summaryParts = result.items[existing].summaryParts
    }
    if (['reasoning', 'plan', 'contextCompaction'].includes(item.type)) item.status = method === 'item/started' ? 'inProgress' : 'completed'
    // Background completion of a tool isn't evidence that a failed model
    // connection has recovered. Keep retrying until model output resumes.
    if (item.type === 'contextCompaction') working(method === 'item/started' ? 'compacting' : 'working')
    else if (thread.progress?.stage !== 'retrying' || method === 'item/started' || ['agentMessage', 'reasoning', 'plan'].includes(item.type)) working()
    result.items = [...result.items]
    if (existing === -1) result.items.push(item)
    else result.items[existing] = item
    if (['agentMessage', 'userMessage'].includes(item.type)) result.choicePending = hasPendingChoice(result.items)
    if (item.type === 'userMessage' && result.title === '新会话') result.title = item.text.slice(0, 80)
  } else if (['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta', 'item/plan/delta'].includes(method)) {
    if (thread.progress?.stage !== 'retrying' || method !== 'item/commandExecution/outputDelta') working()
    const id = string(params.itemId)
    const index = result.items.findIndex(item => item.id === id)
    const type = method.includes('commandExecution') ? 'commandExecution' : method.includes('reasoning') ? 'reasoning' : method.includes('/plan/') ? 'plan' : 'agentMessage'
    const item = index === -1 ? { id, type, text: '', status: 'inProgress' } : { ...result.items[index] }
    if (!item.timestamp) { item.timestamp = Date.now(); item.timeSource = 'observed'; item.turnId = string(params.turnId) || thread.turnId || undefined }
    if (type === 'commandExecution') item.output = ((item.output || '') + string(params.delta)).slice(-visibleLimit)
    else if (type === 'reasoning') {
      const parts = [...(item.summaryParts || (item.text ? [item.text] : []))]
      const part = typeof params.summaryIndex === 'number' && params.summaryIndex >= 0 && params.summaryIndex < 100 ? params.summaryIndex : 0
      parts[part] = ((parts[part] || '') + string(params.delta)).slice(-visibleLimit)
      item.summaryParts = parts; item.text = parts.filter(Boolean).join('\n\n').slice(-visibleLimit)
    } else item.text = (item.text + string(params.delta)).slice(-visibleLimit)
    result.items = [...result.items]
    if (index === -1) result.items.push(item)
    else result.items[index] = item
  } else return thread
  return result
}
