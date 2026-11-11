import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'
import { tinyPng } from './image-fixture.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'local-image-browser-')), cwd = resolve(root, 'project')
await mkdir(resolve(cwd, 'images'), { recursive: true })
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const imagePath = resolve(cwd, 'images/result.png'); await writeFile(imagePath, tinyPng(320, [80, 130, 180], 160))
const id = randomUUID(), store = resolve(root, 'sessions.json')
const markdown = `![相对图片](images/result.png)\n\n![绝对图片](${imagePath})\n\n[打开图片文件](images/result.png)`
await writeFile(store, JSON.stringify({ [id]: { id, name: '本地图片验证', preview: '', cwd, updatedAt: Date.now() / 1000, turns: [{ id: 'history', status: 'completed', items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '查看本地生成图片。' }] }, { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: markdown }] }] } }))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${app.server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], opened = []
let metadataRequests = 0
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => { if (new URL(request.url()).pathname === '/api/image-info') metadataRequests++ })
await page.route('**/api/open-file', async route => { opened.push(route.request().postDataJSON()); await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }) })
const dialog = page.getByRole('dialog', { name: '文件预览', exact: true })
async function until(check, reason = 'Local image state did not settle') {
  for (let i = 0; i < 120; i++) { if (await check()) return; await page.waitForTimeout(50) }
  assert.fail(reason)
}
async function width(image, expected) {
  await image.scrollIntoViewIfNeeded()
  await until(() => image.evaluate((node, expected) => node.complete && node.naturalWidth === expected, expected), `Expected decoded image width ${expected}`)
}
const close = async () => { await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }) }
try {
  await page.goto(base); await page.getByRole('button', { name: /本地图片验证/ }).first().click()
  const relative = page.locator('.transcript').getByRole('img', { name: '相对图片', exact: true })
  const absolute = page.locator('.transcript').getByRole('img', { name: '绝对图片', exact: true })
  await width(relative, 320); await width(absolute, 320)
  assert.match(await relative.getAttribute('src'), /^\/api\/image\?/)
  assert.equal(await page.locator('.transcript img[src^="data:"]').count(), 0)
  await page.getByRole('button', { name: '预览图片：相对图片', exact: true }).click()
  const preview = dialog.getByRole('img', { name: 'result.png', exact: true })
  await width(preview, 320); assert.equal(context.pages().length, 1); assert.equal(opened.length, 0)
  await dialog.getByRole('button', { name: '使用默认应用打开', exact: true }).click()
  await dialog.getByText('已交给默认应用', { exact: true }).waitFor()
  assert.equal(opened.at(-1).path, 'images/result.png')

  const oldPreviewUrl = await preview.getAttribute('src')
  await writeFile(imagePath, tinyPng(400, [175, 80, 105], 160))
  await dialog.getByRole('button', { name: '刷新图片', exact: true }).click(); await width(preview, 400)
  assert.notEqual(await preview.getAttribute('src'), oldPreviewUrl)
  await page.screenshot({ path: resolve(output, 'local-image-preview.png'), fullPage: true })
  await close()
  await page.getByRole('button', { name: '刷新图片：相对图片', exact: true }).click(); await width(relative, 400)
  await page.locator('.transcript').getByRole('link', { name: '打开图片文件', exact: true }).click(); await width(preview, 400); await close()

  const notify = (method, item) => rpc.emit('notification', { method, params: { threadId: id, turnId: 'history', item } })
  const live = { id: 'live-image', type: 'agentMessage', phase: 'final_answer', text: '![流式图片](images/result.png)' }
  notify('item/started', live)
  const streaming = page.locator('.transcript').getByRole('img', { name: '流式图片', exact: true })
  await width(streaming, 400)
  const beforeDelta = metadataRequests
  rpc.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: id, itemId: live.id, delta: '\n\n后续说明' } })
  await page.getByText('后续说明', { exact: true }).waitFor()
  assert.equal(metadataRequests, beforeDelta, 'Streaming text must not poll or reload unchanged local images')
  await writeFile(imagePath, tinyPng(500, [75, 160, 115], 160))
  notify('item/completed', { ...live, text: live.text + '\n\n后续说明' }); await width(streaming, 500)

  await writeFile(imagePath, tinyPng(600, [170, 130, 65], 160))
  notify('item/completed', { id: 'new-image', type: 'agentMessage', phase: 'final_answer', text: '![新回复图片](images/result.png)' })
  await width(page.locator('.transcript').getByRole('img', { name: '新回复图片', exact: true }), 600)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: resolve(output, 'local-images-mobile.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ relativeAndAbsoluteImages: true, imageLinkPreview: true, defaultAppPreserved: true, manualRefreshGetsLatest: true, finalAnswerGetsLatest: true, newReplyGetsLatest: true, noPollingWhileStreaming: true, mobile: true, pageErrors: errors }))
} catch (error) {
  await page.screenshot({ path: resolve(output, 'local-images-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
