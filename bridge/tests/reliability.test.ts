import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { SubmissionJournal } from '../server/submissions.ts'
import { redactDiagnostic, ConnectionDiagnostics } from '../server/diagnostics.ts'
import { classifyFailure } from '../shared/connection.ts'
import { parseElicitation, validateElicitation } from '../shared/elicitation.ts'
import { loadComposerCache, saveComposerCache, emptyComposerCache } from '../client/composer-cache.ts'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { BridgeError } from '../server/errors.ts'
import { createHttpServer } from '../server/http.ts'

async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/reliability-')), workspace = resolve(root, 'project')
  await mkdir(workspace)
  const options = { command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd: workspace, env: { ...process.env, FAKE_STORE: resolve(root, 'store.json'), FAKE_LOG: resolve(root, 'rpc.jsonl') }, timeoutMs: 2000 }
  const rpc = new CodexRpc(options), bridge = new Bridge(rpc, new Workspace(workspace), resolve(root, 'home'), resolve(root, 'data'))
  await bridge.plugin.setEnabled(false)
  return { root, workspace, options, rpc, bridge, log: async () => (await readFile(resolve(root, 'rpc.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row)), close: async () => { await bridge.dispose(); await rm(root, { recursive: true, force: true }) } }
}
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) } assert.fail('state did not settle') }
class MemoryStorage implements Storage {
  map = new Map<string, string>()
  get length() { return this.map.size }
  clear() { this.map.clear() }
  getItem(key: string) { return this.map.get(key) ?? null }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  removeItem(key: string) { this.map.delete(key) }
  setItem(key: string, value: string) { this.map.set(key, value) }
}

test('drafts survive reload including references and edits; another tab cannot erase an unrelated draft', () => {
  const storage = new MemoryStorage(), a = emptyComposerCache(), b = emptyComposerCache()
  a.drafts.one = '原消息'; a.referenceDrafts.one = ['src/main.ts']
  a.fileDrafts.one = [{ id: 'file-1', name: '图.png', size: 100, kind: 'image', url: '/api/attachments/file-1/content' }]
  a.editingMessages.one = { itemId: 'item', turnId: 'turn', saved: { text: '未发送草稿', files: [], skills: [], references: [] }, merged: false }
  saveComposerCache(storage, a)
  b.drafts.two = '另一话题'; saveComposerCache(storage, b)
  const restored = loadComposerCache(storage)
  assert.equal(restored.drafts.one, '原消息'); assert.equal(restored.drafts.two, '另一话题')
  assert.equal(restored.fileDrafts.one[0].name, '图.png')
  assert.equal(restored.editingMessages.one.saved.text, '未发送草稿')
  assert.deepEqual(restored.referenceDrafts.one, ['src/main.ts'])
  const sent = { ...a, drafts: { one: '' }, fileDrafts: { one: [] }, referenceDrafts: { one: [] }, editingMessages: {} }
  saveComposerCache(storage, sent, a)
  assert.equal(loadComposerCache(storage).drafts.one, undefined)
  assert.equal(loadComposerCache(storage).drafts.two, '另一话题')
})

test('unfinished sends reload as unknown and never as a new unsent draft', () => {
  const storage = new MemoryStorage(), cache = emptyComposerCache()
  cache.pendingMessages.push({ id: 'message', key: 'one', state: 'sending', baseline: [], contents: { text: '执行一次', files: [], skills: [], references: [] }, item: { id: 'message', type: 'userMessage', text: '执行一次', status: 'sending' } })
  saveComposerCache(storage, cache)
  const restored = loadComposerCache(storage)
  assert.equal(restored.pendingMessages[0].state, 'unknown')
  assert.equal(restored.drafts.one, '')
})

test('failure categories remain distinct and diagnostic reports remove credentials and personal paths', () => {
  assert.equal(classifyFailure('Broken pipe').kind, 'network')
  assert.equal(classifyFailure('401 Unauthorized').kind, 'authentication')
  assert.equal(classifyFailure('429 quota exceeded').kind, 'quota')
  assert.equal(classifyFailure('maximum context length exceeded').kind, 'context')
  assert.equal(classifyFailure('').kind, 'unknown')
  const report = JSON.stringify(redactDiagnostic({ api_key: 'never-show', auth: { accessToken: 'another-secret' }, message: 'Bearer abc123 ' + homedir() + '/.codex someone@example.com', url: 'https://user:pass@example.com/check?token=secret', ok: true }))
  for (const secret of ['never-show', 'another-secret', 'abc123', homedir(), 'someone@example.com', 'user:pass', 'token=secret']) assert.ok(!report.includes(secret), secret)
  assert.ok(report.includes('"ok":true'))
  const raw = String(redactDiagnostic('OPENAI_API_KEY=private-1 password="private 2" accessToken:private-3'))
  for (const secret of ['private-1', 'private 2', 'private-3']) assert.ok(!raw.includes(secret))
})

test('submission journal atomically deduplicates and survives a new instance without storing message text', async () => {
  const f = await fixture()
  try {
    const file = resolve(f.root, 'receipts.json'), journal = new SubmissionJournal(file), id = randomUUID()
    const results = await Promise.all([journal.claim('one', id, { text: 'private-message' }), journal.claim('one', id, { text: 'private-message' })])
    assert.equal(results.filter(row => row.fresh).length, 1)
    await journal.settle(id, 'accepted')
    assert.equal((await new SubmissionJournal(file).claim('one', id, { text: 'private-message' })).receipt.state, 'accepted')
    await assert.rejects(journal.claim('two', id, { text: 'private-message' }), /标识/)
    assert.ok(!(await readFile(file, 'utf8')).includes('private-message'))
  } finally { await f.close() }
})

test('lost native acknowledgement is reconciled by client message id, never replayed', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.workspace), id = randomUUID(), input = { text: '执行一次', mode: 'read-only' as const, clientMessageId: id }
    const call = f.rpc.call.bind(f.rpc); let dropped = false
    f.rpc.call = async (method, params) => { const result = await call(method, params); if (method === 'turn/start' && !dropped) { dropped = true; throw new BridgeError('CLI_TIMEOUT', 'synthetic lost acknowledgement', 504) } return result }
    await assert.rejects(f.bridge.message(thread.id, input), /lost acknowledgement/)
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed')
    assert.equal((await f.bridge.delivery(thread.id, id)).state, 'accepted')
    await f.bridge.message(thread.id, input)
    assert.equal((await f.log()).filter(row => row.method === 'turn/start').length, 1)
    assert.equal((await f.bridge.delivery(thread.id, randomUUID())).state, 'unknown', 'Absent is not proof of failure')
  } finally { await f.close() }
})

test('MCP form validates required, ranges, enums, false/zero and rejects unrequested data', () => {
  const request = parseElicitation({ serverName: 'fixture', mode: 'form', message: '确认参数', requestedSchema: { type: 'object', required: ['count', 'enabled', 'mode'], properties: {
    count: { type: 'integer', minimum: 0, maximum: 3 }, enabled: { type: 'boolean' }, mode: { type: 'string', oneOf: [{ const: 'a', title: '选项 A' }, { const: 'b', title: '选项 B' }] }, choices: { type: 'array', items: { enum: ['x', 'y'] }, maxItems: 2 },
  } } })
  assert.equal(request.mode, 'form')
  const values = { count: 0, enabled: false, mode: 'b', choices: ['x'] }
  assert.deepEqual({ ...validateElicitation(request, values) }, values)
  assert.throws(() => validateElicitation(request, { ...values, count: 4 }), /范围/)
  assert.throws(() => validateElicitation(request, { ...values, extra: 'x' }), /未请求/)
  assert.throws(() => validateElicitation(request, { mode: 'a' }), /填写/)
  assert.equal(parseElicitation({ mode: 'url', url: 'javascript:alert(1)' }).mode, 'unsupported')
  assert.equal(parseElicitation({ mode: 'openai/userVerification' }).mode, 'unsupported')
  for (const field of [{ type: 'number', exclusiveMinimum: 0 }, { type: 'string', oneOf: [{ type: 'string', pattern: '^x' }] }, { type: 'string', enum: [1, 2] }]) {
    assert.equal(parseElicitation({ mode: 'form', requestedSchema: { type: 'object', properties: { value: field } } }).mode, 'unsupported', 'Unimplemented constraints must not silently accept values')
  }
})

test('MCP requests become actionable approvals, resolve once, and preserve typed answers', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.workspace)
    await f.bridge.message(thread.id, { text: '等待', mode: 'read-only' })
    await f.rpc.call('test/elicitation', { threadId: thread.id, request: { mode: 'form', message: '确认数值', requestedSchema: { type: 'object', required: ['value'], properties: { value: { type: 'number', minimum: 0 } } } } })
    await until(() => f.bridge.approvals().length === 1)
    const request = f.bridge.approvals()[0]
    assert.equal(request.elicitation?.mode, 'form')
    assert.throws(() => f.bridge.answer(request.id, 'accept', {}, { value: -1 }), /范围/)
    assert.equal(f.bridge.approvals().length, 1)
    f.bridge.answer(request.id, 'accept', {}, { value: 0 })
    assert.throws(() => f.bridge.answer(request.id, 'accept', {}, { value: 0 }), /失效/)
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed')
    assert.deepEqual((await f.log()).find(row => row.id === 9010 && row.result)?.result, { action: 'accept', content: { value: 0 } })
  } finally { await f.close() }
})

test('an MCP question arriving before resumed history remains pending', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.workspace)
    f.bridge.threads.delete(thread.id)
    const call = f.rpc.call.bind(f.rpc)
    f.rpc.call = async (method, params) => {
      if (method === 'thread/resume') {
        f.rpc.emit('request', { id: 9011, method: 'mcpServer/elicitation/request', params: { threadId: thread.id, mode: 'form', message: '恢复期间确认', requestedSchema: { type: 'object', properties: { enabled: { type: 'boolean' } } } } })
        assert.equal(f.bridge.approvals().length, 1)
      }
      return call(method, params)
    }
    await f.bridge.open(thread.id, true)
    assert.equal(f.bridge.approvals()[0]?.elicitation?.message, '恢复期间确认')
  } finally { await f.close() }
})

test('native fork keeps the source and boundary; review uses review/start without starting a text task', async () => {
  const f = await fixture()
  try {
    const source = await f.bridge.create(f.workspace)
    await f.bridge.message(source.id, { text: '第一问', mode: 'read-only' })
    await until(() => f.bridge.threads.get(source.id)?.status === 'completed')
    await f.bridge.message(source.id, { text: '第二问', mode: 'read-only' })
    await until(() => f.bridge.threads.get(source.id)?.runs?.length === 2 && f.bridge.threads.get(source.id)?.status === 'completed')
    const second = f.bridge.threads.get(source.id)!.runs![1].id
    const child = await f.bridge.fork(source.id, second)
    assert.notEqual(child.id, source.id); assert.equal(child.forkedFromId, source.id)
    assert.ok(child.items.some(item => item.text === '第一问'))
    assert.ok(!child.items.some(item => item.text === '第二问'))
    assert.ok(f.bridge.threads.get(source.id)!.items.some(item => item.text === '第二问'))
    assert.equal((await f.log()).find(row => row.method === 'thread/fork').params.deferGoalContinuation, true)
    await f.bridge.review(child.id, { type: 'uncommittedChanges' })
    await until(() => f.bridge.threads.get(child.id)?.status === 'completed')
    assert.equal((await f.log()).filter(row => row.method === 'turn/start').length, 2)
    assert.equal((await f.log()).filter(row => row.method === 'review/start').length, 1)
  } finally { await f.close() }
})

test('diagnostic cancellation affects only its probe and exports no raw model error', async () => {
  const f = await fixture(); let cancelled = false
  const diagnostic = new ConnectionDiagnostics(f.rpc, async (args, signal) => {
    if (args[0] === '--version') return { output: 'codex-cli 0.169.0', code: 0 }
    return new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')) }, { once: true }))
  })
  try {
    await f.rpc.start(); diagnostic.start()
    assert.equal((await diagnostic.snapshot()).report.state, 'running')
    diagnostic.cancel(); assert.ok(cancelled); assert.equal(f.rpc.status.state, 'ready')
    f.rpc.emit('notification', { method: 'error', params: { threadId: 'one', error: { message: 'Broken pipe PRIVATE_USER_MESSAGE' } } })
    const snapshot = await diagnostic.snapshot()
    assert.equal(snapshot.engine.installedVersion, '0.169.0')
    assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_USER_MESSAGE'))
    assert.equal(snapshot.report.state, 'cancelled')
  } finally { diagnostic.dispose(); await f.close() }
})

test('diagnostics remain available when bootstrap cannot connect to the CLI', async () => {
  const f = await fixture(), app = createHttpServer({ bridge: f.bridge, dist: resolve(f.root, 'empty') })
  try {
    await f.bridge.initialize()
    f.bridge.bootstrap = async () => { throw new Error('synthetic engine offline') }
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
    const address = app.server.address(); assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`, response = await fetch(base + '/api/bootstrap'), body = await response.json()
    assert.equal(body.runtime.state, 'failed'); assert.equal(body.capabilities.diagnostics, true)
    const diagnostics = await fetch(base + '/api/diagnostics', { headers: { cookie: response.headers.get('set-cookie')!.split(';')[0] } })
    assert.equal(diagnostics.status, 200); assert.equal((await diagnostics.json()).report.state, 'idle')
  } finally { await app.close(); await rm(f.root, { recursive: true, force: true }) }
})
