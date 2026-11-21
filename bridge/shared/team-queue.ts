import { teamOutstanding, type TeamMessage, type TeamSnapshot } from './team.ts'

export type TeamQueuePhase = 'queued' | 'approval' | 'review' | 'sending' | 'receipt' | 'attention'
export interface TeamQueueRow {
  id: string; messageId: string; kind: 'message' | 'review'; title: string
  fromName: string; toName: string; recipientId: string; status: string; phase: TeamQueuePhase
  reason: string; position?: number; blockedReason?: string
}
export interface TeamQueueView {
  rows: TeamQueueRow[]; paused: boolean
  counts: Record<TeamQueuePhase, number>
}
type QueueState = Pick<TeamSnapshot, 'enabled' | 'members' | 'messages'>
const concise = (text: string | undefined) => (text || '').replace(/\s+/g, ' ').trim()
const states: Record<TeamMessage['state'], { status: string; phase: TeamQueuePhase; reason: string }> = {
  pending: { status: '待你审批', phase: 'approval', reason: '批准后才会进入自动投递队列。' },
  reviewing: { status: '待审核', phase: 'review', reason: '等待所需上级或风险审核通过。' },
  approved: { status: '已批准排队', phase: 'queued', reason: '等待会话空闲后按顺序投递。' },
  waiting: { status: '已批准排队', phase: 'queued', reason: '等待会话空闲后按顺序投递。' },
  sending: { status: '投递中', phase: 'sending', reason: '正在提交消息，尚未确认送达。' },
  uncertain: { status: '核对回执', phase: 'receipt', reason: '投递结果尚未确认，核对前不会重复发送。' },
  delivered: { status: '已送达', phase: 'review', reason: '已交给接收会话，不代表任务已完成。' },
  rejected: { status: '已拒绝', phase: 'attention', reason: '' },
  cancelled: { status: '已取消', phase: 'attention', reason: '' },
}

/** A read-only view of the durable recipient queue. Native run state does not
 * identify which task is executing, so it is intentionally not used here.
 * Preserve persisted message order rather than sorting by last update time. */
export function buildTeamQueue(state: QueueState | null | undefined, threadId?: string): TeamQueueView | null {
  if (!state || !threadId) return null
  const names = new Map(state.members.map(member => [member.threadId, member.name]))
  const rows: TeamQueueRow[] = []
  for (const message of state.messages) {
    const base = { messageId: message.id, title: message.title, fromName: names.get(message.from) || '原发送会话', toName: names.get(message.to) || '原接收会话' }
    if (message.to === threadId && teamOutstanding.has(message.state)) {
      const display = states[message.state]
      rows.push({ ...base, ...display, id: `message:${message.id}`, kind: 'message', recipientId: message.to, reason: concise(message.reason) || display.reason })
    }
    for (const review of message.reviews) {
      if (review.reviewerId !== threadId || !['pending', 'sending', 'sent', 'uncertain', 'needs-user'].includes(review.state)) continue
      // In-flight or uncertain receipts still need attention even if their
      // parent request was cancelled. Other obsolete reviews are not queued.
      if (message.state !== 'reviewing' && !['sending', 'uncertain'].includes(review.state)) continue
      const display = review.state === 'pending' ? { status: '审核排队', phase: 'queued' as const, reason: '等待会话空闲后投递审核请求。' }
        : review.state === 'sending' ? { status: '审核投递中', phase: 'sending' as const, reason: '正在提交审核请求，尚未确认送达。' }
        : review.state === 'sent' ? { status: '待审核', phase: 'review' as const, reason: '审核请求已送达，等待判定。' }
        : review.state === 'uncertain' ? { status: '核对审核回执', phase: 'receipt' as const, reason: '审核投递结果尚未确认，核对前不会重复发送。' }
        : { status: '需继续审核', phase: 'attention' as const, reason: '审核未返回有效结论，请查看审批中的说明。' }
      rows.push({ ...base, ...display, id: `review:${review.id}`, kind: 'review', recipientId: review.reviewerId, reason: concise(review.reason) || display.reason })
    }
  }
  if (!rows.length) return null
  // Sending/unknown receipts block this recipient regardless of their age.
  // A sent review holds later work only while it is ahead in the durable FIFO.
  const receipt = rows.find(row => row.phase === 'receipt'), sending = rows.find(row => row.phase === 'sending')
  let position = 0, awaitingReview = false
  for (const row of rows) {
    if (row.phase === 'queued') {
      row.position = ++position
      row.blockedReason = receipt ? '等待投递回执核对后再继续。' : sending ? '等待当前投递确认后再继续。' : awaitingReview ? '前面的审核尚未返回判定，后续通信继续排队。' : undefined
    }
    if (row.kind === 'review' && row.phase === 'review') awaitingReview = true
  }
  const counts: TeamQueueView['counts'] = { queued: 0, approval: 0, review: 0, sending: 0, receipt: 0, attention: 0 }
  for (const row of rows) counts[row.phase]++
  return { rows, counts, paused: !state.enabled }
}
