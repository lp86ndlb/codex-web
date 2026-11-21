import type { ActivityView, ThreadSummary } from './types.ts'

/** Output deltas do not make an older status authoritative. Both the sidebar
 * and notifications use the latest explicitly observed status, without loading
 * the background conversation's history. Equal timestamps favor native events. */
export function threadStatus(summary: ThreadSummary | undefined, view: ActivityView | undefined) {
  if (view?.compacting && view.revision >= 0 && (!summary || view.updatedAt >= summary.updatedAt)) return 'inProgress'
  const statusAt = view?.statusUpdatedAt ?? view?.updatedAt ?? 0
  if (summary?.status && (!view || view.revision < 0 || summary.updatedAt > statusAt)) return summary.status
  return view?.status || summary?.status || 'idle'
}
