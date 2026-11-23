import type { Item } from '../shared/types.ts'
import type { TeamMessage } from '../shared/team.ts'

export type TeamDisplay = 'show' | 'hide'

export function readTeamDisplay(workspace: string): TeamDisplay {
  try {
    const value = localStorage.getItem('cweb:team-display:' + workspace)
    // The previous team-only view also displayed team messages.
    if (value === 'show' || value === 'team') return 'show'
  } catch { /* Use the default if browser storage is disabled. */ }
  return 'hide'
}

export function teamReceiptIndex(messages: TeamMessage[], recipient: string) {
  const deliveries = new Map<string, string>(), messagesById = new Map<string, TeamMessage>()
  const reviews = new Map<string, { row: TeamMessage; digest: string }>()
  for (const row of messages) {
    if (row.to === recipient && ['sending', 'delivered', 'uncertain'].includes(row.state)) {
      deliveries.set(row.batchId || row.deliveryId, row.title)
      messagesById.set(row.id, row)
    }
    for (const review of row.reviews) {
      if (review.reviewerId !== recipient || review.state === 'pending') continue
      deliveries.set(review.batchId || review.deliveryId, '审核 · ' + row.title)
      reviews.set(review.id, { row, digest: review.digest })
    }
  }
  return { deliveries, messagesById, reviews }
}

function receiptTitle(item: Item, index: ReturnType<typeof teamReceiptIndex>, firstPrompt: boolean) {
  // A client-provided ID is independent of the item ID assigned by Codex.
  // When present it also distinguishes a person's verbatim copy from a delivery.
  if (item.clientId) return index.deliveries.get(item.clientId)
  const direct = index.deliveries.get(item.id)
  if (direct || !firstPrompt) return direct

  // Older bridges dropped clientId. Check the recipient's ledger and the wire
  // format; CLI replay timestamps can differ from the sending clock.
  const text = item.text
  if (text.startsWith('[团队通信 · ') && text.trimEnd().endsWith('结束后不轮询。')) {
    const header = /^类型：(task|question|result) · 消息 ID：([\da-f-]{36})\n发件 thread ID：([^\n]+)$/m.exec(text)
    const row = header && index.messagesById.get(header[2])
    if (!row || row.kind !== header[1] || row.from !== header[3]) return
    const edited = row.audit.some(event => event.action === 'edited') ? '正文经管理员修改。\n' : ''
    if (text.includes(`\n标题：${row.title}\n${edited}\n${row.body}\n`)) return row.title
  } else if (text.startsWith('[团队审核 · ') && /(?:<\/待审正文>|审核后结束，不另行派发或循环等待。)\s*$/.test(text)) {
    const header = /messageId=([\da-f-]{36})，reviewId=([\da-f-]{36})，digest=([a-zA-Z0-9]+)/.exec(text)
    const review = header && index.reviews.get(header[2])
    if (!review || review.row.id !== header[1] || review.digest !== header[3]) return
    const row = review.row
    if (text.includes(`\n标题：${row.title}\n来源：${row.from}\n接收方：${row.to}\n`) &&
        text.includes(`<待审正文>\n${row.body}\n</待审正文>`)) return '审核 · ' + row.title
  }
}

export function classifyConversation(items: Item[], index: ReturnType<typeof teamReceiptIndex>) {
  const team = new Set<string>(), turns = new Set<string>()
  if (!index.deliveries.size) return { team }
  const seenPrompts = new Set<string>()
  for (const item of items) {
    if (item.type === 'userMessage') {
      const title = receiptTitle(item, index, !item.turnId || !seenPrompts.has(item.turnId))
      if (item.turnId) seenPrompts.add(item.turnId)
      if (title) {
        team.add(item.id)
        if (item.turnId) turns.add(item.turnId)
      } else if (item.turnId) turns.delete(item.turnId)
    } else if (item.turnId && turns.has(item.turnId)) team.add(item.id)
  }
  return { team }
}

export function projectConversation(items: Item[], sources: ReturnType<typeof classifyConversation>, display: TeamDisplay) {
  if (display === 'show' || !sources.team.size) return items
  return items.filter(item => !sources.team.has(item.id))
}
