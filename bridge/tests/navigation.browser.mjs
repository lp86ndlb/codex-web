import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'navigation-')); const cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json') } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old', '--hide-scrollbars'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); const errors = []
page.on('pageerror', error => errors.push(error.message))
async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(50) }; assert.fail('Navigation state did not settle') }
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`); await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  const a = bridge.catalog.list()[0]
  const bPath = resolve(root, 'second'); const cPath = resolve(root, 'third'); await mkdir(bPath); await mkdir(cPath)
  const b = await bridge.addWorkspace(bPath, '工作区乙'); const c = await bridge.addWorkspace(cPath, '工作区丙')
  const group = id => page.locator(`[data-workspace-id="${id}"]`)
  const toggle = id => group(id).locator('.workspace-toggle')
  const order = () => page.locator('[data-workspace-id]').evaluateAll(nodes => nodes.map(node => node.dataset.workspaceId))
  const threadOrder = id => group(id).locator('[data-thread-id]').evaluateAll(nodes => nodes.map(node => node.dataset.threadId))
  const threads = []
  for (const [path, title] of [[cwd, '任务甲'], [cwd, '任务乙'], [cwd, '任务丙'], [bPath, '其他项目任务'], [cPath, '第三项目任务']]) {
    const thread = await bridge.create(path); await bridge.rename(thread.id, title); await bridge.message(thread.id, { text: title, mode: 'read-only' })
    await page.locator(`[data-thread-id="${thread.id}"]`).waitFor(); threads.push(thread)
  }
  for (const workspace of [a, b, c]) assert.equal(await toggle(workspace.id).getAttribute('aria-expanded'), 'true')
  await toggle(b.id).click(); assert.equal(await toggle(b.id).getAttribute('aria-expanded'), 'false')
  await page.locator(`[data-thread-id="${threads[0].id}"]`).click()
  await page.locator(`[data-thread-id="${threads[4].id}"]`).click()
  assert.equal(await toggle(a.id).getAttribute('aria-expanded'), 'true'); assert.equal(await toggle(c.id).getAttribute('aria-expanded'), 'true'); assert.equal(await toggle(b.id).getAttribute('aria-expanded'), 'false')

  // A completed mark is unread until an explicit opening; it must remain read
  // when the full thread snapshot arrives and after reloading the browser.
  const row = page.locator(`[data-thread-id="${threads[1].id}"]`)
  await row.getByRole('img', { name: '任务已完成', exact: true }).waitFor(); await row.click()
  await until(async () => await row.getByRole('img', { name: '任务已完成', exact: true }).count() === 0)
  await bridge.message(threads[1].id, { text: '新的一轮输出', mode: 'read-only' })
  await row.getByRole('img', { name: '任务已完成', exact: true }).waitFor(); await row.click()
  await until(async () => await row.getByRole('img', { name: '任务已完成', exact: true }).count() === 0)

  await toggle(a.id).dragTo(toggle(c.id), { targetPosition: { x: 80, y: 28 } })
  await until(async () => JSON.stringify(await order()) === JSON.stringify([b.id, c.id, a.id]))
  assert.equal(await toggle(a.id).getAttribute('aria-expanded'), 'true', 'Dragging a folder must not collapse it')
  await page.waitForTimeout(260)
  const aRows = await threadOrder(a.id)
  await group(a.id).locator(`[data-thread-id="${aRows[0]}"]`).dragTo(group(a.id).locator(`[data-thread-id="${aRows[2]}"]`), { targetPosition: { x: 80, y: 29 } })
  const expected = [aRows[1], aRows[2], aRows[0]]
  await until(async () => JSON.stringify(await threadOrder(a.id)) === JSON.stringify(expected))
  await bridge.message(aRows[0], { text: '这条消息不能改变手动排序', mode: 'read-only' }); await page.waitForTimeout(1100)
  assert.deepEqual(await threadOrder(a.id), expected); assert.deepEqual(await order(), [b.id, c.id, a.id]); assert.equal(await toggle(b.id).getAttribute('aria-expanded'), 'false')
  await page.reload(); await toggle(a.id).waitFor()
  assert.deepEqual(await order(), [b.id, c.id, a.id]); assert.deepEqual(await threadOrder(a.id), expected); assert.equal(await toggle(b.id).getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator(`[data-thread-id="${threads[1].id}"]`).getByRole('img', { name: '任务已完成', exact: true }).count(), 0)
  await page.screenshot({ path: resolve(output, 'navigation-manual-order.png'), fullPage: true })

  // First-seen background options must notify even when no prior idle snapshot
  // reached the browser; the fixed corner must survive composer height changes.
  const background = await bridge.create(bPath); await bridge.rename(background.id, '后台新选项'); await bridge.message(background.id, { text: '选择框测试', mode: 'read-only' })
  const waiting = page.locator('.thread-notice.notice-waiting').filter({ hasText: '后台新选项' }); await waiting.waitFor()
  const toast = await waiting.boundingBox()
  assert.ok(Math.abs(toast.y+toast.height-985)<2 && Math.abs(toast.x+toast.width-1425)<2, JSON.stringify(toast))
  assert.equal(await toggle(b.id).getAttribute('aria-expanded'), 'false')
  await page.screenshot({ path: resolve(output, 'navigation-background-choice-notice.png'), fullPage: true })
  await waiting.getByRole('button', { name: '前往会话', exact: true }).click()
  await page.getByRole('region', { name: 'Codex 需要你的选择', exact: true }).waitFor()
  await until(async () => await toggle(b.id).getAttribute('aria-expanded') === 'true')
  await page.getByRole('radio', { name: '先解释', exact: true }).check(); await page.getByRole('button', { name: '提交回答', exact: true }).click()
  await page.getByRole('region', { name: 'Codex 需要你的选择', exact: true }).waitFor({ state: 'hidden' })
  await page.locator(`[data-thread-id="${threads[0].id}"]`).click()
  await bridge.message(threads[3].id, { text: '多步提问', mode: 'read-only' })
  const native = page.locator('.thread-notice.notice-waiting').filter({ hasText: '其他项目任务' }); await native.waitFor()
  await native.getByRole('button', { name: /关闭待回复通知/ }).click()
  const approval = bridge.approvals().find(row => row.threadId === threads[3].id); bridge.answer(approval.id, 'accept', { language: ['中文'], detail: ['简洁结果'] })
  await until(async () => (await bridge.open(threads[3].id)).status === 'completed')
  await bridge.message(threads[3].id, { text: '提问第二次', mode: 'read-only' }); await native.waitFor()
  assert.deepEqual(await order(), [b.id, c.id, a.id]); assert.deepEqual(await threadOrder(a.id), expected)
  await page.screenshot({ path: resolve(output, 'navigation-native-choice-notice.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log('Edge navigation checks passed: user-owned folder state, physical workspace/thread drag ordering, stable activity order, persisted reload, unread completion clearing, first-seen and repeated background choices, fixed window-corner hub and explicit jumps.')
} catch (error) { console.log(JSON.stringify({ errors, sidebar: await page.locator('.compact-workspaces').textContent().catch(() => '') })); await page.screenshot({ path: resolve(output, 'navigation-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
