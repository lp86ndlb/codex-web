import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

// Real HTTP and browser interaction, backed entirely by synthetic CLI history.
// No real model request, user conversation or running cweb service is accessed.
const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'context-usage-')), cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const a = randomUUID(), b = randomUUID(), store = resolve(root, 'sessions.json')
const history = (id, name, turn) => ({ id, name, cwd, preview: '', updatedAt: Date.now() / 1000, turns: [{ id: turn, status: 'completed', startedAt: Date.now() / 1000 - 10, completedAt: Date.now() / 1000, items: [
  { id: `${turn}-user`, type: 'userMessage', content: [{ type: 'text', text: '只读查看示例上下文。' }] },
  { id: `${turn}-answer`, type: 'agentMessage', phase: 'final_answer', text: '示例回答已经完成。' },
] }] })
await writeFile(store, JSON.stringify({ [a]: history(a, '上下文圆环验证', 'turn-a'), [b]: history(b, '独立话题用量', 'turn-b') }))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const nativeCalls = [], compactRequests = [], messageRequests = []
let compactGate, failNextCompact = false
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const nativeCall = rpc.call.bind(rpc)
rpc.call = async (method, params = {}) => {
  nativeCalls.push({ method, threadId: params.threadId })
  if (method === 'thread/compact/start') {
    if (compactGate) await compactGate.promise
    if (failNextCompact) { failNextCompact = false; throw new Error('Synthetic compact transport failure') }
  }
  return nativeCall(method, params)
}
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
await bridge.preferences.update({ autoRecovery: false })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${app.server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => {
  const url = new URL(request.url())
  if (request.method() !== 'POST') return
  if (/\/api\/threads\/[^/]+\/compact$/.test(url.pathname)) compactRequests.push(url.pathname)
  if (/\/api\/threads\/[^/]+\/message$/.test(url.pathname)) messageRequests.push(url.pathname)
})
await page.addInitScript(id => localStorage.setItem('cweb:thread', id), a)
const trigger = page.getByRole('button', { name: '查看上下文用量', exact: true })
const panel = page.getByRole('dialog', { name: '上下文用量', exact: true })
const physicalPanel = page.getByRole('dialog', { name: '上下文用量', exact: true, includeHidden: true })
const compact = panel.getByRole('button', { name: '压缩上下文', exact: true })
const input = page.getByLabel('发送给 Codex 的消息', { exact: true })
const compactCalls = () => nativeCalls.filter(call => call.method === 'thread/compact/start')
const state = patch => bridge.changed({ ...bridge.threads.get(a), ...patch })
function usage(id, inputTokens, windowTokens = 100_000) {
  rpc.emit('notification', { method: 'thread/tokenUsage/updated', params: { threadId: id, turnId: id === a ? 'turn-a' : 'turn-b', tokenUsage: {
    total: { totalTokens: 99_999_999, inputTokens: 99_999_000, cachedInputTokens: 98_000_000, outputTokens: 999 },
    last: { totalTokens: inputTokens + 12, inputTokens, cachedInputTokens: 500, outputTokens: 12 }, modelContextWindow: windowTokens,
  } } })
}
async function until(check, message = 'Context usage UI did not settle') {
  for (let i = 0; i < 200; i++) { if (await check()) return; await page.waitForTimeout(25) }
  assert.fail(message)
}
async function amount(value) { await until(async () => (await trigger.textContent()).trim() === value, `Expected a context usage of ${value}`) }
async function open() { if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click(); await panel.waitFor() }
async function close() {
  const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), inContextPanel: Boolean(document.activeElement?.closest('.context-usage-popover')) }))
  await page.keyboard.press('Escape')
  try { await physicalPanel.waitFor({ state: 'detached', timeout: 5000 }) }
  catch (error) { console.log(JSON.stringify({ escapeFocusBefore: focus, contextPanelStillOpen: await trigger.getAttribute('aria-expanded') })); throw error }
}
const number = label => panel.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).evaluate(node => node.nextElementSibling.textContent.replace(/[,\s]/g, ''))
async function insideViewport() {
  const bounds = await panel.boundingBox(), anchor = await trigger.boundingBox()
  const size = page.viewportSize()
  assert.ok(bounds && anchor && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= size.width + 1 && bounds.y + bounds.height <= anchor.y + 1, JSON.stringify({ bounds, anchor, size }))
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'The context panel overflowed the viewport')
}
try {
  await bridge.refreshList(true); await bridge.open(a, true); await bridge.open(b, true)
  await page.goto(base); await trigger.waitFor(); await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  await amount('—')
  assert.equal(await trigger.getAttribute('data-level'), 'unknown')
  assert.equal(await trigger.locator('.context-ring-value').count(), 0)
  await open()
  for (const label of ['最近输入', '上下文窗口', '已用占比', '剩余占比']) assert.equal(await number(label), '—')
  assert.ok(!(await panel.textContent()).includes('0%'), 'An unknown context must never look like an empty, zero-percent context')
  await insideViewport(); await close()

  usage(a, 37_000)
  await amount('37%')
  assert.equal(await trigger.getAttribute('data-level'), 'normal')
  assert.equal(await trigger.locator('.context-ring-value').getAttribute('pathLength'), '100')
  assert.equal(Number((await trigger.locator('.context-ring-value').getAttribute('stroke-dasharray')).split(/[ ,]+/)[0]), 37)
  const normalColor = await trigger.locator('.context-ring-value').evaluate(node => getComputedStyle(node).stroke)
  await open()
  assert.equal(await number('最近输入'), '37000tokens')
  assert.equal(await number('上下文窗口'), '100000tokens')
  assert.equal(await number('已用占比'), '37%')
  assert.equal(await number('剩余占比'), '63%约63000tokens')
  assert.ok((await panel.textContent()).includes('并非当前请求尺寸或会话累计用量'))
  assert.ok(await panel.locator('time[datetime]').count())
  assert.equal(bridge.threads.get(a).tokens, 99_999_999, 'The fixture must distinguish lifetime totals from the latest context report')
  usage(a, 55_000); await amount('55%')
  assert.equal(await number('最近输入'), '55000tokens', 'An already-open panel must refresh its native usage report')
  assert.equal(await number('剩余占比'), '45%约45000tokens')
  await close()

  await page.locator('.thread-link').filter({ hasText: '独立话题用量' }).click()
  await amount('—')
  usage(b, 20_000); await amount('20%')
  usage(a, 70_000)
  await page.waitForTimeout(80); await amount('20%')
  await page.locator('.thread-link').filter({ hasText: '上下文圆环验证' }).click()
  await amount('70%')
  assert.equal(await trigger.getAttribute('data-level'), 'warning')
  const warningColor = await trigger.locator('.context-ring-value').evaluate(node => getComputedStyle(node).stroke)
  assert.notEqual(warningColor, normalColor)
  await open(); await insideViewport()
  await page.screenshot({ path: resolve(output, 'context-usage-warning-desktop.png'), fullPage: true })
  usage(a, 90_000); await amount('90%')
  assert.equal(await trigger.getAttribute('data-level'), 'critical')
  const criticalColor = await trigger.locator('.context-ring-value').evaluate(node => getComputedStyle(node).stroke)
  assert.notEqual(criticalColor, warningColor)
  usage(a, 137_000); await amount('137%')
  assert.equal(Number((await trigger.locator('.context-ring-value').getAttribute('stroke-dasharray')).split(/[ ,]+/)[0]), 100, 'Only the drawing is clamped, while the reported percentage remains truthful')
  assert.equal(await number('已用占比'), '137%')
  assert.equal(await number('剩余占比'), '0%约0tokens')
  await close()

  // Retain the panel through its actual exit animation, then release its DOM.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await open()
  const exit = await panel.getByRole('button', { name: '关闭上下文用量', exact: true }).evaluate(async button => {
    button.click(); await Promise.resolve()
    const popup = document.querySelector('[role="dialog"][aria-label="上下文用量"]')
    return { retained: Boolean(popup), exiting: popup?.hasAttribute('data-exiting'), animation: popup ? getComputedStyle(popup).animationName : '' }
  })
  assert.equal(exit.retained, true); assert.equal(exit.exiting, true); assert.match(exit.animation, /exit/)
  await physicalPanel.waitFor({ state: 'detached' })
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true)
  await open(); await page.locator('.topbar .run-badge').click(); await physicalPanel.waitFor({ state: 'detached' })
  await page.emulateMedia({ reducedMotion: 'reduce' })

  usage(a, 37_000); await amount('37%'); await open()
  const callsBeforeDisabled = compactCalls().length
  state({ status: 'inProgress', turnId: 'synthetic-running', progress: { stage: 'working', updatedAt: Date.now(), lastEventAt: Date.now() } })
  await panel.getByText('任务运行中可查看用量，等任务结束后再压缩', { exact: true }).waitFor()
  await until(() => compact.isDisabled())
  await compact.evaluate(node => node.click())
  assert.equal(compactCalls().length, callsBeforeDisabled)
  state({ status: 'completed', turnId: null, progress: undefined, externalOwner: 12345 })
  // Disabled was already true for the previous running state. Wait for the
  // actual external-owner event, rather than treating that old state as ready.
  await panel.getByText('这个会话仍在另一端执行，请在该端操作或等任务结束', { exact: true }).waitFor()
  await until(() => compact.isDisabled())
  assert.ok((await panel.textContent()).includes('另一端'))
  await compact.evaluate(node => node.click())
  assert.equal(compactCalls().length, callsBeforeDisabled, 'Externally owned or running sessions cannot issue compact requests')
  state({ externalOwner: undefined })
  await until(async () => !await compact.isDisabled())

  const draft = '保留这段尚未发送的草稿。\n压缩上下文不能发送或清空它。'
  await close(); await input.fill(draft); await open()
  failNextCompact = true
  await compact.click()
  await panel.getByRole('alert').filter({ hasText: 'Synthetic compact transport failure' }).waitFor()
  assert.equal(await input.inputValue(), draft)
  await until(async () => !await compact.isDisabled())
  assert.equal(compactCalls().length, callsBeforeDisabled + 1)

  compactGate = deferred()
  const accepted = page.waitForResponse(response => /\/api\/threads\/[^/]+\/compact$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST' && response.ok())
  await compact.evaluate(node => { node.click(); node.click() })
  await until(() => compactCalls().length === callsBeforeDisabled + 2)
  assert.equal(await compact.isDisabled(), true)
  assert.equal(await input.inputValue(), draft)
  await page.waitForTimeout(100)
  assert.equal(compactCalls().length, callsBeforeDisabled + 2, 'A double click must submit exactly one native compaction')
  compactGate.resolve(); compactGate = undefined
  await accepted
  await panel.getByRole('status').filter({ hasText: 'CLI 已接受压缩请求，等待上下文更新' }).waitFor()
  assert.equal(await compact.isDisabled(), true, 'An accepted request still waits for native compaction to finish')
  await amount('37%')
  assert.equal(await input.inputValue(), draft)
  assert.equal(compactRequests.length, 2)
  assert.ok(compactRequests.every(path => path === `/api/threads/${a}/compact`))
  assert.equal(messageRequests.length, 0, 'The action must not send /compact as an ordinary user message')
  assert.equal(nativeCalls.filter(call => ['turn/start', 'thread/sample'].includes(call.method)).length, 0, 'Viewing/compacting context must not sample a model turn')
  usage(a, 30_000)
  await amount('30%')
  await panel.getByRole('status').filter({ hasText: '上下文用量已更新' }).waitFor()
  assert.equal(await compact.isDisabled(), true, 'A newer usage report alone must not pretend native compaction completed')
  rpc.emit('notification', { method: 'thread/compacted', params: { threadId: a } })
  await until(async () => !await compact.isDisabled())
  assert.equal(await input.inputValue(), draft)

  await page.setViewportSize({ width: 390, height: 844 }); await insideViewport()
  await page.screenshot({ path: resolve(output, 'context-usage-mobile.png'), fullPage: true })
  await close()
  await page.setViewportSize({ width: 1440, height: 900 })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ unknownNotZero: true, latestInputNotLifetimeTokens: true, liveUsageUpdates: true, threadIsolation: true, warningAndCriticalThresholds: true, drawingClamped: true, anchoredUpward: true, escapedAndOutsideDismissed: true, exitRetained: true, runningAndExternalBlocked: true, nativeCompactOnly: true, duplicateCompactPrevented: true, failureRetry: true, waitsForNativeCompletion: true, usageRefreshFeedback: true, draftPreserved: true, mobile: true, pageErrors: errors }))
} catch (error) {
  await page.screenshot({ path: resolve(output, 'context-usage-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  compactGate?.resolve()
  await browser.close(); await app.close(); await rm(root, { recursive: true, force: true })
}
