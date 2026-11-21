import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TeamService, type TeamAdapter } from '../server/team.ts'
import type { TeamMessage, TeamSnapshot } from '../shared/team.ts'

function latch() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
async function within<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 2000) })])
  } finally { clearTimeout(timer!) }
}
const topology = (s: TeamSnapshot) => ({ graphVersion: s.graphVersion, members: s.members, groups: s.groups, edges: s.edges, levels: s.levels })

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'cweb-team-parallel-'))
  const start = latch(), sent: { row: TeamMessage; purpose?: 'task' | 'review' }[] = [], gates: ReturnType<typeof latch>[] = [start]
  const hooks: Partial<TeamAdapter> = {}
  const adapter: TeamAdapter = {
    available: async member => { await start.promise; return hooks.available?.(member) ?? null },
    send: async (row, text, purpose) => { sent.push({ row, purpose }); await hooks.send?.(row, text, purpose) },
    receipt: row => hooks.receipt?.(row) ?? Promise.resolve('unknown'), changed: () => {},
  }
  const team = new TeamService(join(dir, 'team.json'), adapter)
  t.after(async () => { gates.forEach(gate => gate.release()); await team.close(); await rm(dir, { recursive: true, force: true }) })
  await team.register({ threadId: 'lead', name: 'lead', role: 'lead', cwd: '/parallel-trial' })
  for (let i = 1; i <= 6; i++) await team.register({ threadId: `manager-${i}`, name: `manager-${i}`, role: 'manager', parentId: 'lead', cwd: '/parallel-trial' })
  for (let i = 1; i <= 2; i++) await team.register({ threadId: `worker-${i}`, name: `worker-${i}`, role: 'worker', parentId: `manager-${i}`, cwd: '/parallel-trial' })
  const state = await team.snapshot()
  state.edges.push({ id: 'peer', source: 'worker-1', target: 'worker-2', direction: 'both' })
  await team.topology(topology(state))
  await team.enable(true)
  let sequence = 0
  const propose = (to: string, from = 'lead') => team.propose(from, { to, kind: 'task', title: '隔离并发测试', body: '只验证投递，不执行项目任务', requestKey: `request-${++sequence}` })
  const latest = async (id: string) => (await team.snapshot()).messages.find(row => row.id === id)!
  const approve = async (to: string, from = 'lead') => { const row = await propose(to, from); await team.decide(row.id, { version: row.version, decision: 'approve' }); return row }
  const verdict = async (id: string, reviewerId: string) => {
    const row = await latest(id), review = row.reviews.find(r => r.reviewerId === reviewerId)!
    return team.review(reviewerId, { messageId: id, reviewId: review.id, digest: row.digest, decision: 'approve', reason: '范围已核对' })
  }
  return { team, hooks, sent, propose, approve, latest, verdict, start: async () => { start.release(); await team.enable(true) }, gate: () => { const gate = latch(); gates.push(gate); return gate } }
}

test('slow availability does not hold other recipients, including tasks approved after dispatch started', async t => {
  const f = await fixture(t), slow = f.gate()
  let checking = false
  f.hooks.available = async member => { if (member.threadId === 'manager-1') { checking = true; await slow.promise } return null }
  await f.approve('manager-1'); await f.approve('manager-2'); await f.start()
  const flight = f.team.flush()
  await until(() => checking && f.sent.some(s => s.row.to === 'manager-2'), 'independent availability')
  await f.approve('manager-3')
  await until(() => f.sent.some(s => s.row.to === 'manager-3'), 'new approval wakes active dispatcher')
  assert.ok(!f.sent.some(s => s.row.to === 'manager-1'))
  slow.release(); await flight
  assert.equal(f.sent.length, 3)
})

test('slow submission does not hold independent submissions or later approvals', async t => {
  const f = await fixture(t), slow = f.gate()
  f.hooks.send = async row => { if (row.to === 'manager-1') await slow.promise }
  await f.approve('manager-1'); await f.approve('manager-2'); await f.start()
  const flight = f.team.flush()
  await until(() => f.sent.length === 2, 'independent RPC submission')
  await f.approve('manager-3')
  await until(() => f.sent.length === 3, 'later approval while old RPC is pending')
  const state = await f.team.snapshot()
  assert.equal(state.messages.find(m => m.to === 'manager-1')!.state, 'sending')
  assert.equal(state.messages.find(m => m.to === 'manager-2')!.state, 'delivered')
  slow.release(); await flight
})

test('one recipient stays FIFO and never overlaps checks or submissions or interrupts its active model', async t => {
  const f = await fixture(t), firstRpc = f.gate()
  let rpcActive = false, modelBusy = false, overlaps = 0
  const first = await f.approve('manager-1'), second = await f.approve('manager-1')
  await f.approve('manager-2')
  f.hooks.available = async member => {
    if (member.threadId !== 'manager-1') return null
    if (rpcActive) overlaps++
    return modelBusy ? '正在运行，不插话' : null
  }
  f.hooks.send = async row => {
    if (row.to !== 'manager-1') return
    if (rpcActive) overlaps++
    rpcActive = true
    if (row.id === first.id) { await firstRpc.promise; modelBusy = true }
    rpcActive = false
  }
  await f.start(); const flight = f.team.flush()
  await until(() => f.sent.length === 2, 'other recipient progresses')
  assert.deepEqual(f.sent.filter(s => s.row.to === 'manager-1').map(s => s.row.id), [first.id])
  firstRpc.release(); await flight
  assert.equal((await f.latest(second.id)).state, 'waiting')
  assert.equal(f.sent.length, 2)
  modelBusy = false; await f.team.flush()
  assert.deepEqual(f.sent.filter(s => s.row.to === 'manager-1').map(s => s.row.id), [first.id, second.id])
  assert.equal(overlaps, 0)
})

test('parallel dispatch never admits unapproved or rejected messages and remains idempotent', async t => {
  const f = await fixture(t)
  const pending = await f.propose('manager-1'), rejected = await f.propose('manager-2'), approved = await f.approve('manager-3')
  await f.team.decide(rejected.id, { version: 1, decision: 'reject' }); await f.start()
  await Promise.all([f.team.flush(), f.team.flush(), f.team.flush()]); await f.team.flush()
  assert.deepEqual(f.sent.map(s => s.row.id), [approved.id])
  assert.equal((await f.latest(pending.id)).state, 'pending')
  assert.equal((await f.latest(rejected.id)).state, 'rejected')
})

test('one approval releases only the selected current versions and allows parallel work', async t => {
  const f = await fixture(t), slow = f.gate()
  const a = await f.propose('manager-1'), b = await f.propose('manager-2'), unselected = await f.propose('manager-3')
  const selections = [a, b].map(({ id, version }) => ({ id, version }))
  await assert.rejects(f.team.approveTasks({ tasks: [selections[0], { ...selections[1], version: 2 }] }), /已变化/)
  assert.deepEqual((await f.team.snapshot()).messages.map(row => row.state), ['pending', 'pending', 'pending'])
  await f.team.approveTasks({ tasks: selections })
  await assert.rejects(f.team.approveTasks({ tasks: selections }), /已变化/)
  f.hooks.send = async row => { if (row.to === 'manager-1') await slow.promise }
  await f.start()
  const flight = f.team.flush()
  await until(() => f.sent.length === 2, 'both recipients start while one submission is still open')
  assert.deepEqual(new Set(f.sent.map(s => s.row.id)), new Set([a.id, b.id]))
  assert.equal((await f.latest(a.id)).state, 'sending')
  assert.equal((await f.latest(unselected.id)).state, 'pending')
  slow.release(); await flight
  assert.ok((await f.latest(a.id)).audit.some(event => event.actor === 'user' && event.action === 'approved'))
  assert.ok((await f.latest(b.id)).audit.some(event => event.actor === 'user' && event.action === 'approved'))
})

test('one reviewer turn gives independent verdicts, and approved work starts before the reviewer finishes', async t => {
  const f = await fixture(t), reviewing = f.gate()
  await f.team.setPolicy({ policy: 'ai' })
  const a = await f.propose('manager-1'), b = await f.propose('manager-2'), denied = await f.propose('manager-3')
  let envelope: string | undefined
  f.hooks.send = async (_row, text, purpose) => { if (purpose === 'review') { envelope = text; await reviewing.promise } }
  await f.start()
  const flight = f.team.flush()
  await until(() => Boolean(envelope), 'one review submission')
  assert.equal(f.sent.filter(s => s.purpose === 'review').length, 1)
  for (const item of [a, b, denied]) assert.ok(envelope?.includes(item.id))
  await f.verdict(a.id, 'lead'); await f.verdict(b.id, 'lead')
  const row = await f.latest(denied.id), review = row.reviews[0]
  await f.team.review('lead', { messageId: row.id, reviewId: review.id, digest: review.digest, decision: 'reject', reason: '未通过本项独立审核' })
  await until(() => f.sent.filter(s => s.purpose === 'task').length === 2, 'approved work opens before review acknowledgement')
  assert.deepEqual(new Set(f.sent.filter(s => s.purpose === 'task').map(s => s.row.id)), new Set([a.id, b.id]))
  reviewing.release(); await flight
  assert.equal((await f.latest(denied.id)).state, 'rejected')
  assert.deepEqual(await Promise.all([a, b].map(async x => (await f.latest(x.id)).state)), ['delivered', 'delivered'])
})

test('an unknown review batch is reconciled once using its native receipt', async t => {
  const f = await fixture(t)
  await f.team.setPolicy({ policy: 'ai' })
  const a = await f.propose('manager-1'), b = await f.propose('manager-2')
  await f.start()
  f.hooks.send = async () => { throw new Error('Lost review acknowledgement') }
  await f.team.flush()
  assert.equal(f.sent.length, 1)
  const nativeId = f.sent[0].row.deliveryId
  assert.equal((await f.latest(a.id)).reviews[0].state, 'uncertain')
  assert.equal((await f.latest(b.id)).reviews[0].state, 'uncertain')
  f.hooks.receipt = async row => { assert.equal(row.deliveryId, nativeId); return 'accepted' }
  f.hooks.available = async () => '审核会话仍在运行'
  await f.team.reconcile(b.id)
  assert.equal((await f.latest(a.id)).reviews[0].state, 'sent')
  assert.equal((await f.latest(b.id)).reviews[0].state, 'sent')
  assert.equal(f.sent.length, 1)
})

test('independent supervisor reviews run in parallel and both verdicts still gate the target task', async t => {
  const f = await fixture(t), slowReview = f.gate()
  f.hooks.send = async (row, _text, purpose) => { if (purpose === 'review' && row.to === 'manager-1') await slowReview.promise }
  const peer = await f.approve('worker-2', 'worker-1'); await f.start()
  const flight = f.team.flush()
  await until(() => f.sent.filter(s => s.purpose === 'review').length === 2, 'both supervisor RPCs')
  assert.ok(!f.sent.some(s => s.purpose === 'task'))
  await f.verdict(peer.id, 'manager-2')
  assert.equal((await f.latest(peer.id)).state, 'reviewing')
  slowReview.release(); await flight
  await f.verdict(peer.id, 'manager-1'); await f.team.flush()
  assert.equal((await f.latest(peer.id)).state, 'delivered')
  assert.equal(f.sent.filter(s => s.purpose === 'task').length, 1)
})

test('supervisor reviews and ordinary messages share the same recipient queue', async t => {
  const f = await fixture(t), slowTask = f.gate()
  const direct = await f.approve('manager-1'), peer = await f.approve('worker-2', 'worker-1')
  let taskActive = false, overlap = false
  f.hooks.send = async (row, _text, purpose) => {
    if (row.to !== 'manager-1') return
    if (purpose === 'task') { taskActive = true; await slowTask.promise; taskActive = false }
    else overlap ||= taskActive
  }
  await f.start(); const flight = f.team.flush()
  await until(() => f.sent.some(s => s.purpose === 'review' && s.row.to === 'manager-2'), 'independent supervisor')
  assert.deepEqual(f.sent.filter(s => s.row.to === 'manager-1').map(s => s.row.id), [direct.id])
  slowTask.release(); await flight
  assert.deepEqual(f.sent.filter(s => s.row.to === 'manager-1').map(s => [s.row.id, s.purpose]), [[direct.id, 'task'], [peer.id, 'review']])
  assert.equal(overlap, false)
})

test('at most four different recipients are checked or submitted concurrently, and free slots refill', async t => {
  const f = await fixture(t), gates = Array.from({ length: 6 }, () => f.gate())
  const checking: string[] = []
  let active = 0, maximum = 0
  f.hooks.available = async member => {
    checking.push(member.threadId); maximum = Math.max(maximum, ++active)
    await gates[Number(member.threadId.split('-')[1]) - 1].promise
    active--; return null
  }
  for (let i = 1; i <= 6; i++) await f.approve(`manager-${i}`)
  await f.start(); const flight = f.team.flush()
  await until(() => checking.length === 4, 'initial bounded batch')
  assert.equal(active, 4)
  gates[1].release()
  await until(() => checking.length === 5, 'free slot refilled while earlier target is blocked')
  assert.equal(active, 4)
  gates.forEach(gate => gate.release()); await flight
  assert.equal(maximum, 4); assert.equal(f.sent.length, 6)
})

test('close cancels an indefinitely waiting availability check without starting a delivery', async t => {
  const f = await fixture(t), stuck = f.gate()
  let checking = false
  f.hooks.available = async () => { checking = true; await stuck.promise; return null }
  const row = await f.approve('manager-1'); await f.start()
  const flight = f.team.flush(); await until(() => checking, 'availability started')
  await within(f.team.close(), 'close without waiting for a hung read'); await flight
  assert.equal(f.sent.length, 0); assert.equal((await f.latest(row.id)).state, 'approved')
  stuck.release()
})

test('close waits for already submitted acknowledgments but never starts the next queued task', async t => {
  const f = await fixture(t), submitted = f.gate()
  f.hooks.send = async () => { await submitted.promise }
  const first = await f.approve('manager-1'), second = await f.approve('manager-1'); await f.start()
  const flight = f.team.flush(); await until(() => f.sent.length === 1, 'submission started')
  let closed = false
  const close = f.team.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false)
  submitted.release(); await within(close, 'submission drained on close'); await flight
  assert.equal(f.sent.length, 1)
  assert.equal((await f.latest(first.id)).state, 'delivered'); assert.equal((await f.latest(second.id)).state, 'approved')
})

test('pause during a slow preflight prevents dispatch and resume still requires current approval', async t => {
  const f = await fixture(t), slow = f.gate()
  let checking = false
  f.hooks.available = async () => { checking = true; await slow.promise; return null }
  const row = await f.approve('manager-1'); await f.start()
  const flight = f.team.flush(); await until(() => checking, 'preflight started')
  await f.team.enable(false); slow.release(); await flight
  assert.equal(f.sent.length, 0)
  const latest = await f.latest(row.id)
  await f.team.decide(row.id, { version: latest.version, decision: 'cancel' }); await f.start(); await f.team.flush()
  assert.equal(f.sent.length, 0); assert.equal((await f.latest(row.id)).state, 'cancelled')
})

test('unknown task delivery holds its recipient queue without holding or resending other recipients', async t => {
  const f = await fixture(t)
  const first = await f.approve('manager-1'), second = await f.approve('manager-1'), other = await f.approve('manager-2')
  f.hooks.send = async row => { if (row.id === first.id) throw new Error('lost native acknowledgment') }
  await f.start(); await f.team.flush(); await f.team.flush()
  assert.equal((await f.latest(first.id)).state, 'uncertain')
  assert.equal((await f.latest(second.id)).state, 'approved')
  assert.equal((await f.latest(other.id)).state, 'delivered')
  assert.equal(f.sent.length, 2)
})

test('unknown review delivery shares the task exclusion and never auto-resends', async t => {
  const f = await fixture(t)
  const peer = await f.approve('worker-2', 'worker-1'), direct = await f.approve('manager-1'), other = await f.approve('manager-3')
  f.hooks.send = async (row, _text, purpose) => { if (purpose === 'review' && row.to === 'manager-1') throw new Error('lost review acknowledgment') }
  await f.start(); await f.team.flush(); await f.team.flush()
  assert.equal((await f.latest(peer.id)).reviews.find(r => r.reviewerId === 'manager-1')!.state, 'uncertain')
  assert.equal((await f.latest(direct.id)).state, 'approved')
  assert.equal((await f.latest(other.id)).state, 'delivered')
  assert.equal(f.sent.filter(s => s.row.to === 'manager-1').length, 1)
})

test('cancelled tasks can reconcile an unknown review receipt without reviving or resending the task', async t => {
  const f = await fixture(t)
  const peer = await f.approve('worker-2', 'worker-1'), direct = await f.approve('manager-1')
  f.hooks.send = async (row, _text, purpose) => { if (purpose === 'review' && row.to === 'manager-1') throw new Error('lost review acknowledgment') }
  await f.start(); await f.team.flush()
  const row = await f.latest(peer.id)
  await f.team.decide(peer.id, { version: row.version, decision: 'cancel' })
  await f.team.reconcile(peer.id); await f.team.flush()
  assert.equal((await f.latest(peer.id)).state, 'cancelled')
  assert.equal((await f.latest(direct.id)).state, 'approved')
  f.hooks.receipt = async () => 'accepted'
  await f.team.reconcile(peer.id); await f.team.flush()
  const reconciled = await f.latest(peer.id)
  assert.equal(reconciled.state, 'cancelled')
  assert.equal(reconciled.reviews.find(r => r.reviewerId === 'manager-1')!.state, 'sent')
  assert.equal((await f.latest(direct.id)).state, 'delivered')
  assert.equal(f.sent.filter(s => s.purpose === 'review' && s.row.to === 'manager-1').length, 1)
  assert.ok(!f.sent.some(s => s.purpose === 'task' && s.row.id === peer.id))
})
