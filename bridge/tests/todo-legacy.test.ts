import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

test('an old session safely reconnects its scoped todo tools and the stdio adapter updates only its note', async () => {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/todo-old-'))
  const cwd = resolve(root, 'project'); const data = resolve(root, 'data'); const home = resolve(root, 'home')
  await Promise.all([cwd, data, home].map(path => mkdir(path)))
  const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd,
    env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: resolve(root, 'calls.jsonl') }, timeoutMs: 3000 })
  const bridge = new Bridge(rpc, new Workspace(cwd), home, data)
  const app = createHttpServer({ bridge, dist: resolve('dist'), control: { instance: 'todo-fixture', token: 'test-control-token', stop: () => {} } })
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
    const port = (app.server.address() as { port: number }).port
    await rpc.start()
    const old = await rpc.call('thread/start', { cwd }) as { thread: { id: string } }; const id = old.thread.id
    await rpc.call('test/hold', { threadId: id, hold: true })
    await bridge.bootstrap()
    // An already loaded session ignores new resume config: report waiting,
    // rather than claim tools exist or interrupt another client's session.
    assert.equal((await bridge.open(id, true)).todoTools, 'waiting')
    assert.match(await bridge.plugin.context(id), /尚未接入/)
    // Keep the other client's idle subscription intact; don't reacquire it.
    assert.equal((await bridge.connectTodo(id)).todoTools, 'waiting')
    let log = (await readFile(resolve(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(log.filter(call => call.method === 'thread/resume').length, 1)
    await rpc.call('test/hold', { threadId: id, hold: false })
    // A fresh resume now receives the session-scoped MCP configuration.
    const attached = await bridge.connectTodo(id)
    assert.equal(attached.id, id); assert.equal(attached.todoTools, 'mcp')
    // An existing, already connected MCP server can be reused even when the
    // terminal retains its subscription.
    await rpc.call('test/hold', { threadId: id, hold: true })
    assert.equal((await bridge.connectTodo(id)).todoTools, 'mcp')
    log = (await readFile(resolve(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const resume = log.filter(call => call.method === 'thread/resume').at(-1)
    const configKey = Object.keys(resume.params.config).find(key => key.startsWith('mcp_servers.cweb_note_'))!
    assert.ok(configKey)
    const serverName = configKey.slice('mcp_servers.'.length)
    assert.equal(resume.params.config[configKey].default_tools_approval_mode, 'approve')
    assert.equal(resume.params.config[configKey].env.CWEB_TODO_SESSION_ID, id)
    assert.match(await bridge.plugin.context(id, serverName), new RegExp(`mcp__${serverName}__todo_note_update`))

    // A reconfigured cweb port is discovered through the instance state.
    await writeFile(resolve(data, 'daemon.json'), JSON.stringify({ app: 'cweb', port, instance: 'todo-fixture' }))
    child = spawn(process.execPath, [resolve('plugins/todo-note/mcp.mjs')], { cwd,
      env: { ...process.env, CWEB_TODO_SESSION_ID: id, CWEB_TODO_ORIGIN: 'http://127.0.0.1:1', CWEB_TODO_DATA_DIRECTORY: data }, stdio: ['pipe', 'pipe', 'pipe'] })
    const pending = new Map<number, (message: any) => void>()
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line); const complete = pending.get(message.id)
      if (complete) { pending.delete(message.id); complete(message) }
    })
    let requestId = 0
    const call = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++requestId; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)) }, 10000)
      pending.set(id, message => { clearTimeout(timer); resolve(message) })
      child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    assert.equal((await call('initialize', { protocolVersion: '2025-03-26' })).result.serverInfo.name, 'cweb-todo-note')
    const tools = (await call('tools/list')).result.tools
    assert.equal(tools.find((tool: any) => tool.name === 'todo_note_read').annotations.readOnlyHint, true)
    assert.equal(tools.find((tool: any) => tool.name === 'todo_note_update').annotations.readOnlyHint, false)
    const update = await call('tools/call', { name: 'todo_note_update', arguments: { add_tasks: [{ title: '旧会话任务' }] } })
    assert.ok(!update.result.isError, JSON.stringify(update))
    const note = await bridge.plugin.get(id); assert.equal(note.tasks[0].title, '旧会话任务')
    await call('tools/call', { name: 'todo_note_complete', arguments: { id: note.tasks[0].id } })
    assert.equal((await bridge.plugin.get(id)).tasks[0].state, 'awaiting')
    await bridge.setPlugin(false)
    const disabled = await call('tools/call', { name: 'todo_note_read', arguments: {} })
    assert.equal(disabled.result.isError, true)
  } finally {
    if (child) { const done = new Promise<void>(resolve => child!.once('close', () => resolve())); child.stdin.end(); await done }
    await app.close(); await rm(root, { recursive: true, force: true })
  }
})
