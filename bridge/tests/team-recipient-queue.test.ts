import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'
import type { TeamService } from '../server/team.ts'

// The real Bridge, durable ledger and native submission journal run against a
// fake CLI child. No user workspace/session, shell task or real model is used.
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)) } while (Date.now() < deadline)
  assert.fail(`Timed out: ${label}`)
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/team-recipient-queue-')), cwd = resolve(root, 'project'), log = resolve(root, 'rpc.jsonl')
  await mkdir(cwd)
  let rpc!: CodexRpc, bridge!: Bridge, app!: ReturnType<typeof createHttpServer>, team!: TeamService, workspaceId = '', sequence = 0
  async function start() {
    rpc = new CodexRpc({ command: process.execPath, args: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))], cwd,
      env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log }, timeoutMs: 2000 })
    bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'), false, { workspaceTeams: true })
    app = createHttpServer({ bridge, dist: resolve('dist') })
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
    const boot = await bridge.bootstrap(); workspaceId = boot.workspaces[0].id
    await bridge.plugin.setEnabled(false)
    team = await bridge.teamForWorkspace(workspaceId)
  }
  await start()
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  await team.enable(true)
  async function member(name: string, level: number, parentId: string | null = null) {
    const native = await bridge.create(cwd, 'fixture-next', 'medium'); await bridge.rename(native.id, name)
    await bridge.importTeamMember(workspaceId, { threadId: native.id, level, parentId, groupId: null })
    return native.id
  }
  const lead = await member('负责人', 1), manager = await member('收件主管', 2, lead)
  const workerA = await member('执行会话 A', 3, manager), workerB = await member('执行会话 B', 3, manager)
  const logs = async (): Promise<any[]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const starts = async (id = manager) => (await logs()).filter(row => row.method === 'turn/start' && row.params.threadId === id)
  const latest = async (id: string) => (await team.snapshot()).messages.find(row => row.id === id)!
  async function propose(from: string, to = manager, approve = true, detail = '') {
    const key = `queued-${++sequence}`, body = `等待隔离测试逐轮完成 ${key}\n${detail}`.trim()
    const row = await team.propose(from, { to, kind: 'task', title: key, body, requestKey: key })
    if (approve) await team.decide(row.id, { version: row.version, decision: 'approve' })
    return latest(row.id)
  }
  async function finish(id = manager) {
    const old = bridge.threads.get(id)?.turnId
    assert.ok(old, 'The fixture must explicitly finish an active native turn')
    await rpc.call('test/finish', { threadId: id })
    await until(() => bridge.threads.get(id)?.runs?.some(run => run.id === old && run.status === 'completed') === true, 'native turn completed')
    await team.flush()
  }
  async function delivered(id: string) { await until(async () => { await team.flush(); return (await latest(id)).state === 'delivered' }, `delivery ${id}`) }
  return { get bridge() { return bridge }, get rpc() { return rpc }, get team() { return team }, lead, manager, workerA, workerB,
    member, propose, latest, starts, logs, finish, delivered,
    async requestBatch(firstId: string) {
      const address = app.server.address()
      assert.ok(address && typeof address === 'object')
      const base = `http://127.0.0.1:${address.port}`
      const response = await fetch(`${base}/api/bootstrap`)
      const { token } = await response.json() as { token: string }
      const cookie = response.headers.get('set-cookie')!.split(';')[0]
      return fetch(`${base}/api/team/queue/batch?workspace=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': token, origin: base, cookie },
        body: JSON.stringify({ threadId: manager, firstId }),
      })
    },
    restart: async () => { await app.close(); await start() },
    async idleStart() { await bridge.message(manager, { text: '等待现有用户任务完成', mode: 'read-only' }) },
  }
}

test('approved requests share one native turn; pending requests are excluded and new arrivals form their own batch', async t => {
  const f = await fixture(t); await f.idleStart()
  const unapproved = await f.propose(f.workerA, f.manager, false)
  const firstBatch = [await f.propose(f.lead), await f.propose(f.workerA), await f.propose(f.workerB)]
  await f.team.flush()
  assert.equal((await f.starts()).length, 1)
  assert.deepEqual(JSON.parse(await f.team.tool(f.manager, 'team_inbox', {})).received, [])
  const gateSend = gate(), nativeCall = f.rpc.call.bind(f.rpc)
  let startingBatch = false
  f.rpc.call = async (method, value = {}) => {
    if (method === 'turn/start' && !startingBatch) { startingBatch = true; await gateSend.promise }
    return nativeCall(method, value)
  }
  const current = f.finish()
  let secondBatch: typeof firstBatch
  try {
    await until(() => startingBatch, 'batch has been claimed before submitting')
    secondBatch = [await f.propose(f.workerB), await f.propose(f.lead), await f.propose(f.workerA)]
  } finally { gateSend.release() }
  await current
  for (const row of firstBatch) await f.delivered(row.id)
  assert.equal((await f.starts()).length, 2)
  await f.finish()
  for (const row of secondBatch) await f.delivered(row.id)
  const deliveries = (await f.starts()).slice(1)
  assert.equal(deliveries.length, 2)
  for (const [i, batch] of [firstBatch, secondBatch].entries()) {
    const { input, clientUserMessageId } = deliveries[i].params
    assert.equal(input.length, 1)
    let cursor = -1
    for (const row of batch) {
      const index = input[0].text.indexOf(row.body)
      assert.ok(index > cursor, 'Original text remains in queue order')
      cursor = index
      assert.ok(input[0].text.includes(row.id))
      const delivered = await f.latest(row.id)
      assert.equal(delivered.batchId, clientUserMessageId)
      assert.equal(delivered.deliveryId, row.deliveryId)
    }
    assert.ok(!input[0].text.includes(unapproved.body))
    assert.ok(!(i ? firstBatch : secondBatch).some(row => input[0].text.includes(row.body)))
  }
  assert.equal((await f.latest(unapproved.id)).state, 'pending')
  const received = JSON.parse(await f.team.tool(f.manager, 'team_inbox', {})).received
  assert.deepEqual(received.map((row: { id: string }) => row.id), [...firstBatch, ...secondBatch].map(row => row.id))
  assert.ok(!JSON.stringify(received).includes(unapproved.body))
  await f.finish(); await f.team.flush()
  assert.equal((await f.starts()).length, 3)
  assert.equal((await f.logs()).filter(row => ['turn/steer', 'turn/interrupt'].includes(row.method)).length, 0)
})

test('a newly constructed TeamService and Bridge retain every queued delivery and its identity across a reload', async t => {
  const f = await fixture(t); await f.idleStart()
  const messages = [await f.propose(f.lead), await f.propose(f.workerA), await f.propose(f.workerB)]
  await f.team.flush()
  const identity = (row: typeof messages[number]) => ({ id: row.id, deliveryId: row.deliveryId, body: row.body, approvedDigest: row.approvedDigest })
  const before = (await f.team.snapshot()).messages.map(identity)
  await f.restart(); await f.team.flush()
  assert.deepEqual((await f.team.snapshot()).messages.map(identity), before)
  assert.equal((await f.starts()).length, 1)
  await f.finish()
  for (const row of messages) await f.delivered(row.id)
  assert.equal((await f.starts()).length, 2)
  assert.deepEqual((await f.team.snapshot()).messages.map(identity), before)
})

test('one click schedules two approved requests even while busy, survives reload, and runs after Tab messages', async t => {
  const f = await fixture(t); await f.idleStart()
  const first = await f.propose(f.lead), second = await f.propose(f.workerA)
  assert.equal((await f.requestBatch(second.id)).status, 409, 'Stale queue head cannot change a different batch')
  assert.equal((await f.requestBatch(first.id)).status, 200)
  await f.restart(); await f.team.flush()
  assert.equal((await f.latest(first.id)).batchRequested, true)
  const text = '等待用户 Tab 消息优先'
  await f.bridge.enqueue(f.manager, { text, mode: 'read-only' })
  await f.finish()
  await until(async () => (await f.starts()).at(-1)?.params.input[0].text === text, 'user Tab goes first')
  await f.finish(); await f.delivered(first.id); await f.delivered(second.id)
  assert.equal((await f.starts()).length, 3)
  assert.equal((await f.latest(first.id)).batchId, (await f.latest(second.id)).batchId)
  assert.ok((await f.latest(first.id)).batchId)
})

test('ordinary tasks and supervisor reviews share a recipient FIFO and never steer or replace its active task', async t => {
  const f = await fixture(t)
  const otherManager = await f.member('另一主管', 2, f.lead), otherWorker = await f.member('跨组接收会话', 3, otherManager)
  const state = await f.team.snapshot()
  state.edges.push({ id: 'peer-queue', source: f.workerA, target: otherWorker, direction: 'both' })
  await f.team.topology({ graphVersion: state.graphVersion, members: state.members, groups: state.groups, edges: state.edges, levels: state.levels })
  await f.idleStart()
  const first = await f.propose(f.lead), peer = await f.propose(f.workerA, otherWorker), next = await f.propose(f.workerB), last = await f.propose(f.lead)
  await f.team.flush()
  const peerBefore = await f.latest(peer.id)
  assert.equal(peerBefore.reviews.find(row => row.reviewerId === otherManager)!.state, 'sent')
  assert.equal(peerBefore.reviews.find(row => row.reviewerId === f.manager)!.state, 'pending')
  await f.finish(); await f.delivered(first.id)
  await f.finish()
  await until(async () => (await f.latest(peer.id)).reviews.find(row => row.reviewerId === f.manager)?.state === 'sent', 'second turn is a supervisor review')
  assert.equal((await f.starts()).length, 3)
  assert.notEqual((await f.latest(last.id)).state, 'delivered')
  const review = (await f.latest(peer.id)).reviews.find(row => row.reviewerId === f.manager)!
  await f.team.review(f.manager, { messageId: peer.id, reviewId: review.id, digest: review.digest, decision: 'approve', reason: '隔离测试允许通信' })
  assert.equal((await f.latest(peer.id)).state, 'reviewing', 'The other supervisor is still required')
  await f.finish(); await f.delivered(next.id)
  await f.finish(); await f.delivered(last.id)
  const rows = (await f.starts()).slice(1)
  assert.deepEqual(rows.map(row => row.params.clientUserMessageId), [first.deliveryId, review.deliveryId, next.deliveryId, last.deliveryId])
  assert.match(rows[1].params.input[0].text, /团队审核 · 仅审核/)
  assert.equal(rows[1].params.sandboxPolicy.type, 'readOnly')
  assert.equal((await f.starts(otherWorker)).length, 0)
  assert.equal((await f.logs()).filter(row => row.method === 'turn/steer').length, 0)
})

test('Tab user messages queued during an active turn run before the durable team backlog, without merging either queue', async t => {
  const f = await fixture(t); await f.idleStart()
  const first = await f.propose(f.lead), second = await f.propose(f.workerA)
  await f.team.flush()
  const tabs = ['等待用户 Tab 第一条', '等待用户 Tab 第二条']
  for (const text of tabs) await f.bridge.enqueue(f.manager, { text, mode: 'read-only' })
  for (const text of tabs) {
    await f.finish()
    await until(async () => (await f.starts()).at(-1)?.params.input[0].text === text, 'user Tab takes precedence')
    assert.notEqual((await f.latest(first.id)).state, 'delivered')
  }
  await f.finish(); await f.delivered(first.id)
  await f.finish(); await f.delivered(second.id)
  const turns = await f.starts()
  assert.deepEqual(turns.slice(1, 3).map(row => row.params.input[0].text), tabs)
  assert.deepEqual(turns.slice(3).map(row => row.params.clientUserMessageId), [first.deliveryId, second.deliveryId])
  assert.equal(f.bridge.queue().length, 0)
  assert.equal((await f.logs()).filter(row => row.method === 'turn/steer').length, 0)
})

test('a Tab message arriving during team preparation still takes precedence before native submission commits', async t => {
  const f = await fixture(t), paused = gate()
  const nativeCall = f.rpc.call.bind(f.rpc)
  let preparing = false
  f.rpc.call = async (method, value = {}) => {
    const params = value as Record<string, unknown>
    if (method === 'thread/inject_items' && params.threadId === f.manager && !preparing) { preparing = true; await paused.promise }
    return nativeCall(method, value)
  }
  t.after(() => { paused.release() })
  const request = await f.propose(f.lead), flight = f.team.flush()
  await until(() => preparing, 'team preparation before turn/start')
  assert.equal((await f.starts()).length, 0)
  const text = '等待在准备期间排队的用户 Tab 消息'
  await f.bridge.enqueue(f.manager, { text, mode: 'read-only' })
  assert.equal(f.bridge.queue().length, 1)
  paused.release(); await flight
  await until(async () => (await f.starts()).length > 0, 'first native submission')
  assert.equal((await f.starts())[0].params.input[0].text, text)
  assert.equal(f.bridge.queue().length, 0, 'The skipped Tab drain is woken when team preparation yields')
  assert.equal(await f.bridge.submissions.get(f.manager, request.deliveryId), undefined, 'A known pre-submit BUSY receipt is cleared so the original delivery can resume')
  assert.notEqual((await f.latest(request.id)).state, 'delivered')
  await f.finish(); await f.delivered(request.id)
  const starts = await f.starts()
  assert.deepEqual(starts.map(row => row.params.clientUserMessageId).filter(Boolean), [request.deliveryId])
  assert.ok(starts[1].params.input[0].text.includes(request.body))
  assert.equal((await f.latest(request.id)).body, request.body)
  assert.equal((await f.logs()).filter(row => row.method === 'turn/steer').length, 0)
})

test('an unknown batch acknowledgment survives reload and one member receipt settles the whole batch', async t => {
  const f = await fixture(t); await f.idleStart()
  const nativeCall = f.rpc.call.bind(f.rpc)
  let lost = false
  f.rpc.call = async (method, value = {}) => {
    const result = await nativeCall(method, value)
    if (method === 'turn/start' && (value as Record<string, unknown>).threadId === f.manager && !lost) { lost = true; throw new Error('synthetic lost native acknowledgment') }
    return result
  }
  const rows = [await f.propose(f.lead), await f.propose(f.workerA), await f.propose(f.workerB)]
  await f.finish()
  const batchId = (await f.latest(rows[0].id)).batchId
  assert.ok(batchId)
  const later = await f.propose(f.lead)
  assert.equal((await f.starts()).length, 2)
  await f.restart(); await f.team.flush(); await f.team.flush()
  for (const row of rows) {
    const latest = await f.latest(row.id)
    assert.equal(latest.state, 'uncertain')
    assert.equal(latest.body, row.body)
    assert.equal(latest.batchId, batchId)
  }
  assert.equal((await f.latest(later.id)).state, 'approved')
  assert.equal((await f.starts()).length, 2, 'Neither the unknown batch nor its successor is resent')
  // Complete the persisted fake turn explicitly. After an engine reload the
  // web projection must not assume an old, unacknowledged task is still live.
  await f.bridge.open(f.manager)
  await f.rpc.call('test/finish', { threadId: f.manager })
  const reconciled = await f.team.reconcile(rows[1].id)
  assert.equal('receipt' in reconciled && reconciled.receipt, 'accepted')
  for (const row of rows) assert.equal((await f.latest(row.id)).state, 'delivered')
  await f.delivered(later.id)
  assert.deepEqual((await f.starts()).slice(1).map(row => row.params.clientUserMessageId), [batchId, later.deliveryId])
})

test('long messages are split at the batch budget without truncating any original text', async t => {
  const f = await fixture(t); await f.idleStart()
  const rows = []
  for (let i = 0; i < 6; i++) rows.push(await f.propose(f.lead, f.manager, true, '正文'.repeat(3970) + `尾部 ${i}`))
  await f.finish()
  for (const row of rows.slice(0, 3)) await f.delivered(row.id)
  const first = (await f.starts()).at(-1)!.params.input[0].text
  assert.ok(rows.slice(0, 3).every(row => first.includes(row.body)))
  assert.ok(rows.slice(3).every(row => !first.includes(row.body)))
  await f.finish()
  for (const row of rows.slice(3)) await f.delivered(row.id)
  const second = (await f.starts()).at(-1)!.params.input[0].text
  assert.ok(rows.slice(3).every(row => second.includes(row.body)))
  assert.equal((await f.starts()).length, 3)
})
