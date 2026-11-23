import assert from 'node:assert/strict'
import test from 'node:test'
import { projectItem } from '../server/projection.ts'
import { classifyConversation, projectConversation, teamReceiptIndex } from '../client/team-transcript.ts'
import type { TeamMessage } from '../shared/team.ts'
import type { Item } from '../shared/types.ts'

const uuid = '33cd6af3-130f-4656-894f-02d02968d592'
const review = '7506b971-be70-4a1b-81e1-99f926cebaa2'
const row: TeamMessage = {
  from: 'lead', to: 'worker', kind: 'task', title: '核对尺寸', body: '请核对表格中的尺寸。', id: uuid, requestKey: 'request',
  version: 1, graphVersion: 1, digest: 'sum', deliveryId: 'native', state: 'delivered', policy: 'manual',
  createdAt: 1000, updatedAt: 12000, audit: [{ action: 'sending', at: 11000, actor: 'system' }],
  reviews: [{ reviewerId: 'manager', id: review, deliveryId: 'native-review', batchId: 'review-batch', digest: 'sum', kind: 'supervisor', state: 'approved' }],
}
const item = (id: string, type = 'userMessage', turnId = id, text = id, timestamp = 11000): Item => ({ id, type, turnId, text, timestamp, status: 'completed' })
const message = `[团队通信 · 已批准投递]\n主管 → 成员\n类型：task · 消息 ID：${uuid}\n发件 thread ID：lead\n标题：核对尺寸\n\n${row.body}\n\n结束后不轮询。`
const approval = `[团队审核 · 仅审核，不执行任务 · 共 1 项]\n标题：核对尺寸\n来源：lead\n接收方：worker\n审核类型：风险判断\nmessageId=${uuid}，reviewId=${review}，digest=sum\n<待审正文>\n${row.body}\n</待审正文>`
const ids = (items: Item[]) => items.map(item => item.id)

test('native deliveries and their replies can be hidden together, stopping at a personal steer in the same turn', () => {
  const index = teamReceiptIndex([row, { ...row, id: 'other', batchId: 'batch' }], 'worker')
  const items = [item('personal'), item('native'), item('tool', 'tool', 'native'), item('batch'), item('team-reply', 'agentMessage', 'batch'),
    item('steer', 'userMessage', 'batch', message), item('my-reply', 'agentMessage', 'batch')]
  const source = classifyConversation(items, index)
  assert.deepEqual([...source.team], ['native', 'tool', 'batch', 'team-reply'])
  assert.deepEqual(ids(projectConversation(items, source, 'hide')), ['personal', 'steer', 'my-reply'])
  assert.equal(projectConversation(items, source, 'show'), items)
})

test('verified legacy envelopes survive late or missing clocks; quotations and other recipients remain personal', () => {
  const items = [item('legacy', undefined, undefined, message), item('late', undefined, undefined, message, row.updatedAt + 2030),
    { ...item('no-clock', undefined, undefined, message), timestamp: undefined },
    item('quoted', undefined, undefined, '请解释：\n' + message), item('amended', undefined, undefined, message + '\n我的问题是什么？'),
    item('altered-body', undefined, undefined, message.replace(row.body, '不同的正文')), item('unknown'),
    item('old-review', undefined, undefined, approval), item('wrong-review', undefined, undefined, approval.replace('digest=sum','digest=other')), item('review-batch')]
  assert.deepEqual([...classifyConversation(items, teamReceiptIndex([row], 'worker')).team], ['legacy', 'late', 'no-clock'])
  assert.deepEqual([...classifyConversation(items, teamReceiptIndex([row], 'manager')).team], ['old-review', 'review-batch'])
  assert.equal(classifyConversation(items, teamReceiptIndex([row], 'lead')).team.size, 0)
  assert.equal(classifyConversation(items, teamReceiptIndex([{ ...row, state: 'pending' }], 'worker')).team.size, 0)
})

test('CLI-assigned item ID and sender-provided client ID remain distinct even when a person copies a delivery', () => {
  const native = (id: string, clientId: string) => projectItem({ type: 'userMessage', id, clientId, content: [{ type: 'text', text: message }] })
  const items = [native('original', 'native'), native('personal-copy', 'human-client')]
  const sources = classifyConversation(items, teamReceiptIndex([row], 'worker'))
  assert.deepEqual(ids(projectConversation(items, sources, 'hide')), ['personal-copy'])
  assert.deepEqual([...sources.team], ['original'])
})
