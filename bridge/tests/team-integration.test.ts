import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

async function fixture(pilot = true) {
  const parent = resolve('test-results'); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, 'team-http-')), cwd = resolve(root, 'workspace'), log = resolve(root, 'rpc.jsonl')
  await mkdir(cwd)
  const rpc = new CodexRpc({ command: process.execPath, args: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))], cwd,
    env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log }, timeoutMs: 2000 })
  const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'), false, { teamPilot: pilot })
  const app = createHttpServer({ bridge, dist: resolve('dist') })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`, response = await fetch(base + '/api/bootstrap'), boot = await response.json()
  const headers = { cookie: response.headers.get('set-cookie')!.split(';')[0], origin: base, 'x-bridge-token': boot.token, 'content-type': 'application/json' }
  const call = (path: string, data?: unknown, overrides = {}) => fetch(base + '/api' + path, { method: data ? 'POST' : 'GET', headers: { ...headers, ...overrides }, ...(data ? { body: JSON.stringify(data) } : {}) })
  const logs = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { root, cwd, rpc, bridge, boot, base, call, logs, close: async () => { await app.close(); await rm(root, { recursive: true, force: true }) } }
}
async function until<T>(fn: () => Promise<T | undefined>) {
  const end = Date.now() + 4000
  do { const result = await fn(); if (result !== undefined) return result; await new Promise(resolve => setTimeout(resolve, 15)) } while (Date.now() < end)
  throw new Error('Protocol assertion timed out')
}

test('ordinary instances expose no team API or tools and shared history cannot enable pilot', async () => {
  const f = await fixture(false)
  try {
    assert.equal(f.boot.capabilities.teamPilot, false)
    assert.equal((await f.call('/team')).status, 404)
    assert.equal((await f.call('/team/setup', {})).status, 404)
    await f.bridge.create(f.cwd)
    const started = (await f.logs()).find(row => row.method === 'thread/start')
    assert.ok(!started.params.dynamicTools.some((tool: { name: string }) => tool.name.startsWith('team_')))
    assert.throws(() => new Bridge(f.rpc, new Workspace(f.cwd), resolve(f.root, 'home'), resolve(f.root, 'data'), true, { teamPilot: true }), /独立/)
  } finally { await f.close() }
})

test('native source binding and authenticated approvals deliver once, only after a busy recipient finishes', async () => {
  const f = await fixture()
  try {
    assert.equal(f.boot.capabilities.teamPilot, true)
    assert.equal((await f.call('/team/members', {}, { origin: 'https://foreign.invalid' })).status, 403)
    assert.equal((await f.call('/team/members', {}, { 'x-bridge-token': 'wrong' })).status, 403)
    assert.equal((await f.call('/team/setup', {})).status, 404, 'No creation endpoint bypasses user approval')
    let parentId = null
    for (let level = 1; level <= 3; level++) {
      const proposed = await f.call('/team/members', { name: `level-${level}`, level, parentId, groupId: null, requestKey: `member-${level}` })
      assert.equal(proposed.status, 200)
      const request = await proposed.json()
      assert.equal((await f.logs()).filter(row => row.method === 'thread/start').length, level - 1)
      const approved = await f.call(`/team/members/${request.id}/decision`, { version: 1, decision: 'approve' })
      assert.equal(approved.status, 200)
      parentId = (await approved.json()).members.at(-1).threadId
      assert.equal((await f.call(`/team/members/${request.id}/decision`, { version: 1, decision: 'approve' })).status, 409)
    }
    const [lead, manager, worker] = (await f.bridge.team!.snapshot()).members
    await f.call('/team/enabled', { enabled: true })
    assert.equal((await f.logs()).filter(row => row.method === 'thread/start').length, 3)
    assert.equal((await f.call('/workspaces', { path: resolve(f.cwd, '..') })).status, 403)
    for (const row of (await f.logs()).filter(row => row.method === 'thread/start')) {
      assert.equal(row.params.sandbox, 'read-only')
      assert.equal(row.params.approvalPolicy, 'on-request')
      assert.equal(row.params.dynamicTools.filter((tool: { name: string }) => tool.name.startsWith('team_')).length, 5)
      assert.ok(!row.params.dynamicTools.some((tool: { name: string }) => tool.name === 'team_approve'))
    }
    const proposal = { to: manager.threadId, kind: 'task', title: '审批正文', body: '仅用于试验，7+5', requestKey: 'http-1' }
    // Use the same inbound native request path as a real model; source identity
    // is transport threadId, never supplied by the proposed payload.
    f.rpc.emit('request', { id: 99991, method: 'item/tool/call', params: { threadId: lead.threadId, tool: 'team_propose_message', arguments: proposal } })
    const reply = await until(async () => (await f.logs()).find(row => row.id === 99991 && row.result))
    assert.equal(reply.result.success, true)
    const proposed = (await f.bridge.team!.snapshot()).messages[0]
    assert.equal(proposed.from, lead.threadId)
    assert.equal((await f.logs()).filter(row => row.method === 'turn/start').length, 0)
    assert.deepEqual(JSON.parse(await f.bridge.team!.tool(manager.threadId, 'team_inbox', {})).received, [])
    assert.equal((await f.call(`/team/messages/${proposed.id}/decision`, { version: 1, decision: 'approve' }, { 'x-bridge-token': 'wrong' })).status, 403)
    await f.bridge.message(manager.threadId, { text: '等待用户任务', mode: 'read-only' })
    assert.equal((await f.call(`/team/messages/${proposed.id}/decision`, { version: 1, decision: 'approve', body: '审批后修改的正文：7+5' })).status, 200)
    await f.bridge.team!.flush()
    assert.equal((await f.bridge.team!.snapshot()).messages[0].state, 'waiting')
    await f.rpc.call('test/finish', { threadId: manager.threadId })
    // The dispatcher may start the next turn before a busy test runner can
    // observe a transient idle frame. Verify durable delivery instead.
    await until(async () => { await f.bridge.team!.flush(); return (await f.bridge.team!.snapshot()).messages[0].state === 'delivered' ? true : undefined })
    assert.equal((await f.bridge.team!.snapshot()).messages[0].state, 'delivered')
    const turns = (await f.logs()).filter(row => row.method === 'turn/start')
    assert.equal(turns.length, 2)
    assert.equal(turns[1].params.threadId, manager.threadId)
    assert.equal(turns[1].params.clientUserMessageId, proposed.deliveryId)
    assert.equal(turns[1].params.sandboxPolicy.type, 'readOnly')
    assert.match(JSON.stringify(turns[1].params.input), /审批后修改的正文/)
    assert.equal((await f.logs()).filter(row => row.method === 'turn/steer').length, 0)
    assert.equal((await f.call(`/team/messages/${proposed.id}/decision`, { version: 1, decision: 'approve' })).status, 409)
    await f.bridge.team!.flush()
    assert.equal((await f.logs()).filter(row => row.method === 'turn/start').length, 2)
    // A response whose first HTTP result was lost resolves to the original
    // native submission even after that submission has proposed a request.
    const key = randomUUID()
    assert.equal((await f.call('/team/start', { clientMessageId: key })).status, 200)
    await f.bridge.team!.propose(lead.threadId, { ...proposal, requestKey: 'another-pending' })
    assert.equal((await f.call('/team/start', { clientMessageId: key })).status, 200)
    assert.equal((await f.call('/team/start', { clientMessageId: randomUUID() })).status, 409)
    assert.ok(!f.bridge.threads.get(worker.threadId)?.items.length, 'Uninvolved third session remains untouched')
  } finally { await f.close() }
})

test('native startup failure keeps the pilot review entry and durable records accessible', async () => {
  const f = await fixture()
  try {
    const state = await f.bridge.setupTeamPilot(), [lead, manager] = state.members
    const row = await f.bridge.team!.propose(lead.threadId, { to: manager.threadId, kind: 'task', title: '离线审批', body: '保留待审内容', requestKey: 'offline' })
    f.bridge.bootstrap = async () => { throw new Error('native unavailable') }
    const boot = await (await f.call('/bootstrap')).json()
    assert.equal(boot.capabilities.teamPilot, true)
    assert.equal(boot.runtime.state, 'failed')
    const view = await (await f.call('/team')).json()
    assert.equal(view.messages[0].id, row.id)
    assert.equal((await f.call(`/team/messages/${row.id}/decision`, { version: 1, decision: 'reject' })).status, 200)
    assert.equal((await f.bridge.team!.snapshot()).messages[0].state, 'rejected')
  } finally { await f.close() }
})

test('legacy MCP endpoint accepts only session credentials and cannot authorize browser management', async () => {
  const f = await fixture()
  try {
    const state = await f.bridge.setupTeamPilot(), [lead, manager] = state.members
    const token = await f.bridge.team!.toolToken(lead.threadId)
    const call = (path: string, data: object, extra = {}) => fetch(f.base + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cweb-team-token': token, ...extra }, body: JSON.stringify(data) })
    const data = { name: 'team_propose_message', arguments: { to: manager.threadId, kind: 'task', title: 'scoped MCP', body: 'text', requestKey: 'mcp' } }
    assert.equal((await call('/team/tool', data, { origin: f.base })).status, 403)
    assert.equal((await call('/team/tool', data, { 'x-cweb-team-token': '0'.repeat(64) })).status, 403)
    assert.equal((await call('/team/tool', data)).status, 200)
    const message = (await f.bridge.team!.snapshot()).messages[0]
    assert.equal(message.from, lead.threadId)
    assert.equal((await call(`/team/messages/${message.id}/decision`, { version: 1, decision: 'approve' })).status, 401)
    assert.equal((await call('/team/tool', { name: 'team_approve', arguments: {} })).status, 400)
    assert.equal((await f.bridge.team!.snapshot()).messages[0].state, 'pending')
    assert.equal((await f.logs()).filter(r => r.method === 'turn/start').length, 0)
  } finally { await f.close() }
})
