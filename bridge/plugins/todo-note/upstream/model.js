// dsh-todo-note — pure state model.
//
// Everything that mutates a session note goes through `applyAction`, so the
// agent tools and the panel buttons share one implementation (and one test
// suite). This module has no I/O and no DSH imports: it runs in the host half
// and in `node --test`.

export const SCHEMA_VERSION = 1

export const LIMITS = Object.freeze({
  sessions: 80,
  tasks: 200,
  title: 200,
  note: 500,
  phases: 30,
  goals: 20,
  log: 20,
})

export const TASK_STATES = Object.freeze(['active', 'shelved', 'awaiting', 'done'])
// cweb extension: paused preserves a parked main phase while a branch is active.
export const PHASE_STATES = Object.freeze(['todo', 'active', 'paused', 'done'])

/** An action that the model refuses; `code` is stable and shown to the caller. */
export class NoteError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'NoteError'
    this.code = code
  }
}

function uid(prefix) {
  let rand
  try {
    rand = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  } catch {
    rand = Math.random().toString(16).slice(2, 10)
  }
  return `${prefix}_${rand}`
}

function text(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}…` : trimmed
}

function integer(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function weight(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.min(5, Math.max(0.5, Math.round(n * 10) / 10))
}

export function emptyNote() {
  return {
    version: 0,
    updatedAt: 0,
    focus: { current: '', next: '' },
    tasks: [],
    plan: { title: '', goals: [], phases: [] },
    log: [],
    linkedAt: 0,
  }
}

export function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, sessions: {} }
}

export function cloneNote(note) {
  return structuredClone(note)
}

export function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = text(raw.title, LIMITS.title)
  if (!title) return null
  const state = TASK_STATES.includes(raw.state) && raw.state !== 'done' ? raw.state : 'active'
  const createdAt = integer(raw.createdAt, 0, 0, Number.MAX_SAFE_INTEGER)
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : uid('t'),
    title,
    state,
    note: text(raw.note, LIMITS.note),
    phaseId: typeof raw.phaseId === 'string' && raw.phaseId ? raw.phaseId.slice(0, 40) : '',
    by: raw.by === 'user' ? 'user' : 'agent',
    createdAt,
    updatedAt: integer(raw.updatedAt, createdAt, 0, Number.MAX_SAFE_INTEGER),
    doneAt: integer(raw.doneAt, 0, 0, Number.MAX_SAFE_INTEGER),
    rejectedAt: integer(raw.rejectedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    rejects: integer(raw.rejects, 0, 0, 999),
  }
}

export function normalizePhase(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = text(raw.title, LIMITS.title)
  if (!title) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : uid('p'),
    title,
    status: PHASE_STATES.includes(raw.status) ? raw.status : 'todo',
    weight: weight(raw.weight),
    doneAt: integer(raw.doneAt, 0, 0, Number.MAX_SAFE_INTEGER),
  }
}

export function normalizeGoal(raw) {
  if (typeof raw === 'string') {
    const label = text(raw, LIMITS.title)
    return label ? { id: uid('g'), text: label, done: false } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const label = text(raw.text, LIMITS.title)
  if (!label) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : uid('g'),
    text: label,
    done: raw.done === true,
  }
}

export function normalizeNote(raw) {
  const note = emptyNote()
  if (!raw || typeof raw !== 'object') return note
  note.version = integer(raw.version, 0, 0, Number.MAX_SAFE_INTEGER)
  note.updatedAt = integer(raw.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER)
  note.linkedAt = integer(raw.linkedAt, 0, 0, Number.MAX_SAFE_INTEGER)
  note.focus = {
    current: text(raw.focus?.current, LIMITS.title),
    next: text(raw.focus?.next, LIMITS.title),
  }
  if (Array.isArray(raw.tasks)) {
    note.tasks = raw.tasks.map(normalizeTask).filter(Boolean).slice(0, LIMITS.tasks)
  }
  const plan = raw.plan && typeof raw.plan === 'object' ? raw.plan : {}
  note.plan = {
    title: text(plan.title, LIMITS.title),
    goals: Array.isArray(plan.goals)
      ? plan.goals.map(normalizeGoal).filter(Boolean).slice(0, LIMITS.goals)
      : [],
    phases: Array.isArray(plan.phases)
      ? plan.phases.map(normalizePhase).filter(Boolean).slice(0, LIMITS.phases)
      : [],
  }
  if (Array.isArray(raw.log)) {
    note.log = raw.log
      .filter((entry) => entry && typeof entry.title === 'string' && entry.title.trim())
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id.slice(0, 40) : uid('t'),
        title: text(entry.title, LIMITS.title),
        doneAt: integer(entry.doneAt, 0, 0, Number.MAX_SAFE_INTEGER),
      }))
      .slice(0, LIMITS.log)
  }
  return note
}

export function normalizeStore(raw) {
  const store = emptyStore()
  const sessions = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
  for (const [sessionId, rawNote] of Object.entries(sessions)) {
    if (typeof sessionId !== 'string' || !sessionId) continue
    if (!rawNote || typeof rawNote !== 'object') continue
    store.sessions[sessionId] = normalizeNote(rawNote)
  }
  return store
}

function findTask(note, id) {
  const task = note.tasks.find((candidate) => candidate.id === id)
  if (!task) throw new NoteError('task-not-found', `no task with id ${String(id)}`)
  return task
}

function assertList(value, name) {
  if (!Array.isArray(value)) throw new NoteError('bad-action', `${name} must be an array`)
  return value
}

/**
 * Apply one action to a note and return a new note.
 * Unknown or invalid actions throw {@link NoteError}; nothing mutates in place.
 */
function resolvePhaseId(note, value) {
  if (typeof value !== 'string' || !value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const phase = note.plan.phases.find((candidate) => candidate.id === trimmed)
    ?? note.plan.phases.find((candidate) => candidate.title === trimmed)
  return phase ? phase.id : ''
}

export function applyAction(current, action) {
  const base = current && typeof current === 'object' ? current : emptyNote()
  const note = cloneNote(base)
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    throw new NoteError('bad-action', 'action must be an object with a string type')
  }
  const now = Date.now()
  const type = action.type

  switch (type) {
    case 'set_focus': {
      if (action.current !== undefined) note.focus.current = text(action.current, LIMITS.title)
      if (action.next !== undefined) note.focus.next = text(action.next, LIMITS.title)
      if (action.current === undefined && action.next === undefined) {
        throw new NoteError('bad-action', 'set_focus needs current and/or next')
      }
      break
    }
    case 'add_task': {
      if (note.tasks.length >= LIMITS.tasks) throw new NoteError('too-many-tasks', `a session holds at most ${LIMITS.tasks} tasks`)
      const title = text(action.title, LIMITS.title)
      if (!title) throw new NoteError('empty-title', 'a task needs a non-empty title')
      const state = action.state === 'shelved' ? 'shelved' : 'active'
      note.tasks.unshift({
        id: uid('t'),
        title,
        state,
        note: text(action.note, LIMITS.note),
        phaseId: resolvePhaseId(note, action.phase),
        by: action.by === 'user' ? 'user' : 'agent',
        createdAt: now,
        updatedAt: now,
        doneAt: 0,
      })
      break
    }
    case 'update_task': {
      const task = findTask(note, action.id)
      if (action.title !== undefined) {
        const title = text(action.title, LIMITS.title)
        if (!title) throw new NoteError('empty-title', 'a task needs a non-empty title')
        task.title = title
      }
      if (action.note !== undefined) task.note = text(action.note, LIMITS.note)
      if (action.phase !== undefined) task.phaseId = resolvePhaseId(note, action.phase)
      if (action.state !== undefined) {
        if (action.state === 'done' || action.state === 'awaiting') {
          throw new NoteError('use-complete', 'use todo_note_complete to finish a task; update_task only sets active/shelved')
        }
        if (action.state !== 'active' && action.state !== 'shelved') {
          throw new NoteError('bad-state', `unsupported task state ${String(action.state)}`)
        }
        task.state = action.state
      }
      task.updatedAt = now
      break
    }
    case 'remove_task': {
      const index = note.tasks.findIndex((task) => task.id === action.id)
      if (index < 0) throw new NoteError('task-not-found', `no task with id ${String(action.id)}`)
      note.tasks.splice(index, 1)
      break
    }
    case 'move_task': {
      const from = note.tasks.findIndex((task) => task.id === action.id)
      if (from < 0) throw new NoteError('task-not-found', `no task with id ${String(action.id)}`)
      const [moved] = note.tasks.splice(from, 1)
      const before = action.beforeId == null ? -1 : note.tasks.findIndex((task) => task.id === action.beforeId)
      const target = before < 0 ? note.tasks.length : before
      note.tasks.splice(target, 0, moved)
      moved.updatedAt = now
      break
    }
    case 'complete_task': {
      const task = findTask(note, action.id)
      if (task.state === 'awaiting') return { note: base, changed: { type, awaiting: true } }
      task.state = 'awaiting'
      task.updatedAt = now
      break
    }
    case 'confirm_task': {
      const task = findTask(note, action.id)
      note.tasks = note.tasks.filter((candidate) => candidate.id !== task.id)
      note.log = [{ id: task.id, title: task.title, doneAt: now }, ...note.log].slice(0, LIMITS.log)
      break
    }
    case 'reject_task': {
      const task = findTask(note, action.id)
      // A rejection is feedback, not a no-op: the task goes back to active but
      // keeps the fact that the user said no, so the next prompt can say it.
      task.state = 'active'
      task.rejectedAt = now
      task.rejects = (task.rejects ?? 0) + 1
      task.updatedAt = now
      break
    }
    case 'set_plan': {
      const plan = { title: note.plan?.title ?? '', goals: note.plan?.goals ?? [], phases: note.plan?.phases ?? [] }
      if (action.title !== undefined) plan.title = text(action.title, LIMITS.title)
      if (action.goals !== undefined) {
        plan.goals = assertList(action.goals, 'goals')
          .map(normalizeGoal)
          .filter(Boolean)
          .slice(0, LIMITS.goals)
      }
      if (action.phases !== undefined) {
        const previous = new Map((note.plan?.phases ?? []).map((phase) => [phase.title, phase]))
        plan.phases = assertList(action.phases, 'phases')
          .map((raw) => {
            const normalized = normalizePhase(raw)
            if (!normalized) return null
            const existing = previous.get(normalized.title)
            if (existing && !(raw && typeof raw === 'object' && raw.id)) normalized.id = existing.id
            if (normalized.status === 'done' && !normalized.doneAt) normalized.doneAt = now
            return normalized
          })
          .filter(Boolean)
          .slice(0, LIMITS.phases)
      }
      note.plan = plan
      break
    }
    default:
      throw new NoteError('unknown-action', `unknown action ${type}`)
  }

  note.version = (Number(base.version) || 0) + 1
  note.updatedAt = now
  if (!note.linkedAt) note.linkedAt = now
  return { note, changed: { type } }
}

/**
 * Whether this session's note is "linked": the plugin has been adopted by the
 * conversation. Legacy notes written before `linkedAt` existed still count as
 * linked when they hold any content, so we never nag an established session.
 */
export function isLinked(note) {
  if (!note || typeof note !== 'object') return false
  if (Number(note.linkedAt) > 0) return true
  const focus = note.focus && typeof note.focus === 'object' ? note.focus : {}
  if ((focus.current ?? '').trim() || (focus.next ?? '').trim()) return true
  if (Array.isArray(note.tasks) && note.tasks.length > 0) return true
  const plan = note.plan && typeof note.plan === 'object' ? note.plan : {}
  if (Array.isArray(plan.phases) && plan.phases.length > 0) return true
  if (Array.isArray(plan.goals) && plan.goals.length > 0) return true
  return false
}

export const LINK_NUDGE =
  '- 【需要先做一次】本会话还没有关联待办便签：先 `todo_note_read` 看一眼（通常是空的），再用 `todo_note_update` 写入现在/下一步和 1–3 条真实任务，把它和这个会话关联起来。只做这一次，之后不要重复提醒。'

/**
 * The per-agent prompt block: the snapshot, prefixed by a one-time nudge while
 * the session has not been linked yet.
 */
export function renderLiveSection(note, options = {}) {
  const snapshot = renderSnapshot(note)
  if (options.nudge === false) return snapshot
  if (isLinked(note)) return snapshot
  return `${LINK_NUDGE}\n${snapshot}`
}

export function progressOf(plan) {
  const phases = Array.isArray(plan?.phases) ? plan.phases : []
  const totalWeight = phases.reduce((sum, phase) => sum + weight(phase.weight), 0)
  const doneWeight = phases
    .filter((phase) => phase.status === 'done')
    .reduce((sum, phase) => sum + weight(phase.weight), 0)
  const current = phases.find((phase) => phase.status === 'active') || null
  return {
    percent: totalWeight > 0 ? Math.round((doneWeight / totalWeight) * 100) : 0,
    done: phases.filter((phase) => phase.status === 'done').length,
    total: phases.length,
    current: current ? current.title : '',
    goals: (plan?.goals ?? []).length,
    goalsDone: (plan?.goals ?? []).filter((goal) => goal.done).length,
  }
}

export function countsOf(note) {
  const tasks = Array.isArray(note?.tasks) ? note.tasks : []
  return {
    active: tasks.filter((task) => task.state === 'active').length,
    awaiting: tasks.filter((task) => task.state === 'awaiting').length,
    shelved: tasks.filter((task) => task.state === 'shelved').length,
    total: tasks.length,
  }
}

function clip(value, max) {
  const s = String(value ?? '')
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s
}

/**
 * The compact prompt block injected into every agent of the session.
 * Bounded by `maxLines` and `lineMax` so it can never crowd out the prompt.
 */
export function renderSnapshot(note, options = {}) {
  const maxLines = integer(options.maxLines, 6, 2, 12)
  const lineMax = integer(options.lineMax, 64, 24, 160)
  const counts = countsOf(note)
  const plan = note?.plan ?? { title: '', goals: [], phases: [] }
  const progress = progressOf(plan)
  const header = '## 待办便签（自动快照，无需复读上下文）'

  const focusNow = String(note?.focus?.current ?? '').trim()
  const focusNext = String(note?.focus?.next ?? '').trim()
  if (!focusNow && !focusNext && counts.total === 0 && progress.total === 0 && progress.goals === 0) {
    return [header, '- 暂无待办；开工时用 todo_note_update 建立焦点与计划。'].slice(0, maxLines).join('\n')
  }

  const lines = []
  const current = note?.focus?.current
  const next = note?.focus?.next
  if (current || next) {
    const parts = []
    if (current) parts.push(`现在：${clip(current, lineMax / 2)}`)
    if (next) parts.push(`下一步：${clip(next, lineMax / 2)}`)
    lines.push(`- ${parts.join(' ｜ ')}`)
  }

  const active = (note?.tasks ?? []).filter((task) => task.state === 'active')
  if (active.length > 0) {
    const shown = active.slice(0, 5).map((task) => clip(task.title, 18))
    lines.push(`- 进行中（${active.length}）：${shown.join('；')}${active.length > shown.length ? '…' : ''}`)
  }

  const awaiting = (note?.tasks ?? []).filter((task) => task.state === 'awaiting')
  if (awaiting.length > 0) {
    lines.push(`- 待用户确认：${awaiting.slice(0, 3).map((task) => clip(task.title, 18)).join('；')}（别当作已完成）`)
  }

  const rejected = (note?.tasks ?? []).filter((task) => task.state === 'active' && task.rejects > 0)
  if (rejected.length > 0) {
    lines.push(`- 用户未通过：${rejected.slice(0, 3).map((task) => clip(task.title, 18)).join('；')}（先反思再改，别当成已完成）`)
  }

  if (progress.total > 0) {
    const stage = `阶段 ${progress.done}/${progress.total} · ${progress.percent}%`
    const currentPhase = progress.current ? `（当前：${clip(progress.current, 16)}）` : ''
    const title = plan.title ? `「${clip(plan.title, 16)}」` : ''
    const goals = progress.goals > 0 ? `｜目标 ${progress.goalsDone}/${progress.goals}` : ''
    lines.push(`- 长期${title}：${stage}${currentPhase}${goals}`)
  } else if (progress.goals > 0) {
    lines.push(`- 目标：${clip(plan.goals.map((goal) => goal.text).join('、'), lineMax)}`)
  }

  if (counts.shelved > 0) lines.push(`- 搁置（${counts.shelved}）：${clip((note.tasks.find((t) => t.state === 'shelved') || {}).title, 24)} 等`)

  // Every line is bounded to `lineMax`: a prompt block must never grow with the
  // note, whatever the user typed into it.
  return [header, ...lines.map((line) => clip(line, lineMax))].slice(0, maxLines).join('\n')
}

/** Tool-facing listing: includes ids so the model can update or complete tasks. */
export function readText(note, sessionId) {
  const counts = countsOf(note)
  const progress = progressOf(note?.plan)
  const out = []
  out.push(`Todo note · session ${clip(sessionId, 12)} · v${note?.version ?? 0}`)
  out.push(`focus: now=${note?.focus?.current ? JSON.stringify(note.focus.current) : '—'} | next=${note?.focus?.next ? JSON.stringify(note.focus.next) : '—'}`)

  const group = (label, state) => {
    const items = (note?.tasks ?? []).filter((task) => task.state === state)
    if (items.length === 0) return
    out.push(`${label} (${items.length}):`)
    for (const task of items.slice(0, 12)) {
      const flag = task.state === 'awaiting' ? ', awaiting user confirm' : task.rejects > 0 ? `, rejected by user ×${task.rejects} — reflect before retrying` : ''
      out.push(`- [${task.id}] ${task.title}${task.note ? ` — ${task.note}` : ''} (${task.by}${flag})`)
    }
    if (items.length > 12) out.push(`- … ${items.length - 12} more`)
  }
  group('active', 'active')
  group('awaiting user confirm', 'awaiting')
  group('shelved', 'shelved')

  if (progress.total > 0 || note?.plan?.goals?.length) {
    out.push(`plan${note?.plan?.title ? ` "${note.plan.title}"` : ''}: ${progress.done}/${progress.total} phases · ${progress.percent}%${progress.current ? ` · current: ${progress.current}` : ''}${progress.goals ? ` · goals ${progress.goalsDone}/${progress.goals}` : ''}`)
    for (const phase of note?.plan?.phases ?? []) {
      out.push(`- [${phase.status}] ${phase.title} (weight ${phase.weight})`)
    }
    for (const goal of note?.plan?.goals ?? []) {
      out.push(`- ${goal.done ? '[x]' : '[ ]'} goal: ${goal.text}`)
    }
  }
  if (note?.log?.length) out.push(`recently done: ${note.log.slice(0, 5).map((entry) => entry.title).join(' | ')}`)
  if (counts.total === 0 && progress.total === 0 && !note?.log?.length) {
    out.push('(empty — nothing recorded for this session yet)')
  }
  return out.join('\n')
}

/** Drop the least recently touched sessions, keeping `max`. */
export function pruneStore(store, max = LIMITS.sessions) {
  const entries = Object.entries(store.sessions ?? {})
  if (entries.length <= max) return 0
  entries.sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0))
  const keep = new Set(entries.slice(0, max).map(([id]) => id))
  let removed = 0
  for (const id of Object.keys(store.sessions)) {
    if (!keep.has(id)) {
      delete store.sessions[id]
      removed += 1
    }
  }
  return removed
}
