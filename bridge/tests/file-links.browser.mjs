import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'file-links-')), cwd = resolve(root, 'project')
await Promise.all(['.cache', 'docs', 'src'].map(name => mkdir(resolve(cwd, name), { recursive: true })))
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const report = resolve(cwd, '.cache/privacy-review-demo.md'), sourceText = 'const one = 1\nconst two = 2\nconst three = 3\nconst four = 4\nconst five = 5\n'
await Promise.all([
  writeFile(report, '# 演示隐私检查\n\n仅包含用于自动测试的虚构内容。\n'),
  writeFile(resolve(cwd, 'README.md'), '# 演示项目\n\n[打开部署指南](docs/guide.md)\n\n[较慢的文档](docs/slow.md)\n\n[页内标题](#安装)\n\n## 安装\n\n这是安装说明。\n'),
  writeFile(resolve(cwd, 'docs/guide.md'), '# 部署指南\n\n[打开同级文档](./second.md)\n\n[代码第四行](../src/main.ts:4)\n'),
  writeFile(resolve(cwd, 'docs/second.md'), '# 同级文档\n\n相对路径解析正确。\n'),
  writeFile(resolve(cwd, 'docs/slow.md'), '# 过期的慢响应\n\n这个响应不能替换返回后的文档。\n'),
  writeFile(resolve(cwd, 'src/main.ts'), sourceText),
  writeFile(resolve(cwd, '.env'), 'TEST_SECRET=not-a-real-secret\n'),
  writeFile(resolve(cwd, 'binary.pdf'), Buffer.from([37, 80, 68, 70, 0, 1])),
])
const id = randomUUID(), store = resolve(root, 'sessions.json')
const markdown = [
  `[绝对路径报告](${report})`, '[相对路径文档](README.md)', '[文档目录](docs)', '[源码第四行](src/main.ts#L4)',
  '[受保护文件](.env)', '[外部项目](https://github.com/example/example)', `[文件协议](file://${report})`,
  '[危险协议](javascript:alert%281%29)', '[二进制文档](binary.pdf)',
].join('\n\n')
await writeFile(store, JSON.stringify({ [id]: { id, name: '文件预览验证', preview: '', cwd, updatedAt: Date.now() / 1000, turns: [{ id: 'history', status: 'completed', items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '检查文档链接。' }] }, { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: markdown }] }] } }))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${app.server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage(), errors = []
page.on('pageerror', error => errors.push(error.message))
// Desktop launches are covered with an injected opener in the HTTP tests.
// This browser suite must never open applications on the developer's desktop.
const opened = []; let rejectOpen = false, holdOpen
let releaseOpen = () => {}
await page.route('**/api/open-file', async route => {
  assert.equal(route.request().method(), 'POST')
  opened.push(route.request().postDataJSON())
  if (holdOpen) { const pending = holdOpen; holdOpen = undefined; await pending }
  await route.fulfill({ status: rejectOpen ? 503 : 200, contentType: 'application/json', body: JSON.stringify(rejectOpen ? { error: { code: 'OPEN_FAILED', message: '演示：未设置默认应用' } } : { ok: true }) })
})
const dialog = page.getByRole('dialog', { name: '文件预览', exact: true })
const documentView = dialog.locator('.file-preview-document')
const chatLink = name => page.locator('.transcript').getByRole('link', { name, exact: true })
const close = async () => { await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }) }
let releaseSlow = () => {}, slowSeen = false
try {
  await page.goto(base); await page.getByRole('button', { name: /文件预览验证/ }).first().click()
  await chatLink('绝对路径报告').click(); await documentView.getByRole('heading', { name: '演示隐私检查', exact: true }).waitFor()
  assert.equal(page.url(), base + '/', 'Opening a local document must not navigate to a static asset route')
  assert.equal(context.pages().length, 1, 'Local file previews must remain in the current tab')
  assert.equal(opened.length, 0, 'Opening a preview must never launch a desktop application automatically')
  await dialog.getByRole('button', { name: '使用默认应用打开', exact: true }).click()
  await dialog.getByText('已交给默认应用', { exact: true }).waitFor()
  assert.deepEqual(opened.at(-1), { workspace: bridge.catalog.list()[0].id, path: '.cache/privacy-review-demo.md' })
  rejectOpen = true
  await dialog.getByRole('button', { name: '使用默认应用打开', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: '演示：未设置默认应用' }).waitFor()
  await documentView.getByRole('heading', { name: '演示隐私检查', exact: true }).waitFor()
  rejectOpen = false
  await dialog.getByRole('button', { name: '复制内容', exact: true }).click()
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /仅包含用于自动测试的虚构内容/)
  await close(); assert.equal(await chatLink('绝对路径报告').evaluate(node => node === document.activeElement), true, 'Escape should restore focus to the original link')

  await chatLink('相对路径文档').click(); await documentView.getByRole('heading', { name: '演示项目', exact: true }).waitFor()
  await documentView.getByRole('link', { name: '页内标题', exact: true }).click()
  assert.equal(page.url(), base + '/', 'Document heading links must stay inside the preview')
  await dialog.getByRole('button', { name: '源码', exact: true }).click()
  assert.match(await dialog.getByLabel('文件源码', { exact: true }).inputValue(), /^# 演示项目/)
  await dialog.getByRole('button', { name: '阅读', exact: true }).click()
  await documentView.getByRole('link', { name: '打开部署指南', exact: true }).click(); await documentView.getByRole('heading', { name: '部署指南', exact: true }).waitFor()
  await documentView.getByRole('link', { name: '打开同级文档', exact: true }).click(); await documentView.getByRole('heading', { name: '同级文档', exact: true }).waitFor()
  await dialog.getByRole('button', { name: '返回上一个文件', exact: true }).click(); await documentView.getByRole('heading', { name: '部署指南', exact: true }).waitFor()
  await documentView.getByRole('link', { name: '代码第四行', exact: true }).click()
  const source = dialog.getByLabel('文件源码', { exact: true }); await source.waitFor()
  assert.equal(await source.inputValue(), sourceText)
  assert.deepEqual(await source.evaluate(node => ({ readOnly: node.readOnly, selected: node.value.slice(node.selectionStart, node.selectionEnd) })), { readOnly: true, selected: 'const four = 4' })
  await close()

  await chatLink('文档目录').click(); await dialog.locator('.file-preview-directory').waitFor()
  await dialog.getByRole('button', { name: '使用默认应用打开', exact: true }).click()
  await dialog.getByText('已交给默认应用', { exact: true }).waitFor()
  assert.equal(opened.at(-1).path, 'docs')
  await dialog.getByRole('button', { name: 'guide.md', exact: true }).click(); await documentView.getByRole('heading', { name: '部署指南', exact: true }).waitFor(); await close()
  await chatLink('源码第四行').click(); await source.waitFor()
  assert.equal(await source.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd)), 'const four = 4'); await close()
  await chatLink('文件协议').click(); await documentView.getByRole('heading', { name: '演示隐私检查', exact: true }).waitFor(); await close()
  await chatLink('受保护文件').click(); await dialog.getByRole('alert').waitFor()
  assert.match(await dialog.getByRole('alert').textContent(), /无法预览这个路径/)
  assert.equal(await dialog.getByText('TEST_SECRET=not-a-real-secret', { exact: false }).count(), 0)
  assert.equal(await dialog.getByRole('button', { name: '使用默认应用打开', exact: true }).count(), 0); await close()
  await chatLink('二进制文档').click(); await dialog.getByRole('alert').filter({ hasText: '暂不预览二进制文件' }).waitFor()
  await dialog.getByRole('button', { name: '使用默认应用打开', exact: true }).click()
  await dialog.getByText('已交给默认应用', { exact: true }).waitFor()
  assert.equal(opened.at(-1).path, resolve(cwd, 'binary.pdf')); await close()
  assert.equal(await chatLink('外部项目').getAttribute('target'), '_blank')
  assert.equal(await chatLink('外部项目').getAttribute('href'), 'https://github.com/example/example')
  assert.equal(await page.locator('.transcript').getByRole('link', { name: '危险协议', exact: true }).count(), 0)

  // An application launch is explicit and cannot overwrite another document's
  // feedback when its response arrives after in-preview navigation.
  await chatLink('相对路径文档').click(); await documentView.getByRole('heading', { name: '演示项目', exact: true }).waitFor()
  holdOpen = new Promise(resolve => { releaseOpen = resolve })
  await dialog.getByRole('button', { name: '使用默认应用打开', exact: true }).click()
  assert.equal(await dialog.getByRole('button', { name: '正在打开…', exact: true }).isDisabled(), true)
  await documentView.getByRole('link', { name: '打开部署指南', exact: true }).click()
  await documentView.getByRole('heading', { name: '部署指南', exact: true }).waitFor()
  const lateOpen = page.waitForResponse(response => new URL(response.url()).pathname === '/api/open-file')
  releaseOpen(); await (await lateOpen).finished(); await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(await dialog.getByText('已交给默认应用', { exact: true }).count(), 0)
  assert.equal(await dialog.getByRole('button', { name: '使用默认应用打开', exact: true }).isDisabled(), false)
  await close()

  // A pending navigation can be cancelled by Back. Its late response must not
  // replace the newer document or its contextual relative-link base directory.
  const slowGate = new Promise(resolve => { releaseSlow = resolve })
  await page.route('**/api/preview?*', async route => {
    if (!new URL(route.request().url()).searchParams.get('path')?.endsWith('/docs/slow.md')) return route.continue()
    const response = await route.fetch(); slowSeen = true; await slowGate; await route.fulfill({ response })
  })
  await chatLink('相对路径文档').click(); await documentView.getByRole('heading', { name: '演示项目', exact: true }).waitFor()
  await documentView.getByRole('link', { name: '较慢的文档', exact: true }).click()
  await dialog.getByRole('button', { name: '返回上一个文件', exact: true }).click(); await documentView.getByRole('heading', { name: '演示项目', exact: true }).waitFor()
  for (let i = 0; i < 50 && !slowSeen; i++) await page.waitForTimeout(20)
  assert.equal(slowSeen, true)
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/preview' && new URL(response.url()).searchParams.get('path')?.endsWith('/docs/slow.md'))
  releaseSlow(); await (await lateResponse).finished(); await page.waitForTimeout(50)
  assert.equal(await documentView.getByRole('heading', { name: '过期的慢响应', exact: true }).count(), 0)
  await documentView.getByRole('heading', { name: '演示项目', exact: true }).waitFor()
  await page.screenshot({ path: resolve(output, 'file-links-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: resolve(output, 'file-links-mobile.png'), fullPage: true })
  await close(); assert.deepEqual(errors, [])
  console.log(JSON.stringify({ absoluteHiddenDocument: true, relativeAndNestedMarkdown: true, directory: true, sourceLineSelection: true, fileProtocol: true, blockedSecrets: true, safeExternalLinks: true, cancelledNavigation: true, copyAndEscapeFocus: true, explicitDefaultApp: true, desktopFailurePreservesPreview: true, binaryDefaultApp: true, mobile: true, pageErrors: errors }))
} catch (error) {
  await page.screenshot({ path: resolve(output, 'file-links-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  releaseSlow(); releaseOpen(); await browser.close(); await app.close(); await rm(root, { recursive: true, force: true })
}
