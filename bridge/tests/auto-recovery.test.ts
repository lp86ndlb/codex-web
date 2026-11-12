import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import type { ThreadView } from '../shared/types.ts'
import { recoveryPolicy } from '../server/auto-recovery.ts'

type Turn = { id: string; status: string; items: Record<string, unknown>[]; startedAt: number; completedAt?: number; error?: { message: string } }
type NativeThread = { id: string; cwd: string; name: string; historyMode: string; turns: Turn[] }
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
class NativeRpc extends CodexRpc {
  native = new Map<string, NativeThread>(); calls: { method: string; params: Record<string, unknown> }[] = []
  count = 0; readGate?: ReturnType<typeof gate>; injectionGate?: ReturnType<typeof gate>; activeOverride = false
  constructor(root: string) { super({ command: '', args: [], cwd: root, env: {} }); this.status = { state: 'ready', error: null } }
  override async start() {}
  override async dispose() { this.status = { state: 'stopped', error: null }; this.emit('disconnected') }
  notify(method: string, params: object) { this.emit('notification', { method, params }) }
  startTurn(id: string, input: unknown[] = [], client?: string) {
    const turn: Turn = { id: `turn-${++this.count}`, status: 'inProgress', startedAt: Date.now() / 1000, items: [] }
    this.native.get(id)!.turns.push(turn); this.notify('turn/started', { threadId: id, turn: structuredClone(turn) })
    const user = { id: client || `user-${turn.id}`, type: 'userMessage', content: input }
    turn.items.push(user); this.notify('item/completed', { threadId: id, turnId: turn.id, item: user }); return turn
  }
  fail(id: string, message = 'stream disconnected before completion: Broken pipe', retry = false) {
    const turn = this.native.get(id)!.turns.at(-1)!
    if (!retry) { turn.status = 'failed'; turn.error = { message }; turn.completedAt = Date.now() / 1000 }
    this.notify('error', { threadId: id, turnId: turn.id, willRetry: retry, error: { message } })
  }
  output(id: string, text = 'Recovered real model output') {
    const turn = this.native.get(id)!.turns.at(-1)!, item = { id: `answer-${turn.id}`, type: 'agentMessage', phase: 'commentary', text }
    turn.items.push(item); this.notify('item/completed', { threadId: id, turnId: turn.id, item })
  }
  override async call(method: string, value: object = {}): Promise<unknown> {
    const p = value as Record<string, unknown>; this.calls.push({ method, params: p }); const id = String(p.threadId || ''), native = this.native.get(id)
    if (method === 'thread/start') { const thread: NativeThread = { id: `thread-${++this.count}`, cwd: String(p.cwd), name: 'Fixture', historyMode: 'paginated', turns: [] }; this.native.set(thread.id, thread); return { thread: structuredClone(thread), model: 'fixture' } }
    if (method === 'thread/read') { if (this.readGate) await this.readGate.promise; return { thread: { ...structuredClone(native), status: { type: this.activeOverride || native?.turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' }, ...(p.includeTurns === false ? { turns: [] } : {}) } } }
    if (method === 'thread/turns/list') { const turns = structuredClone([...native!.turns].reverse().slice(0, Number(p.limit || 4))); if (p.itemsView !== 'full') for (const turn of turns) turn.items = []; return { data: turns, nextCursor: null } }
    if (method === 'thread/resume') return { thread: structuredClone(native), model: 'fixture' }
    if (method === 'thread/list') return { data: [...this.native.values()].map(thread => ({ ...structuredClone(thread), turns: [] })), nextCursor: null }
    if (method === 'turn/start') return { turn: structuredClone(this.startTurn(id, p.input as unknown[], p.clientUserMessageId as string | undefined)) }
    if (method === 'thread/inject_items') { if (this.injectionGate) await this.injectionGate.promise; return {} }
    if (method === 'account/rateLimits/read' || method === 'thread/unsubscribe' || method === 'thread/archive') return {}
    throw new Error(`Unsupported fixture method ${method}`)
  }
}
async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true }); const root = await mkdtemp(resolve('test-results/auto-recovery-')), cwd = resolve(root, 'project'); await mkdir(cwd)
  const rpc = new NativeRpc(root), bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
  await bridge.initialize(); await bridge.plugin.setEnabled(false)
  return { root, cwd, rpc, bridge, async close() { await bridge.dispose(); await rm(root, { recursive: true, force: true }) } }
}
async function until(check: () => boolean) { const deadline = Date.now() + 2000; while (!check()) { if (Date.now() > deadline) assert.fail('Fixture state did not settle'); await new Promise(resolve => setImmediate(resolve)) } }
const starts = (f: Awaited<ReturnType<typeof fixture>>, id?: string) => f.rpc.calls.filter(row => row.method === 'turn/start' && (!id || row.params.threadId === id))

test('a safe terminal transport failure retries once with a new user id and preserves both turns; real output marks response recovery', async t => {
 const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] })
 try {
  const a = await f.bridge.create(f.cwd), b = await f.bridge.create(f.cwd)
  await f.bridge.message(a.id, { text: 'Original user text', clientMessageId: 'original-user', mode: 'read-only' }); await f.bridge.message(b.id, { text: 'Neighbor', mode: 'read-only' })
  const source = f.bridge.threads.get(a.id)!.turnId!, neighbor = f.bridge.threads.get(b.id)!.turnId
  f.rpc.fail(a.id); await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'scheduled')
  assert.equal(f.bridge.threads.get(a.id)!.error, null)
  t.mock.timers.tick(2000); await until(() => starts(f, a.id).length === 2 && Boolean(f.bridge.threads.get(a.id)?.turnId))
  const retry = f.bridge.threads.get(a.id)!.turnId!
  assert.notEqual(retry, source); assert.equal(f.bridge.threads.get(a.id)!.runs!.find(run => run.id === source)!.status, 'failed')
  assert.equal(f.bridge.threads.get(a.id)!.runs!.find(run => run.id === retry)!.recoveryOf, source)
  assert.notEqual(starts(f, a.id)[1].params.clientUserMessageId, 'original-user')
  assert.deepEqual(starts(f, a.id)[1].params.input, starts(f, a.id)[0].params.input)
  assert.equal(f.bridge.threads.get(a.id)!.recovery!.state, 'retrying')
  f.rpc.output(a.id); assert.equal(f.bridge.threads.get(a.id)!.recovery!.state, 'recovered')
  f.rpc.fail(a.id); await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'manual')
  t.mock.timers.tick(8000); await Promise.resolve(); assert.equal(starts(f, a.id).length, 2)
  assert.equal(f.bridge.threads.get(b.id)!.turnId, neighbor)
  const context = await readFile(resolve(f.root, 'data/session-context.json'), 'utf8'); assert.ok(!context.includes('Original user text'))
 } finally { await f.close(); t.mock.timers.reset() }
})

test('native internal retry, active cleanup, omitted tool notifications and a native final answer never cause replay', async t => {
 const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] })
 try {
  const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: 'A', mode: 'read-only' })
  f.rpc.fail(a.id, 'Broken pipe', true); t.mock.timers.tick(2000); assert.equal(starts(f, a.id).length, 1); assert.equal(f.bridge.threads.get(a.id)!.recovery, undefined)
  f.rpc.fail(a.id); await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'scheduled'); f.rpc.activeOverride = true
  t.mock.timers.tick(2000); await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'manual'); assert.equal(starts(f, a.id).length, 1); f.rpc.activeOverride = false
  for (const item of [{ id: 'hidden-tool', type: 'commandExecution', command: 'synthetic', status: 'completed' }, { id: 'hidden-final', type: 'agentMessage', phase: 'final_answer', text: 'Already answered' }]) {
   const c = await f.bridge.create(f.cwd); await f.bridge.message(c.id, { text: 'C', mode: 'read-only' })
   f.rpc.native.get(c.id)!.turns.at(-1)!.items.push(item)
   f.rpc.fail(c.id); await until(() => f.bridge.threads.get(c.id)?.recovery?.state === 'scheduled'); t.mock.timers.tick(2000)
   await until(() => f.bridge.threads.get(c.id)?.recovery?.state === 'manual'); assert.equal(starts(f, c.id).length, 1)
   assert.ok(f.rpc.calls.some(row => row.method === 'thread/turns/list' && row.params.threadId === c.id && row.params.itemsView === 'full'))
  }
 } finally { await f.close(); t.mock.timers.reset() }
})

test('pending approval evidence and answered choices, high context, quota, permission and content errors require manual recovery', async t => {
 const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] })
 try {
  for (const variant of ['approval','choice','context','429 rate limit','401 permission','content policy violation','Unknown failure']) {
   const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: variant, mode: 'read-only' }); const turn = f.bridge.threads.get(a.id)!.turnId!
   if (variant === 'approval') f.rpc.emit('request', { id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: a.id, turnId: turn, command: 'synthetic' } })
   if (variant === 'choice') f.rpc.notify('item/completed', { threadId: a.id, turnId: turn, item: { id: 'ask', type: 'agentMessage', phase: 'commentary', text: 'Question', questions: [{ title: 'Choose', options: ['A','B'] }] } })
   if (variant === 'context') f.bridge.threads.get(a.id)!.contextUsage = { inputTokens: 350_000, windowTokens: 475_000, updatedAt: Date.now() }
   f.rpc.fail(a.id, ['approval','choice','context'].includes(variant) ? 'Broken pipe' : variant)
   await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'manual'); t.mock.timers.tick(2000); await Promise.resolve()
   assert.equal(starts(f, a.id).length, 1, variant)
  }
 } finally { await f.close(); t.mock.timers.reset() }
})

test('new input, disabling recovery, disconnect, user stop and dispose cancel a scheduled replay', async t => {
 const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] })
 try {
  for (const variant of ['new-input','disable','disconnect','interrupt']) {
   const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: variant, mode: 'read-only' }); f.rpc.fail(a.id)
   await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'scheduled')
   if (variant === 'new-input') await f.bridge.message(a.id, { text: 'User replacement', mode: 'read-only' })
   if (variant === 'disable') { await f.bridge.updatePreferences({ autoRecovery: false }); await f.bridge.updatePreferences({ autoRecovery: true }) }
   if (variant === 'disconnect') f.rpc.emit('disconnected')
   if (variant === 'interrupt') await f.bridge.interrupt(a.id)
   t.mock.timers.tick(2000); for (let i=0;i<10;i++) await new Promise(resolve => setImmediate(resolve))
   assert.equal(starts(f, a.id).length, variant === 'new-input' ? 2 : 1, variant)
  }
  const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: 'Dispose', mode: 'read-only' }); f.rpc.fail(a.id)
  await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'scheduled'); await f.bridge.dispose(); t.mock.timers.tick(5000)
  assert.equal(starts(f, a.id).length, 1)
 } finally { await f.close(); t.mock.timers.reset() }
})

test('queued and external CLI turns are never registered as replayable inputs', async t => {
 const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] })
 try {
  const a = await f.bridge.create(f.cwd); await f.bridge.enqueue(a.id, { text: 'Queue', mode: 'read-only' }); await until(() => Boolean(f.bridge.threads.get(a.id)?.turnId))
  f.rpc.fail(a.id); t.mock.timers.tick(3000); await Promise.resolve(); assert.equal(starts(f, a.id).length, 1); assert.equal(f.bridge.threads.get(a.id)!.recovery, undefined)
  const b = await f.bridge.create(f.cwd); f.rpc.startTurn(b.id); f.rpc.fail(b.id); t.mock.timers.tick(3000); assert.equal(starts(f, b.id).length, 0); assert.equal(f.bridge.threads.get(b.id)!.recovery, undefined)
 } finally { await f.close(); t.mock.timers.reset() }
})

test('new native work arriving during preparation cancels auto replay and keeps original recovery metadata off that work', async t => {
 const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] })
 try {
  const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: 'A', mode: 'read-only' }); f.rpc.fail(a.id)
  await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'scheduled')
  // Force a context re-injection so the automatic submission has an observable
  // async preparation boundary before turn/start may be sent.
  f.rpc.notify('thread/compacted', { threadId: a.id }); f.rpc.injectionGate = gate(); t.mock.timers.tick(2000)
  await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'retrying')
  const other = f.rpc.startTurn(a.id)
  f.rpc.injectionGate.resolve(); for (let i=0;i<30;i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(starts(f, a.id).length, 1)
  assert.equal(f.bridge.threads.get(a.id)!.turnId, other.id)
  assert.equal(f.bridge.threads.get(a.id)!.runs!.find(run => run.id === other.id)!.recoveryOf, undefined)
 } finally { await f.close(); t.mock.timers.reset() }
})

test('cancelling during the final preference read cannot slip past the commit guard', async t => {
 const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] })
 const reading = gate(); let held = false
 try {
  const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: 'A', mode: 'read-only' })
  const originalSnapshot = f.bridge.preferences.snapshot.bind(f.bridge.preferences)
  f.bridge.preferences.snapshot = async () => {
   const result = await originalSnapshot()
   const fullReads = f.rpc.calls.filter(row => row.method === 'thread/turns/list' && row.params.threadId === a.id && row.params.itemsView === 'full').length
   if (!held && fullReads >= 2) { held = true; await reading.promise }
   return result
  }
  f.rpc.fail(a.id); await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'scheduled')
  t.mock.timers.tick(2000); await until(() => held)
  await f.bridge.interrupt(a.id); reading.resolve()
  for (let i=0;i<40;i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(starts(f, a.id).length, 1)
  assert.equal(f.bridge.threads.get(a.id)!.turnId, null)
 } finally { reading.resolve(); await f.close(); t.mock.timers.reset() }
})

test('archiving a scheduled recovery cancels its timer and releases the in-memory original input', async t => {
 const f = await fixture(); t.mock.timers.enable({ apis: ['setTimeout'] })
 try {
  const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: 'Original input for archived task', mode: 'read-only' })
  f.rpc.fail(a.id); await until(() => f.bridge.threads.get(a.id)?.recovery?.state === 'scheduled')
  const candidates = (f.bridge as unknown as { autoRecoveries: Map<string, { input?: unknown }> }).autoRecoveries
  const candidate = candidates.get(a.id)!
  assert.ok(candidate.input, 'The fixture must reach a scheduled recovery with retained input')
  await f.bridge.archive(a.id)
  assert.equal(candidates.has(a.id), false)
  assert.equal(candidate.input, undefined, 'Cancelling an archived task must release its original message text')
  const callsAfterArchive = f.rpc.calls.length
  t.mock.timers.tick(3000); for (let i=0;i<20;i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(starts(f, a.id).length, 1)
  // Settlement can still finish its metadata write and read final account
  // limits. Those normal cleanup calls are unrelated to automatic replay.
  const recoveryCalls = new Set(['thread/read', 'thread/turns/list', 'thread/resume', 'thread/inject_items', 'thread/compact/start', 'turn/start', 'turn/steer', 'turn/interrupt'])
  assert.deepEqual(f.rpc.calls.slice(callsAfterArchive).filter(row => row.params.threadId === a.id && recoveryCalls.has(row.method)).map(row => row.method), [], 'The cancelled timer must not perform recovery reads or submissions')
  assert.equal(f.bridge.threads.has(a.id), false)
 } finally { await f.close(); t.mock.timers.reset() }
})

test('a failed turn with an ambiguous history shape is rejected conservatively by policy', () => {
 const thread: ThreadView = { id: 'x', title: 'x', revision: 1, cwd: '/x', model: '', updatedAt: 1, status: 'failed', turnId: null, items: [{ id: 'u', type: 'userMessage', text: 'x', status: '', turnId: 't' }, { id: 'unknown', type: 'futureTool', text: '', status: '', turnId: 't' }], runs: [{ id: 't', status: 'failed' }], plan: [], diff: '', tokens: 0, error: 'Broken pipe' }
 assert.equal(recoveryPolicy(thread, 't').allowed, false)
})
