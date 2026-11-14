import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AccountUsage } from '../server/account-usage.ts'
import type { CodexRpc } from '../server/rpc.ts'

const snapshot = (used = 29) => ({ accountId: 'account-one', rateLimitsByLimitId: { codex: { primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: 1800000000 } } } })
class Rpc extends EventEmitter {
  account = { account: { type: 'chatgpt', planType: 'prolite' }, userId: 'user-fixture', workspaceRouting: { chatgptAccountId: 'account-one' } }
  results: unknown[] = [snapshot()]
  calls: { method: string; params: unknown }[] = []
  async start() {}
  async call(method: string, params: unknown) {
    this.calls.push({ method, params })
    if (method === 'account/read') return structuredClone(this.account)
    const next = this.results.length > 1 ? this.results.shift() : this.results[0]
    if (next instanceof Error) throw next
    return structuredClone(next)
  }
  service(clock = Date.now) { return new AccountUsage(this as unknown as CodexRpc, clock) }
  reads() { return this.calls.filter(call => call.method === 'account/rateLimits/read') }
}

test('usage polls skip reset-credit details, retain bucket names and share concurrent reads', async () => {
  const rpc = new Rpc(), usage = rpc.service(() => 1000)
  const [a, b] = await Promise.all([usage.read(), usage.read()])
  assert.equal(a.limits[0].limitName, 'codex'); assert.equal(a.limits[0].primary?.usedPercent, 29)
  assert.equal(a.updatedAt, 1000); assert.equal(a.stale, false); assert.deepEqual(a, b)
  assert.equal(rpc.reads().length, 1)
  assert.deepEqual(rpc.reads()[0].params, { excludeResetCreditDetails: true })
  assert.ok(!JSON.stringify(a).includes('account-one')); assert.ok(!JSON.stringify(a).includes('user-fixture'))
})

test('a transient or empty usage response retries only once and can recover', async () => {
  for (const first of [new Error('failed to fetch rate limits: network error'), {}]) {
    const rpc = new Rpc(); rpc.results = [first, snapshot(42)]
    const value = await rpc.service().read()
    assert.equal(value.limits[0].primary?.usedPercent, 42); assert.equal(rpc.reads().length, 2)
    assert.equal(value.error, undefined)
  }
})

test('temporary failures retain a verified same-account snapshot with its original time', async () => {
  const rpc = new Rpc(); let now = 1000; const usage = rpc.service(() => now)
  await usage.read(); rpc.results = [new Error('network timeout')]; now = 10000
  const cached = await usage.read()
  assert.equal(cached.stale, true); assert.equal(cached.updatedAt, 1000)
  assert.equal(cached.limits[0].primary?.usedPercent, 29); assert.match(cached.error!, /超时/)
  now += 16 * 60_000
  assert.equal((await usage.read()).limits.length, 0)
})

test('auth failures are not called unsupported, do not retry and discard cached usage', async () => {
  const rpc = new Rpc(), usage = rpc.service()
  await usage.read(); rpc.results = [new Error('chatgpt authentication required to read rate limits')]
  const before = rpc.reads().length, value = await usage.read()
  assert.equal(rpc.reads().length - before, 1); assert.match(value.error!, /登录/); assert.equal(value.limits.length, 0)
  rpc.results = [new Error('network error')]
  assert.equal((await usage.read()).limits.length, 0)
})

test('account changes, disconnects and mismatched snapshots cannot reuse another account usage', async () => {
  for (const change of ['routing', 'account/updated', 'account/login/completed', 'disconnected']) {
    const rpc = new Rpc(), usage = rpc.service()
    await usage.read()
    if (change === 'routing') rpc.account.workspaceRouting.chatgptAccountId = 'account-two'
    else if (change === 'disconnected') rpc.emit('disconnected')
    else rpc.emit('notification', { method: change })
    rpc.results = [new Error('network error')]
    assert.equal((await usage.read()).limits.length, 0, change)
  }
  const rpc = new Rpc(); rpc.account.workspaceRouting.chatgptAccountId = 'different'
  const value = await rpc.service().read()
  assert.equal(value.limits.length, 0); assert.match(value.error!, /不一致/)
})

test('an account change during a read retires the earlier result', async () => {
  const rpc = new Rpc(), usage = rpc.service(), call = rpc.call.bind(rpc)
  rpc.call = async (method, params) => { const value = await call(method, params); if (method === 'account/rateLimits/read') rpc.emit('notification', { method: 'account/updated' }); return value }
  assert.equal((await usage.read()).limits.length, 0)
})
