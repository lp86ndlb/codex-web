import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'

type NativeItem = Record<string, unknown>
type NativeTurn = { id: string; status: string; items: NativeItem[]; startedAt: number; completedAt?: number }
type NativeThread = { id: string; cwd: string; name: string; updatedAt: number; historyMode: string; turns: NativeTurn[] }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** An in-memory native transport: no real sessions or models are involved. */
class NativeRpc extends CodexRpc {
  native = new Map<string, NativeThread>()
  calls: { method: string; params: Record<string, unknown> }[] = []
  readGate?: ReturnType<typeof deferred>
  readError = false
  runtime = new Map<string, string>()
  sequence = 0
  constructor(root: string) { super({ command: '', args: [], cwd: root, env: {} }); this.status = { state: 'ready', error: null } }
  override async start() {}
  override async dispose() { this.status = { state: 'stopped', error: null } }
  notify(method: string, params: object) { this.emit('notification', { method, params }) }
  startTurn(id: string) {
    const native = this.native.get(id)!
    const turn: NativeTurn = { id: `turn-${++this.sequence}`, status: 'inProgress', items: [], startedAt: Date.now() / 1000 }
    native.turns.push(turn); this.notify('turn/started', { threadId: id, turn: structuredClone(turn) }); return turn
  }
  finish(id: string, notify = true, status = 'completed') {
    const native = this.native.get(id)!, turn = native.turns.at(-1)!
    turn.status = status; turn.completedAt = Date.now() / 1000
    turn.items.push({ id: `answer-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text: `Recovered native answer for ${turn.id}` })
    if (notify) this.notify('turn/completed', { threadId: id, turn: structuredClone(turn) })
    return structuredClone(turn)
  }
  override async call(method: string, value: object = {}): Promise<unknown> {
    const params = value as Record<string, unknown>; this.calls.push({ method, params })
    const id = String(params.threadId || ''), native = this.native.get(id)
    if (method === 'thread/start') {
      const thread: NativeThread = { id: `thread-${++this.sequence}`, cwd: String(params.cwd), name: 'Fixture', updatedAt: Date.now() / 1000, historyMode: 'paginated', turns: [] }
      this.native.set(thread.id, thread); return { thread: structuredClone(thread), model: 'fixture' }
    }
    if (method === 'thread/read') {
      if (this.readGate) await this.readGate.promise
      if (this.readError) throw new Error('Synthetic read failure')
      return { thread: { ...structuredClone(native), status: { type: this.runtime.get(id) || (native?.turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle') }, ...(params.includeTurns === false ? { turns: [] } : {}) } }
    }
    if (method === 'thread/turns/list') {
      const all = [...native!.turns].reverse(), from = Number(params.cursor || 0), limit = Number(params.limit || 50)
      const page = structuredClone(all.slice(from, from + limit))
      if (params.itemsView === 'summary') for (const turn of page) turn.items = []
      return { data: page, nextCursor: from + limit < all.length ? String(from + limit) : null }
    }
    if (method === 'thread/list') return { data: [...this.native.values()].map(thread => ({ ...structuredClone(thread), turns: [], status: { type: thread.turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' } })), nextCursor: null }
    if (method === 'turn/start') {
      const turn = this.startTurn(id), input = params.input as { type: string; text: string }[]
      const item = { id: `user-${turn.id}`, type: 'userMessage', content: input }
      turn.items.push(item); this.notify('item/completed', { threadId: id, turnId: turn.id, item }); return { turn: structuredClone(turn) }
    }
    if (method === 'thread/resume') return { thread: structuredClone(native), model: 'fixture' }
    if (method === 'account/rateLimits/read') return {}
    if (method === 'thread/inject_items' || method === 'thread/unsubscribe') return {}
    throw new Error(`Unsupported fixture method ${method}`)
  }
}
async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/reconcile-')), cwd = resolve(root, 'project'); await mkdir(cwd)
  const rpc = new NativeRpc(root), bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
  await bridge.initialize(); await bridge.plugin.setEnabled(false)
  return { rpc, bridge, cwd, async close() { await bridge.dispose(); await rm(root, { recursive: true, force: true }) } }
}
async function until(check: () => boolean) {
  for (let tries = 0; tries < 100; tries++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('Fixture state did not settle')
}

test('same-workspace threads run concurrently and a dropped completion recovers only its native turn and pending prompts', async () => {
  const f = await fixture()
  try {
    const a = await f.bridge.create(f.cwd), b = await f.bridge.create(f.cwd)
    await Promise.all([f.bridge.message(a.id, { text: 'A', mode: 'read-only' }), f.bridge.message(b.id, { text: 'B', mode: 'read-only' })])
    const turnA = f.bridge.threads.get(a.id)!.turnId, turnB = f.bridge.threads.get(b.id)!.turnId
    assert.ok(turnA && turnB)
    f.rpc.emit('request', { id: 500, method: 'item/commandExecution/requestApproval', params: { threadId: a.id, turnId: turnA, command: 'synthetic command' } })
    f.rpc.emit('request', { id: 501, method: 'item/commandExecution/requestApproval', params: { threadId: b.id, turnId: turnB, command: 'synthetic command' } })
    f.rpc.finish(a.id, false)
    await f.bridge.reconcileActive(true)
    assert.equal(f.bridge.threads.get(a.id)!.status, 'completed')
    assert.equal(f.bridge.threads.get(a.id)!.turnId, null)
    assert.match(f.bridge.threads.get(a.id)!.items.at(-1)!.text, /Recovered native answer/)
    assert.equal(f.bridge.threads.get(b.id)!.turnId, turnB)
    assert.deepEqual(f.bridge.approvals().map(row => row.threadId), [b.id])
    assert.ok(f.rpc.calls.filter(row => row.method === 'thread/read').every(row => row.params.includeTurns === false))
    assert.ok(f.rpc.calls.filter(row => row.method === 'thread/turns/list').every(row => row.params.limit === 4 && row.params.sortDirection === 'desc'))
    await f.bridge.message(a.id, { text: 'A again', mode: 'read-only' })
    assert.notEqual(f.bridge.threads.get(a.id)!.turnId, turnA, 'Recovered completion must retire the old ownership fence')
    assert.equal(f.bridge.threads.get(b.id)!.turnId, turnB)
  } finally { await f.close() }
})

test('loaded open coalesces and rate-limits native checks; idle or notLoaded never falsely ends an in-progress turn', async () => {
  const f = await fixture()
  try {
    const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: 'A', mode: 'read-only' })
    f.rpc.runtime.set(a.id, 'idle'); f.rpc.readGate = deferred()
    const first = f.bridge.open(a.id), second = f.bridge.open(a.id)
    await until(() => f.rpc.calls.filter(row => row.method === 'thread/read').length === 1)
    f.rpc.readGate.resolve(); await Promise.all([first, second])
    assert.ok(f.bridge.threads.get(a.id)!.turnId)
    const reads = f.rpc.calls.filter(row => row.method === 'thread/read').length
    await f.bridge.open(a.id); await f.bridge.reconcileActive()
    assert.equal(f.rpc.calls.filter(row => row.method === 'thread/read').length, reads)
    f.rpc.runtime.set(a.id, 'notLoaded'); await f.bridge.reconcile(a.id, true)
    assert.equal(f.bridge.threads.get(a.id)!.status, 'inProgress')
    const before = f.bridge.threads.get(a.id)!
    f.rpc.readError = true; await f.bridge.reconcile(a.id, true)
    assert.equal(f.bridge.threads.get(a.id), before, 'A temporary native read failure must not terminate work or claim progress')
    assert.equal(f.rpc.calls.filter(row => ['turn/interrupt', 'turn/steer'].includes(row.method)).length, 0)
  } finally { await f.close() }
})

test('a newer native notification or turn invalidates a reconciliation snapshot and late terminal events cannot stop the new turn', async () => {
  const f = await fixture()
  try {
    const a = await f.bridge.create(f.cwd); await f.bridge.message(a.id, { text: 'A', mode: 'read-only' })
    const oldTurn = f.bridge.threads.get(a.id)!.turnId!
    f.rpc.readGate = deferred(); const checking = f.bridge.reconcile(a.id, true)
    await until(() => f.rpc.calls.some(row => row.method === 'thread/read'))
    f.rpc.notify('item/agentMessage/delta', { threadId: a.id, turnId: oldTurn, itemId: 'stream', delta: 'Fresh native output' })
    f.rpc.finish(a.id, false); f.rpc.readGate.resolve(); await checking
    assert.equal(f.bridge.threads.get(a.id)!.status, 'inProgress', 'A read taken before newer output must be discarded')
    assert.match(f.bridge.threads.get(a.id)!.items.at(-1)!.text, /Fresh native output/)
    f.rpc.readGate = deferred(); const oldCheck = f.bridge.reconcile(a.id, true)
    const newTurn = f.rpc.startTurn(a.id)
    f.rpc.readGate.resolve(); await oldCheck
    f.rpc.notify('turn/completed', { threadId: a.id, turn: { id: oldTurn, status: 'completed' } })
    f.rpc.notify('error', { threadId: a.id, turnId: oldTurn, error: { message: 'Late failure' }, willRetry: false })
    assert.equal(f.bridge.threads.get(a.id)!.turnId, newTurn.id)
    assert.equal(f.bridge.threads.get(a.id)!.status, 'inProgress')
    assert.equal(f.bridge.threads.get(a.id)!.error, null)
  } finally { await f.close() }
})

test('recovered completion drains only its queue; permanent errors settle prompts without starting queued work', async () => {
  const f = await fixture()
  try {
    const a = await f.bridge.create(f.cwd), b = await f.bridge.create(f.cwd)
    await Promise.all([f.bridge.message(a.id, { text: 'A', mode: 'read-only' }), f.bridge.message(b.id, { text: 'B', mode: 'read-only' })])
    await f.bridge.enqueue(a.id, { text: 'A queued', mode: 'read-only' }); await f.bridge.enqueue(b.id, { text: 'B queued', mode: 'read-only' })
    const old = f.bridge.threads.get(a.id)!.turnId
    f.rpc.finish(a.id, false); await f.bridge.reconcile(a.id, true)
    await until(() => Boolean(f.bridge.threads.get(a.id)?.turnId && f.bridge.threads.get(a.id)?.turnId !== old))
    assert.equal(f.bridge.queue().filter(row => row.threadId === a.id).length, 0)
    const turnB = f.bridge.threads.get(b.id)!.turnId
    f.rpc.emit('request', { id: 510, method: 'item/commandExecution/requestApproval', params: { threadId: b.id, turnId: turnB, command: 'synthetic' } })
    f.rpc.notify('error', { threadId: b.id, turnId: turnB, error: { message: 'Permanent model failure' }, willRetry: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(f.bridge.threads.get(b.id)!.turnId, null)
    assert.equal(f.bridge.approvals().length, 0)
    assert.equal(f.bridge.queue().filter(row => row.threadId === b.id).length, 1)
    const queued = f.bridge.queue().find(row => row.threadId === b.id)!
    assert.match(queued.error!, /前一任务失败.*重试/)
    const neighbor = f.bridge.threads.get(a.id)!.turnId
    const starts = f.rpc.calls.filter(row => row.method === 'turn/start' && row.params.threadId === b.id).length
    f.bridge.changeQueue(queued.id, true)
    await until(() => Boolean(f.bridge.threads.get(b.id)?.turnId && f.bridge.threads.get(b.id)?.turnId !== turnB))
    assert.equal(f.rpc.calls.filter(row => row.method === 'turn/start' && row.params.threadId === b.id).length, starts + 1, 'An explicit queue retry must start exactly once after failure')
    assert.equal(f.bridge.queue().filter(row => row.threadId === b.id).length, 0)
    assert.equal(f.bridge.threads.get(a.id)!.turnId, neighbor)
  } finally { await f.close() }
})

test('the latest settled turn accepts final native duration and error details without settling or draining twice', async () => {
  const f = await fixture()
  try {
    const a = await f.bridge.create(f.cwd), b = await f.bridge.create(f.cwd)
    await Promise.all([f.bridge.message(a.id, { text: 'A', mode: 'read-only' }), f.bridge.message(b.id, { text: 'B', mode: 'read-only' })])
    const turn = f.bridge.threads.get(a.id)!.turnId!, neighbor = f.bridge.threads.get(b.id)!.turnId
    await f.bridge.enqueue(a.id, { text: 'A queued', mode: 'read-only' })
    f.rpc.notify('error', { threadId: a.id, turnId: turn, error: { message: 'Initial failure' }, willRetry: false })
    const queued = f.bridge.queue().find(row => row.threadId === a.id)!
    const terminal = { id: turn, status: 'failed', startedAt: 1_800_000_000, completedAt: 1_800_000_004.2, durationMs: 4200, error: { message: 'Native terminal detail' } }
    f.rpc.notify('turn/completed', { threadId: a.id, turn: terminal })
    assert.equal(f.bridge.threads.get(a.id)!.runs!.at(-1)!.durationMs, 4200)
    assert.equal(f.bridge.threads.get(a.id)!.error, 'Native terminal detail')
    f.rpc.notify('turn/completed', { threadId: a.id, turn: terminal })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(f.bridge.queue().find(row => row.id === queued.id)!.error, queued.error)
    assert.equal(f.rpc.calls.filter(row => row.method === 'turn/start' && row.params.threadId === a.id).length, 1)
    assert.equal(f.bridge.threads.get(b.id)!.turnId, neighbor)
    f.bridge.changeQueue(queued.id, true)
    await until(() => Boolean(f.bridge.threads.get(a.id)?.turnId))
    const newer = f.bridge.threads.get(a.id)!.turnId
    f.rpc.notify('turn/completed', { threadId: a.id, turn: { ...terminal, durationMs: 9999, error: { message: 'Too late' } } })
    assert.equal(f.bridge.threads.get(a.id)!.turnId, newer)
    assert.equal(f.bridge.threads.get(a.id)!.error, null)
    assert.equal(f.bridge.threads.get(a.id)!.runs!.find(run => run.id === turn)!.durationMs, 4200)
  } finally { await f.close() }
})

test('a background check polls all running sessions and dispose cancels polling and invalidates an outstanding read', async t => {
  const f = await fixture()
  // Enable the clock before creating work, so all lifecycle timers belong to
  // this clock and can be cancelled by dispose without touching real timers.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const x = await f.bridge.create(f.cwd), y = await f.bridge.create(f.cwd)
    await Promise.all([f.bridge.message(x.id, { text: 'X', mode: 'read-only' }), f.bridge.message(y.id, { text: 'Y', mode: 'read-only' })])
    f.rpc.finish(x.id, false); f.rpc.finish(y.id, false)
    t.mock.timers.tick(15_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.equal(f.bridge.threads.get(x.id)!.status, 'completed')
    assert.equal(f.bridge.threads.get(y.id)!.status, 'completed')
    const z = await f.bridge.create(f.cwd); await f.bridge.message(z.id, { text: 'Z', mode: 'read-only' })
    f.rpc.readGate = deferred(); const pending = f.bridge.reconcile(z.id, true)
    const before = f.bridge.threads.get(z.id)
    await f.bridge.dispose(); f.rpc.readGate.resolve(); await pending
    assert.equal(f.bridge.threads.get(z.id), before)
    const calls = f.rpc.calls.length; t.mock.timers.tick(60_000); await Promise.resolve()
    assert.equal(f.rpc.calls.length, calls, 'Disposed bridges must not poll or drain any queue')
  } finally { await f.close(); t.mock.timers.reset() }
})
