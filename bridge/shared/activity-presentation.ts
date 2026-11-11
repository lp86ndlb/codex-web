import type { ActivityCollapseTiming, Item, ThreadView } from './types.ts'

/** Resolve details from the complete transcript, rather than its visible page.
 * A new human turn starts an interaction; steering and background continuations
 * keep the same interaction. This also works when reopening saved history. */
export function activityExpansion(items: readonly Item[], thread: Pick<ThreadView, 'turnId' | 'status' | 'runs'> | undefined, expanded: boolean, timing: ActivityCollapseTiming): Map<string, boolean> {
  const firstInputs = new Map<string, string>()
  const pendingDuringRun = (item: Item) => item.status === 'sending' && Boolean(thread?.turnId)
  for (const item of items) if (item.type === 'userMessage' && item.turnId && !pendingDuringRun(item) && !firstInputs.has(item.turnId)) firstInputs.set(item.turnId, item.id)
  const turns = new Map<string, string>(), interactions = new Map<string, string>()
  let latest = 'initial'
  for (const item of items) {
    if (item.turnId) {
      if (!turns.has(item.turnId)) {
        const input = firstInputs.get(item.turnId)
        if (input) latest = input
        turns.set(item.turnId, latest)
      }
      interactions.set(item.id, turns.get(item.turnId)!)
    } else {
      if (item.type === 'userMessage' && !pendingDuringRun(item)) latest = item.id
      interactions.set(item.id, latest)
    }
  }
  const active = new Set((thread?.runs || []).filter(run => run.status === 'inProgress').map(run => run.id))
  const unsuccessful = new Set((thread?.runs || []).filter(run => ['failed', 'interrupted'].includes(run.status)).map(run => run.id))
  if (thread?.turnId) active.add(thread.turnId)
  const lastTurn = thread?.runs?.at(-1)?.id || items.findLast(item => item.turnId)?.turnId
  if (lastTurn && ['failed', 'interrupted'].includes(thread?.status || '')) unsuccessful.add(lastTurn)
  return new Map(items.map(item => {
    const interaction = interactions.get(item.id)
    const running = item.turnId ? active.has(item.turnId) : thread?.status === 'inProgress' && interaction === latest
    const failed = item.turnId ? unsuccessful.has(item.turnId) : ['failed', 'interrupted'].includes(thread?.status || '') && interaction === latest
    return [item.id, expanded && (timing === 'never' || running || failed || timing === 'next-input' && interaction === latest)]
  }))
}
