import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SessionRouter } from '../server/session-router.ts'
import { CodexRpc } from '../server/rpc.ts'
import { discoverCodexHomes } from '../server/session-sources.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'

const primaryId = '11111111-1111-4111-a111-111111111111'
const externalId = '22222222-2222-4222-a222-222222222222'
const anotherId = '33333333-3333-4333-a333-333333333333'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => Promise<boolean>) { for (let i = 0; i < 120; i++) { if (await check()) return; await delay(25) } throw new Error('Timed out') }
const row = (id: string, cwd: string, name: string) => ({ id, cwd, name, updatedAt: 100, historyMode: 'paginated', turns: [{ id: `${id}-turn`, status: 'completed', items: [{ id: `${id}-item`, type: 'agentMessage', text: name }] }] })

async function fixture(names = ['primary', 'external', 'another']) {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/session-router-'))
  const homes = names.map(name => resolve(root, name))
  for (const home of homes) await mkdir(home)
  await writeFile(resolve(homes[0], 'threads.json'), JSON.stringify({ [primaryId]: row(primaryId, homes[0], '网页会话') }))
  await writeFile(resolve(homes[1], 'threads.json'), JSON.stringify({ [externalId]: row(externalId, homes[1], '终端会话'), [primaryId]: row(primaryId, homes[1], '旧副本') }))
  await writeFile(resolve(homes[2], 'threads.json'), JSON.stringify({ [anotherId]: row(anotherId, homes[2], '第三个来源') }))
  const options = (home: string) => ({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd: root,
    env: { ...process.env, CODEX_HOME: home, FAKE_STORE: resolve(home, 'threads.json'), FAKE_LOG: resolve(home, 'rpc.jsonl') }, timeoutMs: 1500 })
  const router = new SessionRouter(options(homes[0]), { discover: async () => homes.slice(1), create: async home => new CodexRpc(options(home)), discoveryMs: 0 })
  const bridge = new Bridge(router, new Workspace(homes[0]), homes[0], resolve(root, 'data'), true)
  await bridge.plugin.setEnabled(false)
  await bridge.bootstrap()
  await until(async () => (await bridge.refreshList(true)).length === 3)
  return { root, homes, router, bridge, close: async () => { await bridge.dispose(); await rm(root, { recursive: true, force: true }) } }
}

test('source discovery includes default and live Codex homes, canonicalizes aliases and ignores other processes', async () => {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/source-discovery-'))
  try {
    const primary = resolve(root, 'primary'), other = resolve(root, 'other'), unrelated = resolve(root, 'unrelated'), proc = resolve(root, 'proc')
    for (const home of [primary, other, unrelated]) { await mkdir(home); await writeFile(resolve(home, 'state_5.sqlite'), '') }
    await symlink(other, resolve(root, 'alias'))
    for (const [pid, command, home] of [['101', 'codex', other], ['102', 'codex', resolve(root, 'alias')], ['103', 'node', unrelated]]) {
      const directory = resolve(proc, pid); await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, 'comm'), command + '\n'); await writeFile(resolve(directory, 'environ'), `CODEX_HOME=${home}\0SECRET=never-read-or-return\0`)
    }
    assert.deepEqual(await discoverCodexHomes(primary, { proc, defaultHome: primary }), [other])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('foreign sessions stay in their source, appear under their workspace and route updates without changing a duplicate primary ID', async () => {
  const f = await fixture()
  try {
    assert.equal(f.bridge.catalog.list().length, 3)
    assert.equal((await f.bridge.open(primaryId)).title, '网页会话')
    assert.equal((await f.bridge.open(externalId)).items[0].text, '终端会话')
    assert.equal(f.router.forThread(externalId).home, f.homes[1])
    await f.bridge.rename(externalId, '终端改名')
    assert.equal((await f.bridge.refreshList(true)).find(row => row.id === externalId)?.title, '终端改名')
    assert.equal(JSON.parse(await readFile(resolve(f.homes[1], 'threads.json'), 'utf8'))[externalId].name, '终端改名')
    assert.equal(Object.hasOwn(JSON.parse(await readFile(resolve(f.homes[0], 'threads.json'), 'utf8')), externalId), false)
    assert.deepEqual((await readdir(f.homes[0])).sort(), ['rpc.jsonl', 'threads.json'])
    await f.router.call('test/append', { threadId: externalId, text: '来自终端的实时更新' })
    await until(async () => Boolean(f.bridge.threads.get(externalId)?.items.some(item => item.text === '来自终端的实时更新')))
  } finally { await f.close() }
})

test('foreign archive and restore do not resurrect a stale cached row and archives include the source on first open', async () => {
  const f = await fixture()
  try {
    await f.bridge.archive(externalId)
    assert.equal((await f.bridge.refreshList(true)).some(row => row.id === externalId), false)
    assert.ok((await f.bridge.archives()).some(row => row.id === externalId))
    await f.bridge.restore(externalId)
    assert.ok((await f.bridge.refreshList(true)).some(row => row.id === externalId))
  } finally { await f.close() }
})

test('terminal resume commands use the original home and workspace with safe shell quoting', async () => {
  const f = await fixture(["primary space's $HOME", "external space's $(printf broken)", 'another'])
  try {
    for (const [id, home] of [[primaryId, f.homes[0]], [externalId, f.homes[1]]]) {
      const command = await f.bridge.releaseToTerminal(id)
      const { stdout } = await promisify(execFile)('bash', ['-c', `codex() { printf '%s\\0' "$CODEX_HOME" "$@"; }; ${command}`])
      assert.deepEqual(stdout.split('\0').slice(0, -1), [home, 'resume', '--cd', home, id])
    }
  } finally { await f.close() }
})

test('identical native approval IDs are routed back to the correct foreign engine and not to the primary', async () => {
  const f = await fixture()
  try {
    const requests: { id: string; params: { threadId: string } }[] = []
    f.router.on('request', value => requests.push(value))
    for (const id of [externalId, anotherId]) {
      await f.bridge.open(id)
      await f.router.call('test/elicitation', { threadId: id, id: 9010, request: { requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } } } })
    }
    await until(async () => requests.length === 2)
    assert.notEqual(requests[0].id, requests[1].id)
    for (const request of requests) f.router.respond(request.id, { action: 'accept', content: { answer: request.params.threadId } })
    await until(async () => (await readFile(resolve(f.homes[2], 'rpc.jsonl'), 'utf8')).includes('"result"'))
    for (const [home, id] of [[f.homes[1], externalId], [f.homes[2], anotherId]]) {
      const response = (await readFile(resolve(home, 'rpc.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(row => row.id === 9010 && row.result)
      assert.equal(response.result.content.answer, id)
    }
    assert.equal((await readFile(resolve(f.homes[0], 'rpc.jsonl'), 'utf8')).includes('"id":9010'), false)
    assert.throws(() => f.router.respond(requests[0].id, {}), /已过期/)
  } finally { await f.close() }
})

test('a foreign engine failure leaves primary history and runtime available', async () => {
  const f = await fixture()
  try {
    await f.bridge.open(externalId)
    const source = f.router.forThread(externalId), disconnected = once(source, 'disconnected')
    process.kill(source.pid!, 'SIGTERM'); await disconnected
    assert.equal(f.router.status.state, 'ready')
    assert.match(f.bridge.threads.get(externalId)?.error || '', /CLI 连接中断/)
    assert.equal((await f.bridge.open(primaryId)).title, '网页会话')
    assert.equal((await f.bridge.refreshList(true)).length, 3, 'A transient failure must not delete its cached directory')
  } finally { await f.close() }
})

test('an active foreign terminal remains visible but cannot be resumed or counted as a web-owned task', async () => {
  const f = await fixture()
  try {
    const source = f.router.forThread(externalId), call = source.call.bind(source)
    let active = true
    Object.defineProperty(source, 'sharedEngine', { get: () => true })
    Object.defineProperty(source, 'enginePid', { get: () => 12345 })
    source.call = async (method, params) => {
      const value = await call(method, params) as Record<string, any>
      if (method === 'thread/read') value.thread.status = { type: active ? 'active' : 'idle' }
      if (method === 'thread/turns/list' && active) value.data[0].status = 'inProgress'
      return value
    }
    const view = await f.bridge.open(externalId)
    assert.equal(view.externalOwner, 12345)
    assert.equal(view.status, 'inProgress')
    assert.equal(view.turnId, `${externalId}-turn`)
    assert.equal(f.bridge.active, false, 'Merely observing a terminal must not prevent safe web restart')
    await assert.rejects(f.bridge.message(externalId, { text: 'do not run', mode: 'read-only' }), /另一端/)
    await assert.rejects(f.bridge.releaseToTerminal(externalId), /另一端/)
    assert.equal((await readFile(resolve(f.homes[1], 'rpc.jsonl'), 'utf8')).includes('"method":"thread/resume"'), false)
    active = false
    const idle = await f.bridge.handoff(externalId)
    assert.equal(idle.externalOwner, undefined)
    assert.equal(idle.turnId, null)
  } finally { await f.close() }
})

test('a slow foreign source does not delay the first primary session list', async () => {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/source-latency-'))
  let release!: (value: string[]) => void
  const gate = new Promise<string[]>(resolve => { release = resolve })
  const router = new SessionRouter({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd: root, env: { ...process.env, CODEX_HOME: root } }, { discover: () => gate })
  try {
    await router.start()
    const result = await Promise.race([router.call('thread/list', {}), delay(500).then(() => 'blocked')])
    assert.notEqual(result, 'blocked')
  } finally { release([]); await router.dispose(); await rm(root, { recursive: true, force: true }) }
})
