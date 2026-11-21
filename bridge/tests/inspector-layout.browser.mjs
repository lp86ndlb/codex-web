import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'inspector-layout-')), cwd = resolve(root, 'team-project'), other = resolve(root, 'solo-project'), log = resolve(root, 'rpc.jsonl')
await mkdir(cwd); await mkdir(other)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd,
  env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'), false, { workspaceTeams: true })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true,
  ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), errors = []
page.on('pageerror', error => errors.push(error.message))
const panel = page.getByRole('complementary', { name: '工作区面板', exact: true })
const separator = page.getByRole('separator', { name: '调整右侧栏宽度', exact: true })
const approvals = panel.locator('.team-tab')
let stage = 'setup'
async function until(check, label = stage) {
  for (let i = 0; i < 120; i++) { if (await check()) return; await page.waitForTimeout(40) }
  assert.fail(`Timed out: ${label}`)
}
async function widthIs(value) { await until(async () => Math.abs((await panel.boundingBox()).width - value) < 2, `width ${value}`) }
async function choose(id) { await page.locator(`[data-thread-id="${id}"]`).click() }
async function noOverflow() { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow') }
try {
  const boot = await bridge.bootstrap(), workspaceId = boot.workspaces[0].id
  await bridge.renameWorkspace(workspaceId, '团队项目'); await bridge.addWorkspace(other, '普通项目')
  const lead = await bridge.create(cwd), worker = await bridge.create(cwd), solo = await bridge.create(other)
  await bridge.rename(lead.id, '负责人'); await bridge.rename(worker.id, '执行会话'); await bridge.rename(solo.id, '独立会话')
  const team = await bridge.teamForWorkspace(workspaceId)
  await team.register({ threadId: lead.id, name: '负责人', role: 'lead', cwd, level: 1 })
  await team.register({ threadId: worker.id, name: '执行会话', role: 'manager', cwd, level: 2, parentId: lead.id })
  await team.enable(true)
  const task = await team.propose(lead.id, { to: worker.id, kind: 'task', title: '保留这条待审批任务', body: '只验证面板布局，不投递任务。', requestKey: 'layout' })
  await bridge.updatePreferences({ showInspector: true, animations: false })
  const baseline = (await readFile(log, 'utf8')).trim().split('\n').length
  await page.addInitScript(id => { if (!localStorage.getItem('cweb:thread')) localStorage.setItem('cweb:thread', id) }, lead.id)
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  await approvals.waitFor(); await approvals.click(); await panel.getByText('保留这条待审批任务', { exact: true }).waitFor()

  stage = 'disabled workspaces hide approval tab and safely select todo'
  await choose(solo.id); await approvals.waitFor({ state: 'hidden' })
  assert.equal(await panel.getByRole('button', { name: '待办', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await panel.locator('.team-approvals').count(), 0)
  await choose(lead.id); await approvals.waitFor(); await panel.getByText('保留这条待审批任务', { exact: true }).waitFor()
  await team.enable(false); await approvals.waitFor({ state: 'hidden' })
  assert.equal(await panel.getByRole('button', { name: '待办', exact: true }).getAttribute('aria-pressed'), 'true')
  await team.enable(true); await approvals.waitFor(); await panel.getByText('保留这条待审批任务', { exact: true }).waitFor()

  stage = 'pointer resizing remains smooth and persists across close and reload'
  await widthIs(340)
  const handle = await separator.boundingBox()
  await page.mouse.move(handle.x + 2, handle.y + 140); await page.mouse.down()
  await page.mouse.move(handle.x - 158, handle.y + 140, { steps: 12 })
  await widthIs(500)
  assert.equal(await page.locator('.app').getAttribute('data-inspector-resizing'), 'true')
  assert.ok((await page.locator('main').boundingBox()).width >= 360)
  await page.mouse.up()
  assert.equal(await page.locator('.app').getAttribute('data-inspector-resizing'), null)
  assert.equal(await page.evaluate(() => localStorage.getItem('cweb:inspector-width')), '500')
  await panel.getByRole('button', { name: '关闭工作区面板', exact: true }).click(); await panel.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '显示工作区面板', exact: true }).click(); await widthIs(500)
  await page.reload(); await panel.waitFor(); await widthIs(500)

  stage = 'keyboard, bounds, viewport changes, double-click reset'
  await separator.focus(); await separator.press('ArrowLeft'); await widthIs(510)
  await separator.press('ArrowRight'); await widthIs(500)
  await separator.press('End'); await widthIs(640)
  await separator.press('Home'); await widthIs(280)
  await separator.press('End'); await widthIs(640)
  await page.setViewportSize({ width: 1200, height: 800 }); await widthIs(564); await noOverflow()
  assert.ok((await page.locator('main').boundingBox()).width >= 359)
  assert.equal(await page.evaluate(() => localStorage.getItem('cweb:inspector-width')), '640', 'A smaller screen must not overwrite the preferred width')
  await page.setViewportSize({ width: 1440, height: 900 }); await widthIs(640)
  await separator.dblclick(); await widthIs(340)
  assert.equal(await page.evaluate(() => localStorage.getItem('cweb:inspector-width')), null)
  await page.setViewportSize({ width: 1200, height: 800 }); await widthIs(340)
  await until(async () => await separator.getAttribute('aria-valuemax') === '564')
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
  await until(async () => await separator.getAttribute('aria-valuemax') === '640')
  await widthIs(340)
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
  await until(async () => await separator.getAttribute('aria-valuemax') === '564')
  await page.setViewportSize({ width: 1440, height: 900 })

  stage = 'overlay and mobile keep headers and content usable at larger fonts'
  await bridge.updatePreferences({ uiFontSize: 18, fontSize: 20 })
  await approvals.click()
  await page.setViewportSize({ width: 1024, height: 768 }); await widthIs(340); await noOverflow()
  await separator.press('End'); await widthIs(640)
  await page.screenshot({ path: resolve(output, 'inspector-resize-tablet.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 }); await panel.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '显示工作区面板', exact: true }).click(); await widthIs(360)
  assert.equal(await separator.isVisible(), false); await noOverflow()
  const close = await panel.getByRole('button', { name: '关闭工作区面板', exact: true }).boundingBox()
  assert.ok(close.x >= 0 && close.x + close.width <= 390)
  await page.screenshot({ path: resolve(output, 'inspector-resize-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 }); await widthIs(640)
  await panel.getByText('保留这条待审批任务', { exact: true }).waitFor()
  const toolbar = await page.locator('.topbar').boundingBox()
  for (const control of await page.locator('.topbar-actions > .icon-button:visible').all()) {
    const box = await control.boundingBox()
    assert.ok(box.x >= toolbar.x && box.x + box.width <= toolbar.x + toolbar.width + 1 && box.y + box.height <= toolbar.y + toolbar.height + 1, 'Narrow conversation header keeps its actions inside the toolbar')
  }
  await page.screenshot({ path: resolve(output, 'inspector-resize-desktop.png'), fullPage: true })
  assert.equal((await team.snapshot()).messages.find(row => row.id === task.id).state, 'pending')
  const calls = (await readFile(log, 'utf8')).trim().split('\n').slice(baseline).map(line => JSON.parse(line))
  assert.equal(calls.filter(row => ['turn/start', 'turn/steer', 'thread/start'].includes(row.method)).length, 0)
  assert.deepEqual(errors, [])
  console.log('Inspector browser passed: per-workspace approval visibility, retained pending messages, pointer/keyboard resize, persistence, viewport clamping, tablet/mobile and larger fonts; no model calls.')
} catch (error) {
  console.error('Stage:', stage); await page.screenshot({ path: resolve(output, 'inspector-layout-failure.png'), fullPage: true }).catch(() => {}); throw error
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
