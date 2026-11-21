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
const temporary = await mkdtemp('/tmp/cweb-image-browser-'), temporaryPath = resolve(temporary, 'comparison.png')
await writeFile(temporaryPath, tinyPng(1600, [80, 125, 170], 1000))
const imagePath = resolve(cwd, 'images/result.png'); await writeFile(imagePath, tinyPng(320, [80, 130, 180], 160))
await writeFile(resolve(cwd, 'images/thumb.png'), tinyPng(40, [50, 80, 100], 20))
const id = randomUUID(), store = resolve(root, 'sessions.json')
const markdown = `![相对图片](images/result.png)\n\n![绝对图片](${imagePath})\n\n[打开图片文件](images/result.png)\n\n[查看真实图片预览效果](${imagePath})\n\n[引用式图片][figure]\n\n[figure]: images/result.png\n\n[![可点击的图片](images/thumb.png)](images/result.png)\n\n[丢失图片](images/missing.png)\n\n![临时对比图](${temporaryPath})`
await writeFile(store, JSON.stringify({ [id]: { id, name: '本地图片验证', preview: '', cwd, updatedAt: Date.now() / 1000, turns: [{ id: 'history', status: 'completed', items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '查看本地生成图片。' }] }, { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: markdown }] }] } }))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
await bridge.updatePreferences({ showInspector: false })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${app.server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] })
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
  await page.locator('.local-image').filter({ hasText: '相对图片' }).waitFor()
  const conversation = await page.locator('.conversation').boundingBox()
  await page.mouse.move(conversation.x + 100, conversation.y + 100); await page.mouse.wheel(0, -1800)
  await page.locator('.local-image').filter({ hasText: '相对图片' }).scrollIntoViewIfNeeded()
  await width(relative, 320); await width(absolute, 320)
  assert.match(await relative.getAttribute('src'), /^\/api\/image\?/)
  assert.equal(await page.locator('.transcript img[src^="data:"]').count(), 0)
  const screenshotLink = page.locator('.transcript').getByRole('link', { name: '查看真实图片预览效果', exact: true })
  await screenshotLink.scrollIntoViewIfNeeded()
  assert.equal(await screenshotLink.getAttribute('class'), 'local-image-card-link')
  await width(screenshotLink.locator('img'), 320)
  const referenceLink = page.locator('.transcript').getByRole('link', { name: '引用式图片', exact: true })
  await referenceLink.scrollIntoViewIfNeeded(); await width(referenceLink.locator('img'), 320)
  await screenshotLink.focus(); await page.keyboard.press('Enter')
  await width(dialog.getByRole('img', { name: 'result.png', exact: true }), 320)
  await close(); assert.equal(await screenshotLink.evaluate(node => node === document.activeElement), true)
  await page.getByRole('button', { name: '预览图片：可点击的图片', exact: true }).click()
  await width(dialog.getByRole('img', { name: 'result.png', exact: true }), 320); await close()
  assert.equal(await page.locator('.transcript a button, .transcript button a').count(), 0)
  const missingCard = page.locator('.local-image-file-card').filter({ hasText: '丢失图片' })
  await missingCard.scrollIntoViewIfNeeded(); await missingCard.getByRole('status').waitFor()
  await writeFile(resolve(cwd, 'images/missing.png'), tinyPng(80, [70, 150, 100], 40))
  await missingCard.getByRole('button', { name: '刷新图片：丢失图片', exact: true }).click()
  await width(missingCard.locator('img'), 80)
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


  // Temp artifacts, zoom/pan, paths, and explicit host-folder opening share the same preview.
  await page.locator('.local-image').filter({ hasText: '临时对比图' }).scrollIntoViewIfNeeded()
  await width(page.getByRole('img', { name: '临时对比图', exact: true }), 1600)
  await page.getByRole('button', { name: '预览图片：临时对比图', exact: true }).click()
  const large = dialog.getByRole('img', { name: 'comparison.png', exact: true })
  await width(large, 1600)
  await dialog.getByText('对话中的临时图片', { exact: true }).waitFor()
  assert.ok(await large.evaluate(node => node.clientWidth < node.naturalWidth))
  await dialog.getByRole('button', { name: '原始大小', exact: true }).click()
  await until(() => large.evaluate(node => node.clientWidth === 1600))
  const viewport = dialog.getByRole('region', { name: '图片查看器' })
  const area = await viewport.boundingBox()
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2)
  await page.mouse.down(); await page.mouse.move(area.x + area.width / 2 - 100, area.y + area.height / 2 - 60); await page.mouse.up()
  assert.ok(await viewport.evaluate(node => node.scrollLeft > 50))
  await viewport.focus(); await page.keyboard.press('0')
  await until(() => large.evaluate(node => node.clientWidth < node.naturalWidth))
  await dialog.getByRole('button', { name: '复制文件路径', exact: true }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), temporaryPath)
  await dialog.getByRole('button', { name: '打开所在文件夹', exact: true }).click()
  await dialog.getByText('已打开所在文件夹', { exact: true }).waitFor()
  assert.equal(opened.at(-1).path, temporaryPath); assert.equal(opened.at(-1).containingFolder, true)
  assert.equal(await dialog.getByRole('button', { name: '所在目录', exact: true }).count(), 0, 'Temp images do not grant browsing their folder')
  await page.screenshot({ path: resolve(output, 'file-experience-image.png'), fullPage: true })
  await close()

  await page.getByRole('button', { name: '连接与设置', exact: true }).click()
  await page.getByRole('button', { name: '外观与布局', exact: true }).click()
  const settings = page.locator('.settings-dialog')
  await settings.getByLabel('文件预览位置', { exact: true }).selectOption('side')
  await settings.getByLabel('聊天图片大小', { exact: true }).selectOption('compact')
  await settings.getByLabel('图片打开时', { exact: true }).selectOption('actual')
  await until(async () => (await bridge.preferences.snapshot()).preferences.imagePreviewZoom === 'actual')
  await settings.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await settings.waitFor({ state: 'hidden' })
  await page.reload(); await page.getByRole('button', { name: /本地图片验证/ }).first().waitFor()
  await page.locator('.local-image').filter({ hasText: '临时对比图' }).scrollIntoViewIfNeeded()
  const thumbnail = page.getByRole('img', { name: '临时对比图', exact: true }); await width(thumbnail, 1600)
  assert.ok(await thumbnail.evaluate(node => node.clientHeight <= 220))
  await page.getByRole('button', { name: '预览图片：临时对比图', exact: true }).click(); await width(large, 1600)
  assert.equal(await dialog.getAttribute('data-layout'), 'side')
  assert.equal(await large.evaluate(node => node.clientWidth), 1600)
  const box = await dialog.boundingBox(); assert.ok(box.x > 600 && box.x + box.width <= 1440)
  await page.screenshot({ path: resolve(output, 'file-experience-drawer.png'), fullPage: true }); await close()

  // File-panel pictures and unsent attachment thumbnails reuse the viewer.
  await page.getByRole('button', { name: '显示工作区面板', exact: true }).click()
  const inspector = page.getByRole('complementary', { name: '工作区面板', exact: true })
  await inspector.getByRole('button', { name: '文件', exact: true }).click()
  await inspector.getByRole('button', { name: 'images', exact: true }).click()
  await inspector.getByRole('button', { name: 'result.png', exact: true }).click(); await width(preview, 400)
  await dialog.getByRole('button', { name: '所在目录', exact: true }).click()
  await dialog.locator('.file-preview-directory').waitFor()
  await dialog.getByRole('button', { name: '上一级', exact: true }).click()
  await dialog.getByRole('button', { name: 'images 目录', exact: true }).waitFor(); await close()
  await inspector.getByRole('button', { name: '关闭工作区面板', exact: true }).click()
  await page.locator('.composer input[type=file]').setInputFiles(imagePath)
  const attachmentLink = page.locator('.attachment-chip').getByRole('link', { name: '预览附件：result.png', exact: true })
  await attachmentLink.waitFor()
  const attachmentUrl = await attachmentLink.getAttribute('href')
  await attachmentLink.click()
  await width(preview, 400); await dialog.getByText('附件预览', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: '使用默认应用打开', exact: true }).count(), 0)
  await close(); await page.getByRole('button', { name: '移除附件 result.png', exact: true }).click()

  const notify = (method, item) => rpc.emit('notification', { method, params: { threadId: id, turnId: 'history', item } })
  const attachmentId = new URL(attachmentUrl, base).pathname.split('/')[3]
  notify('item/completed', { id: 'sent-image', type: 'userMessage', content: [{ type: 'text', text: '<cweb_attachments>\n' + JSON.stringify([{ id: attachmentId, name: 'result.png', kind: 'image', size: 1000 }]) + '\n</cweb_attachments>' }] })
  await page.locator('.message-attachments').getByRole('link', { name: '预览附件：result.png', exact: true }).click()
  await width(preview, 400); await close()
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
  console.log(JSON.stringify({ pngLinksAsCards: true, referencedPngLinks: true, nestedImageLinks: true, missingImageRetry: true, tempImages: true, zoomAndPan: true, copyPath: true, openFolder: true, inspectorImages: true, attachmentPreview: true, persistedSettings: true, relativeAndAbsoluteImages: true, imageLinkPreview: true, defaultAppPreserved: true, manualRefreshGetsLatest: true, finalAnswerGetsLatest: true, newReplyGetsLatest: true, noPollingWhileStreaming: true, mobile: true, pageErrors: errors }))
} catch (error) {
  await page.screenshot({ path: resolve(output, 'local-images-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }); await rm(temporary, { recursive: true, force: true }) }
