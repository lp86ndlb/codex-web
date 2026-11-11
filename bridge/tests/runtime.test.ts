import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { CodexRpc } from '../server/rpc.ts'
import { Workspace } from '../server/workspace.ts'
import { Bridge } from '../server/bridge.ts'
import { GenuiStore } from '../server/genui.ts'
import { applyThreadPatch } from '../client/thread-state.ts'
import type { ThreadView, StreamEvent } from '../shared/types.ts'

async function temporary() { await mkdir(resolve('test-results'), { recursive: true }); return mkdtemp(resolve('test-results/runtime-')) }

test('shared native engine distinguishes active work from an idle loaded session and closes only the web connection', async () => {
 const root = await temporary(); const socket = resolve(root, 's.sock'); let active = true
 const server = createServer(); const wss = new WebSocketServer({ server }); const peers = new Set<WebSocket>(); const calls: string[] = []
 const id = '11111111-1111-4111-a111-111111111111'
 let wroteFresh = false; let freshRead = false
 const freshId = '22222222-2222-4222-a222-222222222222'
 const native = () => ({ id, cwd: root, name: '共享会话', updatedAt: 100, status: { type: active ? 'active' : 'idle', activeFlags: [] }, turns: [{ id: 'old', status: 'inProgress', items: [] }] })
 wss.on('connection', connection => { peers.add(connection); connection.on('close', () => peers.delete(connection)); connection.on('message', bytes => {
  const message = JSON.parse(bytes.toString()); const method = message.method; calls.push(method)
  const reply = (result: unknown) => connection.send(JSON.stringify({ id: message.id, result }))
  if (method === 'initialize') reply({ userAgent: 'native-test' })
  else if (method === 'thread/list') reply({ data: [{ ...native(), turns: [] }], nextCursor: null })
  else if (method === 'thread/start') reply({ thread: { id: freshId, cwd: root, name: '新会话', updatedAt: 100, status: { type: 'idle' }, turns: [] }, model: 'fixture' })
  else if (method === 'thread/inject_items') reply({})
  else if (method === 'turn/start') {
    wroteFresh = true
    connection.send(JSON.stringify({ method: 'turn/started', params: { threadId: freshId, turn: { id: 'fresh-turn', status: 'inProgress', items: [] } } }))
    reply({ turn: { id: 'fresh-turn', status: 'inProgress', items: [] } })
    connection.send(JSON.stringify({ method: 'turn/completed', params: { threadId: freshId, turn: { id: 'fresh-turn', status: 'completed', items: [] } } }))
  }
  else if (method === 'thread/read' || method === 'thread/resume') {
    if (message.params?.threadId === freshId && !wroteFresh) { freshRead = true; connection.send(JSON.stringify({ id: message.id, error: { code: -1, message: 'no rollout found' } })); return }
    reply({ thread: native(), model: 'fixture' })
  }
  else if (method === 'thread/unsubscribe') reply({ status: 'unsubscribed' })
  else if (method === 'model/list') reply({ data: [] })
  else if (method === 'account/read') reply({ account: { type: 'test' } })
 }) })
 await new Promise<void>(resolve => server.listen(socket, resolve))
 const options = { socketPath: socket, enginePid: 12345, command: '', args: [], cwd: root, env: process.env, timeoutMs: 2000 }
 const terminal = new CodexRpc(options); const web = new CodexRpc(options)
 const bridge = new Bridge(web, new Workspace(root), resolve(root, 'codex-home'), resolve(root, 'web-data'), true)
 try {
  await terminal.start(); await bridge.bootstrap()
  assert.equal((await bridge.open(id)).externalOwner, 12345)
  await assert.rejects(bridge.handoff(id), /仍在另一端执行/)
  await assert.rejects(bridge.enqueue(id, { text: 'must not queue', mode: 'read-only' }), /仍在另一端执行/)
  assert.equal(bridge.queue().length, 0)
  assert.ok(!calls.includes('thread/resume'))
  const created = await bridge.create(root)
  await bridge.message(created.id, { text: 'first message', mode: 'read-only' })
  assert.equal(freshRead, false, 'An unpersisted first turn must not use thread/read')
  assert.equal(wroteFresh, true)
  active = false
  const attached = await bridge.handoff(id)
  assert.equal(attached.externalOwner, undefined); assert.equal(attached.turnId, null)
  assert.ok(calls.includes('thread/resume'))
  await bridge.dispose()
  assert.equal((await terminal.call('thread/read', { threadId: id }) as { thread: { status: { type: string } } }).thread.status.type, 'idle')
  assert.equal(terminal.status.state, 'ready')
 } finally { await bridge.dispose(); await terminal.dispose(); for (const peer of peers) peer.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

test('GenUI validates and persists interactive panels without executing authored code', async () => {
 const root = await temporary()
 try {
  const store = new GenuiStore(root)
  const id = 'thread-one'
  const rendered = await store.render(id, { spec: { title: '项目状态', panel: true, items: [{ type: 'stat', label: '通过', value: '12' }, { type: 'input', label: '名称', id: 'name' }, { type: 'button', label: '继续', action: 'next' }] } })
  assert.equal(rendered.panels[0].title, '项目状态')
  assert.equal((await new GenuiStore(root).get(id))[0].title, '项目状态')
  await assert.rejects(store.render(id, { spec: { items: [{ type: 'button', label: 'x'.repeat(210000) }] } }), /过大/)
  await assert.rejects(store.render('../../outside', { spec: { items: [{ type: 'text', content: 'x' }] } }), /无效/)
  assert.equal((await store.capture(id, '```dsh-ui\n{"title":"面板更新","panel":true,"items":[{"type":"text","content":"已更新"}]}\n```'))[0].title, '面板更新')
 } finally { await rm(root, { recursive: true, force: true }) }
})

test('thread patches preserve untouched message identity and ignore duplicates', () => {
 const old: ThreadView = { id: 'x', revision: 1, title: 'x', cwd: '/x', model: '', updatedAt: 1, status: 'inProgress', turnId: 'turn', items: [{ id: 'old', type: 'userMessage', text: 'question', status: '' }, { id: 'new', type: 'agentMessage', text: 'a', status: '' }], plan: [], diff: '', tokens: 0, error: null }
 const patch: Extract<StreamEvent, { type: 'threadPatch' }> = { type: 'threadPatch', id: 'x', baseRevision: 1, revision: 2, changes: { updatedAt: 2 }, items: [{ ...old.items[1], text: 'ab' }] }
 const result = applyThreadPatch({ x: old }, patch)
 assert.equal(result.x.items[0], old.items[0]); assert.equal(result.x.items[1].text, 'ab')
 assert.equal(applyThreadPatch(result, patch), result)
 const advanced = { x: { ...old, revision: 2, status: 'inProgress' as const, turnId: 'another' } }
 assert.equal(applyThreadPatch(advanced, { ...patch, baseRevision: 1, revision: 3 }), advanced, 'A patch cannot be applied to an intermediate HTTP snapshot')
})

test('a stale native socket falls back to an owned CLI instead of reconnecting forever', async () => {
 const root = await temporary()
 const rpc = new CodexRpc({ socketPath: resolve(root, 'missing.sock'), socketFallback: true, command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd: root, env: { ...process.env, FAKE_STORE: resolve(root, 'store.json') }, timeoutMs: 2000 })
 try { await rpc.start(); assert.equal(rpc.sharedEngine, false); assert.equal(rpc.status.state, 'ready'); assert.ok((await rpc.call('model/list') as { data: unknown[] }).data.length) }
 finally { await rpc.dispose(); await rm(root, { recursive: true, force: true }) }
})
