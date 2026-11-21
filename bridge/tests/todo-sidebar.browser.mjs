import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'todo-sidebar-')), cwd = resolve(root, 'project'); await mkdir(cwd)
await writeFile(resolve(cwd, 'README.md'), '# Sidebar fixture\n')
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json') } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const a = await bridge.create(cwd), b = await bridge.create(cwd)
await bridge.rename(a.id, '侧栏待办甲'); await bridge.rename(b.id, '独立会话乙')
await bridge.plugin.call(a.id, 'todo_note_update', { focus: { current: '检查侧栏待办', next: '保留完整的任务交互' }, add_tasks: [{ title: '等待验收的任务' }, { title: '排序任务乙' }, { title: '排序任务甲' }], set_plan: { title: '侧栏改造', phases: [{ title: '实现', status: 'done' }, { title: '验收', status: 'active' }] } })
const tasks = (await bridge.plugin.get(a.id)).tasks
await bridge.plugin.call(a.id, 'todo_note_complete', { id: tasks[2].id, note: '验证说明：任务已经接入右侧栏。\n请检查这段完整说明后再验收。' })
await bridge.plugin.call(b.id, 'todo_note_update', { focus: { current: '独立会话的焦点' }, add_tasks: [{ title: '只属于乙的任务' }] })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
const errors = []; let reads = 0, fileReads = 0, stage = 'default sidebar'
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => { const path = new URL(request.url()).pathname; if (path.endsWith('/todo-note/get')) reads++; if (['/api/changes', '/api/files'].includes(path)) fileReads++ })
const storedFloat = { view: 'ball', x: 48, y: 96 }
await page.addInitScript(({ id, prefs }) => {
  if (!localStorage.getItem('cweb:thread')) localStorage.setItem('cweb:thread', id)
  if (!localStorage.getItem('cweb:todo-note:prefs:v1')) localStorage.setItem('cweb:todo-note:prefs:v1', JSON.stringify(prefs))
}, { id: a.id, prefs: storedFloat })
const pane = page.getByRole('complementary', { name: '工作区面板', exact: true })
const badge = pane.getByRole('button', { name: '待办', exact: true }).locator('.todo-tab-count')
const card = page.locator('.dtn-card')
const row = id => card.locator(`.dtn-task[data-task-id="${id}"][data-ghost="false"]`)
async function until(check, label = stage) { for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(50) } assert.fail(label) }
async function settings() { await page.getByRole('button', { name: '连接与设置', exact: true }).click(); await page.getByLabel('待办显示位置', { exact: true }).waitFor() }
async function closeSettings() { await page.getByRole('button', { name: '关闭对话框', exact: true }).click(); await page.locator('.settings-dialog[open]').waitFor({ state: 'hidden' }) }
async function choosePlacement(value) {
  await page.getByLabel('待办显示位置', { exact: true }).selectOption(value)
  await until(async () => (await bridge.preferences.snapshot()).preferences.todoPlacement === value)
}
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  await card.getByText('检查侧栏待办', { exact: true }).waitFor()
  await until(async () => await badge.textContent() === '3', 'Todo count includes work awaiting confirmation')
  assert.deepEqual((await pane.locator('.tabs > button').allTextContents()).map(t => t.trim().split(' ')[0]), ['待办', '变更', '文件'])
  assert.equal(await pane.getByRole('button', { name: '待办', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('.dtn-layer[data-layout="floating"]').count(), 0)
  assert.equal(await card.getAttribute('data-view'), 'detail')
  assert.equal(await card.locator('.dtn-measure, .dtn-measure-detail').count(), 0, 'Docked cards must not duplicate rows for offscreen size measurement')
  assert.equal(fileReads, 0, 'The default todo tab must not load Git or directory panels')
  const bounds = await pane.boundingBox(), noteBounds = await card.boundingBox(), mainBounds = await page.locator('main').boundingBox()
  assert.ok(noteBounds.x >= bounds.x && noteBounds.x + noteBounds.width <= bounds.x + bounds.width + 1)
  assert.ok(bounds.x >= mainBounds.x + mainBounds.width - 1, 'Sidebar must not overlay desktop conversation')
  assert.ok(noteBounds.height > 700, 'Sidebar should use available height')
  await card.getByText('侧栏改造', { exact: true }).waitFor()
  await row(tasks[2].id).getByText(/请检查这段完整说明/).waitFor()
  await page.screenshot({ path: resolve(output, 'todo-sidebar-dark.png'), fullPage: true })

  stage = 'task sorting and approval'
  const from = await row(tasks[1].id).locator('.dtn-task-title').boundingBox(), to = await row(tasks[0].id).boundingBox()
  await page.mouse.move(from.x + 35, from.y + from.height / 2); await page.mouse.down()
  await page.mouse.move(from.x + 35, to.y + 1, { steps: 16 }); await page.waitForTimeout(120); await page.mouse.up()
  await until(async () => (await bridge.plugin.get(a.id)).tasks[0].id === tasks[1].id)
  await row(tasks[2].id).locator('.dtn-confirm button').first().click()
  await until(async () => !(await bridge.plugin.get(a.id)).tasks.some(task => task.id === tasks[2].id))
  await row(tasks[2].id).waitFor({ state: 'detached' })
  await until(async () => await badge.textContent() === '2')
  await card.locator('.dtn-head').getByRole('button', { name: '添加', exact: true }).click()
  await card.getByRole('textbox', { name: '添加', exact: true }).fill('从侧栏添加的提醒')
  await card.getByRole('textbox', { name: '添加', exact: true }).press('Enter')
  await card.getByText('从侧栏添加的提醒', { exact: true }).waitFor()
  await until(async () => await badge.textContent() === '3')

  stage = 'hidden panels stop polling and files still work'
  await pane.getByRole('button', { name: '文件', exact: true }).click()
  await pane.getByRole('button', { name: 'README.md', exact: true }).waitFor()
  const hiddenReads = reads
  await bridge.plugin.call(a.id, 'todo_note_update', { add_tasks: [{ title: '后台新增任务' }, { title: '不计入数字的搁置任务', state: 'shelved' }] })
  await until(async () => await badge.textContent() === '4', 'Agent changes update the badge when the note is closed')
  await bridge.plugin.call(a.id, 'todo_note_update', { remove_tasks: (await bridge.plugin.get(a.id)).tasks.filter(task => ['后台新增任务', '不计入数字的搁置任务'].includes(task.title)).map(task => task.id) })
  await until(async () => await badge.textContent() === '3')
  await page.waitForTimeout(1600)
  assert.equal(reads, hiddenReads)
  await pane.getByRole('button', { name: /^变更/ }).click(); await pane.getByText('这里还没有 Git 仓库', { exact: true }).waitFor()
  await pane.getByRole('button', { name: '待办', exact: true }).click(); await card.getByText('从侧栏添加的提醒', { exact: true }).waitFor()
  await pane.getByRole('button', { name: '关闭工作区面板', exact: true }).click(); await pane.waitFor({ state: 'hidden' })
  const closedReads = reads; await page.waitForTimeout(1600); assert.equal(reads, closedReads)
  await page.getByRole('button', { name: '显示工作区面板', exact: true }).click(); await card.waitFor()

  stage = 'session separation'
  await page.locator(`[data-thread-id="${b.id}"]`).click(); await card.getByText('只属于乙的任务', { exact: true }).waitFor()
  await until(async () => await badge.textContent() === '1', 'Todo count is scoped to the selected conversation')
  assert.equal(await card.getByText('从侧栏添加的提醒', { exact: true }).count(), 0)
  await page.locator(`[data-thread-id="${a.id}"]`).click(); await card.getByText('从侧栏添加的提醒', { exact: true }).waitFor()

  stage = 'settings restore the original floating view and persist'
  await settings(); await choosePlacement('floating'); await closeSettings()
  await page.locator('.dtn-layer[data-layout="floating"] .dtn-card[data-view="ball"]').waitFor()
  const ball = await card.boundingBox(); assert.equal(ball.x, storedFloat.x); assert.equal(ball.y, storedFloat.y)
  await card.click(); await page.locator('.dtn-card[data-view="note"]').waitFor()
  await card.locator(':scope > .dtn-fade').getByText('从侧栏添加的提醒', { exact: true }).waitFor()
  await card.getByRole('button', { name: '展开详情', exact: true }).click(); await card.locator(':scope > .dtn-fade').getByText('侧栏改造', { exact: true }).waitFor()
  await page.screenshot({ path: resolve(output, 'todo-sidebar-floating.png'), fullPage: true })
  await page.reload(); await page.locator('.dtn-layer[data-layout="floating"]').waitFor()
  await pane.waitFor({ state: 'hidden' })
  await settings(); await choosePlacement('sidebar'); await closeSettings()
  await card.getByText('从侧栏添加的提醒', { exact: true }).waitFor()
  assert.equal(await page.locator('.dtn-layer').count(), 1)
  await page.reload(); await pane.getByRole('button', { name: '待办', exact: true }).waitFor()

  stage = 'light theme and responsive drawer'
  await bridge.updatePreferences({ theme: 'light' }); await until(() => page.locator('html').getAttribute('data-theme').then(value => value === 'light'))
  await page.screenshot({ path: resolve(output, 'todo-sidebar-light.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 }); await pane.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '显示工作区面板', exact: true }).click(); await card.waitFor()
  const mobile = await pane.boundingBox(); assert.ok(mobile.x >= 0 && mobile.x + mobile.width <= 391)
  assert.equal(await pane.locator('.inspector-footer').evaluate(node => {
    const rect = node.getBoundingClientRect()
    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  }), true, 'The composer must not cover the bottom of the mobile drawer')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: resolve(output, 'todo-sidebar-mobile.png'), fullPage: true })
  await pane.getByRole('button', { name: '关闭工作区面板', exact: true }).click(); await pane.waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  const result = { defaultSidebar: true, firstTab: true, todoCount: true, sorting: true, approvalDetails: true, addAndConfirm: true, hiddenPollingStopped: true, filesAndChanges: true, separateSessions: true, floatingRestored: true, persistence: true, lightAndMobile: true, pageErrors: errors }
  await writeFile(resolve(output, 'todo-sidebar-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
} catch (error) { console.log(JSON.stringify({ stage, errors })); await page.screenshot({ path: resolve(output, 'todo-sidebar-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
