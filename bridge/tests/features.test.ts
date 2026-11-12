import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'
import { PreferencesStore } from '../server/preferences.ts'
import { importLegacyHistory } from '../server/history-import.ts'
import { sessionOwners } from '../server/session-access.ts'
import { spawn } from 'node:child_process'

async function fixture(shared = false) {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/features-')); const cwd = resolve(root, 'project')
  await mkdir(cwd); const home = resolve(root, 'terminal-home'); await mkdir(home)
  const data = resolve(root, 'web-data'); await mkdir(data)
  const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd,
    env: { ...process.env, FAKE_STORE: resolve(root, 'store.json'), FAKE_LOG: resolve(root, 'rpc.jsonl') }, timeoutMs: 3000 })
  const bridge = new Bridge(rpc, new Workspace(cwd), home, data, shared)
  const app = createHttpServer({ bridge, dist: resolve('dist') })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const bootResponse = await fetch(base + '/api/bootstrap'); const boot = await bootResponse.json()
  const headers = { cookie: bootResponse.headers.get('set-cookie')!.split(';')[0], origin: base, 'x-bridge-token': boot.token, 'content-type': 'application/json' }
  const post = (path: string, value: unknown, extra = {}) => fetch(base + '/api' + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) })
  const get = (path: string) => fetch(base + '/api' + path, { headers })
  const log = async () => (await readFile(resolve(root, 'rpc.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { root, cwd, home, data, rpc, bridge, app, base, boot, headers, post, get, log, close: async () => { await app.close(); await rm(root, { recursive: true, force: true }) } }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 20)) }
}

test('graphical directory browsing requires CSRF, lists only directories, resolves links and never authorizes previews', async () => {
  const f = await fixture()
  try {
    const folders = resolve(f.root, 'folders'); await mkdir(folders)
    await Promise.all(['visible', '.hidden', 'space folder'].map(name => mkdir(resolve(folders, name))))
    await writeFile(resolve(folders, 'private.txt'), 'not a directory')
    await symlink(resolve(folders, 'visible'), resolve(folders, 'link'))
    await symlink(resolve(folders, 'private.txt'), resolve(folders, 'file-link'))
    assert.equal((await f.post('/workspaces/browse', { path: folders }, { 'x-bridge-token': 'bad' })).status, 403)
    const result = await (await f.post('/workspaces/browse', { path: folders })).json()
    assert.deepEqual(result.directories.map((row: { name: string }) => row.name), ['link', 'space folder', 'visible'])
    assert.equal(result.parent, f.root); assert.equal(f.bridge.catalog.list().length, 1)
    assert.equal((await f.post('/workspaces/browse', { path: resolve(folders, 'private.txt') })).status, 400)
    assert.equal((await f.post('/workspaces/browse', { path: resolve(folders, 'missing') })).status, 404)
    const hidden = await (await f.post('/workspaces/browse', { path: folders, hidden: true, query: '.hidden' })).json()
    assert.equal(hidden.directories[0].name, '.hidden')
    assert.equal((await f.get(`/file?workspace=${f.boot.workspaces[0].id}&path=${encodeURIComponent(resolve(folders, 'private.txt'))}`)).status, 403)
    const selected = await (await f.post('/workspaces', { path: resolve(folders, 'link') })).json()
    assert.equal(selected.path, resolve(folders, 'visible'))
  } finally { await f.close() }
})

test('preferences persist, existing sessions retain options, and per-web skill disables never write native config', async () => {
  const f = await fixture()
  try {
    const before = await f.bridge.create(f.cwd)
    assert.equal((await f.post('/preferences', { theme: 'dark', model: 'fixture', effort: 'medium', mode: 'read-only', approvalPolicy: 'never', fontSize: 18 })).status, 200)
    const after = await f.bridge.create(f.cwd)
    assert.equal((await f.bridge.preferences.options(before.id)).mode, 'workspace-write')
    assert.equal((await f.bridge.preferences.options(after.id)).mode, 'read-only')
    assert.equal((await f.post('/preferences', { mode: 'unsupported' })).status, 400)
    assert.equal((await f.post('/preferences', { fontSize: 99 })).status, 400)
    const reloaded = new PreferencesStore(resolve(f.data, 'preferences.json'))
    assert.equal((await reloaded.snapshot()).preferences.fontSize, 18)
    const list = await (await f.get(`/skills?workspace=${f.boot.workspaces[0].id}`)).json()
    const skill = list.skills[0]
    await f.bridge.setSkill(f.boot.workspaces[0].id, skill.path, false)
    assert.equal((await f.bridge.skills(f.boot.workspaces[0].id)).skills[0].enabled, false)
    await assert.rejects(f.bridge.message(after.id, { text: 'skill', mode: 'read-only', skills: [skill.path] }), /停用或不可用/)
    await f.bridge.setSkill(f.boot.workspaces[0].id, skill.path, true)
    await f.bridge.message(after.id, { text: 'use skill', mode: 'read-only', skills: [skill.path], model: 'fixture', effort: 'medium', approvalPolicy: 'never' })
    await until(() => f.bridge.threads.get(after.id)?.status === 'completed')
    assert.equal((await f.bridge.skills(f.boot.workspaces[0].id)).skills[0].uses, 1)
    const log = await f.log(); const turn = log.findLast(row => row.method === 'turn/start')
    assert.equal(turn.params.approvalPolicy, 'never'); assert.equal(turn.params.effort, 'medium')
    assert.equal(turn.params.input.at(-1).type, 'skill')
    assert.ok(log.some(row => row.method === 'thread/resume' && row.params.config?.['skills.config']?.[0]?.enabled === false))
    assert.ok(!log.some(row => row.method === 'skills/config/write'))
    await f.bridge.message(after.id, { text: 'full access policy', mode: 'danger-full-access', approvalPolicy: 'on-request' })
    await until(() => f.bridge.threads.get(after.id)?.status === 'completed')
    const full = (await f.log()).findLast(row => row.method === 'turn/start')
    assert.deepEqual(full.params.sandboxPolicy, { type: 'dangerFullAccess' }); assert.equal(full.params.approvalPolicy, 'never')
    assert.equal((await f.bridge.preferences.options(after.id)).mode, 'danger-full-access')
    assert.deepEqual(await readdir(f.home), [])
  } finally { await f.close() }
})

test('attachments preserve originals and default to on-demand image reading, with explicit native inline mode', async () => {
  const f = await fixture()
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=', 'base64')
    const upload = (name: string, content: Buffer) => fetch(f.base + '/api/attachments', { method: 'POST', headers: { ...f.headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) }, body: new Uint8Array(content).buffer })
    const image = await (await upload('diagram.png', png)).json()
    const text = await (await upload('../attachment.json', Buffer.from('A file provided by the user.'))).json()
    assert.equal(image.kind, 'image'); assert.equal(text.kind, 'file'); assert.equal(text.name, 'attachment.json')
    assert.equal((await fetch(f.base + image.url)).status, 401)
    const preview = await fetch(f.base + image.url, { headers: f.headers })
    assert.equal(preview.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png)
    assert.equal((await upload('empty.txt', Buffer.alloc(0))).status, 413)
    assert.equal((await f.post('/attachments', { file: 'wrong content type' })).status, 415)
    const thread = await f.bridge.create(f.cwd)
    await f.bridge.message(thread.id, { text: '', mode: 'read-only', attachments: [image.id, text.id] })
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed')
    const projected = f.bridge.threads.get(thread.id)!.items.find(row => row.type === 'userMessage')!
    assert.equal(projected.text, ''); assert.deepEqual(projected.attachments?.map(row => row.name), ['diagram.png', 'attachment.json'])
    const turn = (await f.log()).findLast(row => row.method === 'turn/start')
    assert.equal(turn.params.input.some((row: { type: string }) => row.type === 'localImage'), false, 'Default input must not permanently embed images in user history')
    assert.match(turn.params.input.find((row: { text?: string }) => row.text?.includes('<cweb_attachments>')).text, /先用看图工具读取/)
    assert.match(turn.params.input.find((row: { text?: string }) => row.text?.includes('<cweb_attachments>')).text, /A file provided by the user/)
    await f.bridge.updatePreferences({ imageInputMode: 'inline' })
    await f.bridge.message(thread.id, { text: 'inline image', mode: 'read-only', attachments: [image.id] })
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed')
    const inline = (await f.log()).findLast(row => row.method === 'turn/start')
    assert.ok(inline.params.input.some((row: { type: string }) => row.type === 'localImage'))
    assert.deepEqual(Buffer.from(await (await fetch(f.base + image.url, { headers: f.headers })).arrayBuffer()), png, 'Input mode must not resize or recompress the original')
    await assert.rejects(f.bridge.attachments.get('../../private'), /无效/)
    const revisionBeforeArchive = f.bridge.threads.get(thread.id)!.revision
    await f.bridge.archive(thread.id)
    assert.equal((await f.bridge.archives())[0].id, thread.id)
    assert.equal((await (await f.get(`/archives/${thread.id}`)).json()).items[0].attachments.length, 2)
    await f.bridge.restore(thread.id)
    const restored = await f.bridge.open(thread.id)
    assert.equal(restored.items[0].attachments?.length, 2)
    assert.ok(restored.revision > revisionBeforeArchive, 'SSE clients must accept a restored thread')
  } finally { await f.close() }
})

test('queued messages wait for completion and an explicit interruption clears the queue', async () => {
  const f = await fixture()
  try {
    const thread = await f.bridge.create(f.cwd)
    await f.bridge.message(thread.id, { text: '等待', mode: 'read-only' })
    await f.bridge.enqueue(thread.id, { text: 'next message', mode: 'read-only' })
    assert.equal(f.bridge.queue().length, 1)
    assert.equal((await f.log()).filter(row => row.method === 'turn/start').length, 1)
    await f.rpc.call('test/finish', { threadId: thread.id })
    await until(() => !f.bridge.queue().length && f.bridge.threads.get(thread.id)?.items.filter(item => item.type === 'userMessage').length === 2)
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed')
    await f.bridge.message(thread.id, { text: '等待', mode: 'read-only' })
    await f.bridge.enqueue(thread.id, { text: 'must not send', mode: 'read-only' })
    await f.bridge.interrupt(thread.id)
    assert.equal(f.bridge.queue().length, 0)
    assert.equal((await f.log()).filter(row => row.method === 'turn/start').length, 3)
  } finally { await f.close() }
})

test('legacy history migration is additive and idempotent across archive moves', async () => {
  const f = await fixture()
  try {
    const legacy = resolve(f.root, 'legacy'); const id = '11111111-1111-4111-a111-111111111111'
    const file = `rollout-2026-11-09T00-00-00-${id}.jsonl`; const folder = resolve(legacy, 'sessions/2026/11/09')
    await mkdir(folder, { recursive: true }); await writeFile(resolve(folder, file), 'original native history\n')
    const marker = resolve(f.data, 'history-import.json')
    assert.equal(await importLegacyHistory(legacy, f.home, marker), 1)
    assert.equal(await readFile(resolve(f.home, 'sessions/2026/11/09', file), 'utf8'), 'original native history\n')
    await rm(resolve(f.home, 'sessions'), { recursive: true }); await mkdir(resolve(f.home, 'archived_sessions'))
    await writeFile(resolve(f.home, 'archived_sessions', file), 'later archived history')
    assert.equal(await importLegacyHistory(legacy, f.home, marker), 0)
    assert.equal(await readFile(resolve(f.home, 'archived_sessions', file), 'utf8'), 'later archived history')
    assert.equal(await readFile(resolve(folder, file), 'utf8'), 'original native history\n')
  } finally { await f.close() }
})

test('shared sessions are read without resuming and an open rollout in another Codex process blocks writes', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture(true); let owner: ReturnType<typeof spawn> | undefined
  try {
    const thread = await f.bridge.create(f.cwd); await f.bridge.release(thread.id)
    const folder = resolve(f.home, 'sessions'); await mkdir(folder)
    const rollout = resolve(folder, `rollout-2026-11-09-${thread.id}.jsonl`); await writeFile(rollout, 'test history')
    owner = spawn(process.execPath, ['-e', 'process.title="codex";require("fs").openSync(process.argv[1],"a");process.send("ready");setInterval(()=>{},1000)', rollout], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    await new Promise<void>((resolve, reject) => { owner!.once('message', () => resolve()); owner!.once('error', reject) })
    assert.equal((await sessionOwners(f.home)).get(thread.id), owner.pid)
    assert.equal((await f.bridge.open(thread.id)).externalOwner, owner.pid)
    assert.ok(!(await f.log()).some(row => row.method === 'thread/resume'))
    await assert.rejects(f.bridge.message(thread.id, { text: 'must not write', mode: 'read-only' }), /另一端/)
    await assert.rejects(f.bridge.archive(thread.id), /另一端/)
    const exited = new Promise(resolve => owner!.once('exit', resolve)); owner.kill(); await exited
    await f.bridge.message(thread.id, { text: 'continue after handoff', mode: 'read-only' })
    await until(() => f.bridge.threads.get(thread.id)?.status === 'completed')
    await until(() => !f.bridge.threads.get(thread.id)?.externalOwner)
    await new Promise(resolve => setTimeout(resolve, 650))
    assert.equal((await f.log()).filter(row => row.method === 'thread/unsubscribe').length, 2)
  } finally { owner?.kill(); await f.close() }
})
