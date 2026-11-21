// Queue rendering uses read-only snapshots and an isolated fake native engine.
// Native FIFO delivery is exercised separately; this suite never approves work.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'team-queue-')), cwd = resolve(root, 'team'), other = resolve(root, 'ordinary'), log = resolve(root, 'rpc.jsonl')
await mkdir(cwd); await mkdir(other)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd,
  env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'), false, { workspaceTeams: true })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true,
  ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' }), errors = []
page.on('pageerror', error => errors.push(error.message))
const queue = page.getByRole('region', { name: '当前会话的团队队列', exact: true })
const input = page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true })
let stage = 'setup'
async function until(check) { const end = Date.now() + 7000; do { if (await check()) return; await page.waitForTimeout(30) } while (Date.now() < end); throw new Error(`Timed out: ${stage}`) }
async function screenshot(name) { await page.waitForTimeout(150); await page.screenshot({ path: resolve(output, name), fullPage: true }) }
async function choose(id) { await page.locator(`[data-thread-id="${id}"]`).click(); await input.waitFor() }
async function containment() {
  const boxes = await page.evaluate(() => {
    const stage = document.querySelector('.conversation-stage').getBoundingClientRect(), dock = document.querySelector('.composer-dock').getBoundingClientRect(), composer = document.querySelector('.composer').getBoundingClientRect(), list = document.querySelector('.team-queue-list')
    return { stage: { top: stage.top, bottom: stage.bottom, height: stage.height }, dock: { top: dock.top, height: dock.height }, composerBottom: composer.bottom, listHeight: list?.clientHeight, listScroll: list?.scrollHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1 }
  })
  assert.equal(boxes.overflow, false)
  assert.ok(boxes.dock.height <= boxes.stage.height * .72 + 2, JSON.stringify(boxes))
  assert.ok(boxes.composerBottom <= boxes.stage.bottom + 2, 'The composer remains inside the viewport')
  assert.ok(boxes.listHeight > 15 && boxes.listHeight < boxes.listScroll, 'Long queues scroll inside their own bounded list')
}
try {
  const boot = await bridge.bootstrap(), workspaceId = boot.workspaces[0].id
  await bridge.renameWorkspace(workspaceId, '团队队列验收'); await bridge.addWorkspace(other, '普通工作区')
  await bridge.updatePreferences({ theme: 'dark', animations: false, showInspector: false })
  const native = async (name, path = cwd) => { const thread = await bridge.create(path); await bridge.rename(thread.id, name); return thread.id }
  const lead = await native('负责人'), manager = await native('接收队列的主管'), a = await native('执行成员 A'), b = await native('执行成员 B'), ordinary = await native('普通会话', other)
  const service = await bridge.teamForWorkspace(workspaceId)
  for (const [id, name, level, parentId] of [[lead, '负责人', 1, null], [manager, '接收队列的主管', 2, lead], [a, '执行成员 A', 3, manager], [b, '执行成员 B', 3, manager]]) await service.register({ threadId: id, name, role: level === 1 ? 'lead' : level === 2 ? 'manager' : 'worker', level, parentId, cwd })
  await service.enable(true)
  let snapshot = { ...await service.snapshot(), running: [manager], workspaceId, pilot: false }
  const message = (id, state, extra = {}) => ({ id, state, from: lead, to: manager, kind: 'task', title: id, body: '这里只核对队列显示；不自动执行任务。', requestKey: id, version: 1, digest: id, approvedDigest: id, deliveryId: id, createdAt: 100, updatedAt: 200, audit: [], policy: 'manual', graphVersion: snapshot.graphVersion, reviews: [], ...extra })
  const review = (id, state) => ({ id, state, reviewerId: manager, kind: 'supervisor', deliveryId: id, digest: id })
  snapshot.messages = [
    message('already-delivered', 'delivered', { title: '已送达并非完成' }),
    message('first', 'approved', { title: '最早批准的任务', updatedAt: 9999 }),
    message('human', 'pending', { title: '等待用户批准的任务' }),
    message('peer-review', 'reviewing', { title: '同层协作待主管审核', from: a, to: b, reviews: [review('pending-review', 'pending')] }),
    message('second', 'waiting', { title: '第二条业务任务', updatedAt: 1 }),
    message('receipt', 'uncertain', { title: '核对前一条投递回执' }),
    message('sent-review', 'reviewing', { title: '等待已送达审核的结论', from: a, to: b, reviews: [review('sent-review', 'sent')] }),
    message('attention-review', 'reviewing', { title: '需继续审核的请求', from: a, to: b, reviews: [review('attention-review', 'needs-user')] }),
    ...Array.from({ length: 20 }, (_, i) => message(`tail-${i}`, 'approved', { title: `后续通信 ${i + 1}：保留完整标题和来源，等待按序投递` })),
  ]
  await page.route('**/api/team?*', route => new URL(route.request().url()).searchParams.get('workspace') === workspaceId ? route.fulfill({ json: snapshot }) : route.continue())
  const refresh = async () => {
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/team' && new URL(value.url()).searchParams.get('workspace') === workspaceId)
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('cweb:team-changed', { detail: { workspaceId: id } })), workspaceId); await response
  }
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  await page.getByText('本地引擎已连接', { exact: true }).waitFor(); await choose(manager); await queue.waitFor()

  stage = 'compact current-session queue and manual message priority'
  assert.equal(await queue.locator('.team-queue-toggle').getAttribute('aria-expanded'), 'false')
  assert.ok((await queue.boundingBox()).height < 45)
  assert.equal(await queue.locator('[data-queue-id]').count(), 0)
  await input.fill('正在编写的草稿不能丢失')
  bridge.publish({ type: 'queue', queue: [{ id: 'manual-fixture', threadId: manager, text: '按 Tab 保留的手动消息', attachmentCount: 0 }] })
  await page.locator('.message-queue').waitFor()
  await until(async () => (await queue.textContent()).includes('手动优先 1'))
  const manual = await page.locator('.message-queue').boundingBox(), teamBox = await queue.boundingBox()
  assert.ok(manual.y + manual.height <= teamBox.y + 1, 'Manual Tab queue stays before team deliveries')
  await screenshot('team-queue-collapsed.png')

  stage = 'shared FIFO, receipts, bounded rows and read-only approval navigation'
  await queue.locator('.team-queue-toggle').click()
  assert.equal(await queue.locator('[data-queue-id]').count(), 12)
  assert.equal(await queue.locator('[data-queue-id="message:first"] .team-queue-position').textContent(), '1')
  assert.equal(await queue.locator('[data-queue-id="review:pending-review"] .team-queue-position').textContent(), '2')
  assert.equal(await queue.locator('[data-queue-id="message:second"] .team-queue-position').textContent(), '3')
  assert.equal(await queue.locator('[data-queue-id="message:human"] .team-queue-position').count(), 0)
  assert.equal(await queue.locator('[data-queue-id="message:first"] .team-queue-source').getAttribute('title'), '负责人 → 接收队列的主管')
  assert.equal(await queue.locator('[data-message-id="already-delivered"]').count(), 0)
  assert.match(await queue.locator('[data-queue-id="message:first"]').textContent(), /回执核对/)
  assert.match(await queue.locator('[data-queue-id="review:sent-review"]').textContent(), /待审核/)
  assert.ok(!/正在执行/.test(await queue.textContent()), 'A running conversation cannot identify the active task')
  await containment(); await screenshot('team-queue-expanded.png')
  await bridge.updatePreferences({ uiFontSize: 12, fontSize: 14 }); await page.waitForTimeout(180)
  const smallFonts = await queue.locator('.team-queue-toggle,.team-queue-row-heading,.team-queue-summary,.team-queue-source,.team-queue-reason,.team-queue-state,.team-queue-hint,.team-queue-row-detail>button').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)))
  assert.ok(smallFonts.every(size => size >= 10), `Queue text remains readable at 12px UI: ${smallFonts}`)
  await containment(); await screenshot('team-queue-small-font.png')
  await bridge.updatePreferences({ uiFontSize: 14, fontSize: 16 }); await page.waitForTimeout(150)
  await queue.getByRole('button', { name: '查看审批：最早批准的任务', exact: true }).click()
  await page.locator('.team-review-card[data-message-id="first"].selected').waitFor()
  assert.equal(await page.getByRole('region', { name: '团队关系图', exact: true }).count(), 0)
  assert.equal(await input.inputValue(), '正在编写的草稿不能丢失')
  await queue.getByRole('button', { name: /^再显示/ }).click(); assert.equal(await queue.locator('[data-queue-id]').count(), 24)
  await containment()

  stage = 'pause preserves the queue and delivery updates do not fake completion'
  snapshot = { ...snapshot, enabled: false }; await refresh()
  await until(async () => (await queue.textContent()).includes('已暂停'))
  assert.equal(await queue.getByRole('button', { name: '查看审批：最早批准的任务', exact: true }).isDisabled(), true)
  assert.equal(await queue.locator('[data-queue-id]').count(), 24)
  await screenshot('team-queue-paused.png')
  snapshot = { ...snapshot, enabled: true, messages: snapshot.messages.map(row => row.id === 'first' ? { ...row, state: 'delivered' } : row) }; await refresh()
  await until(async () => await queue.locator('[data-queue-id="message:first"]').count() === 0)
  assert.equal(await queue.locator('[data-queue-id="review:pending-review"] .team-queue-position').textContent(), '1')
  assert.equal(await input.inputValue(), '正在编写的草稿不能丢失')

  stage = 'conversation and workspace isolation'
  await choose(a); await queue.waitFor({ state: 'hidden' })
  await choose(ordinary); await queue.waitFor({ state: 'hidden' })
  await choose(manager); await queue.waitFor()
  assert.equal(await queue.locator('.team-queue-toggle').getAttribute('aria-expanded'), 'false')
  assert.equal(await input.inputValue(), '正在编写的草稿不能丢失')
  await queue.locator('.team-queue-toggle').click()

  stage = 'combine button schedules the approved prefix without changing the draft'
  bridge.publish({ type: 'queue', queue: [] })
  snapshot = { ...snapshot, capabilities: { batchDelivery: true }, messages: snapshot.messages.filter(row => !['peer-review', 'receipt', 'sent-review'].includes(row.id)) }
  await refresh()
  await queue.getByText('空闲后自动合并前 8 条已批准通信。').waitFor()
  await page.route('**/api/team/queue/batch?*', async route => {
    assert.deepEqual(route.request().postDataJSON(), { threadId: manager, firstId: 'second' })
    snapshot = { ...snapshot, messages: snapshot.messages.map(row => row.id === 'second' ? { ...row, batchRequested: true } : row) }
    await route.fulfill({ json: { ok: true } })
  })
  await queue.getByRole('button', { name: '合并投递', exact: true }).click()
  const scheduled = queue.getByRole('button', { name: '已安排合并', exact: true })
  await scheduled.waitFor()
  assert.ok(await scheduled.isDisabled())
  assert.equal(await input.inputValue(), '正在编写的草稿不能丢失')

  stage = 'small screens and larger text preserve conversation space'
  const hide = page.getByRole('button', { name: '隐藏工作区面板', exact: true }); if (await hide.count()) await hide.click()
  await bridge.updatePreferences({ uiFontSize: 18, fontSize: 20 }); await page.waitForTimeout(200)
  await containment(); await screenshot('team-queue-large-font.png')
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250)
  await containment(); await screenshot('team-queue-mobile.png')
  const calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(calls.filter(call => ['turn/start', 'turn/steer', 'turn/interrupt'].includes(call.method)).length, 0, 'Queue display and approval navigation never send model requests')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ queueVisible: true, fifo: true, reviews: true, receiptBlocking: true, manualPriority: true, paused: true, draftPreserved: true, isolated: true, responsive: true, noModelCalls: true }))
} catch (error) { console.error('Stage:', stage); await page.screenshot({ path: resolve(output, 'team-queue-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
