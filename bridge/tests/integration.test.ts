import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'
import type { ThreadView } from '../shared/types.ts'

async function fixture() {
  const parent = resolve('test-results'); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, 'integration-'))
  const workspace = resolve(root, 'workspace'); await mkdir(workspace)
  const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd: workspace,
    env: { ...process.env, FAKE_STORE: resolve(root, 'store.json'), FAKE_LOG: resolve(root, 'rpc.jsonl') }, timeoutMs: 2_000 })
  const bridge = new Bridge(rpc, new Workspace(workspace), resolve(root, 'codex-home'))
  await bridge.initialize()
  return { root, workspace, rpc, bridge, async close() { await bridge.dispose(); await rm(root, { recursive: true, force: true }) } }
}

async function until<T>(fn: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 3_000
  do { const value = fn(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 10)) } while (Date.now() < deadline)
  throw new Error('Timed out waiting for protocol state')
}

test('account limits, activity preference, paused phases and next-turn model stay session scoped', async () => {
  const f = await fixture()
  try {
    await f.bridge.bootstrap()
    const status = await f.bridge.accountStatus()
    assert.equal(status.planType, 'test-plan')
    assert.equal((status.limits[0].primary as { usedPercent: number }).usedPercent, 35)
    assert.equal((await f.bridge.preferences.update({ showActivityDetails: true })).preferences.showActivityDetails, true)
    const thread = await f.bridge.create(f.workspace)
    await f.bridge.plugin.call(thread.id, 'todo_note_update', { set_plan: { phases: [{ title: '主线', status: 'paused' }, { title: '支线', status: 'active' }] }, add_tasks: [{ title: '主线任务', state: 'shelved', phase: '主线' }] })
    const note = await f.bridge.plugin.get(thread.id)
    assert.equal(note.plan.phases[0].status, 'paused')
    assert.equal(note.plan.phases[1].status, 'active')
    assert.equal(note.tasks[0].state, 'shelved')
    await f.bridge.message(thread.id, { text: '等待', mode: 'workspace-write', model: 'fixture' })
    await f.bridge.preferences.patchOptions(thread.id, { model: 'fixture-next' })
    await f.rpc.call('test/finish', { threadId: thread.id })
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed' ? true : undefined)
    await f.bridge.message(thread.id, { text: '下一轮', mode: 'workspace-write' })
    const log = (await readFile(resolve(f.root, 'rpc.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const turns = log.filter(row => row.method === 'turn/start')
    assert.equal(turns[0].params.model, 'fixture')
    assert.equal(turns[1].params.model, 'fixture-next')
  } finally { await f.close() }
})

test('shutdown reaps the owned process group even when a descendant ignores SIGTERM', { skip: process.platform === 'win32', timeout: 8_000 }, async () => {
  const f = await fixture()
  try {
    await f.rpc.start()
    await f.rpc.call('test/linger')
    await f.bridge.dispose()
    assert.equal(f.rpc.status.state, 'stopped')
  } finally { await f.close() }
})

test('real child transport streams UTF-8, persists native turns, restores after restart, and scopes every turn', async () => {
  const f = await fixture()
  try {
    await f.bridge.bootstrap()
    const created = await f.bridge.create(f.workspace)
    await f.bridge.message(created.id, { text: '你好', mode: 'read-only' })
    const completed = await until(() => f.bridge.threads.get(created.id)?.status === 'completed' ? f.bridge.threads.get(created.id) : undefined)
    assert.equal(completed.items.at(-1)?.text, '测试消息：你好，世界。')
    assert.equal(completed.plan[0].status, 'completed')
    assert.match(completed.diff, /\+new/)
    const summaries = await f.bridge.refreshList(true)
    assert.equal(summaries.find(row => row.id === created.id)?.status, 'completed')
    assert.ok(summaries.every(row => !('items' in row)), 'Session lists must not carry complete message histories')
    await f.bridge.rename(created.id, '可恢复的会话')
    await assert.rejects(f.rpc.call('test/crash'), /已退出/)
    assert.equal(f.rpc.status.state, 'failed')
    const resumed = await f.bridge.open(created.id)
    assert.equal(resumed.title, '可恢复的会话')
    assert.equal(resumed.items.at(-1)?.text, '测试消息：你好，世界。')
    await f.bridge.message(created.id, { text: '等待下一条指令', mode: 'workspace-write' })
    await until(() => f.bridge.threads.get(created.id)?.turnId || undefined)
    await assert.rejects(f.bridge.message(created.id, { text: '重复提交', mode: 'workspace-write' }), /正在执行/)
    await f.bridge.message(created.id, { text: '补充约束', mode: 'workspace-write', steer: true })
    await f.bridge.interrupt(created.id)
    await until(() => f.bridge.threads.get(created.id)?.status === 'interrupted' ? true : undefined)
    const log = (await readFile(resolve(f.root, 'rpc.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const turns = log.filter(row => row.method === 'turn/start')
    assert.equal(turns.length, 2)
    assert.equal(turns[0].params.sandboxPolicy.type, 'readOnly')
    assert.deepEqual(turns[1].params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [f.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true })
    assert.equal(turns[1].params.approvalPolicy, 'on-request')
    assert.equal(turns[1].params.approvalsReviewer, 'user')
    await f.bridge.archive(created.id)
    assert.equal((await f.bridge.refreshList()).length, 0)
  } finally { await f.close() }
})

test('approval and user-input requests remain pending until answered; stale answers are rejected', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.workspace)
    await f.bridge.message(thread.id, { text: '审批', mode: 'workspace-write' })
    const approval = await until(() => f.bridge.approvals()[0])
    assert.equal(f.bridge.threads.get(thread.id)?.status, 'inProgress')
    f.bridge.answer(approval.id, 'decline')
    assert.throws(() => f.bridge.answer(approval.id, 'accept'), /已失效/)
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed' ? true : undefined)
    assert.equal(f.bridge.threads.get(thread.id)?.items.find(item => item.type === 'commandExecution')?.status, 'declined')
    await f.bridge.message(thread.id, { text: '提问', mode: 'read-only' })
    const question = await until(() => f.bridge.approvals()[0])
    assert.throws(() => f.bridge.answer(question.id, 'accept'), /回答所有问题/)
    f.bridge.answer(question.id, 'accept', { language: ['中文'] })
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed' ? true : undefined)
    assert.equal(f.bridge.approvals().length, 0)
  } finally { await f.close() }
})

test('HTTP rejects foreign origins, wrong CSRF tokens and rebinding hosts; SSE reconnects with current state', async () => {
  const f = await fixture()
  const app = createHttpServer({ bridge: f.bridge, dist: resolve('dist') })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const response = await fetch(base + '/api/bootstrap')
    const boot = await response.json(); const cookie = response.headers.get('set-cookie')!.split(';')[0]
    const headers = { cookie, origin: base, 'x-bridge-token': boot.token, 'content-type': 'application/json' }
    const create = (overrides: Record<string, string> = {}) => fetch(base + '/api/threads', { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify({ cwd: f.workspace }) })
    assert.equal((await create({ origin: 'https://evil.example' })).status, 403)
    assert.equal((await create({ 'x-bridge-token': 'bad' })).status, 403)
    const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(base + '/api/bootstrap', { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(rebindingStatus, 403)
    assert.equal((await fetch(base + '/api/threads')).status, 401)
    const created = await (await create()).json() as ThreadView
    assert.ok(created.id)
    const controller = new AbortController()
    const events = await fetch(base + '/api/events?thread=' + created.id, { headers: { cookie }, signal: controller.signal })
    const reader = events.body!.getReader()
    const snapshot = new TextDecoder().decode((await reader.read()).value)
    assert.match(snapshot, /"type":"thread"/)
    assert.match(snapshot, new RegExp(created.id))
    controller.abort(); await reader.cancel().catch(() => {})
    const invalid = await fetch(base + `/api/threads/${created.id}/message`, { method: 'POST', headers, body: JSON.stringify({ text: '', mode: 'unsupported' }) })
    assert.equal(invalid.status, 400)
    assert.equal((await fetch(base + '/')).status, 200)
    assert.equal((await fetch(base + '/api/files?path=../', { headers: { cookie } })).status, 403)
  } finally { await app.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('workspace preview rejects symlink escapes, private data and binary files; Git diff includes staged and unstaged changes', async () => {
  const f = await fixture()
  try {
    const workspace = f.bridge.workspace
    await writeFile(resolve(f.root, 'outside.txt'), 'outside')
    await symlink(resolve(f.root, 'outside.txt'), resolve(f.workspace, 'escape.txt'))
    await assert.rejects(workspace.file('escape.txt'), /之外/)
    await mkdir(resolve(f.workspace, '.data'))
    await writeFile(resolve(f.workspace, '.data/auth.json'), '{"secret":"test"}')
    await assert.rejects(workspace.file('.data/auth.json'), /隐藏配置/)
    await writeFile(resolve(f.workspace, 'binary.bin'), Buffer.from([0, 1, 2]))
    await assert.rejects(workspace.file('binary.bin'), /二进制/)
    assert.ok(!(await workspace.files()).some(file => file.name === 'escape.txt' || file.name === '.data'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.workspace, stdio: 'pipe' })
    git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test')
    await writeFile(resolve(f.workspace, 'code.txt'), 'base\n'); git('add', 'code.txt'); git('commit', '-m', 'fixture')
    await writeFile(resolve(f.workspace, 'code.txt'), 'staged\n'); git('add', 'code.txt')
    await writeFile(resolve(f.workspace, 'code.txt'), 'staged\nunstaged\n')
    const diff = await workspace.diff('.', 'code.txt')
    assert.match(diff, /\+staged/); assert.match(diff, /\+unstaged/)
    await writeFile(resolve(f.workspace, 'new file.txt'), '新文件')
    assert.match(await workspace.diff('.', 'new file.txt'), /\+新文件/)
    await mkdir(resolve(f.workspace, 'src')); await writeFile(resolve(f.workspace, 'src/nested.ts'), 'export {}')
    const references = await workspace.references('')
    assert.ok(references.some(row => row.path === 'src/nested.ts'))
    assert.ok(!references.some(row => row.path === 'escape.txt' || row.path.startsWith('.data/')))
    assert.deepEqual((await workspace.references('nested')).map(row => row.path), ['src/nested.ts'])
  } finally { await f.close() }
})

test('workspace catalog persists multiple projects and HTTP confines previews even when another project is registered', async () => {
  const f = await fixture()
  const app = createHttpServer({ bridge: f.bridge, dist: resolve('dist') })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const second = resolve(f.root, 'second'); await mkdir(second); await writeFile(resolve(second, 'only-second.txt'), 'second project')
    const entry = await f.bridge.addWorkspace(second, '第二个项目')
    assert.equal((await f.bridge.addWorkspace(second)).id, entry.id)
    await f.bridge.renameWorkspace(entry.id, '已命名项目')
    const a = await f.bridge.create(f.workspace); const b = await f.bridge.create(second)
    const bootResponse = await fetch(base + '/api/bootstrap'); const boot = await bootResponse.json()
    const cookie = bootResponse.headers.get('set-cookie')!.split(';')[0]
    assert.equal(boot.workspaces.length, 2); assert.equal(boot.threads.length, 2)
    const first = boot.workspaces.find((row: { path: string }) => row.path === f.workspace)
    assert.equal((await fetch(`${base}/api/file?workspace=${first.id}&path=${encodeURIComponent(resolve(second, 'only-second.txt'))}`, { headers: { cookie } })).status, 403)
    assert.equal((await fetch(`${base}/api/file?workspace=${entry.id}&path=only-second.txt`, { headers: { cookie } })).status, 200)
    await assert.rejects(f.bridge.create(f.root), /添加此目录/)
    const { WorkspaceCatalog } = await import('../server/catalog.ts')
    const reloaded = new WorkspaceCatalog(resolve(f.root, 'workspaces.json')); await reloaded.initialize()
    assert.equal(reloaded.list().length, 2); assert.equal(reloaded.list().find(row => row.id === entry.id)?.name, '已命名项目')
    assert.equal(reloaded.find(a.cwd)?.id, first.id); assert.equal(reloaded.find(b.cwd)?.id, entry.id)
  } finally { await app.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('todo plugin bridges CLI tools, isolates sessions, waits for human completion and commits batches atomically', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.workspace)
    const other = await f.bridge.create(f.workspace)
    await f.bridge.message(thread.id, { text: '待办工具', mode: 'read-only' })
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed' ? true : undefined)
    let note = await f.bridge.plugin.get(thread.id)
    assert.equal(note.tasks.length, 1); assert.equal(note.focus.current, '验证插件')
    assert.equal((await f.bridge.plugin.get(other.id)).tasks.length, 0)
    const id = note.tasks[0].id
    await f.bridge.message(thread.id, { text: `待办完成:${id}`, mode: 'read-only' })
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed' ? true : undefined)
    note = await f.bridge.plugin.get(thread.id)
    assert.equal(note.tasks[0].state, 'awaiting'); assert.equal(note.log.length, 0)
    await assert.rejects(f.bridge.plugin.call(thread.id, 'todo_note_update', { update_tasks: [{ id, state: 'done' }] }))
    await assert.rejects(f.bridge.plugin.call(thread.id, 'confirm_task', { id }))
    await assert.rejects(f.bridge.plugin.call(thread.id, 'todo_note_update', { add_tasks: [{ title: '不得留下部分写入' }], update_tasks: [{ id: 'missing', title: 'bad' }] }))
    assert.equal((await f.bridge.plugin.get(thread.id)).tasks.length, 1)
    await f.bridge.plugin.act(thread.id, [{ type: 'reject_task', id }])
    assert.match(await f.bridge.plugin.context(thread.id), /用户未通过/)
    await f.bridge.plugin.call(thread.id, 'todo_note_complete', { id, note: '已按未通过反馈完成复核与修正，验证插件事务和会话隔离后重新提交。' })
    await f.bridge.plugin.act(thread.id, [{ type: 'confirm_task', id }])
    note = await f.bridge.plugin.get(thread.id)
    assert.equal(note.tasks.length, 0); assert.equal(note.log.length, 1)
    await Promise.all(Array.from({ length: 8 }, (_, i) => f.bridge.plugin.call(other.id, 'todo_note_update', { add_tasks: [{ title: `并发 ${i}` }] })))
    const { TodoNotePlugin } = await import('../server/todo-note.ts')
    const reloaded = new TodoNotePlugin(resolve(f.root, 'plugins/todo-note')); await reloaded.initialize()
    assert.equal((await reloaded.get(other.id)).tasks.length, 8); assert.equal((await reloaded.get(thread.id)).log.length, 1)
    await f.bridge.setPlugin(false)
    await assert.rejects(f.bridge.plugin.call(thread.id, 'todo_note_read', {}), /停用/)
    assert.equal(await f.bridge.plugin.context(thread.id), '')
    const log = (await readFile(resolve(f.root, 'rpc.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(log.find(row => row.method === 'thread/start').params.dynamicTools.filter((tool: { name: string }) => tool.name.startsWith('todo_note_')).length, 3)
    const injected = log.filter(row => row.method === 'thread/inject_items').map(row => row.params.items.map((item: { content: { text?: string }[] }) => item.content.map(part => part.text || '').join('\n')).join('\n'))
    assert.equal(injected.filter(text => text.includes('Keep the user informed')).length, 1, 'A note update must not replay the complete static guide')
    const snapshots = injected.filter(text => !text.includes('Keep the user informed'))
    assert.equal(snapshots.length, 2, 'Both the initial and updated live note must reach the model')
    assert.notEqual(snapshots[0], snapshots[1])
    assert.match(snapshots[1], /验证插件/)
    assert.equal(log.filter(row => row.id === 9003 && row.result?.success === true).length, 2)
  } finally { await f.close() }
})

test('missing project folders keep history readable and prevent further execution until restored', async () => {
  const f = await fixture()
  try {
    const created = await f.bridge.create(f.workspace)
    await f.bridge.message(created.id, { text: '保留历史', mode: 'read-only' })
    await until(() => f.bridge.threads.get(created.id)?.status === 'completed' ? true : undefined)
    await assert.rejects(f.rpc.call('test/crash'))
    await rm(f.workspace, { recursive: true })
    // The real production transport lives in the application data directory.
    // This fixture's child cwd must exist even when its project disappears.
    await mkdir(f.workspace)
    await f.rpc.start()
    await rm(f.workspace, { recursive: true })
    const history = await f.bridge.open(created.id)
    assert.match(history.error!, /历史记录仍可查看/)
    assert.ok(history.items.some(item => item.text.includes('保留历史')))
    await assert.rejects(f.bridge.message(created.id, { text: '不应执行', mode: 'workspace-write' }), /目录不存在/)
    await mkdir(f.workspace)
    const resumed = await f.bridge.open(created.id)
    assert.equal(resumed.error, null)
  } finally { await f.close() }
})

test('daemon control rejects stopping active work unless explicitly forced', async () => {
  const f = await fixture()
  let stopped = 0
  const control = { instance: 'test-instance', token: 'a'.repeat(64), stop: () => { stopped++ } }
  const app = createHttpServer({ bridge: f.bridge, dist: resolve('dist'), control })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const thread = await f.bridge.create(f.workspace)
    await f.bridge.message(thread.id, { text: '等待', mode: 'read-only' })
    const headers = { 'content-type': 'application/json', 'x-cweb-control': control.token }
    const request = (force: boolean) => fetch(base + '/api/control/stop', { method: 'POST', headers, body: JSON.stringify({ force }) })
    assert.equal((await request(false)).status, 409); assert.equal(stopped, 0)
    assert.equal((await request(true)).status, 200)
    await until(() => stopped === 1 ? true : undefined)
  } finally { await app.close(); await rm(f.root, { recursive: true, force: true }) }
})
