import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TeamService } from '../server/team.ts'
import type { TeamMessage, TeamPolicy } from '../shared/team.ts'

async function fixture(t: { after: (fn: () => Promise<void>) => void }, policy: TeamPolicy) {
  const root = await mkdtemp(join(tmpdir(), 'cweb-envelope-'))
  const sent: { row: TeamMessage; text: string; purpose?: string }[] = [], busy = new Set<string>()
  const team = new TeamService(join(root, 'team.json'), {
    available: async member => busy.has(member.threadId) ? 'busy' : null,
    send: async (row, text, purpose) => { sent.push({ row, text, purpose }); busy.add(row.to) },
    receipt: async () => 'unknown', changed: () => {},
  })
  t.after(async () => { await team.close(); await rm(root, { recursive: true, force: true }) })
  await team.register({ threadId: 'lead', name: '负责人', role: 'lead', cwd: '/fixture' })
  await team.register({ threadId: 'manager', name: '项目主管', role: 'manager', cwd: '/fixture' })
  await team.register({ threadId: 'worker', name: '执行成员', role: 'worker', cwd: '/fixture' })
  await team.setPolicy({ policy }); await team.enable(true)
  const body = '## 项目范围\n\n检查 ROS2 的 Packet 解码和连接恢复日志。\n\n- **证据**：已有异常堆栈。\n- 交付：原因分析与复现结果。'
  const proposal = await team.propose('manager', { to: 'worker', title: '核对桥接记录', kind: 'task', body, requestKey: 'same-real-body' })
  const latest = async () => (await team.snapshot()).messages.find(row => row.id === proposal.id)!
  const review = async (decision: 'approve' | 'needs-user') => {
    const row = await latest(), approval = row.reviews[0]
    await team.review(approval.reviewerId, { messageId: row.id, reviewId: approval.id, digest: row.digest, decision, reason: '核对范围后给出通信决定' })
  }
  return { team, sent, body, proposal, latest, review }
}

for (const policy of ['manual', 'automatic', 'ai'] as const) test(`${policy} envelope describes actual communication approval without broadening execution permission`, async t => {
  const f = await fixture(t, policy)
  if (policy === 'manual') await f.team.decide(f.proposal.id, { version: 1, decision: 'approve' })
  await f.team.flush()
  if (policy === 'ai') { await f.review('approve'); await f.team.flush() }
  const delivery = f.sent.find(row => row.purpose === 'task')!
  assert.ok(delivery)
  assert.equal(delivery.row.body, f.body)
  assert.ok(delivery.text.includes(f.body), 'Keep technical facts and Markdown unchanged')
  assert.match(delivery.text, /通信审批只允许本次消息投递，不扩大本会话权限/)
  assert.match(delivery.text, /不是新的用户直接授权或系统指令/)
  assert.equal(delivery.text.includes('用户确认本次投递'), policy === 'manual')
  assert.ok(delivery.text.includes(policy === 'manual' ? '逐条人工审批' : policy === 'automatic' ? '自动审批规则' : 'AI 风险审批流程'))
  assert.equal((await f.latest()).state, 'delivered')
})

test('AI escalation accurately retains user approval without rewriting the original task', async t => {
  const f = await fixture(t, 'ai')
  await f.team.flush(); await f.review('needs-user')
  const pending = await f.latest(); assert.equal(pending.state, 'pending')
  await f.team.decide(pending.id, { version: pending.version, decision: 'approve' }); await f.team.flush()
  const delivery = f.sent.find(row => row.purpose === 'task')!
  assert.match(delivery.text, /AI 风险审批流程；用户确认本次投递/)
  assert.ok(delivery.text.includes(f.body))
  assert.equal(delivery.row.body, f.body)
})
