import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/todo-link-'))
  const cwd = resolve(root, 'project'); const home = resolve(root, 'home'); const data = resolve(root, 'data')
  await Promise.all([cwd, home, data].map(path => mkdir(path)))
  const log = resolve(root, 'calls.jsonl')
  const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd,
    env: { ...process.env, FAKE_STORE: resolve(root, 'store.json'), FAKE_LOG: log }, timeoutMs: 3000 })
  const bridge = new Bridge(rpc, new Workspace(cwd), home, data)
  const app = createHttpServer({ bridge, dist: resolve('dist') })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  await bridge.bootstrap()
  return { root, cwd, rpc, bridge, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    close: async () => { await app.close(); await rm(root, { recursive: true, force: true }) } }
}
async function until(check: () => Promise<boolean> | boolean) {
  const end = Date.now() + 5000
  while (!(await check())) { if (Date.now() > end) throw new Error('Timed out waiting for todo link'); await new Promise(resolve => setTimeout(resolve, 20)) }
}
const input = { text: '请关联本会话的待办便签：按已有事实更新。', mode: 'read-only' as const }

test('a link click during a turn is queued once and runs after the turn completes', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.cwd)
    await f.bridge.message(thread.id, { text: '等待', mode: 'read-only' })
    await Promise.all([f.bridge.requestTodoLink(thread.id, input), f.bridge.requestTodoLink(thread.id, input)])
    assert.equal(f.bridge.queue().filter(row => row.kind === 'todo-link').length, 1)
    assert.equal((await f.bridge.plugin.get(thread.id)).tasks.length, 0)
    await f.rpc.call('test/finish', { threadId: thread.id })
    await until(async () => (await f.bridge.plugin.get(thread.id)).tasks.some((task: { title: string }) => task.title === '已关联测试任务'))
    await until(() => !f.bridge.queue().length && f.bridge.threads.get(thread.id)?.status === 'completed')
    const calls = await f.calls()
    assert.equal(calls.filter(row => row.method === 'turn/start' && row.params.input[0].text === input.text).length, 1)
  } finally { await f.close() }
})

test('a link click waits without resuming a session held by another client', async () => {
  const f = await fixture()
  try {
    const old = await f.rpc.call('thread/start', { cwd: f.cwd }) as { thread: { id: string } }; const id = old.thread.id
    await f.rpc.call('test/hold', { threadId: id, hold: true }); await f.bridge.refreshList(true)
    await f.bridge.requestTodoLink(id, input)
    await until(() => f.bridge.threads.get(id)?.todoTools === 'waiting')
    assert.equal(f.bridge.queue().filter(row => row.kind === 'todo-link').length, 1)
    assert.equal((await f.calls()).filter(row => row.method === 'thread/resume').length, 0)
    await f.rpc.call('test/hold', { threadId: id, hold: false })
    await new Promise(resolve => setTimeout(resolve, 50))
    f.bridge.changeQueue(f.bridge.queue()[0].id, true)
    await until(async () => (await f.bridge.plugin.get(id)).tasks.some((task: { title: string }) => task.title === '已关联测试任务'))
    await until(() => !f.bridge.queue().length)
    assert.equal((await f.calls()).filter(row => row.method === 'thread/resume').length, 1)
  } finally { await f.close() }
})
