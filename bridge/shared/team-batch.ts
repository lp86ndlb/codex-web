import type { TeamMessage, TeamReview } from './team.ts'

export function shouldAutoBatchTeamMessages(rows: readonly TeamMessage[]) {
  return rows.length >= 3 || (rows.length === 2 && rows.every(row => row.kind === 'result'))
}
const maxBatchItems = 8
const maxBatchContent = 30_000

export function isQueuedTeamTask(row: TeamMessage) {
  return row.state === 'approved' || row.state === 'waiting'
}

export function isQueuedTeamReview(review: TeamReview) {
  return review.state === 'pending' || review.state === 'sent'
}

export function nextTeamBatch(messages: TeamMessage[], recipient: string) {
  const rows: TeamMessage[] = []
  let contentSize = 0
  for (const row of messages) {
    // Reviews already ahead in this recipient's queue keep their own turn.
    if (row.state === 'reviewing' && row.reviews.some(review => review.reviewerId === recipient && isQueuedTeamReview(review))) break
    if (row.to !== recipient || !isQueuedTeamTask(row)) continue
    const size = row.title.length + row.body.length
    if (rows.length >= maxBatchItems || contentSize + size > maxBatchContent) break
    rows.push(row)
    contentSize += size
  }
  return rows
}

export function nextTeamReviewBatch(messages: TeamMessage[], reviewerId: string) {
  const items: { row: TeamMessage; review: TeamReview }[] = []
  let contentSize = 0
  for (const row of messages) {
    if (row.to === reviewerId && isQueuedTeamTask(row)) break
    if (row.state !== 'reviewing') continue
    const review = row.reviews.find(review => review.reviewerId === reviewerId && isQueuedTeamReview(review))
    if (!review) continue
    const size = row.title.length + row.body.length
    if (review.state !== 'pending' || items.length >= maxBatchItems || contentSize + size > maxBatchContent) break
    items.push({ row, review })
    contentSize += size
  }
  return items
}
