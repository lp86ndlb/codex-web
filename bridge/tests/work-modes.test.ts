import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'
import { applyNotification, projectThread } from '../server/projection.ts'
import { quotaChange, quotaSnapshot, RunHistory } from '../server/run-history.ts'

async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/work-modes-')); const cwd = resolve(root, 'project'); await mkdir(cwd)
  const log = resolve(root, 'rpc.jsonl')
  const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log }, timeoutMs: 3000 })
  const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
  const app = createHttpServer({ bridge, dist: resolve('dist') }); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`
  const response = await fetch(base + '/api/bootstrap'); const boot = await response.json()
  const headers = { cookie: response.headers.get('set-cookie')!.split(';')[0], origin: base, 'x-bridge-token': boot.token, 'content-type': 'application/json' }
  return { root, cwd, rpc, bridge, boot, headers, base, post: (path: string, value: unknown, extra = {}) => fetch(base + '/api' + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) }), get: (path: string) => fetch(base + '/api' + path, { headers }), calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), close: async () => { await app.close(); await rm(root, { recursive: true, force: true }) } }
}
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 15)) } }

test('plan uses the native collaboration preset, preserves the chosen model, and can switch back', async () => {
  const f = await fixture()
  try {
    assert.equal(f.boot.capabilities.planning, true)
    const thread = await f.bridge.create(f.cwd)
    await f.bridge.message(thread.id, { text: '规划测试', collaborationMode: 'plan', model: 'fixture-next', effort: 'medium', mode: 'read-only' })
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed')
    assert.match(f.bridge.threads.get(thread.id)!.items.at(-1)!.text, /规划方案/)
    const first = (await f.calls()).find(row => row.method === 'turn/start')
    assert.deepEqual(first.params.collaborationMode, { mode: 'plan', settings: { model: 'fixture-next', reasoning_effort: 'medium', developer_instructions: null } })
    assert.equal(first.params.sandboxPolicy.type, 'readOnly')
    await f.bridge.message(thread.id, { text: '规划测试', collaborationMode: 'default', mode: 'workspace-write' })
    const turns = (await f.calls()).filter(row => row.method === 'turn/start')
    assert.equal(turns.at(-1).params.collaborationMode.mode, 'default')
    assert.equal((await f.bridge.preferences.options(thread.id)).collaborationMode, 'default')
  } finally { await f.close() }
})

test('native goals are shared, require authenticated user mutations, and preserve usage when paused', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.cwd); const endpoint = `/threads/${thread.id}/goal`
    assert.equal((await (await f.get(endpoint)).json()).goal, null)
    assert.equal((await f.post(endpoint, { objective: '交付功能并通过测试' }, { 'x-bridge-token': 'bad' })).status, 403)
    assert.equal((await f.post(endpoint, { objective: '' })).status, 400)
    assert.equal((await f.post(endpoint, { objective: 'x'.repeat(4001) })).status, 400)
    const created = await (await f.post(endpoint, { objective: '交付功能并通过测试', tokenBudget: 5000 })).json()
    assert.equal(created.goal.objective, '交付功能并通过测试'); assert.equal(created.goal.tokenBudget, 5000)
    const paused = await (await f.post(endpoint, { status: 'paused' })).json()
    assert.equal(paused.goal.status, 'paused'); assert.equal(paused.goal.createdAt, created.goal.createdAt)
    const native = await f.rpc.call('thread/goal/get', { threadId: thread.id }) as { goal: { status: string } }
    assert.equal(native.goal.status, 'paused')
    await f.post(endpoint, { status: 'active' }); await f.post(endpoint, { clear: true })
    assert.equal((await (await f.get(endpoint)).json()).goal, null)
    const changes = (await f.calls()).filter(row => row.method === 'thread/goal/set' || row.method === 'thread/goal/clear')
    assert.ok(changes.every(row => row.params.origin === 'user'))
  } finally { await f.close() }
})

test('message observation times and per-turn metrics survive session reload without duplicating CLI history', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.cwd)
    await f.bridge.message(thread.id, { text: '你好', mode: 'read-only' })
    await until(() => Boolean(f.bridge.threads.get(thread.id)?.runs?.at(-1)?.quota))
    const view = f.bridge.threads.get(thread.id)!
    assert.equal(view.runs!.at(-1)!.tokens, 120); assert.ok(view.runs!.at(-1)!.durationMs! >= 0)
    assert.equal(view.items.find(item => item.type === 'userMessage')!.timeSource, 'native')
    const answer = view.items.find(item => item.type === 'agentMessage')!; assert.equal(answer.timeSource, 'observed'); assert.ok(answer.timestamp! > 0)
    await f.bridge.metrics.flush(); await f.bridge.release(thread.id); const restored = await f.bridge.open(thread.id, true)
    assert.equal(restored.items.find(item => item.id === answer.id)!.timestamp, answer.timestamp)
    assert.equal(restored.runs!.at(-1)!.tokens, 120); assert.equal(restored.tokens, 120)
    assert.equal(restored.items.filter(item => item.type === 'userMessage').length, 1)
  } finally { await f.close() }
})

test('renaming during native progress preserves the current run and structured question', async () => {
  const f = await fixture()
  try {
    assert.equal(f.boot.capabilities.nativeAsyncQuestions, true)
    const thread = await f.bridge.create(f.cwd)
    const nativeCall = f.rpc.call.bind(f.rpc)
    f.rpc.call = async (method, params) => {
      const result = await nativeCall(method, params)
      if (method === 'thread/name/set') {
        await nativeCall('turn/start', {threadId:thread.id,input:[{type:'text',text:'等待并发状态'}]})
        await nativeCall('test/append', {threadId:thread.id,text:'请使用卡片',questions:[{title:'选择配色',options:['灰白','黑白']}]})
      }
      return result
    }
    await f.bridge.rename(thread.id, '新的标题')
    const view = f.bridge.threads.get(thread.id)!
    assert.equal(view.title, '新的标题')
    assert.equal(view.status, 'inProgress')
    assert.ok(view.turnId)
    assert.ok(view.runs?.at(-1)?.startedAt)
    assert.equal(view.choicePending, true)
    assert.equal(view.items.at(-1)?.questions?.[0].title, '选择配色')
  } finally { await f.close() }
})

test('unknown token baselines are never attributed to the first reopened turn', () => {
  let view = projectThread({ id: 't', turns: [{ id: 'old', status: 'completed', items: [] }] })
  view = applyNotification(view, 'turn/started', { turn: { id: 'new', status: 'inProgress', startedAt: 1000 } })
  view = applyNotification(view, 'thread/tokenUsage/updated', { turnId: 'new', tokenUsage: { total: { totalTokens: 900 } } })
  assert.equal(view.runs!.at(-1)!.tokens, undefined)
  view = applyNotification(view, 'turn/completed', { turn: { id: 'new', status: 'completed', startedAt: 1000, completedAt: 1002 } })
  assert.equal(view.runs!.at(-1)!.durationMs, 2000)
  view = applyNotification(view, 'turn/started', { turn: { id: 'next', status: 'inProgress' } })
  view = applyNotification(view, 'thread/tokenUsage/updated', { turnId: 'next', tokenUsage: { total: { totalTokens: 1500 } } })
  assert.equal(view.runs!.at(-1)!.tokens, 600)
})

test('corrupt optional run statistics do not prevent opening native conversation history', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.cwd)
    await f.bridge.message(thread.id, { text: '你好', mode: 'read-only' })
    await until(() => Boolean(f.bridge.threads.get(thread.id)?.runs?.at(-1)?.quota)); await f.bridge.metrics.flush()
    await f.bridge.release(thread.id)
    const directory = resolve(f.root, 'data/run-history'); const file = resolve(directory, `${thread.id}.json`)
    await writeFile(file, '{broken')
    f.bridge.metrics = new RunHistory(directory)
    const history = await f.bridge.open(thread.id, true)
    assert.match(history.items.find(item => item.type === 'agentMessage')!.text, /你好/)
    assert.match(history.error!, /统计暂时无法读取/)
    assert.equal(await readFile(file, 'utf8'), '{broken')
    f.bridge.metrics = new RunHistory(resolve(f.root, 'safe-empty-statistics'))
  } finally { await f.close() }
})

test('account window changes preserve precision and exclude resets or incompatible windows', () => {
  const snapshot = (usedPercent: number, resetsAt = 10) => quotaSnapshot({ rateLimits: { primary: { usedPercent, resetsAt, windowDurationMins: 300 } } })
  assert.equal(quotaChange(snapshot(35), snapshot(35.2))!.windows[0].change, .2)
  assert.equal(quotaChange(snapshot(35), snapshot(35))!.windows[0].change, 0)
  assert.equal(quotaChange(snapshot(35), snapshot(0, 11)), undefined)
  assert.equal(quotaChange(snapshot(35), snapshot(30)), undefined)
  assert.equal(quotaChange(undefined, snapshot(35)), undefined)
})

test('rejected todos require an improvement note and keep user acceptance separate from implementation', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.cwd)
    await f.bridge.plugin.call(thread.id, 'todo_note_update', { add_tasks: [{ title: '修复输入框对齐' }] })
    const task = (await f.bridge.plugin.get(thread.id)).tasks[0]
    await f.bridge.plugin.call(thread.id, 'todo_note_complete', { id: task.id })
    await f.bridge.plugin.act(thread.id, [{ type: 'reject_task', id: task.id, by: 'user' }])
    await assert.rejects(f.bridge.plugin.call(thread.id, 'todo_note_complete', { id: task.id }), /复核并改进/)
    assert.match(await f.bridge.plugin.context(thread.id), /Needs improvement: 修复输入框对齐/)
    await f.bridge.plugin.call(thread.id, 'todo_note_complete', { id: task.id, note: '改用统一图标，并在 Edge 测量中心对齐偏差小于 3px。' })
    assert.equal((await f.bridge.plugin.get(thread.id)).tasks[0].state, 'awaiting')
    assert.match(await f.bridge.plugin.context(thread.id), /1 awaiting user acceptance/)
  } finally { await f.close() }
})
