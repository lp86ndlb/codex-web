import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { JsonStore } from './storage.ts'
import { BridgeError, record } from './errors.ts'
import { processGenuiSpec, partialRepairGenuiSpec } from '../plugins/genui/client/guard.ts'
import type { GenuiPanelInfo } from '../shared/types.ts'

export const genuiSkillPath = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins/genui/SKILL.md')
export const genuiInstructions = `GenUI is built into this cweb host. For interactive or visual answers, read the skill at ${genuiSkillPath} and emit a dsh-ui JSON fence in the assistant body. The browser renders that fence directly, including in older sessions without render_ui. Example: {"title":"Overview","items":[{"type":"text","content":"A short explanation"},{"type":"input","id":"name","label":"Name"}]}. Match the user's language. If render_ui is available it can update a persistent panel. Do not require missing tools. Do not use UI for simple one-line replies. [genui-action] messages are interactions with an existing UI.`
export const genuiTool = { type: 'function', name: 'render_ui', description: 'Render an interactive GenUI card or update the session panel. Use the genui skill for the dsh-ui specification. Pass a JSON spec object; never executable JavaScript.', inputSchema: { type: 'object', properties: { spec: { type: 'object', properties: { title: { type: 'string' }, panel: { type: 'boolean' }, items: { type: 'array', items: { type: 'object' } } } } }, required: ['spec'], additionalProperties: false } }
export const genuiValidateTool = { type: 'function', name: 'validate_dsh_ui', description: 'Validate a dsh-ui spec before emitting a complex interface. Returns resource-limit and schema diagnostics and the next action.', inputSchema: { type: 'object', properties: { spec: { anyOf: [{ type: 'string' }, { type: 'object' }] } }, required: ['spec'], additionalProperties: false } }
const schema = z.object({ panels: z.array(z.object({ id: z.string(), title: z.string(), spec: z.unknown(), updatedAt: z.number() })).max(12) })
export class GenuiStore {
  private stores = new Map<string, JsonStore<z.infer<typeof schema>>>()
  directory: string
  constructor(directory: string) { this.directory = directory }
  private store(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new BridgeError('THREAD_ID', '会话编号无效')
    let store = this.stores.get(id)
    if (!store) { store = new JsonStore(resolve(this.directory, id + '.json'), { panels: [] }, value => schema.parse(value)); this.stores.set(id, store) }
    return store
  }
  async get(id: string): Promise<GenuiPanelInfo[]> { return (await this.store(id).read()).panels.map(row => ({ ...row, spec: row.spec })) }
  validate(args: unknown) {
    const raw = record(args).spec
    if (JSON.stringify(raw || {}).length > 200_000) return '[genui-validation]\n{"status":"invalid","next":"fix_and_revalidate","errors":["spec exceeds 200000 characters"]}\n[/genui-validation]'
    let spec = raw
    try { if (typeof raw === 'string') spec = JSON.parse(raw) }
    catch { return '[genui-validation]\n{"status":"invalid","next":"fix_and_revalidate","errors":["Invalid JSON"]}\n[/genui-validation]' }
    const result = processGenuiSpec(spec, { deferPanelReferences: true })
    return `[genui-validation]\n${JSON.stringify({ status: result.errors.length ? 'invalid' : 'valid', next: result.errors.length ? 'fix_and_revalidate' : 'emit_fence', errors: result.errors, warnings: result.warnings, reply_language: 'conversation' })}\n[/genui-validation]`
  }
  async render(id: string, args: unknown) {
    const spec = record(args).spec
    if (JSON.stringify(spec || {}).length > 200_000) throw new BridgeError('GENUI_SIZE', 'GenUI 规格过大，请拆分为多个卡片')
    const result = processGenuiSpec(spec, { deferPanelReferences: true }); const repaired = partialRepairGenuiSpec(result)
    if (!repaired?.items?.length) throw new BridgeError('GENUI_SPEC', '未找到可渲染的组件，请按 genui Skill 提供合法的 spec.items')
    const value = { id: typeof record(spec).id === 'string' ? String(record(spec).id).slice(0, 80) : 'default', title: repaired.title || '交互面板', spec: repaired, updatedAt: Date.now() }
    await this.store(id).update(data => { data.panels = [...data.panels.filter(row => row.id !== value.id), value].slice(-12) })
    return { panels: await this.get(id), message: `已呈现“${value.title}”，交互事件会以 [genui-action] 返回当前会话。` }
  }
  async capture(id: string, text: string) {
    const pattern = /```\s*dsh-ui[^\n]*\n([\s\S]*?)\n```/gi
    for (const match of text.matchAll(pattern)) {
      try { const spec = JSON.parse(match[1]); if (spec.panel === true) await this.render(id, { spec }) } catch { /* Partial or invalid fences stay visible in the transcript. */ }
    }
    return this.get(id)
  }
}
