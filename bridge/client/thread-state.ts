import type { ThreadView, ThreadPatch } from '../shared/types.ts'
import { hasPendingChoice } from '../shared/choices.ts'
export function mergeView(previous: Record<string, ThreadView>, value: ThreadView) {
  const old = previous[value.id]
  if (old && old.revision >= value.revision) return previous
  if (old) {
    const byId = new Map(old.items.map(item => [item.id, item]))
    value.items = value.items.map(item => { const known = byId.get(item.id); return known && JSON.stringify(known) === JSON.stringify(item) ? known : item })
  }
  return { ...previous, [value.id]: { ...value, choicePending: hasPendingChoice(value.items) } }
}
export function applyThreadPatch(previous: Record<string, ThreadView>, patch: ThreadPatch) {
  const old = previous[patch.id]
  if (!old || old.revision >= patch.revision || old.revision !== patch.baseRevision) return previous
  const changed = new Map(patch.items.map(item => [item.id, item]))
  const known = new Map(old.items.map(item => [item.id, item]))
  const items = patch.order ? patch.order.map(id => changed.get(id) || known.get(id)!).filter(Boolean) : old.items.map(item => changed.get(item.id) || item)
  return { ...previous, [patch.id]: { ...old, ...patch.changes, revision: patch.revision, items, choicePending: hasPendingChoice(items) } }
}
