import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTeamQueue } from '../shared/team-queue.ts'
import type { TeamMember, TeamMessage, TeamReview } from '../shared/team.ts'

function message(id: string, state: TeamMessage['state'], patch: Partial<TeamMessage> = {}): TeamMessage {
  return { id, state, from: 'lead', to: 'manager', kind: 'task', title: id, body: 'body', requestKey: id, version: 1, digest: id, approvedDigest: id, deliveryId: id, createdAt: 100, updatedAt: 200, audit: [], policy: 'manual', graphVersion: 1, reviews: [], ...patch }
}
function review(id: string, state: TeamReview['state']): TeamReview { return { id, state, reviewerId: 'manager', kind: 'supervisor', deliveryId: id, digest: id } }
function fixture(messages: TeamMessage[], enabled = true) {
  const members: TeamMember[] = ['lead', 'manager', 'worker-a', 'worker-b'].map((id, index) => ({ threadId: id, name: `name:${id}`, role: index ? 'worker' : 'lead', level: index + 1, parentId: null, groupId: null, cwd: '/isolated', order: index, useDefaults: true, model: '', effort: '' }))
  return { enabled, members, messages }
}

test('current recipient queue shares durable FIFO numbering between approved messages and reviews', () => {
  const state = fixture([
    message('first', 'approved', { updatedAt: 9999, createdAt: 9999 }),
    message('needs-user', 'pending'),
    message('review', 'reviewing', { from: 'worker-a', to: 'worker-b', reviews: [review('review-one', 'pending')] }),
    message('second', 'waiting', { updatedAt: 1, createdAt: 1 }),
    message('outgoing', 'approved', { from: 'manager', to: 'worker-a' }),
  ]), before = structuredClone(state)
  const queue = buildTeamQueue(state, 'manager')!
  assert.deepEqual(queue.rows.map(row => [row.id, row.position]), [['message:first', 1], ['message:needs-user', undefined], ['review:review-one', 2], ['message:second', 3]])
  assert.equal(queue.rows[2].kind, 'review'); assert.equal(queue.rows[2].status, '审核排队')
  assert.equal(queue.rows[1].phase, 'approval'); assert.equal(queue.counts.queued, 3)
  assert.deepEqual(state, before, 'The display cannot mutate a durable queue')
})

test('sent reviews hold only following queue entries and never claim a task is running or complete', () => {
  const state = fixture([
    message('before-review', 'approved'),
    message('peer', 'reviewing', { to: 'worker-b', reviews: [review('sent-review', 'sent')] }),
    message('after-review', 'approved'),
  ])
  const rows = buildTeamQueue(state, 'manager')!.rows
  assert.equal(rows[0].blockedReason, undefined)
  assert.equal(rows[1].status, '待审核'); assert.equal(rows[1].position, undefined)
  assert.match(rows[2].blockedReason!, /审核尚未返回判定/)
  assert.ok(rows.every(row => !/正在执行|已完成|下一条/.test(`${row.status} ${row.reason} ${row.blockedReason}`)))
})

test('unknown receipts block ready entries even when later, including cancelled parent reviews', () => {
  const state = fixture([
    message('ready', 'waiting'),
    message('unknown', 'uncertain', { reason: '  等待\n 原生回执  ' }),
    message('cancelled-review', 'cancelled', { to: 'worker-b', reviews: [review('unknown-review', 'uncertain'), review('obsolete-review', 'pending')] }),
  ])
  const queue = buildTeamQueue(state, 'manager')!
  assert.match(queue.rows[0].blockedReason!, /回执核对/)
  assert.equal(queue.rows[0].position, 1); assert.equal(queue.counts.receipt, 2)
  assert.equal(queue.rows[1].reason, '等待 原生回执')
  assert.ok(queue.rows.some(row => row.id === 'review:unknown-review'))
  assert.ok(!queue.rows.some(row => row.id === 'review:obsolete-review'))
})

test('sending and human fallback have distinct statuses without assigning false execution state', () => {
  const state = fixture([
    message('sending', 'sending'), message('waiting', 'approved'),
    message('review-fallback', 'reviewing', { to: 'worker-b', reviews: [review('needs-user-review', 'needs-user')] }),
    message('review-unknown', 'reviewing', { to: 'worker-b', reviews: [review('sending-review', 'sending')] }),
  ])
  const queue = buildTeamQueue(state, 'manager')!
  assert.deepEqual(queue.rows.map(row => row.status), ['投递中', '已批准排队', '需继续审核', '审核投递中'])
  assert.match(queue.rows[1].blockedReason!, /投递确认/)
  assert.equal(queue.rows[2].phase, 'attention')
})

test('paused queues remain visible, ordinary workspaces and delivered tasks stay out', () => {
  const state = fixture([message('kept', 'waiting')], false)
  assert.equal(buildTeamQueue(state, 'manager')!.paused, true)
  assert.equal(buildTeamQueue(state, 'manager')!.rows[0].position, 1)
  assert.equal(buildTeamQueue(state), null); assert.equal(buildTeamQueue(null, 'manager'), null)
  assert.equal(buildTeamQueue(state, 'unrelated'), null)
  assert.equal(buildTeamQueue(fixture([message('delivered', 'delivered'), message('cancelled', 'cancelled'), message('rejected', 'rejected')]), 'manager'), null)
})
