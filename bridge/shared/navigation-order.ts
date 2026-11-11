import type { ThreadSummary, ThreadView } from './types.ts'
export interface ReadMark { at: number; turn?: string }
export interface NavigationLayout { version: 1; workspaces: string[]; threads: string[]; collapsed: Record<string, boolean>; read: Record<string, ReadMark> }
export const navigationKey = 'cweb:navigation-layout:v1'
export const threadReadEvent = 'cweb:thread-read'
const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length <= 200))].slice(0, 10_000) : []
export function readNavigation(raw: string | null): NavigationLayout {
  try {
    const value = JSON.parse(raw || '{}')
    const read: Record<string, ReadMark> = {}
    for (const [id, raw] of Object.entries(value.read || {}).slice(-10_000)) { const mark = raw as ReadMark; if (id.length <= 200 && mark && Number.isFinite(mark.at)) read[id] = { at: mark.at, ...(typeof mark.turn === 'string' ? { turn: mark.turn } : {}) } }
    return { version: 1, workspaces: ids(value.workspaces), threads: ids(value.threads), collapsed: Object.fromEntries(Object.entries(value.collapsed || {}).filter(([key, value]) => key.length <= 200 && typeof value === 'boolean').map(([key, value]) => [key, value as boolean])), read }
  } catch { return { version: 1, workspaces: [], threads: [], collapsed: {}, read: {} } }
}
export function unreadCompletion(summary: ThreadSummary, view: ThreadView | undefined, mark: ReadMark | undefined) {
  if (!mark) return true
  const run = view?.runs?.at(-1)
  // A click can precede hydration of the completed run. Its recorded completion
  // time is authoritative even when the click still saw the previous turn id.
  if (run?.completedAt) return run.completedAt > mark.at
  if (run?.id && mark.turn) return run.id !== mark.turn
  return Math.max(summary.updatedAt, view?.updatedAt || 0) * 1000 > mark.at
}
export function appendNavigation(order: string[], available: string[]) {
  const known = new Set(order); const added = available.filter(id => !known.has(id))
  return added.length ? [...order, ...new Set(added)] : order
}
export function orderedNavigation<T extends { id: string }>(rows: T[], order: string[]): T[] {
  const positions = new Map(order.map((id, index) => [id, index]))
  return [...rows].sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity))
}
/** Same before-id contract as the todo plugin; unrelated ids keep their order. */
export function moveNavigation(order: string[], id: string, before: string | null) {
  if (!order.includes(id) || id === before || before !== null && !order.includes(before)) return order
  const rest = order.filter(value => value !== id)
  rest.splice(before === null ? rest.length : rest.indexOf(before), 0, id)
  return rest.every((value, index) => value === order[index]) ? order : rest
}
