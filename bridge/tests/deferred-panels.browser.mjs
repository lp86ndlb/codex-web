import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

await mkdir(resolve('test-results'), { recursive: true })
const root = await mkdtemp(resolve('test-results/deferred-')), cwd = resolve(root, 'project'); await mkdir(cwd)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json') } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const thread = await bridge.create(cwd)
await bridge.plugin.call(thread.id, 'todo_note_update', { focus: { current: '验证后台休眠' }, add_tasks: [{ title: '后台暂停轮询' }] })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }), page = await context.newPage()
let reads = 0, inflight = 0, maxInflight = 0
await page.addInitScript(id => localStorage.setItem('cweb:thread', id), thread.id)
try {
  await page.route('**/assets/TodoNote-*.js', route => route.abort(), { times: 1 })
  await page.route('**/api/plugins/todo-note/get', async route => {
    reads++; inflight++; maxInflight = Math.max(maxInflight, inflight)
    await new Promise(resolve => setTimeout(resolve, 180))
    await route.continue(); inflight--
  })
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  await page.getByRole('alert').filter({ hasText: '待办便签暂未加载' }).waitFor()
  const input = page.locator('.composer textarea'); await input.fill('模块失败仍可输入')
  await page.getByRole('button', { name: '刷新重试', exact: true }).click()
  await page.locator('.dtn-card').waitFor()
  assert.equal(await input.inputValue(), '模块失败仍可输入')
  await page.waitForTimeout(300)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  const hiddenReads = reads; await page.waitForTimeout(4300); assert.equal(reads, hiddenReads, 'Hidden todo kept polling')
  await bridge.plugin.call(thread.id, 'todo_note_update', { focus: { current: '重新可见后自动同步' } })
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); for (let i = 0; i < 10; i++) document.dispatchEvent(new Event('visibilitychange')) })
  await page.locator('.dtn-card').getByText('重新可见后自动同步', { exact: true }).first().waitFor()
  assert.equal(maxInflight, 1, 'Repeated focus events started overlapping todo requests')
  await context.setOffline(true)
  await page.getByRole('button', { name: '查看连接与诊断', exact: true }).click()
  await page.getByRole('heading', { name: '连接与诊断', exact: true }).waitFor()
  assert.ok(await page.locator('.settings-layout').isVisible(), 'First diagnostics visit failed offline')
  await context.setOffline(false)
  console.log('Deferred panel checks passed: failed chunk isolated, retry restores note, editor survives, hidden polling stops, visible state refreshes, requests stay single-flight, diagnostics open offline.')
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
