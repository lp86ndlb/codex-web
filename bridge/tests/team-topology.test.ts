import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TeamService, type TeamAdapter } from '../server/team.ts'
import { teamRoute, validateTeamGraph, layoutTeam } from '../shared/team-topology.ts'
import { parseTeam } from '../server/team-schema.ts'
import type { TeamSnapshot, TeamMessage } from '../shared/team.ts'

const topology = (s: TeamSnapshot) => ({ graphVersion: s.graphVersion, members: s.members, groups: s.groups, edges: s.edges, levels: s.levels })
async function fixture(t: { after: (fn: () => Promise<void>) => void }, overrides: Partial<TeamAdapter> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cweb-graph-')), file = join(dir, 'team.json'), sent: { row: TeamMessage; text: string }[] = [], busy = new Set<string>()
  let creates = 0
  const adapter: TeamAdapter = { changed: () => {}, available: async m => busy.has(m.threadId) ? 'busy' : null,
    send: async (row, text) => { sent.push({ row, text }); busy.add(row.to) }, receipt: async () => 'unknown',
    createMember: async () => ({ threadId: `new-${++creates}`, cwd: '/trial', model: 'test-model', effort: 'low' }), ...overrides }
  const services: TeamService[] = [], reopen = () => { const s = new TeamService(file, adapter); services.push(s); return s }, team = reopen()
  t.after(async () => { for (const s of services) await s.close(); await rm(dir, { recursive: true, force: true }) })
  for (const [threadId, role, parentId] of [['lead', 'lead', null], ['manager', 'manager', 'lead'], ['worker', 'worker', 'manager'], ['manager-b', 'manager', 'lead'], ['worker-b', 'worker', 'manager-b']] as const) await team.register({ threadId, role, name: threadId, cwd: '/trial', parentId })
  const s = await team.snapshot(); s.edges.push({ id: 'peer', source: 'worker', target: 'worker-b', direction: 'both' }); await team.topology(topology(s)); await team.enable(true)
  const propose = (from = 'worker', to = 'worker-b', requestKey = 'peer-task') => team.propose(from, { to, kind: 'task', title: '协调接口', body: '请确认接口字段', requestKey })
  const latest = async (id: string) => (await team.snapshot()).messages.find(m => m.id === id)!
  const verdict = async (id: string, reviewerId: string, decision = 'approve') => { const row = await latest(id), r = row.reviews.find(r => r.reviewerId === reviewerId)!; return team.review(reviewerId, { messageId: id, reviewId: r.id, digest: row.digest, decision, reason: '范围已核对' }) }
  return { team, file, sent, busy, propose, latest, verdict, reopen, creates: () => creates }
}

test('graph enforces one root, adjacent parents, exclusive groups and directed permissions', async t => {
  const { team } = await fixture(t), s = await team.snapshot()
  assert.equal(validateTeamGraph(s.members, s.groups, s.edges, s.levels), null)
  assert.ok(teamRoute(s, 'lead', 'worker').error)
  assert.ok(teamRoute(s, 'manager-b', 'worker').error)
  assert.deepEqual(teamRoute(s, 'worker', 'worker-b').supervisors, ['manager', 'manager-b'])
  const edge = s.edges.find(e => e.id === 'peer')!
  edge.direction = 'forward'; assert.ok(!teamRoute(s, 'worker', 'worker-b').error); assert.ok(teamRoute(s, 'worker-b', 'worker').error)
  edge.direction = 'none'; assert.ok(teamRoute(s, 'worker', 'worker-b').error)
  s.members.find(m => m.threadId === 'worker')!.groupId = 'group-manager-b'; assert.match(validateTeamGraph(s.members, s.groups, s.edges, s.levels)!, /交叉归组/)
  const duplicateRoot = structuredClone(await team.snapshot()); duplicateRoot.members[1].level = 1
  assert.match(validateTeamGraph(duplicateRoot.members, duplicateRoot.groups, duplicateRoot.edges, duplicateRoot.levels)!, /一位/)
  const invalid = structuredClone(await team.snapshot()); invalid.edges[1].id = invalid.edges[0].id
  assert.match(validateTeamGraph(invalid.members, invalid.groups, invalid.edges, invalid.levels)!, /标识/)
  const layout = layoutTeam(await team.snapshot()), bands = layout.bands.filter(b => b.group.level === 3)
  assert.ok(bands[0].y + bands[0].height < bands[1].y, 'Same-tier groups occupy disjoint vertical intervals')
})

test('cross-group tasks require both supervisors, exact digest and assigned identity', async t => {
  const f = await fixture(t); await f.team.setPeerMode({ peerMode: 'supervised' }); const task = await f.propose()
  await f.team.flush(); assert.equal(f.sent.length, 0)
  await f.team.decide(task.id, { version: 1, decision: 'approve' }); await f.team.flush()
  assert.deepEqual(f.sent.map(s => s.row.to), ['manager', 'manager-b'])
  let row = await f.latest(task.id), r = row.reviews[0]
  await assert.rejects(f.team.review('lead', { messageId: task.id, reviewId: r.id, digest: row.digest, decision: 'approve', reason: 'spoof' }), { code: 'TEAM_REVIEW' })
  await assert.rejects(f.team.review(r.reviewerId, { messageId: task.id, reviewId: r.id, digest: 'changed', decision: 'approve', reason: 'stale' }), { code: 'TEAM_REVIEW' })
  await f.verdict(task.id, 'manager'); await f.team.flush()
  assert.equal((await f.latest(task.id)).state, 'reviewing'); assert.equal(f.sent.length, 2)
  await f.verdict(task.id, 'manager-b'); await f.team.flush()
  assert.equal((await f.latest(task.id)).state, 'delivered'); assert.equal(f.sent.at(-1)!.row.to, 'worker-b')
  await assert.rejects(f.verdict(task.id, 'manager-b'), { code: 'TEAM_REVIEW' })
})

test('legacy automatic routing still requires supervisors for peer communication', async t => {
  const f = await fixture(t); await f.team.setPolicy({ policy: 'automatic' })
  await f.team.setPeerMode({ peerMode: 'supervised' })
  const direct = await f.propose('lead', 'manager', 'direct'); await f.team.flush()
  assert.equal((await f.latest(direct.id)).reviews.length, 0); assert.equal(f.sent.length, 1)
  f.busy.clear()
  const peer = await f.propose(); await f.team.flush()
  assert.equal((await f.latest(peer.id)).state, 'reviewing'); assert.equal(f.sent.filter(s => s.text.includes('仅审核')).length, 2)
  await f.verdict(peer.id, 'manager', 'reject'); await f.team.flush()
  assert.equal((await f.latest(peer.id)).state, 'rejected'); assert.ok(!f.sent.some(s => s.row.to === 'worker-b'))
})

test('AI risk judgment falls back to user, and edited content must be reviewed again', async t => {
  const f = await fixture(t); await f.team.setPolicy({ policy: 'ai' })
  const task = await f.propose('manager', 'worker', 'risk'); await f.team.flush()
  assert.equal(f.sent[0].row.to, 'lead')
  await f.verdict(task.id, 'lead', 'needs-user'); assert.equal((await f.latest(task.id)).state, 'pending')
  let row = await f.latest(task.id)
  await f.team.decide(task.id, { version: row.version, decision: 'approve', body: '用户修改后的正文' }); f.busy.clear(); await f.team.flush()
  assert.equal((await f.latest(task.id)).state, 'reviewing'); assert.equal(f.sent.length, 2)
  await f.verdict(task.id, 'lead', 'needs-user'); row = await f.latest(task.id)
  await f.team.decide(task.id, { version: row.version, decision: 'approve' }); await f.team.flush()
  assert.equal((await f.latest(task.id)).state, 'delivered'); assert.equal(f.sent.at(-1)!.row.to, 'worker')
})

test('permission edits invalidate pending authorization; layout edits cost no calls and preserve it', async t => {
  const f = await fixture(t); f.busy.add('manager')
  const task = await f.propose('lead', 'manager'); await f.team.decide(task.id, { version: 1, decision: 'approve' }); await f.team.flush()
  let s = await f.team.snapshot(); s.members[1].order += 1; s.members[1].name = 'renamed'; await f.team.topology(topology(s))
  assert.equal((await f.latest(task.id)).state, 'waiting'); assert.equal(f.sent.length, 0)
  s = await f.team.snapshot(); s.edges.find(e => e.target === 'manager')!.direction = 'none'; await f.team.topology(topology(s))
  const row = await f.latest(task.id); assert.equal(row.state, 'pending'); assert.equal(row.approvedDigest, undefined)
  await assert.rejects(f.team.decide(task.id, { version: row.version, decision: 'approve' }), { code: 'TEAM_ROUTE' })
  await assert.rejects(f.team.topology(topology(s)), { code: 'TEAM_STALE' })
})

test('member creation always needs user approval, deduplicates, and cannot broaden agent scope', async t => {
  const f = await fixture(t); await f.team.setPolicy({ policy: 'automatic' })
  const input = { name: '新执行成员', level: 3, parentId: 'manager', groupId: null, requestKey: 'new' }
  await assert.rejects(f.team.requestMember('worker', input), { code: 'TEAM_MEMBER_SCOPE' })
  const request = await f.team.requestMember('manager', input); await f.team.flush()
  assert.equal(f.creates(), 0); assert.equal((await f.team.requestMember('manager', input)).id, request.id)
  await assert.rejects(f.team.tool('manager', 'team_approve_member', { id: request.id }))
  const results = await Promise.allSettled([f.team.decideMember(request.id, { version: 1, decision: 'approve' }), f.team.decideMember(request.id, { version: 1, decision: 'approve' })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.creates(), 1)
  const s = await f.team.snapshot(); assert.equal(s.members.at(-1)!.parentId, 'manager'); assert.equal(s.members.at(-1)!.model, 'test-model')
  const rejected = await f.team.requestMember('user', { ...input, requestKey: 'reject' }); await f.team.decideMember(rejected.id, { version: 1, decision: 'reject' }); assert.equal(f.creates(), 1)
})

test('unknown review delivery is never resent and its scoped verdict can recover', async t => {
  let sends = 0
  const f = await fixture(t, { send: async () => { sends++; throw new Error('lost response') } })
  await f.team.setPolicy({ policy: 'ai' }); const task = await f.propose('manager', 'worker'); await f.team.flush(); await f.team.flush()
  assert.equal(sends, 1); assert.equal((await f.latest(task.id)).reviews[0].state, 'uncertain')
  await f.team.reconcile(task.id); assert.equal(sends, 1)
  await f.verdict(task.id, 'lead'); assert.equal((await f.latest(task.id)).state, 'approved')
})

test('legacy records migrate without replacing histories; restart never recreates uncertain members', async t => {
  const f = await fixture(t), task = await f.propose('lead', 'manager'); await f.team.close()
  const s = JSON.parse(await readFile(f.file, 'utf8'))
  const legacy = { revision: s.revision, enabled: s.enabled, workspace: s.workspace, members: s.members.slice(0, 3).map(({ threadId, name, role, cwd }: any) => ({ threadId, name, role, cwd })), messages: s.messages.map(({ policy, graphVersion, reviews, ...row }: any) => row) }
  const migrated = parseTeam(legacy); assert.equal(migrated.messages[0].id, task.id); assert.equal(migrated.edges.length, 2); assert.equal(migrated.members[2].parentId, 'manager')
  const request = { name: 'lost', reason: '', level: 3, parentId: 'manager', groupId: null, useDefaults: true, model: '', effort: '', requestKey: 'lost', id: crypto.randomUUID(), from: 'user', state: 'creating', version: 2, createdAt: Date.now() }
  migrated.memberRequests.push(request as any); await writeFile(f.file, JSON.stringify(migrated))
  const reopened = f.reopen(); assert.equal((await reopened.snapshot()).memberRequests[0].state, 'uncertain'); await reopened.flush(); assert.equal(f.creates(), 0)
})

test('agent credential stays bound to one source and exposes no approval authority', async t => {
  const f = await fixture(t), token = await f.team.toolToken('worker')
  const s = await f.team.snapshot(); assert.ok(!JSON.stringify(s).includes(token))
  const payload = { to: 'worker-b', kind: 'task', title: 'scoped', body: 'text', requestKey: 'bound' }
  await f.team.agentTool(token, 'team_propose_message', payload); assert.equal((await f.team.snapshot()).messages[0].from, 'worker')
  await assert.rejects(f.team.agentTool(token, 'team_propose_message', { ...payload, from: 'lead' }))
  await assert.rejects(f.team.agentTool('0'.repeat(64), 'team_members', {}), { code: 'TEAM_TOKEN' })
  await assert.rejects(f.team.agentTool(token, 'team_approve', {}), { code: 'TOOL_UNKNOWN' })
})

test('peers collaborate directly across groups and escalate a linked disagreement once', async t => {
  const f = await fixture(t)
  assert.equal((await f.team.snapshot()).peerMode, 'direct')
  await f.team.setPolicy({ policy: 'automatic' })
  const task = await f.propose()
  await f.team.flush()
  assert.deepEqual(f.sent.map(s => s.row.to), ['worker-b'])
  assert.deepEqual((await f.latest(task.id)).reviews, [])
  assert.match(f.sent[0].text, /直属上级提交分歧/)
  const ask = await f.team.propose('worker-b', { to: 'manager-b', kind: 'question', replyTo: task.id, title: '请决定接口版本', body: '甲方需要兼容，乙方希望简化。建议保留兼容层。', requestKey: 'decision' })
  await f.team.flush()
  const decision = await f.team.propose('manager-b', { to: 'worker-b', kind: 'result', replyTo: ask.id, title: '保留兼容层', body: '采用兼容方案。', requestKey: 'answer' })
  f.busy.clear(); await f.team.flush()
  assert.equal((await f.latest(decision.id)).state, 'delivered')
  await f.team.propose('worker-b', { to: 'worker', kind: 'result', replyTo: task.id, title: '接口决定', body: '保留兼容层。', requestKey: 'sync' })
  await f.team.flush()
  assert.deepEqual(f.sent.map(s => s.row.to), ['worker-b', 'manager-b', 'worker-b', 'worker'])
  await assert.rejects(f.propose('worker', 'lead', 'skip'), { code: 'TEAM_ROUTE' })
  await assert.rejects(f.propose('manager', 'manager-b', 'unlinked'), { code: 'TEAM_ROUTE' })
})

test('direct peers use an independent risk reviewer and an unresolved risk still needs the user', async t => {
  const f = await fixture(t)
  await f.team.setPolicy({ policy: 'ai' })
  const task = await f.propose()
  await f.team.flush()
  assert.deepEqual(f.sent.map(s => s.row.to), ['manager'])
  const row = await f.latest(task.id)
  assert.deepEqual(row.reviews.map(r => r.kind), ['risk'])
  await assert.rejects(f.team.review('worker', { messageId: row.id, reviewId: row.reviews[0].id, digest: row.digest, decision: 'approve', reason: 'self' }), { code: 'TEAM_REVIEW' })
  await f.verdict(task.id, 'manager', 'needs-user')
  assert.equal((await f.latest(task.id)).state, 'pending')
  const pending = await f.latest(task.id)
  await f.team.decide(task.id, { version: pending.version, decision: 'approve' }); await f.team.flush()
  assert.deepEqual(f.sent.map(s => s.row.to), ['manager', 'worker-b'])
})

test('root proposals surface to the user without a model turn; explicit forwarding checks the route and is idempotent', async t => {
  const f = await fixture(t)
  await f.team.setPolicy({ policy: 'ai' })
  const original = await f.propose('lead', 'manager', 'forward-source')
  await f.team.flush()
  assert.equal(f.sent.length, 0)
  assert.equal((await f.latest(original.id)).state, 'pending')
  await f.team.decide(original.id, { version: original.version, decision: 'approve' })
  await f.team.flush()
  const parent = await f.latest(original.id)
  assert.equal(parent.state, 'delivered')
  const input = { to: 'worker', title: '接手通知', body: '请阅读交接文档。', version: parent.version }
  await assert.rejects(f.team.forward(parent.id, { ...input, to: 'worker-b' }), { code: 'TEAM_ROUTE' })
  await assert.rejects(f.team.forward(parent.id, { ...input, version: 1 }), { code: 'TEAM_SOURCE' })
  const [a, b] = await Promise.all([f.team.forward(parent.id, input), f.team.forward(parent.id, input)])
  assert.equal(a.id, b.id)
  await f.team.flush()
  const row = await f.latest(a.id)
  assert.equal(row.from, 'manager'); assert.equal(row.replyTo, parent.id)
  assert.equal(row.audit[0].actor, 'user')
  assert.equal(row.reviews[0].reviewerId, 'lead')
  await f.verdict(a.id, 'lead'); await f.team.flush()
  assert.deepEqual(f.sent.map(x => x.row.to), ['manager', 'lead', 'worker'])
})

test('reopening a legacy self-review surfaces one pending user decision without replay', async t => {
  const f = await fixture(t)
  await f.team.setPolicy({ policy: 'ai' })
  const task = await f.propose('manager', 'worker', 'legacy-review')
  await f.team.flush()
  await f.team.close()
  const stored = JSON.parse(await readFile(f.file, 'utf8'))
  const old = stored.messages[0]
  old.reviews[0].reviewerId = old.from
  await writeFile(f.file, JSON.stringify(stored))
  const team = f.reopen()
  const pending = (await team.snapshot()).messages[0]
  await team.flush()
  assert.equal(pending.id, task.id)
  assert.equal(pending.state, 'pending')
  assert.equal(pending.reviews.length, 0)
  assert.ok(pending.version > old.version)
  assert.equal(f.sent.length, 1)
  await assert.rejects(team.review(old.from, { messageId: old.id, reviewId: old.reviews[0].id, digest: old.digest, decision: 'approve', reason: 'late' }), { code: 'TEAM_REVIEW' })
})

test('mode switches survive restart and legacy pending requests keep the original approvals', async t => {
  const f = await fixture(t)
  await f.team.setPeerMode({ peerMode: 'supervised' })
  const old = await f.propose()
  await f.team.setPeerMode({ peerMode: 'direct' })
  const fresh = await f.propose('worker-b', 'worker', 'fresh')
  await f.team.close()
  const stored = JSON.parse(await readFile(f.file, 'utf8'))
  delete stored.peerMode
  delete stored.messages[0].peerMode
  await writeFile(f.file, JSON.stringify(stored))
  const team = f.reopen()
  assert.equal((await team.snapshot()).peerMode, 'direct')
  await team.setPeerMode({ peerMode: 'supervised' })
  for (const row of [old, fresh]) await team.decide(row.id, { version: row.version, decision: 'approve' })
  await team.flush()
  const state = await team.snapshot()
  assert.equal(state.messages[0].reviews.length, 2)
  assert.equal(state.messages[1].state, 'delivered')
  assert.equal(parseTeam(JSON.parse(await readFile(f.file, 'utf8'))).peerMode, 'supervised')
})

test('same-parent peers use the configured direction and manual gate in both modes', async t => {
  const f = await fixture(t), state = await f.team.snapshot()
  state.edges.push({ id: 'managers', source: 'manager', target: 'manager-b', direction: 'forward' })
  await f.team.topology(topology(state))
  for (const mode of ['direct', 'supervised'] as const) {
    await f.team.setPeerMode({ peerMode: mode })
    await assert.rejects(f.propose('manager-b', 'manager', mode), { code: 'TEAM_ROUTE' })
    const task = await f.propose('manager', 'manager-b', mode)
    assert.equal(task.state, 'pending')
    await f.team.decide(task.id, { version: task.version, decision: 'approve' })
    await f.team.flush()
    const row = await f.latest(task.id)
    assert.deepEqual(row.reviews.map(r => r.reviewerId), mode === 'direct' ? [] : ['lead'])
    assert.equal(row.state, mode === 'direct' ? 'delivered' : 'reviewing')
    f.busy.clear()
  }
})

test('workload preferences survive reopen and workload only shows reachable direct children', async t => {
  const f = await fixture(t)
  await f.team.setDelegationPreference({ preference: 'local' })
  await assert.rejects(f.team.setDelegationPreference({ preference: 'any' }))
  const s = await f.team.snapshot()
  s.edges.find(e => e.target === 'worker')!.direction = 'backward'
  await f.team.topology(topology(s)); await f.team.close()
  const team = f.reopen()
  const read = async (id: string) => JSON.parse(await team.tool(id, 'team_members', { view: 'workload' }))
  const blocked = await read('manager')
  assert.equal(blocked.preference, 'local')
  assert.deepEqual(blocked.members.map((m: { id: string }) => m.id), ['manager'])
  const allowed = await read('manager-b')
  assert.deepEqual(allowed.members.map((m: { activity: string }) => m.activity), ['unknown', 'unknown'])
  assert.deepEqual(JSON.parse(await team.tool('manager-b', 'team_members', {})).workload, allowed)
})
