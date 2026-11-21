import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TeamService, type TeamAdapter } from '../server/team.ts'
import { validateTeamGraph } from '../shared/team-topology.ts'
import type { TeamMessage, TeamSnapshot } from '../shared/team.ts'

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 4000
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)) } while (Date.now() < end)
  assert.fail('Isolated team fixture did not settle')
}
const topology = (state: TeamSnapshot) => ({ graphVersion: state.graphVersion, members: state.members, groups: state.groups, edges: state.edges, levels: state.levels })
async function fixture(t: { after: (fn: () => Promise<void>) => void }, override: Partial<TeamAdapter> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cweb-team-remove-')), file = join(dir, 'team.json'), sent: TeamMessage[] = []
  const busy = new Set(['lead', 'manager', 'manager-b', 'worker', 'worker-b'])
  const adapter: TeamAdapter = { changed: () => {}, available: async member => busy.has(member.threadId) ? 'fixture busy' : null,
    send: async row => { sent.push(row); busy.add(row.to) }, receipt: async () => 'unknown', ...override }
  const team = new TeamService(file, adapter), services = [team]
  t.after(async () => { for (const service of services) await service.close(); await rm(dir, { recursive: true, force: true }) })
  for (const [threadId, role, parentId] of [['lead', 'lead', null], ['manager', 'manager', 'lead'], ['manager-b', 'manager', 'lead'], ['worker', 'worker', 'manager'], ['worker-b', 'worker', 'manager-b']] as const) await team.register({ threadId, name: threadId, role, parentId, cwd: '/isolated-team' })
  await team.enable(true)
  const latest = async (id: string) => (await team.snapshot()).messages.find(row => row.id === id)!
  const propose = (from: string, to: string, requestKey = crypto.randomUUID()) => team.propose(from, { to, kind: 'task', title: requestKey, body: '隔离测试正文', requestKey })
  const approve = async (id: string) => { const row = await latest(id); await team.decide(id, { version: row.version, decision: 'approve' }); await team.flush() }
  const remove = async (threadId: string, reassignTo?: string) => team.removeMember({ threadId, graphVersion: (await team.snapshot()).graphVersion, ...(reassignTo ? { reassignTo } : {}) })
  return { team, busy, sent, latest, propose, approve, remove,
    reopen: () => { const service = new TeamService(file, adapter); services.push(service); return service } }
}

test('removing a leaf preserves delivery history, cancels its backlog and keeps unrelated approvals and durable identity', async t => {
  const f = await fixture(t)
  f.busy.delete('worker')
  const delivered = await f.propose('manager', 'worker'); await f.approve(delivered.id)
  const history = await f.latest(delivered.id); assert.equal(history.state, 'delivered')
  const pending = await f.propose('worker', 'manager'), queued = await f.propose('manager', 'worker'); await f.approve(queued.id)
  const backlog = [await f.latest(pending.id), await f.latest(queued.id)]
  const unaffected = await f.propose('lead', 'manager-b'); await f.approve(unaffected.id)
  const before = await f.latest(unaffected.id), token = await f.team.toolToken('worker'), calls = f.sent.length
  const removed = await f.remove('worker'); await f.team.flush()
  assert.ok(!removed.members.some(row => row.threadId === 'worker'))
  assert.ok(!removed.edges.some(row => row.source === 'worker' || row.target === 'worker'))
  assert.ok(!removed.groups.some(row => row.id === 'group-manager'))
  assert.deepEqual(await f.latest(delivered.id), history, 'Completed delivery records stay intact')
  for (const row of backlog) {
    const cancelled = await f.latest(row.id)
    assert.equal(cancelled.state, 'cancelled'); assert.match(cancelled.reason!, /移出团队/)
    assert.equal(cancelled.deliveryId, row.deliveryId)
    assert.equal(cancelled.body, row.body)
  }
  assert.equal((await f.latest(unaffected.id)).state, before.state)
  assert.equal((await f.latest(unaffected.id)).version, before.version)
  assert.equal((await f.latest(unaffected.id)).approvedDigest, before.approvedDigest)
  assert.equal(f.sent.length, calls, 'Membership changes never invoke an agent')
  await assert.rejects(f.team.agentTool(token, 'team_members', {}), { code: 'TEAM_MEMBER' })
  const reopened = await f.reopen().snapshot()
  assert.deepEqual(reopened, JSON.parse(JSON.stringify(await f.team.snapshot())))
})

test('a chosen same-level replacement inherits child groups and restricted directions; affected reviews require new approval', async t => {
  const f = await fixture(t), state = await f.team.snapshot()
  state.edges.find(row => row.source === 'manager' && row.target === 'worker')!.direction = 'backward'
  state.edges.push({ id: 'peer-link', source: 'worker', target: 'worker-b', direction: 'both' })
  await f.team.topology(topology(state))
  const peer = await f.propose('worker', 'worker-b'); await f.approve(peer.id)
  const before = await f.latest(peer.id)
  assert.deepEqual(before.reviews.map(row => row.reviewerId), ['manager', 'manager-b'])
  const removed = await f.remove('manager', 'manager-b')
  assert.equal(removed.members.find(row => row.threadId === 'worker')!.parentId, 'manager-b')
  assert.equal(removed.groups.find(row => row.id === 'group-manager')!.parentId, 'manager-b')
  assert.equal(removed.edges.find(row => row.target === 'worker')!.source, 'manager-b')
  assert.equal(removed.edges.find(row => row.target === 'worker')!.direction, 'backward')
  assert.equal(validateTeamGraph(removed.members, removed.groups, removed.edges, removed.levels), null)
  const after = await f.latest(peer.id)
  assert.equal(after.state, 'pending'); assert.equal(after.policy, 'manual')
  assert.equal(after.approvedDigest, undefined); assert.deepEqual(after.reviews, [])
  assert.equal(after.deliveryId, before.deliveryId); assert.equal(after.body, before.body)
  await assert.rejects(f.team.review('manager', { messageId: peer.id, reviewId: before.reviews[0].id, digest: before.digest, decision: 'approve', reason: '过期审核' }), { code: 'TEAM_REVIEW' })
})

test('invalid or stale removals are atomic and never orphan descendants or expose an agent removal tool', async t => {
  const f = await fixture(t), before = await f.team.snapshot()
  await assert.rejects(f.remove('lead'), { code: 'TEAM_GRAPH' })
  await assert.rejects(f.remove('manager'), { code: 'TEAM_GRAPH' })
  await assert.rejects(f.remove('manager', 'worker'), { code: 'TEAM_GRAPH' })
  await assert.rejects(f.remove('worker', 'worker-b'), { code: 'TEAM_GRAPH' })
  await assert.rejects(f.team.removeMember({ threadId: 'worker', graphVersion: before.graphVersion - 1 }), { code: 'TEAM_STALE' })
  await assert.rejects(f.team.tool('manager', 'team_remove_member', {}), { code: 'TOOL_UNKNOWN' })
  assert.deepEqual(await f.team.snapshot(), before)
  await f.remove('worker'); await f.remove('manager'); await f.remove('worker-b'); await f.remove('manager-b')
  const empty = await f.remove('lead'); assert.deepEqual(empty.members, []); assert.deepEqual(empty.groups, []); assert.deepEqual(empty.edges, [])
})

test('removal during availability preflight cancels the request before any native delivery', async t => {
  const waiting = gate(); let checking = false
  t.after(async () => { waiting.release() })
  const f = await fixture(t, { available: async () => { checking = true; await waiting.promise; return null } })
  const message = await f.propose('manager', 'worker')
  await f.team.decide(message.id, { version: 1, decision: 'approve' })
  await until(() => checking)
  await f.remove('worker')
  waiting.release(); await f.team.flush()
  assert.equal((await f.latest(message.id)).state, 'cancelled'); assert.equal(f.sent.length, 0)
})

test('in-flight submissions and unknown affected receipts must settle before a member can be removed', async t => {
  const sending = gate(); let started = false, loseReceipt = false
  t.after(async () => { sending.release() })
  const f = await fixture(t, { send: async () => { started = true; await sending.promise; if (loseReceipt) throw new Error('fixture lost receipt') } })
  f.busy.delete('worker')
  const message = await f.propose('manager', 'worker')
  await f.team.decide(message.id, { version: 1, decision: 'approve' })
  await until(() => started)
  await assert.rejects(f.remove('worker'), { code: 'TEAM_BUSY' })
  loseReceipt = true; sending.release(); await f.team.flush()
  const before = await f.team.snapshot(); assert.equal((await f.latest(message.id)).state, 'uncertain')
  await assert.rejects(f.remove('worker'), { code: 'TEAM_RECEIPT' })
  assert.deepEqual(await f.team.snapshot(), before)
  await f.remove('worker-b')
  assert.equal((await f.latest(message.id)).state, 'uncertain', 'An unrelated removal does not discard an unknown receipt')
})

test('pending member applications tied to a removed conversation close without creating sessions', async t => {
  let created = 0
  const f = await fixture(t, { createMember: async () => { created++; return { threadId: 'unused', cwd: '/isolated-team', model: '', effort: '' } } })
  const request = await f.team.requestMember('manager', { name: '待加入下级', level: 3, parentId: 'manager', groupId: null, requestKey: 'new-worker' })
  const keep = await f.team.requestMember('user', { name: '其他下级', level: 3, parentId: 'manager-b', groupId: null, requestKey: 'other-worker' })
  const removed = await f.remove('manager', 'manager-b')
  const closed = removed.memberRequests.find(row => row.id === request.id)!
  assert.equal(closed.state, 'rejected'); assert.match(closed.error!, /移出团队/)
  assert.equal(removed.memberRequests.find(row => row.id === keep.id)!.state, 'pending')
  await assert.rejects(f.team.decideMember(request.id, { version: request.version, decision: 'approve' }), { code: 'TEAM_STALE' })
  assert.equal(created, 0)
})
