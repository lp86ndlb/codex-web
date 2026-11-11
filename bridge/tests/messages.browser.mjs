import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'messages-')), cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const store = resolve(root, 'sessions.json')
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
// Floating note placement has its own suites; it must not cover the message
// action targets in this focused send/edit regression.
await bridge.plugin.setEnabled(false)
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${app.server.address().port}`
const browser = await chromium.launch({ executablePath: '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message))
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const createdGate = gate(), sendGate = gate(), replyGate = gate()
let firstSend = true, rejectNext = false
await page.route('**/api/threads', async route => {
  if (route.request().method() !== 'POST') return route.continue()
  await createdGate.promise; await route.continue()
})
await page.route('**/api/threads/*/message', async route => {
  if (rejectNext) { rejectNext = false; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_REJECTION', message: '测试：服务拒绝发送' } }) }) }
  if (!firstSend) return route.continue()
  firstSend = false; await sendGate.promise
  const response = await route.fetch(); await replyGate.promise; await route.fulfill({ response })
})
async function until(predicate, message = 'UI state did not settle') {
  const deadline = Date.now() + 6000
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await page.waitForTimeout(20) }
}
try {
  await page.goto(base); await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  await page.locator('.workspace-card').first().click()
  const input = page.getByLabel('发送给 Codex 的消息', { exact: true })
  await input.fill('第一条立即显示的消息'); await input.press('Enter')
  await until(async () => await page.locator('.user-bubble').filter({ hasText: '第一条立即显示的消息' }).count() === 1)
  assert.equal(await input.inputValue(), '', 'A slow thread creation must not hold the submitted draft in the input')
  await input.fill('等待回执时写下的新草稿')
  createdGate.release(); await until(() => [...bridge.threads.values()].length === 1)
  await until(async () => await input.inputValue() === '等待回执时写下的新草稿')
  await until(async () => await input.evaluate(node => node === document.activeElement), 'Creating the native thread took focus away from the next draft')
  sendGate.release()
  await until(() => [...bridge.threads.values()][0]?.items.some(item => item.text === '第一条立即显示的消息'))
  await page.locator('.agent-message').first().waitFor()
  assert.equal(await page.locator('.user-message').count(), 1, 'Native echo duplicated the optimistic bubble')
  assert.equal(await input.inputValue(), '等待回执时写下的新草稿')
  replyGate.release(); await until(async () => await page.locator('.message-delivery').count() === 0)
  assert.equal(await input.inputValue(), '等待回执时写下的新草稿', 'A delayed HTTP acknowledgement erased the next draft')

  // Failure stays recoverable, including a newer draft written afterward.
  rejectNext = true; await input.fill('失败后保留的消息'); await input.press('Enter')
  await page.getByRole('button', { name: '恢复草稿', exact: true }).waitFor()
  assert.equal(await page.locator('form.composer').getAttribute('data-running'), null, 'A rejected send must not keep the loading indicator running')
  await input.fill('后来继续输入'); await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
  assert.equal(await input.inputValue(), '失败后保留的消息\n\n后来继续输入')
  assert.equal(await page.locator('.message-delivery').count(), 0)

  await input.fill('应该被回退的后续消息'); await input.press('Enter')
  await until(async () => await page.locator('.message-delivery').count() === 0)
  const original = page.locator('.user-message').filter({ hasText: '第一条立即显示的消息' })
  await original.hover(); await original.getByRole('button', { name: '复制内容', exact: true }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '第一条立即显示的消息')
  await input.fill('编辑前的草稿')
  await original.getByRole('button', { name: '编辑并从此处继续', exact: true }).click()
  await page.locator('.edit-message-banner').waitFor(); assert.equal(await input.inputValue(), '第一条立即显示的消息')
  await page.getByRole('button', { name: '取消编辑', exact: true }).click(); assert.equal(await input.inputValue(), '编辑前的草稿')
  const id = [...bridge.threads.keys()][0]
  assert.equal(JSON.parse(await readFile(store, 'utf8'))[id].turns.length, 2, 'Clicking or cancelling edit must not change history')
  await original.hover(); await original.getByRole('button', { name: '编辑并从此处继续', exact: true }).click()
  await input.fill('修正错字之后继续'); await page.screenshot({ path: resolve(output, 'messages-edit-confirm.png'), fullPage: true })
  await page.getByRole('button', { name: '从编辑处继续', exact: true }).click()
  await until(async () => await page.locator('.message-delivery').count() === 0)
  await until(() => bridge.threads.get(id)?.status === 'completed')
  assert.deepEqual(bridge.threads.get(id).items.filter(item => item.type === 'userMessage').map(item => item.text), ['修正错字之后继续'])
  assert.equal(await page.locator('.user-message').count(), 1)
  assert.equal(await input.inputValue(), '')
  await page.locator('.user-message').hover(); await page.screenshot({ path: resolve(output, 'messages-desktop.png'), fullPage: true })

  // Keep the final review bounded: light/dark, narrow viewport, and settings.
  await page.setViewportSize({ width: 390, height: 844 })
  await until(async () => await page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().right <= 0), 'The mobile sidebar did not finish retracting')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: resolve(output, 'messages-mobile.png'), fullPage: true })
  await page.keyboard.press('Control+,'); await page.getByRole('button', { name: '外观与布局', exact: true }).click()
  await page.getByRole('button', { name: '浅色', exact: true }).click()
  await page.getByRole('group', { name: '输入框运行效果', exact: true }).waitFor()
  assert.equal(await page.getByRole('group', { name: '输入框运行效果', exact: true }).getByRole('radio').count(), 5)
  await page.screenshot({ path: resolve(output, 'messages-mobile-settings.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await page.locator('.settings-dialog[open]').waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: resolve(output, 'messages-light.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ optimisticSend: true, nextDraftRetained: true, nativeEchoOnce: true, failureRecovery: true, copy: true, editCancel: true, nativeHistoryReverted: true, mobileAndLight: true, presetsInSettings: 5, pageErrors: errors }))
} catch (error) {
  await page.screenshot({ path: resolve(output, 'messages-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  createdGate.release(); sendGate.release(); replyGate.release()
  await browser.close(); await new Promise(resolve => app.server.close(resolve)); await bridge.dispose(); await rm(root, { recursive: true, force: true })
}
