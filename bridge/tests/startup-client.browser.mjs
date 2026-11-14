import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'startup-client-')), cwd = resolve(root, 'project'); await mkdir(cwd)
const a = randomUUID(), b = randomUUID(), c = randomUUID(), log = resolve(root, 'rpc.jsonl'), store = resolve(root, 'sessions.json')
const now = Math.floor(Date.now() / 1000)
const sessions = Object.fromEntries([[a, '正在载入的当前话题'], [b, '快速切换后的话题'], [c, '失败后可重试的话题']].map(([id, name]) => [id, {
  id, name, cwd, preview: '', updatedAt: now,
  goal: { threadId: id, objective: '非常古老的已完成目标', status: 'complete', createdAt: 1, updatedAt: 1, timeUsedSeconds: 20, tokensUsed: 50, tokenBudget: null },
  turns: [{ id: `${id}-turn`, status: 'completed', startedAt: now, completedAt: now, items: [
    { id: `${id}-user`, type: 'userMessage', content: [{ type: 'text', text: name + '的最新提问' }] },
    { id: `${id}-answer`, type: 'agentMessage', phase: 'final_answer', text: name + '的最新回答' },
  ] }],
}]))
await writeFile(store, JSON.stringify(sessions))
const rpcOptions = { command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store, FAKE_LOG: log } }
const rpc = new CodexRpc(rpcOptions)
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data')); await bridge.plugin.setEnabled(false)
let app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const port = app.server.address().port
const browser = await chromium.launch({ executablePath: '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), errors = []
const requested = []
page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/threads/')) requested.push(path) })
page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(id => localStorage.setItem('cweb:thread', id), a)
let release; const gate = new Promise(resolve => release = resolve)
let releaseRestart; const restartGate = new Promise(resolve => releaseRestart = resolve)
let firstReads = 0, rejectC = true, cancelledA = false, restarted = false, restartedReadPending = false
page.on('requestfailed', request => { if (new URL(request.url()).pathname === `/api/threads/${a}`) cancelledA = true })
await page.route(`**/api/threads/${a}`, async route => { firstReads++; await gate; await route.continue().catch(() => {}) })
await page.route(`**/api/threads/${c}`, async route => {
  if (rejectC) { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_TIMEOUT', message: '测试会话暂时载入失败' } }) }); return }
  if (restarted) { restartedReadPending = true; await restartGate }
  const response = await route.fetch(), value = await response.json()
  if (!restarted) value.revision = 9000
  else assert.ok(value.revision < 9000)
  await route.fulfill({ response, json: value })
})
await page.route(`**/api/plugins/genui/${c}`, async route => { if (restarted) await restartGate; await route.continue() })
const choose = id => page.locator(`[data-thread-id="${id}"]`).click()
try {
  await page.goto('http://127.0.0.1:' + app.server.address().port)
  await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  await page.locator('.breadcrumb strong').filter({ hasText: '正在载入的当前话题' }).waitFor()
  await page.locator('.conversation-skeleton').waitFor()
  bridge.emit('event', { type: 'threadPatch', id: a, baseRevision: 7, revision: 8, items: [], changes: { status: 'completed' } })
  await page.waitForTimeout(200)
  assert.equal(firstReads, 1, 'First SSE open duplicated the selected history request')
  assert.equal(requested.some(path => path === `/api/threads/${a}/snapshot`), false, 'An unknown patch bypassed the bounded initial history read')
  assert.equal(await page.locator('.goal-bar').count(), 0, 'Loading history exposed an obsolete completed goal')
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.filter(call => call.method === 'thread/goal/get').length, 0, 'Goal was read before the selected history was ready: ' + JSON.stringify({ requested, calls: calls.filter(call => call.method === 'thread/goal/get'), selected: a }))
  await page.screenshot({ path: resolve(output, 'startup-client-pending.png'), fullPage: true })

  await choose(b); await page.getByText('快速切换后的话题的最新回答', { exact: true }).waitFor()
  release(); await page.waitForTimeout(100)
  assert.ok(cancelledA, 'Changing topic left the obsolete browser history request running')
  assert.equal(await page.locator('.breadcrumb strong').textContent(), '快速切换后的话题')
  assert.equal(await page.getByText('正在载入的当前话题的最新回答', { exact: true }).count(), 0)
  assert.equal(await page.locator('.goal-bar').count(), 0)

  await choose(c); await page.getByRole('button', { name: '重试载入会话', exact: true }).waitFor()
  assert.equal(await page.locator('.conversation-skeleton').count(), 0, 'Failure left an endless loading skeleton')
  assert.equal(await page.locator('.breadcrumb strong').textContent(), '失败后可重试的话题')
  await page.screenshot({ path: resolve(output, 'startup-client-retry.png'), fullPage: true })
  rejectC = false; await page.getByRole('button', { name: '重试载入会话', exact: true }).click()
  await page.getByText('失败后可重试的话题的最新回答', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '重试载入会话', exact: true }).count(), 0)
  assert.equal(await page.locator('.goal-bar').count(), 0)
  const input = page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true })
  await input.fill('/goal'); await input.press('Enter')
  const goal = page.getByRole('dialog', { name: '会话目标', exact: true }); await goal.waitFor()
  assert.equal(await goal.getByLabel('目标与验收条件', { exact: true }).inputValue(), '非常古老的已完成目标', 'The hidden completed goal must remain available explicitly')
  await goal.getByRole('button', { name: '关闭目标设置', exact: true }).click()
  await goal.waitFor({ state: 'hidden' })
  // A new HTTP instance restarts its revision sequence. Keep the old visible
  // view during reattachment, then accept the new revision 1 over old 9000.
  restarted = true; await app.close()
  const saved = JSON.parse(await readFile(store, 'utf8'))
  saved[c].turns[0].items[1].text = '重启后的最新回答'; await writeFile(store, JSON.stringify(saved))
  const nextBridge = new Bridge(new CodexRpc(rpcOptions), new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data')); await nextBridge.plugin.setEnabled(false)
  app = createHttpServer({ bridge: nextBridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve))
  for (let i = 0; i < 200 && !restartedReadPending; i++) await page.waitForTimeout(25)
  assert.ok(restartedReadPending, 'A changed service token did not re-read the selected history')
  assert.equal(await page.locator('.conversation-skeleton').count(), 0)
  await page.getByText('失败后可重试的话题的最新回答', { exact: true }).waitFor()
  releaseRestart(); await page.getByText('重启后的最新回答', { exact: true }).waitFor()
  await page.waitForTimeout(100)
  assert.equal(await page.getByText('失败后可重试的话题的最新回答', { exact: true }).count(), 0)
  // The first DB-only directory can omit a saved legacy topic. Restore it when
  // the delayed scan arrives, unless the user already chose or started typing.
  const originalList = nextBridge.list.bind(nextBridge)
  let directoryReady = false
  nextBridge.list = () => originalList().filter(row => directoryReady || row.id !== a)
  for (const action of ['untouched', 'topic', 'workspace', 'new-topic', 'input']) {
    directoryReady = false
    const late = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await late.addInitScript(id => localStorage.setItem('cweb:thread', id), a)
    await late.goto('http://127.0.0.1:' + port)
    await late.getByText('本地引擎已连接', { exact: true }).waitFor()
    assert.equal(await late.locator(`[data-thread-id="${a}"]`).count(), 0)
    if (action === 'topic') { await late.locator(`[data-thread-id="${b}"]`).click(); await late.getByText('快速切换后的话题的最新回答', { exact: true }).waitFor() }
    if (action === 'workspace') await late.locator('.workspace-card').first().click()
    if (action === 'new-topic') await late.locator('.new-thread').click()
    if (action === 'input') await late.getByRole('textbox', { name: '搜索会话', exact: true }).fill('用户已开始输入')
    directoryReady = true; nextBridge.emit('event', { type: 'threads', threads: originalList() })
    if (action === 'untouched') await late.getByText('正在载入的当前话题的最新回答', { exact: true }).waitFor()
    else {
      await late.waitForTimeout(150)
      assert.equal(await late.getByText('正在载入的当前话题的最新回答', { exact: true }).count(), 0, action + ' was overridden by a delayed restore')
      if (action === 'topic') assert.equal(await late.locator('.breadcrumb strong').textContent(), '快速切换后的话题')
      if (action === 'input') assert.equal(await late.getByRole('textbox', { name: '搜索会话', exact: true }).inputValue(), '用户已开始输入')
    }
    await late.close()
  }
  nextBridge.list = originalList
  const finalCalls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(finalCalls.filter(call => call.method === 'turn/start').length, 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ singleInitialHistoryRequest: true, unknownPatchSharesBoundedRead: true, selectedTitleBeforeHistory: true, goalWaitsForHistory: true, completedGoalHidden: true, oldGoalExplicitlyAvailable: true, staleReadAborted: true, loadFailureRetry: true, restartKeepsVisibleContent: true, lowerRevisionAfterRestartAccepted: true, delayedSavedTopicRestored: true, userActionsCancelDelayedRestore: true, pageErrors: errors }))
} catch (error) { await page.screenshot({ path: resolve(output, 'startup-client-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { release(); releaseRestart(); await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
