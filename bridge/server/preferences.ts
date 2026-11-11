import { z } from 'zod'
import { JsonStore } from './storage.ts'
import { defaultPreferences, type Preferences, type SessionOptions } from '../shared/types.ts'

export const sessionOptionsSchema = z.object({ model: z.string().max(200), effort: z.string().max(64),
  mode: z.enum(['workspace-write', 'read-only', 'danger-full-access']), approvalPolicy: z.enum(['on-request', 'untrusted', 'never']), collaborationMode: z.enum(['default', 'plan']).optional() }).strict()
export const preferencesSchema = sessionOptionsSchema.extend({ theme: z.enum(['dark', 'light', 'system']),
  fontSize: z.number().int().min(14).max(22), uiFontSize: z.number().int().min(12).max(18), animations: z.boolean(),
  sendKey: z.enum(['enter', 'mod-enter']), codeWrap: z.boolean(), showInspector: z.boolean(), genui: z.boolean().default(true), showActivityDetails: z.boolean().default(true) }).strict()
const schema = z.object({ preferences: preferencesSchema, sessions: z.record(sessionOptionsSchema),
  disabledSkills: z.array(z.string()).default([]),
  skillUsage: z.record(z.object({ uses: z.number(), lastUsed: z.number() })) })
export class PreferencesStore {
  store: JsonStore<z.infer<typeof schema>>
  constructor(file: string) { this.store = new JsonStore(file, { preferences: defaultPreferences, sessions: {}, skillUsage: {}, disabledSkills: [] }, value => schema.parse(value)) }
  async disabledSkills() { return (await this.store.read()).disabledSkills }
  async setSkill(path: string, enabled: boolean) { await this.store.update(data => { data.disabledSkills = [...new Set(enabled ? data.disabledSkills.filter(value => value !== path) : [...data.disabledSkills, path])] }) }
  async snapshot() { const data = await this.store.read(); return { preferences: data.preferences, sessionOptions: data.sessions } }
  async update(patch: Partial<Preferences>) { await this.store.update(data => { const next = { ...data.preferences, ...patch }; if (next.mode === 'danger-full-access') next.approvalPolicy = 'never'; data.preferences = preferencesSchema.parse(next) }); return this.snapshot() }
  async options(id?: string): Promise<SessionOptions> {
    const data = await this.store.read(); return id && data.sessions[id] ? data.sessions[id] : sessionOptionsSchema.parse({ model: data.preferences.model, effort: data.preferences.effort, mode: data.preferences.mode, approvalPolicy: data.preferences.approvalPolicy })
  }
  async setOptions(id: string, value: SessionOptions) { await this.store.update(data => { data.sessions[id] = sessionOptionsSchema.parse(value.mode === 'danger-full-access' ? { ...value, approvalPolicy: 'never' } : value) }) }
  async patchOptions(id: string, patch: Partial<SessionOptions>) {
    await this.store.update(data => {
      const defaults = { model: data.preferences.model, effort: data.preferences.effort, mode: data.preferences.mode, approvalPolicy: data.preferences.approvalPolicy }
      const next = { ...(data.sessions[id] || defaults), ...patch }
      if (next.mode === 'danger-full-access') next.approvalPolicy = 'never'
      data.sessions[id] = sessionOptionsSchema.parse(next)
    })
    return this.snapshot()
  }
  async skillUsage() { return (await this.store.read()).skillUsage }
  async recordSkills(paths: string[]) { if (paths.length) await this.store.update(data => { for (const path of paths) data.skillUsage[path] = { uses: (data.skillUsage[path]?.uses || 0) + 1, lastUsed: Date.now() } }) }
}
