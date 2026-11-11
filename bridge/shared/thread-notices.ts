import type { Approval, ThreadSummary, ThreadView } from './types.ts'
import { pendingChoiceMessage } from './choices.ts'

export interface ThreadActivity { id: string; title: string; cwd: string; status: string; attention: boolean; updatedAt: number; turn: string; loaded?: boolean; fresh?: boolean; attentionKey?: string }
export interface ThreadNotice extends ThreadActivity { kind: 'waiting' | 'completed'; key: string }
export function threadActivity(threads: ThreadSummary[], views: Record<string, ThreadView>, approvals: Approval[]): Map<string, ThreadActivity> {
  const pending = new Map<string, string[]>()
  for (const approval of approvals) pending.set(approval.threadId, [...(pending.get(approval.threadId) || []), `${approval.id}:${approval.questions.map(q => q.id + ':' + q.question).join('|')}`])
  const ids = new Set([...threads.map(row => row.id), ...Object.keys(views), ...pending.keys()])
  const summaries = new Map(threads.map(row => [row.id, row]))
  return new Map([...ids].map(id => {
    const view = views[id]; const summary = summaries.get(id)
    const summaryAttention = summary?.attention && (!view || summary.updatedAt >= view.updatedAt)
    const choice = view?.choicePending ? `choice:${pendingChoiceMessage(view.items || [])?.id || ''}` : ''
    const attentionKey = pending.get(id)?.sort().join(';') || choice || (summaryAttention ? 'summary' : '')
    return [id, { id, title: view?.title || summary?.title || '会话', cwd: view?.cwd || summary?.cwd || '', status: summary && (!view || summary.updatedAt > view.updatedAt) ? summary.status || view?.status || 'idle' : view?.status || summary?.status || 'idle', attention: Boolean(attentionKey), attentionKey, updatedAt: Math.max(view?.updatedAt || 0, summary?.updatedAt || 0), turn: view?.turnId || view?.runs?.at(-1)?.id || '', loaded: Boolean(view) }]
  }))
}
export function newThreadNotices(previous: Map<string, ThreadActivity>, current: Map<string, ThreadActivity>): ThreadNotice[] {
  const result: ThreadNotice[] = []
  for (const row of current.values()) {
    const old = previous.get(row.id)
    const newQuestion = row.attention && (!old?.attention || Boolean(old.attentionKey && old.attentionKey !== 'summary' && row.attentionKey && row.attentionKey !== old.attentionKey) || Boolean(old.turn && row.turn && old.turn !== row.turn))
    const newTurnFinished = Boolean(old?.loaded && row.turn && row.turn !== old.turn)
    const completed = !row.attention && row.status === 'completed' && ((!old && row.fresh) || old && (newTurnFinished || old.attention || old.status === 'inProgress' || (old.status !== 'completed' && row.updatedAt > old.updatedAt)))
    const kind = newQuestion ? 'waiting' : completed ? 'completed' : null
    if (kind) result.push({ ...row, kind, key: `${row.id}:${kind}:${kind === 'waiting' ? row.attentionKey || row.turn || row.updatedAt : row.turn || row.updatedAt}` })
  }
  return result
}
