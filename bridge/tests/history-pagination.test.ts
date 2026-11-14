import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'
import { RunHistory } from '../server/run-history.ts'
import { projectThread } from '../server/projection.ts'

type Turn = { id: string; status: string; startedAt: number; completedAt?: number; items: unknown[] }
class HistoryRpc extends CodexRpc {
  calls: { method: string; params: Record<string, unknown> }[] = []
  holdNext = false
  dbOnlyFirst = false
  legacyGate?: Promise<void>
  legacyScans = 0
  pageGate?: Promise<void>
  pageStarted = false
  native = new Map<string, { id: string; name: string; cwd: string; historyMode: string; turns: Turn[] }>()
  constructor(cwd: string, mode = 'paginated') {
    super({ command: 'unused', args: [], cwd, env: process.env })
    for (const id of ['history-one', 'history-two']) this.native.set(id, { id, name: id, cwd, historyMode: mode, turns: Array.from({ length: 64 }, (_, index) => ({ id: `${id}-turn-${index + 1}`, status: 'completed', startedAt: 1_000_000 + index, completedAt: 1_000_001 + index, items: [
      { id: `${id}-user-${index + 1}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${index + 1}` }] },
      { id: `${id}-tool-${index + 1}`, type: 'commandExecution', command: 'fixture', status: 'completed', aggregatedOutput: '.'.repeat(40000), exitCode: 0 },
      { id: `${id}-answer-${index + 1}`, type: 'agentMessage', phase: 'final_answer', text: `Answer ${index + 1}` },
    ] })) })
  }
  override async start() { this.status = { state: 'ready', error: null } }
  override async call(method: string, value: object = {}): Promise<unknown> {
    const params = value as Record<string, unknown>; this.calls.push({ method, params })
    const native = this.native.get(String(params.threadId))
    if (method === 'thread/list') {
      const data = [...this.native.values()].map(thread => ({ ...structuredClone(thread), turns: [] }))
      if (params.useStateDbOnly === false) { this.legacyScans++; await this.legacyGate }
      return { data: this.dbOnlyFirst && params.useStateDbOnly ? data.slice(0, 1) : data, nextCursor: null }
    }
    if (method === 'thread/archive') { this.native.delete(String(params.threadId)); return {} }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { ...structuredClone(native), ...((params.includeTurns === false || params.excludeTurns) ? { turns: [] } : {}) }, model: 'fixture' }
    if (method === 'thread/turns/list') {
      const all = params.sortDirection === 'asc' ? native!.turns : [...native!.turns].reverse(), start = Number(params.cursor || 0), size = Number(params.limit)
      const result = { data: structuredClone(all.slice(start, start + size)), nextCursor: start + size < all.length ? String(start + size) : null }
      const gate = this.pageGate; this.pageGate = undefined
      if (gate) { this.pageStarted = true; await gate }
      return result
    }
    if (method === 'thread/revert') { native!.turns = native!.turns.slice(0, native!.turns.findIndex(turn => turn.id === params.beforeTurnId)); this.emit('notification', { method: 'thread/reverted', params: { threadId: native!.id } }); return { thread: { ...structuredClone(native), turns: [] } } }
    if (method === 'turn/start') {
      const turn: Turn = { id: 'new-turn', status: 'inProgress', startedAt: Date.now() / 1000, items: [] }; native!.turns.push(turn)
      this.emit('notification', { method: 'turn/started', params: { threadId: native!.id, turn } })
      const item = { id: 'new-user', type: 'userMessage', content: params.input }; turn.items.push(item)
      this.emit('notification', { method: 'item/completed', params: { threadId: native!.id, turnId: turn.id, item } })
      if (this.holdNext) { this.holdNext = false; return { turn } }
      turn.status = 'completed'; this.emit('notification', { method: 'turn/completed', params: { threadId: native!.id, turn } }); return { turn }
    }
    if (method === 'account/rateLimits/read' || method === 'thread/inject_items' || method === 'thread/unsubscribe') return {}
    throw new Error(`Unexpected fixture call ${method}`)
  }
}
async function fixture(mode = 'paginated') {
  await mkdir(resolve('test-results'), { recursive: true }); const root = await mkdtemp(resolve('test-results/history-pagination-')), cwd = resolve(root, 'project'); await mkdir(cwd)
  const rpc = new HistoryRpc(cwd, mode), bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
  await bridge.initialize(); await bridge.plugin.setEnabled(false)
  return { root, cwd, rpc, bridge, close: async () => { await bridge.dispose(); await rm(root, { recursive: true, force: true }) } }
}
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) assert.fail('Fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 20)) } }

test('opening a long native history fetches only the most recent two turns', async () => {
  const f = await fixture()
  try {
    const view = await f.bridge.open('history-one')
    assert.equal(view.runs?.length, 2); assert.equal(view.runs?.[0].id, 'history-one-turn-63'); assert.equal(view.runs?.at(-1)?.id, 'history-one-turn-64')
    assert.equal(view.history?.hasOlder, true); assert.ok(view.history?.cursor)
    const calls = f.rpc.calls.filter(call => call.method === 'thread/turns/list')
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].params, { threadId: 'history-one', limit: 2, sortDirection: 'desc', itemsView: 'full' })
    assert.ok(!f.rpc.calls.some(call => call.method === 'thread/read' && call.params.includeTurns === true))
    assert.ok(JSON.stringify(view).length < 100000)
  } finally { await f.close() }
})

test('older native history remains readable if a registered workspace directory is temporarily missing', async () => {
  const f = await fixture()
  try {
    const first = await f.bridge.open('history-one')
    await rm(f.cwd, { recursive: true, force: true })
    const older = await f.bridge.olderHistory(first.id, first.history!.cursor!)
    assert.equal(older.runs?.length, 10)
  } finally { await f.close() }
})

test('repairing a live patch preserves the open projection instead of applying the cold-start limit', async () => {
  const f = await fixture()
  try {
    await f.bridge.open('history-one')
    await f.bridge.message('history-one', { text: 'Continue this conversation', mode: 'read-only' })
    for (let i = 0; i < 100 && !f.bridge.snapshot('history-one'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    const snapshot = f.bridge.snapshot('history-one')!
    assert.equal(snapshot.runs?.length, 3)
    assert.ok(snapshot.items.some(item => item.id === 'history-one-user-63'))
  } finally { await f.close() }
})

test('older pages are chronological, concurrent/idempotent and bound to their thread', async () => {
  const f = await fixture()
  try {
    const view = await f.bridge.open('history-one'), cursor = view.history!.cursor!
    const [a, b] = await Promise.all([f.bridge.olderHistory(view.id, cursor), f.bridge.olderHistory(view.id, cursor)])
    assert.equal(a.runs?.length, 10); assert.deepEqual(a, b); assert.equal(a.runs?.[0].id, 'history-one-turn-55')
    assert.equal(new Set(a.items.map(item => item.id)).size, a.items.length)
    const count = f.rpc.calls.filter(call => call.method === 'thread/turns/list').length
    assert.deepEqual(await f.bridge.olderHistory(view.id, cursor), a)
    assert.equal(f.rpc.calls.filter(call => call.method === 'thread/turns/list').length, count)
    await f.bridge.open('history-two')
    await assert.rejects(f.bridge.olderHistory('history-two', a.history!.cursor!), /分页位置/)
  } finally { await f.close() }
})

test('refreshing the latest tail preserves explicitly loaded older turns', async () => {
  const f = await fixture()
  try {
    const initial = await f.bridge.open('history-one'), paged = await f.bridge.olderHistory(initial.id, initial.history!.cursor!)
    f.rpc.native.get(initial.id)!.turns.push({ id: 'new-latest', status: 'completed', startedAt: 2_000_000, items: [{ id: 'new-latest-answer', type: 'agentMessage', phase: 'final_answer', text: 'Latest answer' }] })
    await f.bridge.open(initial.id, true)
    const next = f.bridge.threads.get(initial.id)!
    assert.equal(next.runs?.length, 11); assert.equal(next.runs?.[0].id, 'history-one-turn-55'); assert.equal(next.runs?.at(-1)?.id, 'new-latest')
    assert.equal(next.history?.cursor, paged.history?.cursor)
  } finally { await f.close() }
})

test('a long-lived loaded session trims unrequested old turns on the next normal open, preserving active ownership', async () => {
  const f = await fixture()
  try {
    await f.bridge.open('history-one', true)
    const native = f.rpc.native.get('history-one')!
    for (let index = 65; index <= 126; index++) {
      const turn: Turn = { id: `live-turn-${index}`, status: 'inProgress', startedAt: 2_000_000 + index, items: [] }
      native.turns.push(turn); f.rpc.emit('notification', { method: 'turn/started', params: { threadId: native.id, turn } })
      const item = { id: `live-answer-${index}`, type: 'agentMessage', phase: 'final_answer', text: `Live answer ${index}` }; turn.items.push(item)
      f.rpc.emit('notification', { method: 'item/completed', params: { threadId: native.id, turnId: turn.id, item } })
      turn.status = 'completed'; f.rpc.emit('notification', { method: 'turn/completed', params: { threadId: native.id, turn } })
    }
    assert.equal(f.bridge.threads.get(native.id)!.runs?.length, 64)
    const recent = await f.bridge.open(native.id)
    assert.equal(recent.runs?.length, 2); assert.equal(recent.runs?.[0].id, 'live-turn-125')
    const oldCursor = recent.history!.cursor!
    f.rpc.holdNext = true
    await f.bridge.message(native.id, { text: 'Keep running', mode: 'read-only' })
    assert.equal(f.bridge.threads.get(native.id)!.status, 'inProgress')
    const running = await f.bridge.open(native.id)
    assert.equal(running.runs?.length, 2); assert.equal(running.turnId, 'new-turn'); assert.equal(running.status, 'inProgress')
    assert.notEqual(running.history!.cursor, oldCursor)
    const older = await f.bridge.olderHistory(native.id, running.history!.cursor!)
    assert.equal(older.runs?.length, 10); assert.equal(older.turnId, 'new-turn'); assert.equal(older.status, 'inProgress')
  } finally { await f.close() }
})

test('legacy native reads retain all original turns but send only the recent page', async () => {
  const f = await fixture('legacy')
  try {
    const view = await f.bridge.open('history-one')
    assert.equal(view.runs?.length, 2); assert.equal(f.rpc.native.get(view.id)!.turns.length, 64)
    const nativeReads = f.rpc.calls.filter(call => call.method === 'thread/read').length
    const older = await f.bridge.olderHistory(view.id, view.history!.cursor!)
    assert.equal(older.runs?.length, 10); assert.equal(f.rpc.calls.filter(call => call.method === 'thread/read').length, nativeReads)
  } finally { await f.close() }
})

test('history editing validates and backs up full native history without displaying it all again', async () => {
  const f = await fixture()
  try {
    await f.bridge.open('history-one')
    await f.bridge.message('history-one', { text: 'Edited old question', mode: 'read-only' }, { itemId: 'history-one-user-40', turnId: 'history-one-turn-40' })
    const file = (await readdir(resolve(f.root, 'data/edit-backups')))[0], backup = JSON.parse(await readFile(resolve(f.root, 'data/edit-backups', file), 'utf8'))
    assert.equal(backup.thread.turns.length, 64)
    const view = f.bridge.threads.get('history-one')!
    assert.ok((view.runs?.length || 0) <= 3); assert.ok(!view.items.some(item => item.id === 'history-one-user-64'))
    assert.equal(view.items.findLast(item => item.type === 'userMessage')?.text, 'Edited old question')
    const older = await f.bridge.olderHistory(view.id, view.history!.cursor!)
    assert.ok((older.runs?.length || 0) > (view.runs?.length || 0)); assert.ok(!older.items.some(item => item.id === 'history-one-user-64'))
  } finally { await f.close() }
})

test('history HTTP requires a valid authenticated, thread-bound cursor', async () => {
  const f = await fixture(), app = createHttpServer({ bridge: f.bridge, dist: resolve('dist') })
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const address = app.server.address(); assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`, boot = await fetch(base + '/api/bootstrap'), headers = { cookie: boot.headers.get('set-cookie')!.split(';')[0] }
    const initial = await f.bridge.open('history-one'), path = `/api/threads/history-one/history?cursor=${initial.history!.cursor}`
    assert.equal((await fetch(base + path)).status, 401)
    assert.equal((await fetch(base + path, { headers })).status, 200)
    assert.equal((await fetch(base + '/api/threads/history-one/history?cursor=forged', { headers })).status, 409)
  } finally { await app.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('SSE releases its subscription if the requested history is still pending or fails', async () => {
  const f = await fixture(), app = createHttpServer({ bridge: f.bridge, dist: resolve('dist') })
  let release = () => {}
  try {
    await f.bridge.open('history-one')
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
    const address = app.server.address(); assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`, boot = await fetch(base + '/api/bootstrap')
    const headers = { cookie: boot.headers.get('set-cookie')!.split(';')[0] }, baseline = f.bridge.listenerCount('event')
    for (const disconnect of [true, false]) {
      const gate = new Promise<void>(resolve => { release = resolve })
      f.bridge.open = async () => { await gate; throw new Error('Delayed history unavailable') }
      const controller = new AbortController()
      const stream = await fetch(base + '/api/events?thread=history-one', { headers, signal: controller.signal })
      const reader = stream.body!.getReader(); await reader.read()
      await until(() => f.bridge.listenerCount('event') === baseline + 1)
      if (disconnect) {
        controller.abort(); await reader.cancel().catch(() => {})
        await until(() => f.bridge.listenerCount('event') === baseline)
        release()
      } else {
        release(); while (!(await reader.read()).done) { /* Drain the closed stream. */ }
        await until(() => f.bridge.listenerCount('event') === baseline)
      }
    }
  } finally { release(); await app.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('saving a partial tail retains older statistics but a reverted tail never resurrects future runs', async () => {
  const f = await fixture()
  try {
    const metrics = new RunHistory(resolve(f.root, 'stats')), native = f.rpc.native.get('history-one')!
    const full = projectThread(native)
    full.runs![0].quota = { capturedAt: 1, windows: [{ name: 'fixture', change: 1.5 }] }
    full.items[0].timestamp = 500; full.items[0].timeSource = 'observed'
    await metrics.save(full)
    const tail = projectThread({ ...native, turns: native.turns.slice(-8) }); tail.history = { hasOlder: true, cursor: 'fixture' }
    await metrics.save(tail)
    const reopened = await metrics.enrich(projectThread(native))
    assert.equal(reopened.runs![0].quota?.windows[0].change, 1.5)
    assert.equal(reopened.items[0].timestamp, 500)
    const reverted = projectThread({ ...native, turns: native.turns.slice(24, 32) }); reverted.history = { hasOlder: true, cursor: 'fixture' }
    await metrics.save(reverted)
    const saved = JSON.parse(await readFile(resolve(f.root, 'stats/history-one.json'), 'utf8'))
    assert.equal(saved.runs.length, 32); assert.equal(saved.runs.at(-1).id, 'history-one-turn-32')
    assert.ok(!saved.runs.some((run: { id: string }) => run.id === 'history-one-turn-64'))
  } finally { await f.close() }
})

test('bootstrap reads the native DB immediately while a one-time legacy repair runs later without blocking refresh', async () => {
  const f = await fixture(); let release!: () => void
  f.rpc.dbOnlyFirst = true; f.rpc.legacyGate = new Promise<void>(resolve => { release = resolve })
  try {
    const value = await f.bridge.bootstrap()
    assert.deepEqual(value.threads.map(thread => thread.id), ['history-one'])
    assert.equal(f.rpc.legacyScans, 0)
    assert.ok(f.rpc.calls.filter(call => call.method === 'thread/list').every(call => call.params.useStateDbOnly === true))
    await until(() => f.rpc.legacyScans === 1)
    const fast = await Promise.race([f.bridge.refreshList(true), new Promise<null>(resolve => setTimeout(() => resolve(null), 300))])
    assert.ok(fast, 'A foreground DB refresh must not wait for the blocked rollout scan')
    release(); await until(() => f.bridge.list().some(thread => thread.id === 'history-two'))
    await f.bridge.refreshList(true)
    assert.ok(f.bridge.list().some(thread => thread.id === 'history-two'), 'Legacy-only discoveries remain visible on DB-only refresh')
    assert.equal(f.rpc.legacyScans, 1)
  } finally { release(); await f.close() }
})

test('a late legacy directory repair cannot resurrect an archived topic', async () => {
  const f = await fixture(); let release!: () => void
  f.rpc.dbOnlyFirst = true; f.rpc.legacyGate = new Promise<void>(resolve => { release = resolve })
  try {
    await f.bridge.bootstrap(); await until(() => f.rpc.legacyScans === 1)
    await f.bridge.archive('history-one')
    release(); await until(() => f.bridge.list().some(thread => thread.id === 'history-two'))
    assert.ok(!f.bridge.list().some(thread => thread.id === 'history-one'))
  } finally { release(); await f.close() }
})

test('disposing before the deferred directory repair cancels it', async () => {
  const f = await fixture()
  try {
    await f.bridge.bootstrap(); await f.bridge.dispose()
    await new Promise(resolve => setTimeout(resolve, 2100))
    assert.equal(f.rpc.legacyScans, 0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('a native page captured before a revert or archive cannot restore retired history when it returns late', async () => {
  for (const mutation of ['revert', 'archive']) {
    const f = await fixture(); let release!: () => void
    try {
      await f.bridge.open('history-one')
      f.rpc.emit('disconnected') // invalidate the recent-read cache, as on reconnect
      f.rpc.pageGate = new Promise<void>(resolve => { release = resolve })
      const pending = f.bridge.open('history-one')
      await until(() => f.rpc.pageStarted)
      if (mutation === 'revert') {
        await f.rpc.call('thread/revert', { threadId: 'history-one', beforeTurnId: 'history-one-turn-40' })
        await until(() => f.bridge.threads.get('history-one')?.runs?.at(-1)?.id === 'history-one-turn-39')
      } else {
        await f.rpc.call('thread/archive', { threadId: 'history-one' })
        f.rpc.emit('notification', { method: 'thread/archived', params: { threadId: 'history-one' } })
      }
      const rejected = assert.rejects(pending, /历史记录已变化/)
      release(); await rejected
      if (mutation === 'revert') assert.equal(f.bridge.threads.get('history-one')?.runs?.at(-1)?.id, 'history-one-turn-39')
      else { assert.equal(f.bridge.threads.has('history-one'), false); assert.ok(!f.bridge.list().some(thread => thread.id === 'history-one')) }
    } finally { release?.(); await f.close() }
  }
})
