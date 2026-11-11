import type { ActivityCollapseTiming, Item, ThreadView } from './types.ts'

/** Resolve details from the complete transcript, rather than its visible page.
 * A delivered human message starts a segment, including steering in one native
 * turn. Pending input and autonomous continuations do not start a segment. */
export function activityExpansion(items: readonly Item[], thread: Pick<ThreadView, 'turnId' | 'status' | 'runs'> | undefined, expanded: boolean, timing: ActivityCollapseTiming): Map<string, boolean> {
  const pendingDuringRun = (item: Item) => item.status === 'sending' && Boolean(thread?.turnId)
  const interactions = new Map<string, string>()
  let latest = 'initial'
  for (const item of items) {
    if (item.type === 'userMessage' && item.status !== 'failed' && !pendingDuringRun(item)) latest = item.id
    interactions.set(item.id, latest)
  }
  const active = new Set(thread?.turnId ? [thread.turnId] : thread?.status === 'inProgress' ? (thread.runs || []).filter(run => run.status === 'inProgress').map(run => run.id) : [])
  const unsuccessful = new Set((thread?.runs || []).filter(run => ['failed', 'interrupted'].includes(run.status)).map(run => run.id))
  if (thread?.turnId) active.add(thread.turnId)
  const lastTurn = thread?.runs?.at(-1)?.id || items.findLast(item => item.turnId)?.turnId
  if (lastTurn && ['failed', 'interrupted'].includes(thread?.status || '')) unsuccessful.add(lastTurn)
  return new Map(items.map(item => {
    const current = interactions.get(item.id) === latest
    const activeTurn = item.turnId ? active.has(item.turnId) : thread?.status === 'inProgress'
    // Completed work before steering may fold, while an actual outstanding
    // operation remains visible until it settles, even in that older segment.
    const running = activeTurn && (current || item.status === 'inProgress')
    const failed = current && (item.turnId ? unsuccessful.has(item.turnId) : ['failed', 'interrupted'].includes(thread?.status || ''))
    return [item.id, expanded && (timing === 'never' || running || failed || timing === 'next-input' && current)]
  }))
}
