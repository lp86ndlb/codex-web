import { resolve } from 'node:path'
import { z } from 'zod'
import type { RunMetrics, ThreadView } from '../shared/types.ts'
import { JsonStore } from './storage.ts'
import { record, string } from './errors.ts'

const runSchema = z.object({ id: z.string(), status: z.string(), startedAt: z.number().optional(), completedAt: z.number().optional(), durationMs: z.number().optional(), tokenBase: z.number().optional(), tokens: z.number().optional(), observed: z.boolean().optional(), quota: z.object({ capturedAt: z.number(), windows: z.array(z.object({ name: z.string(), change: z.number() })) }).optional() })
const schema = z.object({ runs: z.array(runSchema), times: z.record(z.object({ timestamp: z.number(), timeSource: z.enum(['native', 'turn', 'observed']) })), totalTokens: z.number(), tokenUsageKnown: z.boolean(), lastTurnId: z.string() })

/** Only observed metadata is stored here. Codex remains the history authority. */
export class RunHistory {
  private stores = new Map<string, JsonStore<z.infer<typeof schema>>>()
  private directory: string
  constructor(directory: string) { this.directory = directory }
  private store(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('Invalid thread id')
    let store = this.stores.get(id)
    if (!store) { store = new JsonStore(resolve(this.directory, `${id}.json`), { runs: [], times: {}, totalTokens: 0, tokenUsageKnown: false, lastTurnId: '' }, value => schema.parse(value)); this.stores.set(id, store) }
    return store
  }
  async enrich(thread: ThreadView) {
    const saved = await this.store(thread.id).read(); const runs = new Map(saved.runs.map(run => [run.id, run]))
    thread.runs = thread.runs?.map(run => ({ ...runs.get(run.id), ...run }))
    thread.items = thread.items.map(item => {
      const known = saved.times[item.id]
      return known && (!item.timestamp || item.timeSource === 'turn') ? { ...item, ...known } : item
    })
    if (!thread.turnId && thread.runs?.at(-1)?.id === saved.lastTurnId && saved.tokenUsageKnown) { thread.tokens = saved.totalTokens; thread.tokenUsageKnown = true }
    return thread
  }
  async save(thread: ThreadView) {
    const runs = structuredClone((thread.runs || []).slice(-1000)); const times: z.infer<typeof schema>['times'] = {}
    for (const item of thread.items.slice(-20_000)) if (item.timestamp && item.timeSource && ['userMessage', 'agentMessage'].includes(item.type)) times[item.id] = { timestamp: item.timestamp, timeSource: item.timeSource }
    await this.store(thread.id).update(data => { data.runs = runs; data.times = times; data.totalTokens = thread.tokens; data.tokenUsageKnown = Boolean(thread.tokenUsageKnown); data.lastTurnId = runs.at(-1)?.id || '' })
  }
  async flush() { await Promise.all([...this.stores.values()].map(store => store.read())) }
}

export interface QuotaSnapshot { at: number; windows: { key: string; name: string; used: number; reset: unknown }[] }
export function quotaSnapshot(value: unknown): QuotaSnapshot {
  const raw = record(value); const byId = Object.entries(record(raw.rateLimitsByLimitId))
  const rows = byId.length ? byId : raw.rateLimits ? [['codex', raw.rateLimits] as const] : []
  return { at: Date.now(), windows: rows.flatMap(([key, value]) => ['primary', 'secondary'].flatMap(window => {
    const row = record(value); const usage = record(row[window]); const used = usage.usedPercent
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return []
    const minutes = typeof usage.windowDurationMins === 'number' ? usage.windowDurationMins : 0
    const name = minutes >= 1440 ? `${Math.round(minutes / 1440)} 天` : minutes >= 60 ? `${Math.round(minutes / 60)} 小时` : minutes ? `${minutes} 分钟` : window === 'primary' ? '主要窗口' : '次要窗口'
    return [{ key: `${key}:${window}:${minutes}`, name: `${string(row.limitName) || string(row.limitId) || 'Codex'} · ${name}`, used, reset: usage.resetsAt }]
  })) }
}
export function quotaChange(before: QuotaSnapshot | undefined, after: QuotaSnapshot | undefined): RunMetrics['quota'] {
  if (!before || !after) return undefined
  const windows = before.windows.flatMap(row => {
    const end = after.windows.find(value => value.key === row.key && value.reset === row.reset)
    return end && end.used >= row.used ? [{ name: row.name, change: Math.round((end.used - row.used) * 100) / 100 }] : []
  })
  return windows.length ? { windows, capturedAt: after.at } : undefined
}
