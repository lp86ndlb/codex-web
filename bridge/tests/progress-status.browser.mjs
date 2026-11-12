import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

// Synthetic sessions only: exercise the live event projection and actual dock.
const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'progress-status-')), cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const a = randomUUID(), b = randomUUID(), store = resolve(root, 'sessions.json')
await writeFile(store, JSON.stringify(Object.fromEntries([[a, '压缩状态会话'], [b, '并行正常会话']].map(([id, name]) => [id, { id, name, cwd, preview: '', updatedAt: Date.now() / 1000, turns: [] }]))))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store, FAKE_STARTED_OFFSET_MS: '87000' } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${app.server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), errors = []
page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(id => localStorage.setItem('cweb:thread', id), a)
const status = page.getByRole('group', { name: '本轮运行状态', exact: true })
const label = status.locator('.working-label')
const elapsed = async () => Number((await status.locator('time').getAttribute('datetime')).slice(2, -1))
async function until(check, message = 'Run progress did not settle') {
  for (let i = 0; i < 160; i++) { if (await check()) return; await page.waitForTimeout(25) }
  assert.fail(message)
}
function notify(method, params) { rpc.emit('notification', { method, params }) }
// Deliberately construct the payload an older running cweb process can emit.
// Product state is changed only in this isolated in-process test server.
function legacyView(patch) { bridge.changed({ ...bridge.threads.get(a), ...patch }) }
try {
  await bridge.message(a, { text: '等待压缩状态测试', mode: 'read-only' })
  await bridge.message(b, { text: '等待并行正常测试', mode: 'read-only' })
  const turn = bridge.threads.get(a).turnId, otherTurn = bridge.threads.get(b).turnId
  await page.goto(base); await status.waitFor()
  assert.equal(await label.textContent(), '正在处理')
  const timeBefore = await elapsed(); assert.ok(timeBefore >= 87)

  const compaction = { id: 'current-compaction', type: 'contextCompaction', startedAtMs: Date.now(), completedAtMs: null }
  notify('item/started', { threadId: a, turnId: turn, item: compaction })
  await until(async () => await label.textContent() === '正在压缩上下文')
  assert.equal(await page.locator('.topbar .run-badge').textContent(), '压缩中')
  assert.ok((await status.textContent()).includes('正在整理历史记录'))
  await until(async () => await elapsed() > timeBefore, 'Progress reporting reset or froze the live timer')

  legacyView({ progress: undefined })
  await until(async () => await label.textContent() === '正在压缩上下文', 'Legacy timestamp-only compaction was hidden')
  notify('item/completed', { threadId: a, turnId: turn, item: { ...compaction, completedAtMs: Date.now() } })
  await until(async () => await label.textContent() === '正在处理')
  const current = bridge.threads.get(a)
  legacyView({ progress: undefined, items: [...current.items, { id: 'old-compaction', type: 'contextCompaction', status: '', text: JSON.stringify(compaction), turnId: 'a-previous-turn' }] })
  await until(async () => await label.textContent() === '正在处理', 'An unfinished historical compaction contaminated the current turn')

  const retryMessage = 'Synthetic model stream disconnected before response.completed; retrying'
  notify('error', { threadId: a, turnId: turn, error: { message: retryMessage }, willRetry: true })
  await until(async () => await label.textContent() === '模型请求重试中')
  assert.equal(await label.getAttribute('title'), retryMessage)
  assert.equal(await page.locator('.topbar .run-badge').textContent(), '重试中')
  assert.equal(bridge.threads.get(b).turnId, otherTurn, 'Retrying one session interrupted its same-workspace neighbor')
  assert.notEqual(bridge.threads.get(b).progress?.stage, 'retrying')

  await page.locator('.thread-link').filter({ hasText: '并行正常会话' }).click()
  await until(async () => await label.textContent() === '正在处理')
  assert.equal(await page.locator('.topbar .run-badge').textContent(), '处理中')
  await page.locator('.thread-link').filter({ hasText: '压缩状态会话' }).click()
  await until(async () => await label.textContent() === '模型请求重试中')

  notify('item/started', { threadId: a, turnId: turn, item: { id: 'resumed-command', type: 'commandExecution', command: 'cat README.md', status: 'inProgress' } })
  await until(async () => (await label.textContent()).includes('读取文件'))
  assert.equal(await status.getAttribute('data-stage'), 'working')
  const now = Date.now()
  legacyView({ progress: { stage: 'working', updatedAt: now - 100_000, lastEventAt: now - 100_000 } })
  await status.getByText('较长时间未收到新进展，等待状态更新', { exact: true }).waitFor()
  assert.ok(!(await status.textContent()).includes('断网'), 'No activity is not evidence of a disconnected network')
  assert.equal(bridge.threads.get(a).turnId, turn, 'The quiet hint must never interrupt or resubmit a task')

  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  const timer = await status.locator('time').boundingBox(), input = await page.locator('form.composer').boundingBox()
  assert.ok(timer && input && timer.y + timer.height <= input.y && timer.y > 64, 'The mobile progress hint hid the live timer or composer')
  await page.screenshot({ path: resolve(output, 'progress-status-quiet-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })

  notify('error', { threadId: a, turnId: turn, error: { message: 'Synthetic permanent failure' }, willRetry: false })
  await status.waitFor({ state: 'hidden' })
  assert.equal(await page.locator('form.composer').getAttribute('data-running'), null)
  assert.equal(await page.locator('.topbar .run-badge').textContent(), '已失败')
  legacyView({ status: 'failed', turnId: turn, progress: { stage: 'retrying', updatedAt: now, lastEventAt: now } })
  await page.waitForTimeout(80)
  assert.equal(await status.count(), 0, 'A terminal legacy payload retaining turnId must not show a running indicator')
  assert.equal(await page.locator('form.composer').getAttribute('data-running'), null)
  assert.equal(bridge.threads.get(b).turnId, otherTurn)
  await page.screenshot({ path: resolve(output, 'progress-status-failed.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ compactionVisible: true, legacyTimestampFallback: true, oldCompactionIgnored: true, retryDetailsVisible: true, sameWorkspaceIndependent: true, resumedWorking: true, longQuietHint: true, noAutomaticInterruption: true, elapsedRetained: true, terminalHidesRunning: true, mobile: true, pageErrors: errors }))
} catch (error) {
  await page.screenshot({ path: resolve(output, 'progress-status-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
