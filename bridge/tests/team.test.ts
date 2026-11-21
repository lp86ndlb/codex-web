import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamService, type TeamAdapter } from '../server/team.ts'
import { BridgeError } from '../server/errors.ts'
import type { TeamMessage } from '../shared/team.ts'

async function fixture(t: { after: (fn: () => Promise<void>) => void }, overrides: Partial<TeamAdapter> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cweb-team-')), file = join(dir, 'team.json'), sent: TeamMessage[] = []
  const adapter: TeamAdapter = { available: async () => null, send: async row => { sent.push(row) }, receipt: async () => 'unknown', changed: () => {}, ...overrides }
  const services: TeamService[] = []
  const reopen = () => { const service = new TeamService(file, adapter); services.push(service); return service }
  const team = reopen()
  t.after(async () => { for (const service of services) await service.close(); await rm(dir, { recursive: true, force: true }) })
  for (const role of ['lead', 'manager', 'worker'] as const) await team.register({ role, threadId: role, name: role, cwd: '/isolated' })
  await team.enable(true)
  const propose = (body = 'please compute', extra = {}) => team.propose('lead', { to: 'manager', kind: 'task', title: 'task', body, requestKey: 'once', ...extra })
  return { team, file, sent, reopen, propose }
}

test('unapproved and rejected text never reaches the recipient inbox or executor', async t => {
  const { team, sent, propose } = await fixture(t)
  const pending = await propose('private pending text')
  await team.flush()
  assert.equal(sent.length, 0)
  assert.ok(!(await team.tool('manager', 'team_inbox', {})).includes('private pending text'))
  await team.decide(pending.id, { version: 1, decision: 'reject', note: 'scope is wrong' })
  await team.flush()
  assert.equal(sent.length, 0)
  assert.ok(!(await team.tool('manager', 'team_inbox', {})).includes('private pending text'))
  assert.match(await team.tool('lead', 'team_inbox', {}), /scope is wrong/)
})

test('three independent members complete task delegation and separately approved feedback', async t => {
  const { team, sent, propose } = await fixture(t)
  const task = await propose()
  await team.decide(task.id, { version: 1, decision: 'approve' }); await team.flush()
  const child = await team.propose('manager', { to: 'worker', kind: 'task', title: 'compute', body: '7+5', requestKey: 'child', replyTo: task.id })
  assert.equal(sent.length, 1)
  await team.decide(child.id, { version: 1, decision: 'approve' }); await team.flush()
  const result = await team.propose('worker', { to: 'manager', kind: 'result', title: 'result', body: '12', requestKey: 'result', replyTo: child.id })
  assert.equal(sent.length, 2)
  await team.decide(result.id, { version: 1, decision: 'approve' }); await team.flush()
  const summary = await team.propose('manager', { to: 'lead', kind: 'result', title: 'summary', body: 'worker returned 12', requestKey: 'summary', replyTo: task.id })
  await team.decide(summary.id, { version: 1, decision: 'approve' }); await team.flush()
  assert.deepEqual(sent.map(row => [row.from, row.to]), [['lead', 'manager'], ['manager', 'worker'], ['worker', 'manager'], ['manager', 'lead']])
  assert.ok((await team.snapshot()).messages.every(row => row.state === 'delivered'))
})

test('simultaneous approval, proposal retries and stale versions cannot duplicate delivery', async t => {
  const { team, sent, propose } = await fixture(t)
  const task = await propose()
  assert.equal((await propose()).id, task.id)
  await assert.rejects(propose('different body'), { code: 'TEAM_KEY_CONFLICT' })
  const answers = await Promise.allSettled([team.decide(task.id, { version: 1, decision: 'approve' }), team.decide(task.id, { version: 1, decision: 'approve' })])
  assert.equal(answers.filter(row => row.status === 'fulfilled').length, 1)
  await team.flush(); await team.flush()
  assert.equal(sent.length, 1)
  await assert.rejects(team.decide(task.id, { version: 1, decision: 'approve' }), { code: 'TEAM_STALE' })
})

test('reviewer edits bind approval to the exact new body while original retry is deduplicated', async t => {
  const { team, sent, propose } = await fixture(t)
  const task = await propose('original')
  await team.decide(task.id, { version: 1, decision: 'approve', body: 'revised by user' })
  await team.flush()
  assert.equal(sent[0].body, 'revised by user')
  assert.equal(sent[0].digest, sent[0].approvedDigest)
  assert.equal((await propose('original')).id, task.id)
  assert.match(team.envelope(sent[0], (await team.snapshot()).members), /正文经管理员修改/)
})

test('busy recipients wait durably, while pause and cancellation prevent later execution', async t => {
  let busy = true
  const { team, sent, propose, reopen } = await fixture(t, { available: async () => busy ? 'busy' : null })
  const task = await propose()
  await team.decide(task.id, { version: 1, decision: 'approve' }); await team.flush()
  assert.equal((await team.snapshot()).messages[0].state, 'waiting')
  assert.equal(sent.length, 0)
  await team.close()
  const second = reopen(); await second.initialize(); await second.enable(false); busy = false
  await second.flush(); assert.equal(sent.length, 0)
  await second.enable(true); await second.flush(); assert.equal(sent.length, 1)
  const another = await second.propose('lead', { to: 'manager', kind: 'task', title: 'second', body: 'cancel me', requestKey: 'cancel' })
  await second.enable(false)
  await second.decide(another.id, { version: 1, decision: 'approve' })
  const version = (await second.snapshot()).messages.find(row => row.id === another.id)!.version
  await second.decide(another.id, { version, decision: 'cancel' }); await second.enable(true); await second.flush()
  assert.equal(sent.length, 1)
})

test('lost RPC response stays uncertain across restart; reconciliation never resends', async t => {
  let calls = 0, acknowledged = false
  const { team, propose, reopen } = await fixture(t, { send: async () => { calls++; throw new Error('response lost') }, receipt: async () => acknowledged ? 'accepted' : 'unknown' })
  const task = await propose(); await team.decide(task.id, { version: 1, decision: 'approve' }); await team.flush()
  assert.equal((await team.snapshot()).messages[0].state, 'uncertain')
  await team.close()
  const second = reopen(); await second.initialize(); await second.flush(); await second.reconcile(task.id)
  assert.equal(calls, 1)
  acknowledged = true; await second.reconcile(task.id)
  assert.equal((await second.snapshot()).messages[0].state, 'delivered')
  assert.equal(calls, 1)
})

test('source identity, management edges, workspace and task-result binding are enforced', async t => {
  const { team } = await fixture(t)
  const raw = { to: 'manager', kind: 'task', title: 'task', body: 'body', requestKey: 'x' }
  await assert.rejects(team.propose('outsider', raw), { code: 'TEAM_MEMBER' })
  await assert.rejects(team.propose('lead', { ...raw, to: 'worker' }), { code: 'TEAM_ROUTE' })
  await assert.rejects(team.propose('lead', { ...raw, from: 'manager' }))
  await assert.rejects(team.propose('worker', { ...raw, kind: 'result' }), { code: 'TEAM_REPLY' })
  await assert.rejects(team.tool('worker', 'team_approve', {}), { code: 'TOOL_UNKNOWN' })
  await assert.rejects(team.register({ role: 'worker', threadId: 'other', name: 'other', cwd: '/actual-project' }))
})

test('approval cancelled while availability is being checked is not delivered', async t => {
  let release!: (value: string | null) => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const { team, sent, propose } = await fixture(t, { available: async () => { entered(); return new Promise(resolve => { release = resolve }) } })
  const task = await propose(); await team.decide(task.id, { version: 1, decision: 'approve' })
  const dispatch = team.flush(); await started
  const version = (await team.snapshot()).messages[0].version
  await team.decide(task.id, { version, decision: 'cancel' }); release(null); await dispatch
  assert.equal(sent.length, 0)
})

test('interrupted sending and changed content are rechecked after restart', async t => {
  const { team, file, sent, propose, reopen } = await fixture(t)
  const task = await propose(); await team.enable(false); await team.decide(task.id, { version: 1, decision: 'approve' }); await team.close()
  const data = JSON.parse(await readFile(file, 'utf8')); data.messages[0].state = 'sending'; data.enabled = true
  await writeFile(file, JSON.stringify(data))
  const second = reopen(); await second.initialize(); await second.flush()
  assert.equal((await second.snapshot()).messages[0].state, 'uncertain'); assert.equal(sent.length, 0)
  await second.close(); data.messages[0].state = 'approved'; data.messages[0].body = 'tampered'
  await writeFile(file, JSON.stringify(data))
  const third = reopen(); await third.initialize(); await third.flush()
  assert.equal((await third.snapshot()).messages[0].state, 'pending'); assert.equal(sent.length, 0)
})

test('known preflight busy can be retried without treating an unknown outcome as safe', async t => {
  let attempt = 0
  const { team, propose } = await fixture(t, { send: async () => { if (++attempt === 1) throw new BridgeError('BUSY', 'became busy', 409) } })
  const task = await propose(); await team.decide(task.id, { version: 1, decision: 'approve' }); await team.flush(); await team.flush()
  assert.equal(attempt, 2); assert.equal((await team.snapshot()).messages[0].state, 'delivered')
})
