import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Workspace } from '../server/workspace.ts'
import { BridgeError } from '../server/errors.ts'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { createHttpServer } from '../server/http.ts'

async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/preview-'))
  const project = resolve(root, 'project'); await mkdir(project)
  const workspace = new Workspace(project)
  const write = async (path: string, text: string | Buffer) => {
    const file = resolve(project, path)
    await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, text)
  }
  return { root, project, workspace, write, close: () => rm(root, { recursive: true, force: true }) }
}

function code(expected: string) {
  return (error: unknown) => error instanceof BridgeError && error.code === expected
}

test('explicit document previews allow safe hidden documents without exposing them in ordinary file browsing', async () => {
  const f = await fixture()
  try {
    await f.write('.cache/privacy-review-20261111.md', '# Local privacy review')
    await f.write('.github/topics.json', '["codex", "local-first"]')
    await f.write('src/main.ts', 'export const ready = true')
    assert.deepEqual(await f.workspace.preview(resolve(f.project, '.cache/privacy-review-20261111.md')), {
      path: '.cache/privacy-review-20261111.md', kind: 'file', text: '# Local privacy review', language: 'markdown',
    })
    assert.equal((await f.workspace.preview('.github/topics.json')).language, 'json')
    assert.equal((await f.workspace.preview('src/../src/main.ts')).path, 'src/main.ts')
    assert.deepEqual(await f.workspace.preview('src'), { path: 'src', kind: 'directory' })
    assert.deepEqual(await f.workspace.preview('.'), { path: '.', kind: 'directory' })
    assert.deepEqual((await f.workspace.files()).map(file => file.name), ['src'])
    await assert.rejects(f.workspace.file('.github/topics.json'), code('PRIVATE_FILE'))
    await assert.rejects(f.workspace.files('.cache'), code('PRIVATE_FILE'))
  } finally { await f.close() }
})

test('explicit previews reject runtime data, credentials, private keys, links, and paths outside the selected workspace', async () => {
  const f = await fixture()
  try {
    const privateFiles = [
      '.data/threads.json', 'bridge/.data/events.json', '.git/config', '.codex/auth.json', '.ssh/id_ed25519',
      '.aws/credentials', '.docker/config.json', 'node_modules/package/index.js', '.env', '.env.production',
      'config/credentials.json', 'config/auth.json', '.netrc', '.npmrc', 'signing.pem', 'private.key',
    ]
    for (const path of privateFiles) {
      await f.write(path, 'private')
      await assert.rejects(f.workspace.preview(path), code('PRIVATE_FILE'), path)
    }
    await f.write('innocent.txt', '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate payload')
    await assert.rejects(f.workspace.preview('innocent.txt'), code('PRIVATE_FILE'))
    await f.write('docs/readme.md', 'public')
    await symlink(resolve(f.project, 'docs/readme.md'), resolve(f.project, 'linked.md'))
    await symlink(resolve(f.project, 'docs'), resolve(f.project, 'linked-docs'))
    await symlink(resolve(f.project, '.data'), resolve(f.project, 'runtime-alias'))
    await writeFile(resolve(f.root, 'outside.txt'), 'outside')
    await symlink(resolve(f.root, 'outside.txt'), resolve(f.project, 'external.md'))
    for (const path of ['linked.md', 'linked-docs/readme.md', 'runtime-alias/threads.json', 'external.md']) {
      await assert.rejects(f.workspace.preview(path), code('SYMLINK_FILE'), path)
    }
    await assert.rejects(f.workspace.preview('../outside.txt'), code('OUTSIDE_WORKSPACE'))
    await assert.rejects(f.workspace.preview(resolve(f.root, 'outside.txt')), code('OUTSIDE_WORKSPACE'))
    await assert.rejects(f.workspace.preview('missing.md'), code('FILE_MISSING'))
  } finally { await f.close() }
})

test('previews preserve text-size and binary boundaries', async () => {
  const f = await fixture()
  try {
    await f.write('too-large.md', Buffer.alloc(512 * 1024 + 1, 65))
    await f.write('binary.bin', Buffer.from([65, 0, 66]))
    await f.write('at-limit.txt', Buffer.alloc(512 * 1024, 65))
    await assert.rejects(f.workspace.preview('too-large.md'), code('FILE_LARGE'))
    await assert.rejects(f.workspace.preview('binary.bin'), code('BINARY_FILE'))
    assert.equal((await f.workspace.preview('at-limit.txt')).text?.length, 512 * 1024)
  } finally { await f.close() }
})

test('HTTP preview requires authentication, preserves workspace boundaries, and returns files or directories without caching', async () => {
  const f = await fixture()
  const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd: f.project,
    env: { ...process.env, FAKE_STORE: resolve(f.root, 'store.json'), FAKE_LOG: resolve(f.root, 'rpc.jsonl') }, timeoutMs: 3000 })
  const bridge = new Bridge(rpc, f.workspace, resolve(f.root, 'home'), resolve(f.root, 'data'))
  const app = createHttpServer({ bridge, dist: resolve('dist') })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    await f.write('.cache/privacy-review.md', '# A report')
    await f.write('.env', 'private')
    const boot = await fetch(base + '/api/bootstrap'); const data = await boot.json()
    const headers = { cookie: boot.headers.get('set-cookie')!.split(';')[0] }
    const workspaceId = data.workspaces.find((row: { path: string }) => row.path === f.project).id
    const preview = (path: string, id = workspaceId) => `${base}/api/preview?workspace=${id}&path=${encodeURIComponent(path)}`
    assert.equal((await fetch(preview('.cache/privacy-review.md'))).status, 401)
    assert.equal((await fetch(preview('.cache/privacy-review.md'), { headers: { ...headers, origin: 'https://example.com' } })).status, 403)
    const result = await fetch(preview(resolve(f.project, '.cache/privacy-review.md')), { headers })
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await result.json(), { path: '.cache/privacy-review.md', kind: 'file', text: '# A report', language: 'markdown' })
    assert.deepEqual(await (await fetch(preview('.cache'), { headers })).json(), { path: '.cache', kind: 'directory' })
    assert.equal((await fetch(preview('.env'), { headers })).status, 403)
    assert.equal((await fetch(`${base}/api/file?workspace=${workspaceId}&path=.cache/privacy-review.md`, { headers })).status, 403)
    assert.equal((await fetch(preview('missing.md'), { headers })).status, 404)
    assert.equal((await fetch(preview('.', 'unknown'), { headers })).status, 404)
    const second = resolve(f.root, 'other'); await mkdir(second); await writeFile(resolve(second, 'readme.md'), 'other workspace')
    const entry = await bridge.addWorkspace(second)
    assert.equal((await fetch(preview(resolve(second, 'readme.md')), { headers })).status, 403)
    assert.equal((await fetch(preview('readme.md', entry.id), { headers })).status, 200)
  } finally { await app.close(); await f.close() }
})
