import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { SessionContextStore } from '../server/session-context.ts'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true })
  const directory = await mkdtemp(resolve('test-results/session-context-'))
  const path = resolve(directory, 'contexts.json')
  return { directory, path, close: () => rm(directory, { recursive: true, force: true }) }
}

test('unchanged contexts persist only hashes and deduplicate across restarts and independent threads', async () => {
  const f = await fixture()
  try {
    const store = new SessionContextStore(f.path)
    const context = 'PRIVATE-SYNTHETIC-INSTRUCTIONS: use current display preferences'
    const calls: string[] = []
    assert.equal(await store.ensure('thread-a', context, async () => { calls.push('a') }), true)
    assert.equal(await store.ensure('thread-a', context, async () => { calls.push('duplicate') }), false)
    assert.equal(await store.ensure('thread-b', context, async () => { calls.push('b') }), true)
    const restarted = new SessionContextStore(f.path)
    assert.equal(await restarted.ensure('thread-a', context, async () => { calls.push('restart duplicate') }), false)
    assert.deepEqual(calls, ['a', 'b'])
    const text = await readFile(f.path, 'utf8'), saved = JSON.parse(text)
    assert.equal(text.includes(context), false, 'Instruction contents must never be stored')
    const hash = createHash('sha256').update(context).digest('hex')
    assert.deepEqual(saved, { version: 1, threads: { 'thread-a': hash, 'thread-b': hash } })
  } finally { await f.close() }
})

test('changed preferences inject once; failures do not poison success or block subsequent attempts', async () => {
  const f = await fixture()
  try {
    const store = new SessionContextStore(f.path); let calls = 0
    assert.equal(await store.ensure('thread', 'before', async () => { calls++ }), true)
    await assert.rejects(store.ensure('thread', 'after', async () => { calls++; throw new Error('Synthetic failed injection') }), /failed injection/)
    assert.equal(await store.ensure('thread', 'before', async () => { calls++ }), false, 'An unsuccessful change cannot erase the previous known context')
    assert.equal(await store.ensure('thread', 'after', async () => { calls++ }), true)
    assert.equal(await store.ensure('thread', 'after', async () => { calls++ }), false)
    assert.equal(calls, 3)
    const restarted = new SessionContextStore(f.path)
    assert.equal(await restarted.ensure('thread', 'after', async () => { calls++ }), false)
  } finally { await f.close() }
})

test('same-thread concurrent ensures serialize while another thread makes independent progress', async () => {
  const f = await fixture()
  try {
    const store = new SessionContextStore(f.path), entered = deferred(), release = deferred()
    const calls: string[] = []
    const first = store.ensure('a', 'context', async () => { calls.push('a'); entered.resolve(); await release.promise })
    await entered.promise
    const duplicate = store.ensure('a', 'context', async () => { calls.push('duplicate') })
    assert.equal(await store.ensure('b', 'context', async () => { calls.push('b') }), true)
    release.resolve()
    assert.deepEqual(await Promise.all([first, duplicate]), [true, false])
    assert.deepEqual(calls, ['a', 'b'])
    const saved = JSON.parse(await readFile(f.path, 'utf8'))
    assert.deepEqual(Object.keys(saved.threads).sort(), ['a', 'b'])
  } finally { await f.close() }
})

test('compaction/revert invalidation fences an in-flight ensure and persists the cleared fingerprint', async () => {
  const f = await fixture()
  try {
    const store = new SessionContextStore(f.path), entered = deferred(), release = deferred()
    let calls = 0
    const injecting = store.ensure('thread', 'context', async () => { calls++; entered.resolve(); await release.promise })
    await entered.promise
    const invalidating = store.invalidate('thread')
    release.resolve()
    assert.equal(await injecting, true)
    await invalidating
    const saved = JSON.parse(await readFile(f.path, 'utf8'))
    assert.equal(Object.hasOwn(saved.threads, 'thread'), false, 'A completed old injection cannot restore a fingerprint invalidated while it was in flight')
    assert.equal(await store.ensure('thread', 'context', async () => { calls++ }), true)
    assert.equal(await store.ensure('thread', 'context', async () => { calls++ }), false)
    await store.invalidate('thread')
    const restarted = new SessionContextStore(f.path)
    assert.equal(await restarted.ensure('thread', 'context', async () => { calls++ }), true)
    assert.equal(calls, 3)
  } finally { await f.close() }
})

test('an early invalidation also fences initial loading and already queued ensures', async () => {
  const f = await fixture()
  try {
    const initial = new SessionContextStore(f.path)
    await initial.ensure('thread', 'context', async () => {})
    const store = new SessionContextStore(f.path)
    const invalidating = store.invalidate('thread')
    let calls = 0
    const next = store.ensure('thread', 'context', async () => { calls++ })
    await invalidating
    assert.equal(await next, true); assert.equal(calls, 1)
    const entered = deferred(), release = deferred()
    const first = store.ensure('thread', 'changed', async () => { entered.resolve(); await release.promise })
    await entered.promise
    const queued = store.ensure('thread', 'changed', async () => { calls++ })
    const invalidated = store.invalidate('thread')
    release.resolve(); await Promise.all([first, queued, invalidated])
    assert.equal(await store.ensure('thread', 'changed', async () => { calls++ }), true)
    assert.equal(calls, 3)
  } finally { await f.close() }
})

test('malformed or unavailable cache cannot block successful user sends and preserves the original', async () => {
  const f = await fixture()
  try {
    for (const damaged of ['{broken JSON', JSON.stringify({ version: 1, threads: { thread: 'not-a-fingerprint' } })]) {
      await writeFile(f.path, damaged)
      const store = new SessionContextStore(f.path); let calls = 0
      assert.equal(await store.ensure('thread', 'context', async () => { calls++ }), true)
      assert.equal(await store.ensure('thread', 'context', async () => { calls++ }), false)
      await store.invalidate('thread')
      assert.equal(await store.ensure('thread', 'context', async () => { calls++ }), true)
      assert.equal(calls, 2)
      assert.equal(await readFile(f.path, 'utf8'), damaged)
      assert.equal(await new SessionContextStore(f.path).ensure('thread', 'context', async () => {}), true, 'An unreadable cache must never suppress a new process injection')
    }
    const blocked = resolve(f.directory, 'blocked'); await writeFile(blocked, 'not a directory')
    const unavailable = new SessionContextStore(resolve(blocked, 'contexts.json'))
    assert.equal(await unavailable.ensure('thread', 'context', async () => {}), true)
    assert.equal(await unavailable.ensure('thread', 'context', async () => {}), false)
  } finally { await f.close() }
})

test('a persistence failure after a successful injection remains usable and a later write repairs the cache', async () => {
  const f = await fixture()
  try {
    const parent = resolve(f.directory, 'temporarily-blocked'), path = resolve(parent, 'contexts.json')
    const store = new SessionContextStore(path)
    assert.equal(await store.ensure('thread', 'context', async () => { await writeFile(parent, 'block cache directory creation') }), true)
    assert.equal(await store.ensure('thread', 'context', async () => assert.fail('A disk error cannot erase a successful RPC within this process')), false)
    await rm(parent)
    assert.equal(await store.ensure('neighbor', 'other context', async () => {}), true)
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8')).threads).sort(), ['neighbor', 'thread'])
    assert.equal(await new SessionContextStore(path).ensure('thread', 'context', async () => assert.fail('The later atomic write should include earlier in-memory successes')), false)
  } finally { await f.close() }
})

test('shutdown flush drains unawaited invalidations before deleting their data directory', async () => {
  const f = await fixture()
  try {
    const store = new SessionContextStore(f.path)
    await Promise.all(['a', 'b', 'c'].map(id => store.ensure(id, 'context', async () => {})))
    // Native disconnect handlers cannot await a store write. Teardown flushes
    // those resets only after the transport has stopped producing notifications.
    void store.invalidate('a'); void store.invalidate('b'); void store.invalidate('c')
    await store.flush()
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).threads, {})
    await rm(f.directory, { recursive: true })
    await new Promise<void>(resolve => setImmediate(resolve))
    await assert.rejects(stat(f.directory), { code: 'ENOENT' })
    await store.flush()
    await assert.rejects(stat(f.directory), { code: 'ENOENT' })
    const damagedPath = resolve('test-results', `absent-context-cache-${Date.now()}.json`)
    const damaged = new SessionContextStore(damagedPath)
    await damaged.flush()
    await assert.rejects(stat(damagedPath), { code: 'ENOENT' })
  } finally { await f.close() }
})
