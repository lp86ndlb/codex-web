import { resolve } from 'node:path'
import { z } from 'zod'
// This vendored model is deliberately shared with the original plugin.
// @ts-expect-error Upstream is dependency-free JavaScript.
import { applyAction, emptyNote, isLinked, normalizeNote, readText, renderLiveSection } from '../plugins/todo-note/upstream/model.js'
// @ts-expect-error Verbatim upstream usage guide.
import { GUIDE } from '../plugins/todo-note/guide.js'
import { JsonStore } from './storage.ts'
import { BridgeError } from './errors.ts'

type Note = ReturnType<typeof emptyNote>
const text = z.string().max(500)
const taskFields = { title: text.optional(), note: text.optional(), state: z.enum(['active', 'shelved']).optional(), phase: text.optional() }
const updateSchema = z.object({
  focus: z.object({ current: text.optional(), next: text.optional() }).strict().optional(),
  add_tasks: z.array(z.object({ ...taskFields, title: text.min(1) }).strict()).max(200).optional(),
  update_tasks: z.array(z.object({ ...taskFields, id: text.min(1) }).strict()).max(200).optional(),
  remove_tasks: z.array(text).max(200).optional(),
  move_task: z.object({ id: text, beforeId: text.nullable().optional() }).strict().optional(),
  set_plan: z.object({ title: text.optional(), goals: z.array(z.union([text, z.object({ text, done: z.boolean().optional() }).strict()])).max(20).optional(),
    phases: z.array(z.object({ title: text, status: z.enum(['todo', 'active', 'paused', 'done']).optional(), weight: z.number().optional() }).strict()).max(30).optional() }).strict().optional(),
}).strict()
const field = { type: 'string' }
const taskProps = { title: field, note: field, state: { type: 'string', enum: ['active', 'shelved'] }, phase: field }
const object = (properties: object, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const list = (items: object) => ({ type: 'array', items })

export const todoTools = [
  { type: 'function', name: 'todo_note_read', description: 'Read the session sticky note: current focus, tasks, plan and user feedback.', inputSchema: object({}) },
  { type: 'function', name: 'todo_note_update', description: 'Update the shared sticky note. Tasks are concrete actions; set_plan replaces the supplied lists. Do not remove completed tasks: use todo_note_complete so the user can confirm.', inputSchema: object({
    focus: object({ current: field, next: field }), add_tasks: list(object(taskProps, ['title'])),
    update_tasks: list(object({ ...taskProps, id: field }, ['id'])), remove_tasks: list(field),
    move_task: object({ id: field, beforeId: { type: ['string', 'null'] } }, ['id']),
    set_plan: object({ title: field, goals: list({ anyOf: [field, object({ text: field, done: { type: 'boolean' } }, ['text'])] }),
      phases: list(object({ title: field, status: { type: 'string', enum: ['todo', 'active', 'paused', 'done'] }, weight: { type: 'number' } }, ['title'])) }),
  }) },
  { type: 'function', name: 'todo_note_complete', description: 'Submit verified work for human confirmation. Only the user confirms or rejects. After a rejection, note must describe the improvement and new verification.', inputSchema: object({ id: field, note: field }, ['id']) },
]

export class TodoNotePlugin {
  private settings: JsonStore<{ enabled: boolean; linkedThreads: string[] }>
  private notes = new Map<string, JsonStore<{ note: Note }>>()
  enabled = true
  private directory: string
  constructor(directory: string) {
    this.directory = directory
    this.settings = new JsonStore(resolve(directory, 'plugin.json'), { enabled: true, linkedThreads: [] }, value =>
      z.object({ enabled: z.boolean(), linkedThreads: z.array(z.string()).default([]) }).parse(value))
  }
  async initialize() { this.enabled = (await this.settings.read()).enabled }
  async flush() { await this.settings.read(); await Promise.all([...this.notes.values()].map(store => store.read())) }
  async setEnabled(enabled: boolean) { await this.settings.update(data => { data.enabled = enabled }); this.enabled = enabled }
  async register(id: string) { await this.settings.update(data => { if (!data.linkedThreads.includes(id)) data.linkedThreads.push(id) }) }
  async supportsTools(id: string) { return (await this.settings.read()).linkedThreads.includes(id) }
  private store(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new BridgeError('SESSION_ID', '无效的会话编号')
    let store = this.notes.get(id)
    if (!store) {
      store = new JsonStore(resolve(this.directory, 'sessions', `${id}.json`), { note: emptyNote() }, value => {
        const parsed = z.object({ note: z.record(z.unknown()) }).parse(value)
        return { note: normalizeNote(parsed.note) }
      })
      this.notes.set(id, store)
    }
    return store
  }
  async get(id: string) { return (await this.store(id).read()).note }
  async linked(id: string) { return isLinked(await this.get(id)) }
  async act(id: string, actions: object[]) {
    if (!this.enabled) throw new BridgeError('PLUGIN_DISABLED', '待办便签插件已停用', 409)
    return this.store(id).update(data => {
      for (const action of actions) data.note = applyAction(data.note, action).note
      return data.note
    })
  }
  async context(id: string, mcpServer?: string) {
    const { instructions, snapshot } = await this.contextParts(id, mcpServer)
    return [instructions, snapshot].filter(Boolean).join('\n')
  }
  /** Separate durable tool guidance from the changing note snapshot, so a
   * focus update does not replay the complete instructions into native history. */
  async contextParts(id: string, mcpServer?: string) {
    if (!this.enabled) return { instructions: '', snapshot: '' }
    const note = await this.get(id)
    const native = await this.supportsTools(id)
    if (!native && !mcpServer) return { instructions: '本会话的待办便签快照（待办工具尚未接入，用户可在便签中手动维护；不要尝试调用缺失的工具）：', snapshot: renderLiveSection(note, { nudge: false }) }
    const guide = native ? GUIDE : `The following tools are available only when listed in the current cweb session. If this conversation is resumed elsewhere and they are absent, do not attempt to call them. Earlier references to todo_note_* mean the matching MCP tools below.\n\n${GUIDE.replace(/\btodo_note_(read|update|complete)\b/g, `mcp__${mcpServer}__todo_note_$1`)}`
    const rejected = note.tasks.filter((task: { state: string; rejects: number }) => task.state === 'active' && task.rejects > 0)
    const awaiting = note.tasks.filter((task: { state: string }) => task.state === 'awaiting')
    const review = rejected.length || awaiting.length ? `\nQuality review reminder: ${rejected.length} rejected task(s), ${awaiting.length} awaiting user acceptance. Unaccepted work is not user-approved. Prioritize concrete feedback, review and improve; never self-confirm.\n${rejected.slice(0, 5).map((task: { title: string; note: string }) => `- Needs improvement: ${task.title}${task.note ? ` · ${task.note}` : ''}`).join('\n')}` : ''
    return { instructions: guide, snapshot: `${renderLiveSection(note)}${review}` }
  }
  async call(id: string, name: string, raw: unknown): Promise<string> {
    if (!this.enabled) throw new BridgeError('PLUGIN_DISABLED', '待办便签已停用')
    if (name === 'todo_note_read') { z.object({}).strict().parse(raw); return readText(await this.get(id), id) }
    const actions: object[] = []
    if (name === 'todo_note_update') {
      const args = updateSchema.parse(raw)
      if (args.focus) actions.push({ type: 'set_focus', ...args.focus })
      for (const task of args.add_tasks || []) actions.push({ type: 'add_task', ...task, by: 'agent' })
      for (const task of args.update_tasks || []) actions.push({ type: 'update_task', ...task })
      for (const taskId of args.remove_tasks || []) actions.push({ type: 'remove_task', id: taskId })
      if (args.move_task) actions.push({ type: 'move_task', ...args.move_task, beforeId: args.move_task.beforeId ?? null })
      if (args.set_plan) actions.push({ type: 'set_plan', ...args.set_plan })
    } else if (name === 'todo_note_complete') {
      const args = z.object({ id: text.min(1), note: text.optional() }).strict().parse(raw)
      const task = (await this.get(id)).tasks.find((task: { id: string }) => task.id === args.id)
      if (task?.rejects > 0 && !args.note?.trim()) throw new BridgeError('REVIEW_REQUIRED', '这个待办被用户标为未通过。请先复核并改进，再在 note 中说明本次修改和验证结果。')
      if (args.note) actions.push({ type: 'update_task', id: args.id, note: args.note })
      actions.push({ type: 'complete_task', id: args.id })
    } else throw new BridgeError('TOOL_UNKNOWN', '未知的便签工具')
    if (!actions.length) throw new BridgeError('EMPTY_UPDATE', '请至少提供一项待办更新')
    return readText(await this.act(id, actions), id)
  }
}
