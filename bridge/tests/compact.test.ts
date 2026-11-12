import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { BridgeError } from '../server/errors.ts'

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
class CompactRpc extends CodexRpc {
  calls: { method: string; params: Record<string, unknown> }[] = []
  threads = new Map<string, Record<string, unknown>>()
  sequence = 0; readGate?: ReturnType<typeof gate>; compactError?: Error; compactGate?: ReturnType<typeof gate>; activeNative = false
  constructor(root: string) { super({ command: '', args: [], cwd: root, env: {} }); this.status = { state: 'ready', error: null } }
  override async start() {}
  override async dispose() { this.status = { state: 'stopped', error: null }; this.emit('disconnected') }
  notify(method: string, params: object) { this.emit('notification', { method, params }) }
  override async call(method: string, value: object = {}): Promise<unknown> {
    const params = value as Record<string, unknown>; this.calls.push({ method, params }); const id = String(params.threadId || '')
    if (method === 'thread/start') {
      const thread = { id: `thread-${++this.sequence}`, cwd: params.cwd, name: 'Fixture', historyMode: 'paginated', turns: [] }
      this.threads.set(thread.id, thread); return { thread, model: 'fixture' }
    }
    if (method === 'thread/read') { if (this.readGate) await this.readGate.promise; return { thread: { ...this.threads.get(id), turns: [], status: { type: this.activeNative ? 'active' : 'idle' } } } }
    if (method === 'thread/compact/start') { if (this.compactGate) await this.compactGate.promise; if (this.compactError) throw this.compactError; return {} }
    if (method === 'thread/turns/list') return { data: structuredClone([...(this.threads.get(id)!.turns as Record<string, unknown>[])].reverse()), nextCursor: null }
    if (method === 'turn/start') {
      const turn = { id: `turn-${++this.sequence}`, status: 'inProgress', items: [], startedAt: Date.now() / 1000 }
      this.notify('turn/started', { threadId: id, turn })
      this.notify('item/completed', { threadId: id, turnId: turn.id, item: { id: `user-${turn.id}`, type: 'userMessage', content: params.input } })
      this.notify('item/completed', { threadId: id, turnId: turn.id, item: { id: `answer-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text: 'Fixture answer' } })
      this.notify('turn/completed', { threadId: id, turn: { ...turn, status: 'completed' } }); return { turn }
    }
    if (method === 'account/rateLimits/read' || method === 'thread/inject_items' || method === 'thread/unsubscribe') return {}
    throw new Error(`Unsupported fixture method ${method}`)
  }
}
async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true }); const root = await mkdtemp(resolve('test-results/compact-')), cwd = resolve(root, 'project'); await mkdir(cwd)
  const rpc = new CompactRpc(root), bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
  await bridge.initialize(); await bridge.plugin.setEnabled(false)
  return { root, cwd, rpc, bridge, async close() { await bridge.dispose(); await rm(root, { recursive: true, force: true }) } }
}
async function until(check: () => boolean) { const deadline = Date.now() + 2000; while (!check()) { if (Date.now() > deadline) assert.fail('Fixture state did not settle'); await new Promise(resolve => setImmediate(resolve)) } }
const count = (f: Awaited<ReturnType<typeof fixture>>, method: string, id?: string) => f.rpc.calls.filter(row => row.method === method && (!id || row.params.threadId === id)).length

test('compact accepts only the native endpoint, reserves the acknowledgement gap and leaves messages unchanged', async () => {
 const f = await fixture()
 try {
  const a = await f.bridge.create(f.cwd), b = await f.bridge.create(f.cwd)
  await f.bridge.message(a.id, { text: 'Existing question', mode: 'read-only' })
  const original = structuredClone(f.bridge.threads.get(a.id)!.items)
  const request = f.bridge.compact(a.id)
  await assert.rejects(f.bridge.compact(a.id), /执行|提交|排队/)
  await request
  assert.equal(count(f, 'thread/compact/start', a.id), 1)
  assert.deepEqual(f.rpc.calls.find(row => row.method === 'thread/compact/start')!.params, { threadId: a.id })
  assert.equal(f.bridge.threads.get(a.id)!.compacting, true); assert.equal(f.bridge.active, true)
  await assert.rejects(f.bridge.message(a.id, { text: 'Too early', mode: 'read-only' }), /正在压缩/)
  await assert.rejects(f.bridge.release(a.id), /执行或排队/)
  assert.deepEqual(f.bridge.threads.get(a.id)!.items, original, 'Compression submission must not inject a user prompt or replace the answer')
  await f.bridge.message(b.id, { text: 'Neighbor still works', mode: 'read-only' }); assert.equal(count(f, 'turn/start', b.id), 1)
  await f.bridge.enqueue(a.id, { text: 'Explicitly queued next question', mode: 'read-only' })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(count(f, 'turn/start', a.id), 1)
  f.rpc.notify('thread/compacted', { threadId: a.id })
  await until(() => count(f, 'turn/start', a.id) === 2)
  assert.equal(f.bridge.threads.get(a.id)!.compacting, false)
 } finally { await f.close() }
})

test('native lifecycle and terminal errors release only the corresponding compaction reservation', async () => {
 const f = await fixture()
 try {
  const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: 'Before', mode: 'read-only' }); const old = f.bridge.threads.get(a.id)!.runs!.at(-1)!.id
  await f.bridge.compact(a.id)
  f.rpc.notify('turn/completed', { threadId: a.id, turn: { id: old, status: 'completed' } })
  assert.equal(f.bridge.threads.get(a.id)!.compacting, true, 'A delayed old completion cannot unlock accepted compression')
  f.rpc.notify('turn/started', { threadId: a.id, turn: { id: 'native-compact', status: 'inProgress', items: [] } })
  f.rpc.notify('item/started', { threadId: a.id, turnId: 'native-compact', item: { id: 'compact-item', type: 'contextCompaction' } })
  f.rpc.notify('error', { threadId: a.id, turnId: 'native-compact', willRetry: true, error: { message: 'Reconnecting' } })
  assert.equal(f.bridge.threads.get(a.id)!.compacting, true)
  f.rpc.notify('item/completed', { threadId: a.id, turnId: 'native-compact', item: { id: 'compact-item', type: 'contextCompaction' } })
  assert.equal(f.bridge.threads.get(a.id)!.compacting, false)
  await assert.rejects(f.bridge.message(a.id, { text: 'Native turn not finished', mode: 'read-only' }), /正在执行/)
  f.rpc.notify('turn/completed', { threadId: a.id, turn: { id: 'native-compact', status: 'completed' } })
  await f.bridge.compact(a.id)
  await f.bridge.enqueue(a.id, { text: 'Wait for successful compaction', mode: 'read-only' })
  f.rpc.notify('error', { threadId: a.id, turnId: 'next-native-compact', willRetry: false, error: { message: 'Native compact failed' } })
  assert.equal(f.bridge.threads.get(a.id)!.compacting, false)
  assert.equal(f.bridge.threads.get(a.id)!.error, 'Native compact failed')
  assert.equal(count(f, 'turn/start', a.id), 1, 'Compaction failures must never be replayed as user messages')
  await new Promise(resolve => setImmediate(resolve))
  assert.match(f.bridge.queue()[0].error!, /压缩未完成/)
  assert.equal(count(f, 'turn/start', a.id), 1, 'A failed compaction cannot silently consume the queued task')
 } finally { await f.close() }
})

test('preflight rechecks native activity and newly queued messages, allowing no compression overlap', async () => {
 const f = await fixture()
 try {
  const a = await f.bridge.create(f.cwd); f.rpc.activeNative = true
  await assert.rejects(f.bridge.compact(a.id), /仍在执行/); assert.equal(count(f, 'thread/compact/start'), 0)
  f.rpc.activeNative = false; f.rpc.readGate = gate(); const request = f.bridge.compact(a.id)
  await until(() => count(f, 'thread/read', a.id) === 2)
  await f.bridge.enqueue(a.id, { text: 'Queued during preflight', mode: 'read-only' })
  f.rpc.readGate.resolve(); await assert.rejects(request, /仍在执行/)
  await until(() => count(f, 'turn/start', a.id) === 1)
  assert.equal(count(f, 'thread/compact/start'), 0)
 } finally { await f.close() }
})

test('native rejection becomes visible and permits a later explicit request; unknown acceptance remains guarded until disconnect', async () => {
 const f = await fixture()
 try {
  const a = await f.bridge.create(f.cwd); f.rpc.compactError = new BridgeError('CLI_RPC', 'Synthetic native refusal', 502)
  await assert.rejects(f.bridge.compact(a.id), /Synthetic native refusal/)
  assert.equal(f.bridge.threads.get(a.id)!.compacting, false); assert.match(f.bridge.threads.get(a.id)!.error!, /Synthetic native refusal/)
  f.rpc.compactError = new BridgeError('CLI_TIMEOUT', 'Synthetic acceptance unknown', 504)
  await assert.rejects(f.bridge.compact(a.id), /Synthetic acceptance unknown/)
  assert.equal(f.bridge.threads.get(a.id)!.compacting, true)
  await assert.rejects(f.bridge.compact(a.id), /执行|提交|排队/)
  assert.equal(count(f, 'thread/compact/start'), 2)
  f.rpc.emit('disconnected'); assert.equal(f.bridge.threads.get(a.id)!.compacting, false)
 } finally { await f.close() }
})

test('an explicit compact cancels scheduled automatic replay and releases its in-memory input', async t => {
 const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] })
 try {
  const a = await f.bridge.create(f.cwd)
  let replayed = false
  const source = { input: { text: 'Do not replay', mode: 'read-only' }, sourceTurnId: 'failed-before', attempt: 0, failure: 'Broken pipe', timer: setTimeout(() => { replayed = true }, 2000) }
  const candidates = (f.bridge as unknown as { autoRecoveries: Map<string, typeof source> }).autoRecoveries
  candidates.set(a.id, source)
  await f.bridge.compact(a.id)
  t.mock.timers.tick(3000); assert.equal(replayed, false); assert.equal(candidates.has(a.id), false); assert.equal(source.input, undefined)
  assert.equal(count(f, 'turn/start'), 0); assert.equal(count(f, 'thread/compact/start'), 1)
 } finally { await f.close(); t.mock.timers.reset() }
})

test('lost lifecycle notifications recover from positive native compaction history, never from idle alone', async () => {
 const f = await fixture()
 try {
  const a = await f.bridge.create(f.cwd)
  await f.bridge.compact(a.id)
  await f.bridge.reconcile(a.id, true)
  assert.equal(f.bridge.threads.get(a.id)!.compacting, true, 'An idle native engine without a new compaction result cannot release the reservation')
  await assert.rejects(f.bridge.message(a.id, { text: 'Still unknown', mode: 'read-only' }), /正在压缩/)
  const original = structuredClone(f.bridge.threads.get(a.id)!.items)
  const native = f.rpc.threads.get(a.id)!
  native.turns = [{ id: 'compact-with-lost-events', status: 'completed', items: [{ id: 'completed-compaction', type: 'contextCompaction' }] }]
  await f.bridge.reconcileActive(true)
  assert.equal(f.bridge.threads.get(a.id)!.compacting, false)
  assert.deepEqual(f.bridge.threads.get(a.id)!.items, original, 'A status repair must not replace the conversation body')
  assert.equal(f.bridge.active, false)
  await f.bridge.message(a.id, { text: 'After verified completion', mode: 'read-only' })
  assert.equal(count(f, 'turn/start', a.id), 1)
 } finally { await f.close() }
})

test('a message awaiting the prior submission rechecks a compaction reservation before submitting', async () => {
 const f = await fixture()
 try {
  const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: 'Prior completed turn', mode: 'read-only' })
  const previous = gate()
  const state = f.bridge as unknown as { submitting: Set<string>; submissionDone: Map<string, Promise<void>> }
  state.submitting.add(a.id); state.submissionDone.set(a.id, previous.promise)
  const message = f.bridge.message(a.id, { text: 'Waiting to submit', mode: 'read-only' })
  state.submitting.delete(a.id)
  await f.bridge.compact(a.id)
  previous.resolve()
  await assert.rejects(message, /正在压缩/)
  assert.equal(count(f, 'turn/start', a.id), 1)
  assert.equal(count(f, 'thread/compact/start', a.id), 1)
 } finally { await f.close() }
})
