import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Workspace } from '../server/workspace.ts'
import { BridgeError } from '../server/errors.ts'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { createHttpServer } from '../server/http.ts'
import { tinyPng } from './image-fixture.ts'

async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/local-images-')), project = resolve(root, 'project')
  await mkdir(project)
  const write = async (path: string, bytes: Buffer | string) => { await mkdir(resolve(project, path, '..'), { recursive: true }); await writeFile(resolve(project, path), bytes) }
  return { root, project, workspace: new Workspace(project), write, close: () => rm(root, { recursive: true, force: true }) }
}
const code = (expected: string) => (error: unknown) => error instanceof BridgeError && error.code === expected

test('workspace image bytes and version follow changes, without loosening text previews', async () => {
  const f = await fixture()
  try {
    const initial = tinyPng(); await f.write('images/示意 图.png', initial)
    const info = await f.workspace.imageInfo('images/示意 图.png')
    assert.equal(info.path, 'images/示意 图.png'); assert.equal(info.mime, 'image/png'); assert.equal(info.size, initial.length)
    assert.deepEqual((await f.workspace.image('images/示意 图.png')).data, initial)
    await assert.rejects(f.workspace.preview('images/示意 图.png'), code('BINARY_FILE'))
    const changed = tinyPng(3, [170, 80, 100]); await f.write('images/示意 图.png', changed)
    const next = await f.workspace.imageInfo('images/示意 图.png')
    assert.notEqual(next.version, info.version)
    assert.deepEqual((await f.workspace.image('images/示意 图.png')).data, changed)
  } finally { await f.close() }
})

test('local image serving detects supported raster signatures and rejects executable or oversized content', async () => {
  const f = await fixture()
  try {
    const samples = [
      ['photo.jpg', Buffer.from([255, 216, 255, 224]), 'image/jpeg'],
      ['animation.gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0])]), 'image/gif'],
      ['photo.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X')]), 'image/webp'],
      ['photo.avif', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypavif'), Buffer.alloc(4), Buffer.from('avifmif1')]), 'image/avif'],
    ] as const
    for (const [path, data, mime] of samples) { await f.write(path, data); assert.equal((await f.workspace.imageInfo(path)).mime, mime) }
    await f.write('pretend.png', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    await assert.rejects(f.workspace.image('pretend.png'), code('IMAGE_TYPE'))
    await f.write('plain.svg', '<svg />'); await assert.rejects(f.workspace.image('plain.svg'), code('IMAGE_TYPE'))
    await f.write('huge.png', tinyPng()); await truncate(resolve(f.project, 'huge.png'), 20 * 1024 * 1024 + 1)
    await assert.rejects(f.workspace.imageInfo('huge.png'), code('IMAGE_LARGE'))
    await assert.rejects(f.workspace.image('.'), code('NOT_FILE'))
  } finally { await f.close() }
})

test('local image requests enforce sensitive paths, real paths, and the selected workspace', async () => {
  const f = await fixture()
  try {
    for (const path of ['.data/picture.png', '.git/picture.png', '.ssh/picture.png', 'node_modules/picture.png']) {
      await f.write(path, tinyPng()); await assert.rejects(f.workspace.image(path), code('PRIVATE_FILE'))
    }
    await f.write('image.png', tinyPng()); await symlink(resolve(f.project, 'image.png'), resolve(f.project, 'alias.png'))
    await assert.rejects(f.workspace.image('alias.png'), code('SYMLINK_FILE'))
    await writeFile(resolve(f.root, 'outside.png'), tinyPng())
    await assert.rejects(f.workspace.image('../outside.png'), code('OUTSIDE_WORKSPACE'))
    await assert.rejects(f.workspace.image('missing.png'), code('FILE_MISSING'))
  } finally { await f.close() }
})

test('HTTP local images require the same-origin workspace session and always return fresh raster bytes', async () => {
  const f = await fixture()
  const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd: f.project,
    env: { ...process.env, FAKE_STORE: resolve(f.root, 'store.json') }, timeoutMs: 3000 })
  const bridge = new Bridge(rpc, f.workspace, resolve(f.root, 'home'), resolve(f.root, 'data'))
  const app = createHttpServer({ bridge, dist: resolve('dist') })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    await f.write('image.png', tinyPng())
    const boot = await fetch(base + '/api/bootstrap'), data = await boot.json()
    const headers = { cookie: boot.headers.get('set-cookie')!.split(';')[0] }, workspace = data.workspaces[0].id
    const url = (kind: string, path = 'image.png') => `${base}/api/${kind}?${new URLSearchParams({ workspace, path })}`
    assert.equal((await fetch(url('image'))).status, 401)
    assert.equal((await fetch(url('image'), { headers: { ...headers, origin: 'https://example.com' } })).status, 403)
    const info = await (await fetch(url('image-info'), { headers })).json()
    const image = await fetch(url('image') + '&v=' + info.version, { headers })
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png')
    assert.equal(image.headers.get('cache-control'), 'no-store'); assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin')
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), tinyPng())
    const changed = tinyPng(3, [180, 70, 80]); await f.write('image.png', changed)
    const fresh = await fetch(url('image') + '&v=' + info.version, { headers })
    assert.deepEqual(Buffer.from(await fresh.arrayBuffer()), changed, 'An old URL must not serve a stale cached image')
    await f.write('bad.png', '<html>not an image</html>')
    assert.equal((await fetch(url('image', 'bad.png'), { headers })).status, 415)
    assert.equal((await fetch(url('image', '.git/image.png'), { headers })).status, 403)
    assert.equal((await fetch(url('image', '../outside.png'), { headers })).status, 403)
  } finally { await app.close(); await f.close() }
})
