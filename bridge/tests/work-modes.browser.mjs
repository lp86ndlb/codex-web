import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'work-modes-browser-')); const cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const log = resolve(root, 'rpc.jsonl')
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old', '--hide-scrollbars'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); const errors = []
page.on('pageerror', error => errors.push(error.message))
const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
try {
  const base = `http://127.0.0.1:${app.server.address().port}`
  await page.goto(base); await page.locator('.workspace-card').first().click()
  const input = page.getByLabel('发送给 Codex 的消息', { exact: true })
  await input.fill('/plan'); await input.press('Enter'); await page.locator('.plan-mode-banner').waitFor()
  await input.fill('规划测试'); await input.press('Enter'); await page.getByRole('heading', { name: '规划方案', exact: true }).waitFor()
  const summary = page.getByLabel('任务结算').last(); await summary.getByText('120 tokens', { exact: true }).waitFor()
  const user = page.locator('.user-message').last(); const time = user.locator('time')
  assert.equal(await time.evaluate(node => getComputedStyle(node).opacity), '0')
  assert.match(await time.getAttribute('title'), /CLI 消息时间/)
  assert.match(await time.getAttribute('datetime'), /^\d{4}-\d{2}-\d{2}T/)
  await user.hover(); assert.equal(await time.evaluate(node => Number(getComputedStyle(node).opacity) > .5), true)
  await summary.getByText('用量详情', { exact: true }).click()
  await summary.getByText(/CLI 没有提供单任务额度百分比/).waitFor()
  await page.screenshot({ path: resolve(output, 'task-metrics.png'), fullPage: true })
  await summary.getByText('用量详情', { exact: true }).click()
  await input.fill('/plan'); await input.press('Enter'); await page.locator('.plan-mode-banner').waitFor({ state: 'hidden' })
  await input.fill('规划测试'); await input.press('Enter'); await page.getByText('已处于执行模式', { exact: true }).waitFor()

  await input.fill('/goal 让功能通过验收，并在全部检查通过后结束'); await input.press('Enter')
  const dialog = page.getByRole('dialog', { name: '会话目标', exact: true }); await dialog.waitFor()
  assert.equal(await dialog.getByLabel('目标与验收条件').inputValue(), '让功能通过验收，并在全部检查通过后结束')
  await dialog.getByLabel('目标 Token 预算').fill('5000')
  await dialog.getByRole('checkbox', { name: '保存后开始执行', exact: true }).uncheck()
  const before = (await calls()).filter(row => row.method === 'turn/start').length
  await page.screenshot({ path: resolve(output, 'goal-dialog.png'), fullPage: true })
  await dialog.getByRole('button', { name: '保存目标', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
  await page.locator('.goal-title strong').filter({ hasText: '让功能通过验收' }).waitFor()
  assert.equal((await calls()).filter(row => row.method === 'turn/start').length, before)
  await page.getByRole('button', { name: '暂停目标', exact: true }).click(); await page.locator('.goal-paused').waitFor()
  await page.reload(); await page.locator('.goal-paused').waitFor()
  const beforeResume = (await calls()).filter(row => row.method === 'turn/start').length
  await page.getByRole('button', { name: '恢复目标', exact: true }).click(); await page.locator('.goal-active').waitFor()
  await page.locator('.user-message').filter({ hasText: '继续推进当前目标：' }).waitFor()
  assert.equal((await calls()).filter(row => row.method === 'turn/start').length, beforeResume + 1)
  await page.screenshot({ path: resolve(output, 'goal-active.png'), fullPage: true })
  await page.getByRole('button', { name: '编辑目标', exact: true }).click(); await dialog.waitFor()
  await dialog.getByRole('button', { name: '清除目标', exact: true }).click(); await page.locator('.goal-bar').waitFor({ state: 'hidden' })

  // Creating a goal before the first thread must retain the modal and submit once.
  await page.getByRole('button', { name: /新建会话/ }).first().click()
  await input.fill('/goal'); await input.press('Enter'); await dialog.waitFor()
  await dialog.getByLabel('目标与验收条件').fill('完成一次目标验收测试')
  assert.equal(await dialog.getByRole('checkbox', { name: '保存后开始执行', exact: true }).isChecked(), true)
  await dialog.getByRole('button', { name: '保存目标', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
  await page.locator('.user-message').filter({ hasText: '完成一次目标验收测试' }).waitFor()
  await page.locator('.goal-title strong').filter({ hasText: '完成一次目标验收测试' }).waitFor()
  assert.equal((await calls()).filter(row => row.method === 'turn/start' && row.params.input[0].text === '完成一次目标验收测试').length, 1)

  // Failed saves leave the objective intact; retrying after recovery works.
  await page.getByRole('button', { name: '编辑目标', exact: true }).click(); await dialog.waitFor()
  await dialog.getByLabel('目标与验收条件').fill('恢复后保留的目标输入')
  const failGoalSave = route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CLI_OFFLINE', message: '测试：引擎连接暂时中断' } }) }) : route.continue()
  await page.route('**/api/threads/*/goal', failGoalSave)
  await dialog.getByRole('button', { name: '保存目标', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: '引擎连接暂时中断' }).waitFor()
  assert.equal(await dialog.getByLabel('目标与验收条件').inputValue(), '恢复后保留的目标输入')
  await page.unroute('**/api/threads/*/goal', failGoalSave)
  await dialog.getByRole('button', { name: '保存目标', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
  await page.locator('.goal-title strong').filter({ hasText: '恢复后保留的目标输入' }).waitFor()

  await page.setViewportSize({ width: 390, height: 844 })
  await input.fill('/goal'); await input.press('Enter'); await dialog.waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  const modal = await dialog.boundingBox(); assert.ok(modal.x >= 0 && modal.x + modal.width <= 390)
  await page.screenshot({ path: resolve(output, 'goal-mobile.png'), fullPage: true })
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  console.log('Edge work-mode checks passed: native plan toggle, hover timestamps, honest task metrics, shared goal creation/pause/resume/clear, first-thread creation, single submission, failed-save recovery and mobile layout.')
} catch (error) {
  console.log(JSON.stringify({ errors, tail: (await page.locator('main').textContent().catch(() => '')).slice(-900) }))
  await page.screenshot({ path: resolve(output, 'work-modes-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
