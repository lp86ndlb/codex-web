import type { ActivityView, ThreadPatch, ThreadView } from '../shared/types.ts'
import { pendingChoiceMessage } from '../shared/choices.ts'

/** Background badges and notices never need tool output, diffs or old runs. */
export function observeActivity(previous: Record<string, ActivityView>, value: ThreadView | ThreadPatch): Record<string, ActivityView> {
  const old = previous[value.id]
  if (old && (old.revision > value.revision || old.revision === value.revision && 'changes' in value)) return previous
  const change = 'changes' in value ? value.changes : value
  const runs = change.runs === undefined ? old?.runs : change.runs?.slice(-1)
  const choicePending = change.choicePending ?? old?.choicePending
  const next: ActivityView = {
    id: value.id, revision: value.revision, title: change.title ?? old?.title ?? '', cwd: change.cwd ?? old?.cwd ?? '',
    status: change.status ?? old?.status, updatedAt: change.updatedAt ?? old?.updatedAt ?? 0,
    statusUpdatedAt: change.status === undefined ? old?.statusUpdatedAt : change.updatedAt ?? old?.updatedAt ?? 0,
    turnId: change.turnId === undefined ? old?.turnId ?? null : change.turnId,
    choicePending, externalOwner: change.externalOwner === undefined ? old?.externalOwner : change.externalOwner,
    compacting: change.compacting === undefined ? old?.compacting : Boolean(change.compacting),
    runs, choiceId: choicePending ? pendingChoiceMessage(value.items)?.id || old?.choiceId : undefined,
  }
  // Ignore output-only revisions: only these small fields affect the sidebar.
  if (old && Object.keys(next).every(key => key === 'revision' || (key === 'runs'
    ? next.runs?.at(-1)?.id === old.runs?.at(-1)?.id && next.runs?.at(-1)?.completedAt === old.runs?.at(-1)?.completedAt
    : next[key as keyof ActivityView] === old[key as keyof ActivityView]))) return previous
  return { ...previous, [value.id]: next }
}

/** Evict browser copies only. Native history and saved drafts are untouched. */
export function retainThreadViews(views: Record<string, ThreadView>, protectedIds: Set<string>, recent: string[], limit = 4) {
  const keep = new Set([...protectedIds].filter(id => views[id]))
  for (const id of [...recent].reverse()) { if (keep.size >= limit) break; if (views[id]) keep.add(id) }
  for (const id of Object.keys(views).reverse()) { if (keep.size >= limit) break; keep.add(id) }
  return Object.keys(views).every(id => keep.has(id)) ? views : Object.fromEntries(Object.entries(views).filter(([id]) => keep.has(id)))
}
