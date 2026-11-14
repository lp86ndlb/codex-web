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

// An invented, large transcript exercises real browser layout without opening
// a real Codex session or copying any personal conversation into the fixture.
const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'history-window-')), cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
await writeFile(resolve(cwd, 'history-step.png'), tinyPng(120, [90, 130, 160], 60))
const id = randomUUID(), runningId = randomUUID(), store = resolve(root, 'sessions.json')
const count = 110
const user = (id, text = id) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] })
const reason = number => ({ id: `reason-${number}`, type: 'reasoning', summary: [`历史任务 ${number} 的简短分析。\n\n![仅展开时读取的步骤图片](history-step.png)`], content: [] })
const command = (id, output, status = 'completed') => ({ id, type: 'commandExecution', command: 'printf synthetic-history', status, aggregatedOutput: output, exitCode: status === 'completed' ? 0 : null })
const turns = Array.from({ length: count }, (_, index) => {
  const number = index + 1
  return { id: `history-turn-${number}`, status: 'completed', items: [
    user(`user-${number}`, `第 ${number} 个历史问题：验证按需展开和稳定翻页。`),
    reason(number),
    command(`command-${number}-0`, `RAW-HISTORY-${number}-0\n` + 'Synthetic output remains available on demand.\n'.repeat(24)),
    { id: `commentary-${number}`, type: 'agentMessage', phase: 'commentary', text: `阶段说明 ${number}：这段过程应归入步骤组。` },
    { id: `native-${number}`, type: 'subAgentActivity', status: 'completed', detail: `RAW-NATIVE-${number}` },
    ...Array.from({ length: 26 }, (_, step) => command(`command-${number}-${step + 1}`, `RAW-HISTORY-${number}-${step + 1}\n` + 'Synthetic repeated output.\n'.repeat(24))),
    { id: `answer-${number}`, type: 'agentMessage', phase: 'final_answer', text: `第 ${number} 个问题的最终回答。\n\n` + '这里保留用户需要回看的结果，过程只在主动展开时加载。\n\n'.repeat(number % 3 + 1) + `\n\n\`\`\`js\nconst historyResult = ${number}\n\`\`\`` },
  ] }
})
const histories = {
  [id]: { id, name: '历史窗口与按需步骤验证', preview: '', cwd, updatedAt: Date.now() / 1000, turns },
  [runningId]: { id: runningId, name: '历史窗口运行状态验证', preview: '', cwd, updatedAt: Date.now() / 1000, turns: [{ id: 'running-turn', status: 'inProgress', items: [
    user('running-user'), command('running-done', 'Completed synthetic step'),
    command('running-working', 'Still working', 'inProgress'),
    user('running-steering'), command('running-current', 'Current synthetic step'),
  ] }] },
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
let imageReads = 0
page.on('request', request => { if (new URL(request.url()).pathname === '/api/image-info') imageReads++ })
const transcript = page.locator('.transcript'), conversation = page.getByLabel('会话内容', { exact: true })
const earlier = page.getByRole('button', { name: /显示更早的消息/ })
const visibleRows = transcript.locator(':scope > .user-message, :scope > .agent-message, :scope > .activity-group')
const group = number => page.locator(`.activity-group[data-activity-id="reason-${number}"]`)
const heading = number => group(number).locator('[data-disclosure-row]').first()
const firstId = () => transcript.getAttribute('data-window-first-id')
const domSizes = [], anchorErrors = []
async function until(check, message = 'History window did not settle') {
  for (let i = 0; i < 160; i++) { if (await check()) return; await page.waitForTimeout(25) }
  assert.fail(message)
}
async function bounded(maxRows = 60) {
  assert.ok(await visibleRows.count() <= maxRows, `Rendered rows exceeded ${maxRows}`)
  const nodes = await transcript.locator('*').count(); domSizes.push(nodes)
  assert.ok(nodes < 6000, `Collapsed history retained too many DOM nodes: ${nodes}`)
}
async function atTop() {
  await conversation.evaluate(node => {
    // Pause following away from the load boundary, then position the viewport
    // without consuming the upward gesture reserved for this test's next step.
    node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, 600)
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
    node.scrollTop = 0
  })
  await page.waitForTimeout(50)
}
async function anchor() {
  return conversation.evaluate(node => {
    const top = node.getBoundingClientRect().top
    const row = [...node.querySelectorAll('.user-message[data-message-id]')].find(row => row.getBoundingClientRect().top >= top - 1)
    return row ? { id: row.dataset.messageId, top: row.getBoundingClientRect().top - top } : null
  })
}
async function checkAnchor(before) {
  assert.ok(before, 'The page did not contain a usable reading anchor')
  const after = await page.locator(`[data-message-id="${before.id}"]`).evaluate(node => node.getBoundingClientRect().top - node.closest('.conversation').getBoundingClientRect().top)
  const error = Math.abs(after - before.top); anchorErrors.push(error)
  assert.ok(error < 3, `Loading older history moved the reading anchor ${before.id} by ${error}px`)
}
try {
  await page.goto(base)
  await page.getByRole('button', { name: /历史窗口与按需步骤验证/ }).first().click()
  await page.locator('[data-message-id="user-110"]').waitFor()
  await page.evaluate(() => document.fonts.ready)
  await until(async () => await conversation.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 3))
  const originalFirst = await firstId()
  await bounded()
  assert.equal(await transcript.locator(':scope > .agent-commentary').count(), 0, 'Process commentary must share the step disclosure rather than clutter historical Q/A')
  assert.equal(await transcript.locator('.tool-output, .file-change, .local-image').count(), 0, 'Closed raw details must not mount expensive content')
  assert.equal(imageReads, 0, 'Closed reasoning images must not request local files')
  assert.equal(await heading(110).getAttribute('aria-expanded'), 'true', 'The latest completed question remains available until new input')
  await page.locator('.agent-message pre').filter({ hasText: 'const historyResult = 110' }).waitFor()

  // Reaching the top through a layout adjustment alone must not load all pages.
  await conversation.evaluate(node => { node.scrollTop = 0 })
  await page.waitForTimeout(100)
  assert.equal(await firstId(), originalFirst)
  const hidden = turns.flatMap(turn => turn.items).findIndex(item => item.id === originalFirst)
  assert.ok((await earlier.textContent()).includes(String(hidden)), 'The header must report hidden native items, not compact row counts')

  // Click once, then keep rolling upward at the boundary. Both paths retain an
  // overlapping reading anchor while replacing distant, newer history rows.
  let pages = 0
  while (await earlier.count()) {
    await atTop()
    const beforeId = await firstId(), beforeAnchor = await anchor()
    if (pages === 0) await earlier.click()
    else {
      const box = await conversation.boundingBox()
      await page.mouse.move(box.x + 100, box.y + 100)
      await page.mouse.wheel(0, -120)
    }
    await until(async () => {
      if (await firstId() !== beforeId) return true
      // A single gesture inside the 450 ms page-load throttle is deliberately
      // ignored. Model continued scrolling until the next page can be loaded.
      if (pages > 0) await page.mouse.wheel(0, -120)
      return false
    }, 'Continuing to roll upward did not reveal the preceding page')
    await checkAnchor(beforeAnchor)
    await bounded()
    assert.equal(await transcript.locator('.tool-output, .local-image').count(), 0)
    assert.equal(await transcript.locator('.activity-group [data-disclosure-row][aria-expanded="true"]').count(), 0, 'Older pages should initially show only Q/A and closed step headers')
    assert.equal(imageReads, 0)
    pages++
    assert.ok(pages < 30, 'History paging did not reach its earliest message')
  }
  assert.ok(pages > 3, 'The fixture did not exercise repeated history paging')
  await page.locator('[data-message-id="user-1"]').waitFor()
  await conversation.evaluate(node => { node.scrollTop = 0 })
  await page.screenshot({ path: resolve(output, 'history-window-compact.png'), fullPage: true })

  // Expanded groups mount summaries; raw reasoning and command contents mount
  // only when their own detail is explicitly opened.
  await heading(1).click()
  const firstReason = group(1).locator('details[data-activity-id="reason-1"]')
  await firstReason.waitFor()
  assert.equal(imageReads, 0)
  await firstReason.locator('summary').click()
  const image = group(1).getByRole('img', { name: '仅展开时读取的步骤图片', exact: true })
  await image.waitFor()
  await until(() => image.evaluate(node => node.complete && node.naturalWidth === 120))
  assert.ok(imageReads > 0)
  const firstCommand = group(1).locator('details.tool-card').filter({ has: page.locator('summary .tool-description') }).first()
  await firstCommand.locator('summary').click()
  await firstCommand.getByText('RAW-HISTORY-1-0', { exact: false }).waitFor()
  assert.equal(await firstCommand.locator('.full-command').textContent(), '$ printf synthetic-history')
  await firstCommand.locator('summary').click()
  await until(async () => await firstCommand.locator('.tool-output').count() === 0, 'Closing raw output retained its contents')
  await heading(1).click()
  await until(async () => await group(1).locator('.activity-group-body').count() === 0, 'Closing the historical group retained its detail tree')
  const readsAfterClose = imageReads
  rpc.emit('notification', { method: 'item/completed', params: { threadId: id, turnId: 'history-turn-1', item: { ...reason(1), summary: ['后台更新也不应读取已折叠图片。\n\n![仅展开时读取的步骤图片](history-step.png)'] } } })
  await page.waitForTimeout(100)
  assert.equal(imageReads, readsAfterClose, 'Updating a closed historical step fetched its hidden image')

  const firstPage = await firstId()
  await page.getByRole('button', { name: /显示较新的消息/ }).click()
  await until(async () => await firstId() !== firstPage, 'The newer-page control did not advance the history window')
  await bounded()
  await atTop()
  await earlier.click()
  await until(async () => await firstId() === firstPage, 'The earlier-page control did not restore the previous page')

  // Preserve the current historical page while a bounded live tail receives a
  // burst larger than one whole window. Native ids remain available to the rail.
  await atTop()
  const reading = await anchor(), historicalFirst = await firstId()
  for (let index = 0; index < 95; index++) rpc.emit('notification', { method: 'item/completed', params: { threadId: id, turnId: 'history-turn-110', item: { id: `live-answer-${index}`, type: 'agentMessage', phase: 'final_answer', text: `实时尾部结果 ${index}，不应夺走历史阅读位置。` } } })
  await page.locator('.agent-message').filter({ hasText: '实时尾部结果 94，' }).waitFor({ state: 'attached' })
  assert.equal(await firstId(), historicalFirst)
  await checkAnchor(reading)
  await bounded(120)
  await page.getByRole('button', { name: /显示中间的消息|显示较新的消息/ }).waitFor()
  assert.equal(imageReads, readsAfterClose)

  const rail = page.getByRole('navigation', { name: '对话回溯', exact: true })
  await rail.getByRole('button', { name: '定位第 110 条提问', exact: true }).click()
  await page.locator('[data-message-id="user-110"]').waitFor()
  await page.getByRole('button', { name: '回到底部', exact: true }).click()
  await page.locator('.agent-message').filter({ hasText: '实时尾部结果 94，' }).waitFor()
  await bounded()

  // Genuine outstanding work before steering must keep its owning group open.
  await bridge.open(runningId, true)
  await page.getByRole('button', { name: /历史窗口运行状态验证/ }).first().click()
  const running = page.locator('.activity-group[data-activity-id="running-done"] [data-disclosure-row]')
  await running.waitFor()
  assert.equal(await running.getAttribute('aria-expanded'), 'true', 'A real running member was swallowed by historical folding')
  assert.equal(await page.locator('.activity-group[data-activity-id="running-current"] [data-disclosure-row]').getAttribute('aria-expanded'), 'true')
  assert.equal(await page.locator('.activity-group .tool-output').count(), 0)
  await page.screenshot({ path: resolve(output, 'history-window-running.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ nativeItems: turns.reduce((sum, turn) => sum + turn.items.length, 0), repeatedPages: pages, maxHistoryDomNodes: Math.max(...domSizes), maxAnchorError: Math.max(...anchorErrors), boundedHistory: true, wheelAndClickPaging: true, lazyGroupAndRawDetails: true, hiddenImagesDoNotFetch: true, liveTailBounded: true, railPreserved: true, genuineRunningVisible: true, finalCodeVisible: true, pageErrors: errors }))
} catch (error) {
  await page.screenshot({ path: resolve(output, 'history-window-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
