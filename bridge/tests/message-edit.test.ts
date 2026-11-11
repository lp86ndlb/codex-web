import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { echoedMessage, withPendingMessage, type PendingMessage } from '../client/pending-message.ts'
import type { ThreadView } from '../shared/types.ts'

async function fixture() {
  const parent = resolve('test-results'); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, 'message-edit-')), cwd = resolve(root, 'project'); await mkdir(cwd)
  const store = resolve(root, 'sessions.json'), log = resolve(root, 'rpc.jsonl')
  const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store, FAKE_LOG: log } })
  const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
  await bridge.bootstrap()
  return { root, cwd, store, log, bridge, rpc, async close() { await bridge.dispose(); await rm(root, { recursive: true, force: true }) } }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Native state did not settle'); await new Promise(resolve => setTimeout(resolve, 10)) }
}

test('native edit removes only the selected turn and later history; files and a recoverable backup remain', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.cwd), id = thread.id
    for (const text of ['保留之前', '需要修改', '删除后续']) {
      await f.bridge.message(id, { text, mode: 'workspace-write', clientMessageId: randomUUID() })
      await until(() => f.bridge.threads.get(id)?.status === 'completed')
    }
    const original = f.bridge.threads.get(id)!, target = original.items.find(item => item.text === '需要修改')!
    await writeFile(resolve(f.cwd, 'keep.txt'), '已有项目改动')
    const clientMessageId = randomUUID()
    await f.bridge.message(id, { text: '修改后的指令', mode: 'workspace-write', clientMessageId }, { itemId: target.id, turnId: target.turnId! })
    await until(() => f.bridge.threads.get(id)?.status === 'completed')
    const view = f.bridge.threads.get(id)!
    assert.deepEqual(view.items.filter(item => item.type === 'userMessage').map(item => item.text), ['保留之前', '修改后的指令'])
    assert.equal(view.items.find(item => item.text === '修改后的指令')?.id, clientMessageId)
    assert.equal(await readFile(resolve(f.cwd, 'keep.txt'), 'utf8'), '已有项目改动')
    const backups = await readdir(resolve(f.root, 'data/edit-backups'))
    const backup = JSON.parse(await readFile(resolve(f.root, 'data/edit-backups', backups[0]), 'utf8'))
    assert.equal(backup.thread.turns.length, 3)
    const persisted = JSON.parse(await readFile(f.store, 'utf8'))[id]
    assert.equal(persisted.turns.length, 2)
    assert.equal(persisted.turns[0].id, original.runs![0].id)
    const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.some(call => call.method === 'thread/read' && call.params.includeTurns === true), false, 'Paginated history must not be downloaded in full before downloading its pages again')
    const revert = calls.findIndex(call => call.method === 'thread/revert')
    assert.deepEqual(calls[revert].params, { threadId: id, beforeTurnId: target.turnId })
    assert.ok(calls.slice(revert + 1).some(call => call.method === 'thread/turns/list'), 'Revert returns metadata only; retained history must be hydrated')
  } finally { await f.close() }
})

test('edit validates attachments and message identity before interrupting or reverting', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.cwd), id = thread.id
    await f.bridge.message(id, { text: '等待编辑测试', mode: 'workspace-write' })
    const target = f.bridge.threads.get(id)!.items.find(item => item.type === 'userMessage')!
    await assert.rejects(f.bridge.message(id, { text: '修改', mode: 'workspace-write', attachments: [randomUUID()] }, { itemId: target.id, turnId: target.turnId! }), /附件不存在/)
    assert.equal(f.bridge.threads.get(id)?.status, 'inProgress')
    await assert.rejects(f.bridge.message(id, { text: '修改', mode: 'workspace-write' }, { itemId: 'stale', turnId: target.turnId! }), /已变化/)
    assert.equal(f.bridge.threads.get(id)?.status, 'inProgress')
    await f.bridge.message(id, { text: '停止后从这里继续', mode: 'workspace-write' }, { itemId: target.id, turnId: target.turnId! })
    await until(() => f.bridge.threads.get(id)?.status === 'completed')
    const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.filter(call => call.method === 'turn/interrupt').length, 1)
    assert.equal(calls.filter(call => call.method === 'thread/revert').length, 1)
    assert.deepEqual(f.bridge.threads.get(id)!.items.filter(item => item.type === 'userMessage').map(item => item.text), ['停止后从这里继续'])
  } finally { await f.close() }
})

test('optimistic messages reconcile exactly once and a failed edit restores the visible history', () => {
  const first = { id: 'old', type: 'userMessage', text: '相同的文本', status: '', turnId: 't1' }
  const thread = { id: 'thread', items: [first] } as ThreadView
  const pending: PendingMessage = { id: 'client', key: 'thread', state: 'sending', baseline: ['old'], contents: { text: '相同的文本', files: [], skills: [], references: [] }, item: { ...first, id: 'client', status: 'sending', turnId: undefined } }
  assert.equal(echoedMessage(pending, thread), false, 'An older identical prompt is not an acknowledgement')
  assert.equal(withPendingMessage(thread, pending)?.items.length, 2)
  const echo = { ...thread, items: [first, { ...first, id: 'native' }] }
  assert.equal(echoedMessage(pending, echo), true)
  assert.equal(withPendingMessage(echo, pending), echo)
  const edit = { ...pending, editTurnId: 't1' }
  assert.deepEqual(withPendingMessage(thread, edit)?.items.map(item => item.id), ['client'])
  assert.deepEqual(withPendingMessage(thread, { ...edit, state: 'failed' })?.items.map(item => item.id), ['old', 'client'])
})

test('legacy history is kept intact when the native CLI cannot revert it', async () => {
  const f = await fixture()
  try {
    const result = await f.rpc.call('thread/start', { cwd: f.cwd, historyMode: 'legacy' }) as { thread: { id: string } }
    const id = result.thread.id
    await f.bridge.refreshList(true)
    await f.bridge.message(id, { text: '保留旧版记录', mode: 'workspace-write' })
    await until(() => f.bridge.threads.get(id)?.status === 'completed')
    const before = await readFile(f.store, 'utf8'), target = f.bridge.threads.get(id)!.items.find(item => item.type === 'userMessage')!
    await assert.rejects(f.bridge.message(id, { text: '编辑', mode: 'workspace-write' }, { itemId: target.id, turnId: target.turnId! }), /旧版记录格式/)
    assert.equal(await readFile(f.store, 'utf8'), before)
    const log = await readFile(f.log, 'utf8')
    assert.equal(log.includes('"method":"thread/revert"'), false)
    assert.equal(log.includes('"method":"turn/interrupt"'), false)
  } finally { await f.close() }
})
