import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'thread-menu-')), cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json') } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old', '--hide-scrollbars'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' })
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
const errors = [], requests = []; let stage = 'setup'
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => { if (request.url().includes('/api/threads/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname }) })
await page.addInitScript(() => document.addEventListener('contextmenu', event => { window.lastContextEvent = event }, true))
async function until(check, message = stage) { for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(40) }; assert.fail(message) }
const row = id => page.locator(`[data-thread-id="${id}"]`)
const menu = () => page.getByRole('menu', { name: '会话菜单', exact: true })
const selected = () => page.locator('.thread-link.selected').getAttribute('data-thread-id')
async function right(id) { await row(id).click({ button: 'right' }); await menu().waitFor(); assert.equal(await page.evaluate(() => window.lastContextEvent?.defaultPrevented), true) }
async function bounds() {
  const box = await menu().boundingBox(), { width, height } = page.viewportSize()
  assert.ok(box.x >= 7 && box.y >= 7 && box.x + box.width <= width - 7 && box.y + box.height <= height - 7, JSON.stringify(box))
}
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`); await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  await bridge.setPlugin(false)
  const a = await bridge.create(cwd), b = await bridge.create(cwd), c = await bridge.create(cwd)
  for (const [thread, title] of [[a, '当前会话'], [b, '另一个会话'], [c, '运行中的会话']]) {
    await bridge.rename(thread.id, title); await bridge.message(thread.id, { text: title, mode: 'read-only' })
    await until(async () => await row(thread.id).textContent().then(text => text.includes(title)))
  }
  await row(a.id).click(); await page.locator('.transcript .agent-message').first().waitFor()
  const composer = page.locator('.composer textarea'); await composer.fill('保留这份草稿')
  stage = 'right click preserves selection, draft and unread mark'
  await row(b.id).getByRole('img', { name: '任务已完成', exact: true }).waitFor()
  const beforeReads = requests.filter(request => request.method === 'GET' && request.path === `/api/threads/${b.id}`).length
  await right(b.id); await bounds()
  assert.equal(await selected(), a.id); assert.equal(await composer.inputValue(), '保留这份草稿')
  assert.equal(requests.filter(request => request.method === 'GET' && request.path === `/api/threads/${b.id}`).length, beforeReads)
  assert.equal(await row(b.id).getByRole('img', { name: '任务已完成', exact: true }).count(), 1)
  await page.screenshot({ path: resolve(output, 'thread-menu-dark.png'), fullPage: true })
  await menu().getByRole('menuitem', { name: '复制会话名称', exact: true }).click()
  await until(async () => await page.evaluate(() => navigator.clipboard.readText()) === '另一个会话')
  assert.equal(await selected(), a.id)

  stage = 'background rename has a stable target'
  await right(b.id); await menu().getByRole('menuitem', { name: '重命名', exact: true }).click()
  await page.getByLabel('会话名称', { exact: true }).fill('另一个会话 · 已改名')
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  await until(async () => await row(b.id).textContent().then(text => text.includes('已改名')))
  await page.locator('dialog[open]').waitFor({ state: 'hidden' })
  assert.equal(await selected(), a.id); assert.equal(bridge.list().find(thread => thread.id === a.id).title, '当前会话')
  assert.equal(await composer.inputValue(), '保留这份草稿')

  stage = 'keyboard entry, navigation, exit and reopening'
  await row(b.id).focus(); await page.keyboard.press('Shift+F10'); await menu().waitFor()
  await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.textContent), '归档会话')
  await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.textContent), '打开会话')
  // Observe the transition in-page; two automation round-trips can outlast
  // the 220 ms retention window on a busy desktop.
  await menu().evaluate(node => {
    window.threadMenuExit = null
    const observer = new MutationObserver(() => {
      if (node.dataset.exiting) { window.threadMenuExit = getComputedStyle(node).animationName; observer.disconnect() }
    })
    observer.observe(node, { attributes: true, attributeFilter: ['data-exiting'] })
  })
  await page.keyboard.press('Escape')
  assert.equal(await row(b.id).evaluate(node => node === document.activeElement), true)
  assert.equal(await page.evaluate(() => window.threadMenuExit), 'thread-menu-exit')
  await right(c.id); assert.equal(await page.locator('.thread-context-menu').count(), 1)
  await page.keyboard.press('Escape'); await page.locator('.thread-context-menu').waitFor({ state: 'detached' })
  await row(b.id).focus(); await page.keyboard.press('ContextMenu'); await menu().waitFor()
  await page.keyboard.press('Tab'); await menu().waitFor({ state: 'hidden' })

  stage = 'viewport clamping and dismissing'
  await row(b.id).dispatchEvent('contextmenu', { clientX: 1438, clientY: 998 }); await menu().waitFor(); await bounds()
  await page.mouse.click(700, 140); await menu().waitFor({ state: 'hidden' })
  await right(b.id)
  await page.locator('.thread-list').dispatchEvent('scroll'); await page.locator('.conversation').dispatchEvent('scroll')
  assert.equal(await menu().isVisible(), true, 'Queued focus/streaming scrolls must not dismiss a newly opened menu')
  await page.locator('.thread-list').dispatchEvent('wheel', { deltaY: 80 }); await menu().waitFor({ state: 'hidden' })
  await page.locator('.brand').dispatchEvent('contextmenu'); assert.equal(await page.evaluate(() => window.lastContextEvent?.defaultPrevented), false)

  stage = 'terminal command belongs to the context target'
  await right(b.id); await menu().getByRole('menuitem', { name: '复制终端继续命令', exact: true }).click()
  await until(async () => await page.evaluate(() => navigator.clipboard.readText()) === `CODEX_HOME='${resolve(root, 'home')}' codex resume --cd '${cwd}' '${b.id}'`)
  assert.ok(requests.some(request => request.method === 'POST' && request.path === `/api/threads/${b.id}/release`))
  assert.equal(await selected(), a.id)

  stage = 'running guards update while menu is open'
  await right(c.id); await bridge.message(c.id, { text: '等待菜单测试', mode: 'read-only' })
  await until(async () => await menu().getByRole('menuitem', { name: '归档会话', exact: true }).isDisabled())
  assert.equal(await menu().getByRole('menuitem', { name: '复制终端继续命令', exact: true }).isDisabled(), true)
  assert.equal(await menu().getByRole('menuitem', { name: '复制会话名称', exact: true }).isEnabled(), true)
  await bounds(); await page.keyboard.press('Escape'); await bridge.interrupt(c.id)
  await until(() => bridge.threads.get(c.id)?.status === 'interrupted')

  stage = 'native fork receives the right background topic'
  await right(b.id); await menu().getByRole('menuitem', { name: '创建分支话题', exact: true }).click()
  const fork = page.locator('.native-action-dialog'); await fork.waitFor()
  assert.ok((await fork.textContent()).includes('另一个会话 · 已改名'))
  await fork.getByRole('button', { name: '创建分支', exact: true }).click()
  await until(async () => await selected() !== a.id)
  const forkId = await selected(); assert.equal(bridge.threads.get(forkId)?.forkedFromId, b.id)
  await fork.waitFor({ state: 'hidden' }); await row(a.id).click()

  stage = 'background archive preserves current conversation'
  await right(b.id); await menu().getByRole('menuitem', { name: '归档会话', exact: true }).click()
  await row(b.id).waitFor({ state: 'detached' })
  assert.equal(await selected(), a.id); assert.equal(await composer.inputValue(), '保留这份草稿')
  assert.ok((await bridge.archives()).some(thread => thread.id === b.id))

  stage = 'light theme, more button, mobile and reduced motion'
  await bridge.updatePreferences({ theme: 'light' }); await until(async () => await page.locator('html').getAttribute('data-theme') === 'light')
  await row(a.id).hover(); await page.getByRole('button', { name: '会话操作：当前会话', exact: true }).click(); await menu().waitFor(); await bounds()
  await page.screenshot({ path: resolve(output, 'thread-menu-light.png'), fullPage: true })
  await page.getByRole('button', { name: '会话操作：当前会话', exact: true }).click(); await menu().waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 390, height: 720 }); await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('.mobile-menu').click(); await row(a.id).waitFor()
  await page.getByRole('button', { name: '会话操作：当前会话', exact: true }).click(); await menu().waitFor(); await bounds()
  await page.screenshot({ path: resolve(output, 'thread-menu-mobile.png'), fullPage: true })
  await page.keyboard.press('Escape'); await page.locator('.thread-context-menu').waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  const result = { rightClick: true, keyboard: true, viewportClamped: true, preservesSelectionAndDraft: true, backgroundRename: true, backgroundArchive: true, terminalTarget: true, forkTarget: true, runningGuards: true, entryAndExit: true, lightAndMobile: true, pageErrors: errors }
  await writeFile(resolve(output, 'thread-menu-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
} catch (error) { console.log(JSON.stringify({ stage, errors })); await page.screenshot({ path: resolve(output, 'thread-menu-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
