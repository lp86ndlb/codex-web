import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'
import type { TeamSnapshot } from '../shared/team.ts'

async function fixture(sharedHistory = false, pilot = false) {
  const parent = resolve('test-results'); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, 'workspace-teams-')), cwd = resolve(root, 'project-a'), log = resolve(root, 'rpc.jsonl')
  await mkdir(cwd)
  const rpc = new CodexRpc({ command: process.execPath, args: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))], cwd,
    env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log }, timeoutMs: 2000 })
  const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'), sharedHistory, pilot ? { teamPilot: true } : { workspaceTeams: true })
  const app = createHttpServer({ bridge, dist: resolve('dist') })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`, response = await fetch(base + '/api/bootstrap'), boot = await response.json()
  const headers = { cookie: response.headers.get('set-cookie')!.split(';')[0], origin: base, 'x-bridge-token': boot.token, 'content-type': 'application/json' }
  const call = (path: string, data?: unknown, overrides = {}) => fetch(base + '/api' + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...headers, ...overrides }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
  const logs = async (): Promise<any[]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const addWorkspace = async (name: string) => { const path = resolve(root, name); await mkdir(path, { recursive: true }); return bridge.catalog.add(path) }
  const importThread = (workspace: string, threadId: string, level = 1, parentId: string | null = null) => call(`/team/members/import?workspace=${workspace}`, { threadId, level, parentId, groupId: null })
  return { root, cwd, rpc, bridge, boot, base, call, logs, addWorkspace, importThread,
    workspaceId: boot.workspaces[0].id as string, close: async () => { await app.close(); await rm(root, { recursive: true, force: true }) } }
}
async function jsonOk(response: Response) {
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  return value
}
async function until<T>(fn: () => Promise<T | undefined>) {
  const end = Date.now() + 4000
  do { const value = await fn(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 15)) } while (Date.now() < end)
  throw new Error('Workspace team assertion timed out')
}
const modelMutations = (rows: any[]) => rows.filter(row => ['thread/start', 'thread/resume', 'thread/unsubscribe', 'thread/revert', 'thread/fork', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(row.method))
const nativeHistory = (value: unknown) => { const { status: _status, ...thread } = value as Record<string, unknown>; return thread }

for (const sharedHistory of [false, true]) test(`production teams are opt-in per workspace and preserve normal creation settings (sharedHistory=${sharedHistory})`, async () => {
  const f = await fixture(sharedHistory)
  try {
    assert.equal(f.boot.capabilities.teamMode, true)
    assert.equal(f.boot.capabilities.teamPilot, false)
    const other = await f.addWorkspace('project-b')
    const a = await f.bridge.teamForWorkspace(f.workspaceId), b = await f.bridge.teamForWorkspace(other.id)
    assert.notEqual(a, b)
    assert.equal((await a.snapshot()).enabled, false)
    assert.equal((await b.snapshot()).enabled, false)
    assert.equal(await f.bridge.teamForThread('unassigned-native-thread'), undefined)
    const index = await jsonOk(await f.call('/teams'))
    assert.deepEqual(index.workspaces.map((row: { id: string }) => row.id).sort(), [f.workspaceId, other.id].sort())
    assert.ok(index.workspaces.every((row: { enabled: boolean; members: number }) => !row.enabled && row.members === 0))
    await jsonOk(await f.call(`/team/enabled?workspace=${f.workspaceId}`, { enabled: true }))
    assert.equal((await a.snapshot()).enabled, true)
    assert.equal((await b.snapshot()).enabled, false)
    await f.bridge.updatePreferences({ mode: 'workspace-write', approvalPolicy: 'on-request' })
    const ordinary = await f.bridge.create(f.cwd, 'fixture-next', 'medium')
    const native = (await f.logs()).find(row => row.method === 'thread/start')
    assert.equal(native.params.sandbox, 'workspace-write')
    assert.equal(native.params.model, 'fixture-next')
    assert.ok(!String(native.params.developerInstructions || '').includes('隔离团队试验'))
    assert.equal(await f.bridge.teamForThread(ordinary.id), undefined, 'New ordinary conversations are not auto-enrolled')
    assert.equal((await f.logs()).filter(row => row.method === 'turn/start').length, 0)
  } finally { await f.close() }
})

test('candidate listing is read-only; importing an existing conversation retains native history, identity and options', async () => {
  const f = await fixture()
  try {
    const second = await f.addWorkspace('project-b')
    await f.bridge.updatePreferences({ mode: 'workspace-write', approvalPolicy: 'on-request' })
    const original = await f.bridge.create(f.cwd, 'fixture-next', 'medium')
    await f.bridge.rename(original.id, '已有负责人')
    await f.bridge.message(original.id, { text: '规划测试', model: 'fixture-next', effort: 'medium', mode: 'workspace-write', approvalPolicy: 'on-request' })
    await until(async () => f.bridge.threads.get(original.id)?.turnId ? undefined : true)
    const foreign = await f.bridge.create(second.path)
    const history = (await f.rpc.call('thread/read', { threadId: original.id, includeTurns: true }) as { thread: unknown }).thread
    const options = await f.bridge.preferences.options(original.id), before = (await f.logs()).length
    const candidates = await jsonOk(await f.call(`/team/candidates?workspace=${f.workspaceId}`))
    const candidate = candidates.find((row: { threadId: string }) => row.threadId === original.id)
    assert.ok(candidate)
    assert.equal(candidate.title, '已有负责人')
    assert.equal(candidate.model, 'fixture-next')
    assert.equal(candidate.effort, 'medium')
    assert.equal(candidate.busy, false)
    assert.ok(!candidates.some((row: { threadId: string }) => row.threadId === foreign.id))
    assert.deepEqual(modelMutations((await f.logs()).slice(before)), [], 'Opening the picker never activates a native thread')
    const imported: TeamSnapshot = await jsonOk(await f.importThread(f.workspaceId, original.id))
    assert.equal(imported.members.length, 1)
    assert.equal(imported.members[0].threadId, original.id)
    assert.equal(imported.members[0].name, '已有负责人')
    assert.equal(imported.members[0].model, 'fixture-next')
    assert.equal(imported.members[0].effort, 'medium')
    assert.deepEqual(await f.bridge.preferences.options(original.id), options)
    assert.deepEqual(nativeHistory((await f.rpc.call('thread/read', { threadId: original.id, includeTurns: true }) as { thread: unknown }).thread), nativeHistory(history))
    const mutations = modelMutations((await f.logs()).slice(before))
    assert.ok(mutations.every(row => ['thread/resume', 'thread/unsubscribe'].includes(row.method)), 'Import may attach tools at idle but never adds or rewrites a turn')
    assert.equal(await f.bridge.teamForThread(original.id), await f.bridge.teamForWorkspace(f.workspaceId))
    assert.equal(await f.bridge.teamForThread(foreign.id), undefined)
  } finally { await f.close() }
})

test('workspace scope rejects cross-project imports and credentials while preserving local approvals', async () => {
  const f = await fixture()
  try {
    const second = await f.addWorkspace('project-b')
    const aLead = await f.bridge.create(f.cwd), aManager = await f.bridge.create(f.cwd)
    const bLead = await f.bridge.create(second.path)
    await jsonOk(await f.importThread(f.workspaceId, aLead.id))
    await jsonOk(await f.importThread(f.workspaceId, aManager.id, 2, aLead.id))
    await jsonOk(await f.importThread(second.id, bLead.id))
    assert.equal((await f.importThread(f.workspaceId, bLead.id, 2, aLead.id)).status, 403)
    assert.ok([400, 404].includes((await f.call('/team')).status), 'A production request must select a workspace')
    assert.equal((await f.call('/team?workspace=missing-workspace')).status, 404)
    assert.equal((await f.call(`/team/enabled?workspace=${f.workspaceId}`, { enabled: true }, { 'x-bridge-token': 'invalid' })).status, 403)
    const a = await f.bridge.teamForWorkspace(f.workspaceId), b = await f.bridge.teamForWorkspace(second.id)
    await a.enable(true); await b.enable(true)
    const token = await a.toolToken(aLead.id)
    const tool = (workspace: string, name: string, args: object) => fetch(f.base + `/api/team/tool?workspace=${workspace}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cweb-team-token': token }, body: JSON.stringify({ name, arguments: args }) })
    assert.equal((await tool(second.id, 'team_members', {})).status, 403)
    await jsonOk(await tool(f.workspaceId, 'team_propose_message', { to: aManager.id, kind: 'task', title: '待审任务', body: '仅验证审批，不执行模型', requestKey: 'scoped-pending' }))
    const [request] = (await a.snapshot()).messages
    assert.equal(request.from, aLead.id)
    assert.equal(request.state, 'pending')
    assert.equal((await b.snapshot()).messages.length, 0)
    assert.equal((await f.call(`/team/messages/${request.id}/decision?workspace=${second.id}`, { version: request.version, decision: 'reject' })).status, 404)
    await jsonOk(await f.call(`/team/messages/${request.id}/decision?workspace=${f.workspaceId}`, { version: request.version, decision: 'reject' }))
    assert.equal((await a.snapshot()).messages[0].state, 'rejected')
    assert.equal((await f.logs()).filter(row => row.method === 'turn/start').length, 0)
    await a.enable(false)
    assert.equal((await b.snapshot()).enabled, true)
  } finally { await f.close() }
})

test('the nearest registered workspace owns a conversation, including nested projects', async () => {
  const f = await fixture()
  try {
    const nested = await f.addWorkspace('project-a/nested')
    const thread = await f.bridge.create(nested.path)
    const outer = await jsonOk(await f.call(`/team/candidates?workspace=${f.workspaceId}`))
    const inner = await jsonOk(await f.call(`/team/candidates?workspace=${nested.id}`))
    assert.ok(!outer.some((row: { threadId: string }) => row.threadId === thread.id))
    assert.ok(inner.some((row: { threadId: string }) => row.threadId === thread.id))
    assert.equal((await f.importThread(f.workspaceId, thread.id)).status, 403)
    await jsonOk(await f.importThread(nested.id, thread.id))
    assert.equal(await f.bridge.teamForThread(thread.id), await f.bridge.teamForWorkspace(nested.id))
  } finally { await f.close() }
})

test('a running conversation can be enrolled without interruption, steering or history changes', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.cwd)
    await f.bridge.message(thread.id, { text: '等待中的普通用户任务', mode: 'workspace-write' })
    const activeId = f.bridge.threads.get(thread.id)?.turnId
    assert.ok(activeId)
    const before = (await f.logs()).length
    const candidates = await jsonOk(await f.call(`/team/candidates?workspace=${f.workspaceId}`))
    assert.equal(candidates.find((row: { threadId: string }) => row.threadId === thread.id)?.busy, true)
    await jsonOk(await f.importThread(f.workspaceId, thread.id))
    assert.equal(await f.bridge.connectTeam(thread.id), false, 'Tool attachment also waits for the active turn')
    assert.equal(f.bridge.threads.get(thread.id)?.turnId, activeId)
    assert.deepEqual(modelMutations((await f.logs()).slice(before)), [])
    assert.equal((await (await f.bridge.teamForWorkspace(f.workspaceId)).snapshot()).members[0].threadId, thread.id)
    await f.rpc.call('test/finish', { threadId: thread.id })
    await until(async () => f.bridge.threads.get(thread.id)?.turnId ? undefined : true)
    assert.equal(await f.bridge.connectTeam(thread.id), true)
    assert.equal((await f.logs()).filter(row => row.method === 'turn/start').length, 1, 'Attaching MCP does not send a model turn')
  } finally { await f.close() }
})

test('CLI-only import recovers native model, effort and permissions before its first team delivery', async () => {
  const f = await fixture()
  try {
    await f.bridge.updatePreferences({ model: 'fixture', effort: '', mode: 'danger-full-access', approvalPolicy: 'never' })
    // Bypass Bridge.create: this models an original CLI session that has no
    // cweb sessionOptions or native dynamic team tools.
    const started = await f.rpc.call('thread/start', { cwd: f.cwd, model: 'fixture-next', sandbox: 'read-only', approvalPolicy: 'untrusted', config: { model_reasoning_effort: 'medium' } }) as { thread: { id: string } }
    const id = started.thread.id
    const manager = await f.bridge.create(f.cwd)
    assert.equal((await f.bridge.preferences.snapshot()).sessionOptions[id], undefined)
    const imported: TeamSnapshot = await jsonOk(await f.importThread(f.workspaceId, id))
    await jsonOk(await f.importThread(f.workspaceId, manager.id, 2, id))
    assert.equal(imported.members[0].model, 'fixture-next')
    assert.equal(imported.members[0].effort, 'medium')
    assert.equal((await f.bridge.preferences.snapshot()).sessionOptions[id], undefined, 'Import itself does not replace unknown native settings with defaults')
    const before = (await f.logs()).length
    assert.equal(await f.bridge.connectTeam(id), true)
    const attachment = (await f.logs()).slice(before)
    const resume = attachment.find(row => row.method === 'thread/resume')
    assert.ok(Object.keys(resume?.params.config || {}).some(key => key.startsWith('mcp_servers.cweb_team_')))
    assert.equal(resume.params.sandbox, undefined)
    assert.equal(resume.params.approvalPolicy, undefined)
    assert.equal(attachment.filter(row => row.method === 'turn/start').length, 0)
    assert.deepEqual(await f.bridge.preferences.options(id), { model: 'fixture-next', effort: 'medium', mode: 'read-only', approvalPolicy: 'untrusted' })
    const team = await f.bridge.teamForWorkspace(f.workspaceId)
    await team.enable(true)
    const pending = await team.propose(manager.id, { to: id, kind: 'task', title: '原生设置验证', body: '等待用户核对', requestKey: 'native-options' })
    await team.decide(pending.id, { version: pending.version, decision: 'approve' })
    await until(async () => { await team.flush(); return (await team.snapshot()).messages[0].state === 'delivered' ? true : undefined })
    const turn = (await f.logs()).find(row => row.method === 'turn/start' && row.params.threadId === id)
    assert.equal(turn.params.model, 'fixture-next')
    assert.equal(turn.params.effort, 'medium')
    assert.equal(turn.params.sandboxPolicy.type, 'readOnly')
    assert.equal(turn.params.approvalPolicy, 'untrusted')
    assert.deepEqual(await f.bridge.preferences.options(id), { model: 'fixture-next', effort: 'medium', mode: 'read-only', approvalPolicy: 'untrusted' })
    await f.rpc.call('test/finish', { threadId: id })
  } finally { await f.close() }
})

test('a read-only risk review does not persistently change the imported native conversation options', async () => {
  const f = await fixture()
  try {
    await f.bridge.updatePreferences({ model: 'fixture', effort: '', mode: 'read-only', approvalPolicy: 'on-request' })
    const native = await f.rpc.call('thread/start', { cwd: f.cwd, model: 'fixture-next', sandbox: 'workspace-write', approvalPolicy: 'untrusted', config: { model_reasoning_effort: 'medium' } }) as { thread: { id: string } }
    const id = native.thread.id, manager = await f.bridge.create(f.cwd)
    await jsonOk(await f.importThread(f.workspaceId, id))
    await jsonOk(await f.importThread(f.workspaceId, manager.id, 2, id))
    const team = await f.bridge.teamForWorkspace(f.workspaceId)
    await team.enable(true); await team.setPolicy({ policy: 'ai' })
    const worker = await f.bridge.create(f.cwd)
    await jsonOk(await f.importThread(f.workspaceId, worker.id, 3, manager.id))
    const pending = await team.propose(manager.id, { to: worker.id, kind: 'task', title: '待评估任务', body: '等待后续确认', requestKey: 'risk-review' })
    await until(async () => { await team.flush(); const row = (await team.snapshot()).messages[0]; return row.reviews[0]?.state === 'sent' ? true : undefined })
    const reviewTurn = (await f.logs()).find(row => row.method === 'turn/start' && row.params.threadId === id)
    assert.equal(reviewTurn.params.model, 'fixture-next')
    assert.equal(reviewTurn.params.effort, 'medium')
    assert.equal(reviewTurn.params.sandboxPolicy.type, 'readOnly')
    assert.equal(reviewTurn.params.approvalPolicy, 'on-request')
    const expected = { model: 'fixture-next', effort: 'medium', mode: 'workspace-write' as const, approvalPolicy: 'untrusted' as const }
    assert.deepEqual(await f.bridge.preferences.options(id), expected)
    const latest = (await team.snapshot()).messages.find(row => row.id === pending.id)!
    await team.decide(latest.id, { version: latest.version, decision: 'cancel' })
    await f.rpc.call('test/finish', { threadId: id })
    await until(async () => f.bridge.threads.get(id)?.turnId ? undefined : true)
    await f.bridge.message(id, { ...await f.bridge.preferences.options(id), text: '等待中的日常任务' })
    const normalTurn = (await f.logs()).filter(row => row.method === 'turn/start' && row.params.threadId === id).at(-1)
    assert.equal(normalTurn.params.sandboxPolicy.type, 'workspaceWrite')
    assert.equal(normalTurn.params.approvalPolicy, 'untrusted')
    assert.equal(normalTurn.params.model, 'fixture-next')
    assert.deepEqual(await f.bridge.preferences.options(id), expected)
    await f.rpc.call('test/finish', { threadId: id })
  } finally { await f.close() }
})

test('team MCP waits when another native client keeps an idle conversation loaded', async () => {
  const f = await fixture()
  try {
    const native = await f.rpc.call('thread/start', { cwd: f.cwd, model: 'fixture-next', sandbox: 'read-only', approvalPolicy: 'on-request' }) as { thread: { id: string } }
    const id = native.thread.id
    await jsonOk(await f.importThread(f.workspaceId, id))
    await f.rpc.call('test/hold', { threadId: id, hold: true })
    const before = (await f.logs()).length
    assert.equal(await f.bridge.connectTeam(id), false)
    assert.deepEqual(modelMutations((await f.logs()).slice(before)).map(row => row.method), ['thread/unsubscribe'])
    await f.rpc.call('test/hold', { threadId: id, hold: false })
    assert.equal(await f.bridge.connectTeam(id), true)
    assert.equal((await f.logs()).filter(row => ['turn/start', 'turn/interrupt', 'turn/steer', 'thread/fork', 'thread/revert'].includes(row.method)).length, 0)
  } finally { await f.close() }
})

test('a different cweb installation MCP connection cannot satisfy this installation tool readiness', async () => {
  const f = await fixture()
  try {
    const native = await f.rpc.call('thread/start', { cwd: f.cwd, model: 'fixture-next', sandbox: 'read-only', approvalPolicy: 'on-request' }) as { thread: { id: string } }
    const id = native.thread.id, foreignServer = 'cweb_team_other-installation'
    await f.rpc.call('thread/unsubscribe', { threadId: id })
    await f.rpc.call('thread/resume', { threadId: id, config: { [`mcp_servers.${foreignServer}`]: {} } })
    await f.rpc.call('test/hold', { threadId: id, hold: true })
    await jsonOk(await f.importThread(f.workspaceId, id))
    const before = (await f.logs()).length
    assert.equal(await f.bridge.connectTeam(id), false, 'Similar tool names are not proof that this bridge owns the MCP endpoint')
    const checks = (await f.logs()).slice(before).filter(row => row.method === 'mcpServerStatus/list')
    assert.ok(checks.some(row => /^cweb_team_[a-f0-9]+$/.test(row.params.serverName)))
    assert.ok(checks.every(row => row.params.serverName !== foreignServer))
    assert.equal((await f.logs()).slice(before).filter(row => row.method === 'thread/resume').length, 0)
    await f.rpc.call('test/hold', { threadId: id, hold: false })
    assert.equal(await f.bridge.connectTeam(id), true)
    const resume = (await f.logs()).filter(row => row.method === 'thread/resume').at(-1)
    const server = Object.keys(resume.params.config).find(key => key.startsWith('mcp_servers.cweb_team_'))
    assert.ok(server)
    assert.notEqual(server, `mcp_servers.${foreignServer}`)
    assert.equal((await f.logs()).filter(row => row.method === 'turn/start').length, 0)
  } finally { await f.close() }
})

test('creating a new production team conversation still requires explicit member approval', async () => {
  const f = await fixture()
  try {
    await f.bridge.updatePreferences({ model: 'fixture-next', effort: 'medium', mode: 'workspace-write', approvalPolicy: 'on-request' })
    const suffix = `?workspace=${f.workspaceId}`
    const request = await jsonOk(await f.call('/team/members' + suffix, { name: '经批准的负责人', level: 1, parentId: null, groupId: null, useDefaults: true, requestKey: 'approved-member' }))
    assert.equal((await f.logs()).filter(row => row.method === 'thread/start').length, 0)
    const snapshot = await jsonOk(await f.call(`/team/members/${request.id}/decision` + suffix, { version: request.version, decision: 'approve' }))
    assert.equal(snapshot.members.length, 1)
    assert.equal(snapshot.members[0].model, 'fixture-next')
    assert.equal(snapshot.members[0].effort, 'medium')
    const starts = (await f.logs()).filter(row => row.method === 'thread/start')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].params.sandbox, 'workspace-write')
    assert.equal((await f.logs()).filter(row => row.method === 'turn/start').length, 0)
    assert.equal((await f.call(`/team/members/${request.id}/decision` + suffix, { version: request.version, decision: 'approve' })).status, 409)
    assert.equal((await f.logs()).filter(row => row.method === 'thread/start').length, 1)
  } finally { await f.close() }
})

test('pilot compatibility retains implicit workspace routes and rejects outside directories', async () => {
  const f = await fixture(false, true)
  try {
    assert.equal(f.boot.capabilities.teamPilot, true)
    const snapshot = await jsonOk(await f.call('/team'))
    assert.equal(snapshot.members.length, 0)
    assert.equal((await f.call('/workspaces', { path: f.root })).status, 403)
    assert.throws(() => new Bridge(f.rpc, new Workspace(f.cwd), resolve(f.root, 'home'), resolve(f.root, 'data'), true, { teamPilot: true }), /独立/)
    assert.equal((await f.logs()).filter(row => row.method === 'turn/start').length, 0)
  } finally { await f.close() }
})
