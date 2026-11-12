import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

// UI fixtures use only a synthetic in-process server, never a real model or
// external CLI session. Backend eligibility/replay rules have separate tests.
const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'auto-recovery-ui-')), cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const a = randomUUID(), b = randomUUID(), store = resolve(root, 'sessions.json')
const sourceTurn = 'failed-source', retryTurn = 'automatic-retry'
const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] })
const histories = {
  [a]: { id: a, name: '自动恢复界面验证', cwd, updatedAt: Date.now() / 1000, turns: [{ id: sourceTurn, status: 'failed', error: { message: 'Synthetic remote request failed' }, items: [user('source-input', '请核对示例文件。')] }] },
  [b]: { id: b, name: '恢复后的对话', cwd, updatedAt: Date.now() / 1000, turns: [
    { id: 'previous-failed', status: 'failed', items: [user('original-input', '请解释示例结果。')] },
    { id: retryTurn, status: 'completed', items: [user('retried-input', '请解释示例结果。'), { id: 'restored-answer', type: 'agentMessage', phase: 'final_answer', text: '示例结果已返回。' }] },
  ] },
}
await writeFile(store, JSON.stringify(histories))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${app.server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), errors = []
page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(id => { if (!localStorage.getItem('cweb:thread')) localStorage.setItem('cweb:thread', id) }, a)
const recovery = page.getByRole('status', { name: '自动恢复状态', exact: true })
const contextHint = page.getByRole('note', { name: '上下文使用提示', exact: true })
const runStatus = page.getByRole('group', { name: '本轮运行状态', exact: true })
async function until(check, message = 'Recovery UI did not settle') {
  for (let i = 0; i < 160; i++) { if (await check()) return; await page.waitForTimeout(25) }
  assert.fail(message)
}
async function settingChange(action, expected) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/preferences' && response.request().method() === 'POST')
  await action()
  const snapshot = await (await response).json()
  for (const [key, value] of Object.entries(expected)) assert.equal(snapshot.preferences[key], value)
}
async function generalSettings() { await page.getByText('本地引擎已连接', { exact: true }).waitFor(); await page.getByRole('button', { name: '连接与设置', exact: true }).click(); await page.getByRole('button', { name: '常规', exact: true }).click() }
async function closeSettings() { await page.getByRole('button', { name: '关闭对话框', exact: true }).click(); await page.locator('.settings-dialog[open]').waitFor({ state: 'hidden' }) }
function state(value, patch = {}) {
  const current = bridge.threads.get(a)
  bridge.changed({ ...current, status: 'failed', turnId: null, progress: undefined, error: null, recovery: { state: value, attempt: 1, maxAttempts: 1, sourceTurnId: sourceTurn, message: '确认请求失败后，只恢复尚未执行工具的消息。' }, ...patch })
}
try {
  await bridge.refreshList(true)
  const restored = await bridge.open(b)
  const marked = { ...restored, runs: restored.runs.map(run => run.id === retryTurn ? { ...run, recoveryOf: 'previous-failed' } : run) }
  await bridge.metrics.save(marked); bridge.changed(marked)
  await page.goto(base); await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  await page.locator('[data-message-id="source-input"]').waitFor()
  await generalSettings()
  const enabled = page.getByRole('checkbox', { name: '自动恢复失败的请求', exact: true })
  const images = page.getByLabel('图片读取方式', { exact: true })
  assert.equal(await enabled.isChecked(), true)
  assert.equal(await images.inputValue(), 'on-demand')
  await page.getByText('只处理从网页提交的请求；原生终端会话由 CLI 自身恢复。', { exact: true }).waitFor()
  await settingChange(() => enabled.uncheck(), { autoRecovery: false })
  await settingChange(() => images.selectOption('inline'), { imageInputMode: 'inline' })
  await closeSettings(); await page.reload(); await generalSettings()
  assert.equal(await enabled.isChecked(), false)
  assert.equal(await images.inputValue(), 'inline')
  await settingChange(() => enabled.check(), { autoRecovery: true })
  await settingChange(() => images.selectOption('on-demand'), { imageInputMode: 'on-demand' })
  await closeSettings()

  state('scheduled')
  await recovery.getByText('准备自动重试', { exact: true }).waitFor()
  assert.equal(await runStatus.count(), 0, 'Scheduling recovery must not pretend the failed model turn is still running')
  assert.equal(await page.locator('form.composer').getAttribute('data-running'), null)
  assert.equal(await recovery.locator('.recovery-count').textContent(), '1/1')

  state('retrying', { status: 'inProgress', turnId: retryTurn, progress: { stage: 'working', updatedAt: Date.now(), lastEventAt: Date.now() } })
  await recovery.getByText('正在自动重试', { exact: true }).waitFor()
  await runStatus.waitFor()
  state('recovered', { status: 'inProgress', turnId: retryTurn, progress: { stage: 'working', updatedAt: Date.now(), lastEventAt: Date.now() } })
  await recovery.getByText('响应已恢复', { exact: true }).waitFor()
  assert.ok(!(await recovery.textContent()).includes('任务成功'), 'A restored response does not establish completion of the task')

  state('manual', { recovery: { state: 'manual', attempt: 1, maxAttempts: 1, sourceTurnId: sourceTurn, message: '本轮已执行工具，请检查结果后手动继续。' } })
  await recovery.getByText('需要手动继续', { exact: true }).waitFor()
  await recovery.getByText('本轮已执行工具，请检查结果后手动继续。', { exact: true }).waitFor()
  assert.equal(await runStatus.count(), 0)
  bridge.changed({ ...bridge.threads.get(a), contextUsage: { inputTokens: 69_000, windowTokens: 100_000, updatedAt: Date.now() } })
  await page.waitForTimeout(80); assert.equal(await contextHint.count(), 0)
  bridge.changed({ ...bridge.threads.get(a), contextUsage: { inputTokens: 70_000, windowTokens: 100_000, updatedAt: Date.now() } })
  await contextHint.getByText('最近已知输入约占上下文 70%', { exact: true }).waitFor()
  assert.ok((await contextHint.textContent()).includes('并非当前请求尺寸'))
  assert.ok((await contextHint.textContent()).includes('/compact'))
  assert.equal(bridge.threads.get(a).turnId, null, 'The context suggestion must not start a new turn')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  const hintBox = await contextHint.boundingBox(), input = await page.locator('form.composer').boundingBox()
  assert.ok(hintBox && input && hintBox.y >= 64 && hintBox.y + hintBox.height <= input.y, 'Recovery feedback covered the mobile composer')
  await page.screenshot({ path: resolve(output, 'auto-recovery-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.locator('.thread-link').filter({ hasText: '恢复后的对话' }).click()
  const original = page.locator('[data-message-id="original-input"]'), retried = page.locator('[data-message-id="retried-input"]')
  await retried.waitFor()
  assert.equal(await original.locator('.message-recovery-tag').count(), 0)
  assert.equal(await retried.locator('.message-recovery-tag').textContent(), '自动重试')
  assert.equal(await original.locator('.user-bubble').textContent(), await retried.locator('.user-bubble').textContent(), 'The recovery marker must not rewrite either user message')
  // Rehydrate from native fake history plus saved metadata, rather than merely
  // proving that one live React object retained a temporary recovery flag.
  bridge.threads.delete(b)
  await page.reload(); await retried.waitFor()
  assert.equal(await retried.locator('.message-recovery-tag').textContent(), '自动重试')
  assert.equal(await original.locator('.message-recovery-tag').count(), 0)
  await page.screenshot({ path: resolve(output, 'auto-recovery-message-tag.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ settingsPersisted: true, originalQualityExplained: true, webpageOnlyRecoveryScope: true, scheduledNotFakeRunning: true, recoveryStatesVisible: true, recoveryNotTaskSuccess: true, contextThresholdAndLimits: true, contextDoesNotAutoExecute: true, retryBubbleMarked: true, tagSurvivesNativeRehydration: true, originalMessagesUnchanged: true, mobile: true, pageErrors: errors }))
} catch (error) {
  await page.screenshot({ path: resolve(output, 'auto-recovery-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
