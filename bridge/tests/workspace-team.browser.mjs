// Ordinary-workspace UI acceptance against a fake native engine. No real
// workspace, session, model turn, or live server is touched by this fixture.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'workspace-team-browser-')), cwd = resolve(root, 'project-a'), other = resolve(root, 'project-b'), log = resolve(root, 'rpc.jsonl')
await mkdir(cwd); await mkdir(other)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'), false, { workspaceTeams: true })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [], requests = []
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => { if (request.url().includes('/api/team')) requests.push({ method: request.method(), path: request.url(), body: request.postDataJSON() }) })
const base = `http://127.0.0.1:${app.server.address().port}`
let stage = 'setup'
async function until(fn, label = stage) { const end = Date.now() + 7000; do { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 30)) } while (Date.now() < end); throw new Error(`Timed out: ${label}`) }
const graph = page.getByRole('region', { name: '团队关系图', exact: true })
const member = id => page.locator(`.react-flow__node[data-id="${id}"]`)
const row = id => page.locator(`[data-thread-id="${id}"]`)
async function rightWorkspace(name) {
  await page.locator('.workspace-toggle').filter({ hasText: name }).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: '工作区菜单', exact: true }); await menu.waitFor(); return menu
}
async function openWorkspace(name) { const menu = await rightWorkspace(name); await menu.getByRole('menuitem', { name: '打开关系图', exact: true }).click(); await graph.waitFor() }
async function importMember(title, level, parentId) {
  await graph.getByRole('button', { name: '加入会话', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '加入已有会话', exact: true }); await dialog.waitFor()
  await dialog.getByRole('button', { name: new RegExp(title) }).click()
  await dialog.getByRole('combobox', { name: '加入会话层级' }).selectOption(String(level))
  if (parentId) await dialog.getByRole('combobox', { name: '加入会话直属上级' }).selectOption(parentId)
  await dialog.getByRole('button', { name: '确认加入团队' }).click(); await dialog.waitFor({ state: 'hidden' })
}
async function screenshot(name) { await page.waitForTimeout(250); await page.screenshot({ path: resolve(output, name), fullPage: true }) }
try {
  const boot = await bridge.bootstrap(), a = boot.workspaces[0], b = await bridge.addWorkspace(other, 'Project B')
  await bridge.renameWorkspace(a.id, 'Project A')
  await bridge.updatePreferences({ theme: 'dark', showInspector: false, animations: false })
  const aThreads = [], bThreads = []
  for (const name of ['A-负责人', 'A-项目主管', 'A-执行成员', 'A-视觉主管', 'A-图像成员']) {
    const thread = await bridge.create(cwd, 'fixture-next', 'medium'); await bridge.rename(thread.id, name); aThreads.push(thread)
  }
  for (const name of ['B-负责人', 'B-执行成员']) {
    const thread = await bridge.create(other, 'fixture-next', 'high'); await bridge.rename(thread.id, name); bThreads.push(thread)
  }
  const originalHistory = (await rpc.call('thread/read', { threadId: bThreads[0].id, includeTurns: true })).thread
  const baselineCalls = (await readFile(log, 'utf8')).trim().split('\n').length
  await page.goto(base); await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  await row(aThreads[0].id).click(); await page.locator('.composer textarea').fill('保留原对话草稿')
  const switchChat = await page.locator('.team-mode-switch').boundingBox()

  stage = 'right-click another workspace toggles its own state'
  const menu = await rightWorkspace('Project B')
  assert.equal(await menu.getByRole('menuitemcheckbox', { name: '团队模式', exact: true }).getAttribute('aria-checked'), 'false')
  await until(async () => !(await menu.getByRole('menuitemcheckbox', { name: '团队模式', exact: true }).isDisabled()))
  await menu.getByRole('menuitemcheckbox', { name: '团队模式', exact: true }).click()
  await graph.getByRole('button', { name: '选择已有负责人' }).waitFor()
  const aTeam = await bridge.teamForWorkspace(a.id), bTeam = await bridge.teamForWorkspace(b.id)
  assert.equal((await bTeam.snapshot()).enabled, true); assert.equal((await aTeam.snapshot()).enabled, false)
  assert.equal(await graph.getByRole('button', { name: '运行演示' }).count(), 0)
  const switchGraph = await page.locator('.team-mode-switch').boundingBox()
  assert.ok(Math.abs(switchChat.x - switchGraph.x) < 1 && Math.abs(switchChat.y - switchGraph.y) < 1, 'Mode switch stays aligned when chat actions disappear')

  stage = 'existing session picker remains scoped and import retains history'
  await graph.getByRole('button', { name: '选择已有负责人' }).click()
  const picker = page.getByRole('dialog', { name: '加入已有会话', exact: true })
  await picker.getByRole('button', { name: /B-负责人/ }).waitFor()
  assert.equal(await picker.getByRole('button', { name: /A-负责人/ }).count(), 0)
  await picker.getByRole('button', { name: '取消', exact: true }).click(); await picker.waitFor({ state: 'hidden' })
  assert.equal((await bTeam.snapshot()).members.length, 0)
  await importMember('B-负责人', 1)
  await member(bThreads[0].id).waitFor()
  await importMember('B-执行成员', 2, bThreads[0].id)
  assert.deepEqual((await rpc.call('thread/read', { threadId: bThreads[0].id, includeTurns: true })).thread, originalHistory)
  assert.equal((await bTeam.snapshot()).members[0].model, 'fixture-next')

  stage = 'independent workspace graph with five members and an unused fourth tier'
  await openWorkspace('Project A'); await graph.getByRole('button', { name: '选择已有负责人' }).waitFor()
  await importMember('A-负责人', 1)
  await importMember('A-项目主管', 2, aThreads[0].id)
  await importMember('A-执行成员', 3, aThreads[1].id)
  await importMember('A-视觉主管', 2, aThreads[0].id)
  await importMember('A-图像成员', 3, aThreads[3].id)
  await graph.getByRole('button', { name: '层级', exact: true }).click()
  await until(async () => (await aTeam.snapshot()).levels.length === 4)
  assert.equal(await page.locator('.team-level-header').count(), 3, 'Unused tiers stay configurable without shrinking the graph')
  await graph.getByRole('button', { name: '开启团队', exact: true }).click()
  await until(async () => (await aTeam.snapshot()).enabled)
  const configuredCalls = (await readFile(log, 'utf8')).trim().split('\n').slice(baselineCalls).map(line => JSON.parse(line))
  assert.equal(configuredCalls.filter(row => ['turn/start', 'turn/steer', 'thread/start'].includes(row.method)).length, 0, 'Configuring and importing never spend a model turn or create sessions')
  await aTeam.propose(aThreads[2].id, { to: aThreads[1].id, kind: 'task', title: '核对识别接口', body: '请主管核对图像时间戳与目标坐标字段。', requestKey: 'browser-review' })
  await page.locator('.team-traffic-edge').waitFor()
  assert.match(await page.locator('.team-traffic-edge').textContent(), /核对识别接口/)
  for (let i = 0; i < 5; i++) {
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/team' && new URL(response.url()).searchParams.get('workspace') === a.id)
    await page.evaluate(workspaceId => window.dispatchEvent(new CustomEvent('cweb:team-changed', { detail: { workspaceId } })), a.id)
    await refreshed; await page.waitForTimeout(40)
    assert.equal(await page.locator('.team-permission-edge').count(), 4, 'Repeated status refresh retains measured connection handles')
    assert.equal(await page.locator('.team-traffic-edge').count(), 1)
  }
  await screenshot('workspace-team-1440.png')
  const header = await page.locator('.team-graph-header').boundingBox(); assert.ok(header.height < 106, JSON.stringify(header))
  await page.setViewportSize({ width: 1920, height: 1080 }); await screenshot('workspace-team-1920.png')

  stage = 'late response from the previous workspace cannot overwrite current graph'
  let held
  const delayed = async route => {
    if (!held && new URL(route.request().url()).searchParams.get('workspace') === a.id) { held = route; return }
    await route.continue()
  }
  await page.route('**/api/team?*', delayed)
  await page.evaluate(workspaceId => window.dispatchEvent(new CustomEvent('cweb:team-changed', { detail: { workspaceId } })), a.id)
  await until(() => Boolean(held))
  await openWorkspace('Project B'); await member(bThreads[0].id).waitFor()
  await held.fulfill({ json: { ...await aTeam.snapshot(), running: [], workspaceId: a.id, pilot: false } })
  await page.waitForTimeout(100)
  assert.equal(await member(aThreads[0].id).count(), 0); assert.equal(await member(bThreads[0].id).count(), 1)
  await page.unroute('**/api/team?*', delayed)
  await row(aThreads[0].id).click(); await until(async () => await page.locator('.composer textarea').inputValue() === '保留原对话草稿')

  stage = 'mobile and larger font keep graph controls and import dialog usable'
  await openWorkspace('Project A')
  await bridge.updatePreferences({ uiFontSize: 18, fontSize: 20 })
  await page.setViewportSize({ width: 390, height: 844 })
  const hide = page.getByRole('button', { name: '隐藏工作区面板', exact: true }); if (await hide.count()) await hide.click()
  await screenshot('workspace-team-mobile.png')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'No horizontal overflow at mobile width')
  await graph.getByRole('button', { name: '加入会话', exact: true }).click(); await picker.waitFor()
  const box = await picker.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, JSON.stringify(box))
  await screenshot('workspace-team-import-mobile.png')
  await picker.getByRole('button', { name: '取消', exact: true }).click(); await picker.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 1440, height: 900 }); await screenshot('workspace-team-large-font.png')

  stage = 'new frontend on old backend has an honest discoverable entry'
  await page.route('**/api/bootstrap', async route => { const response = await route.fetch(), value = await response.json(); delete value.capabilities.teamMode; delete value.capabilities.teamPilot; await route.fulfill({ response, json: value }) })
  await page.reload(); await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  const legacyMenu = await rightWorkspace('Project A'); await legacyMenu.getByRole('menuitem', { name: /团队模式/ }).click()
  const availability = page.getByRole('dialog', { name: '团队模式服务待更新' }); await availability.waitFor()
  assert.match(await availability.textContent(), /后台仍是旧版本/)
  assert.equal(new URL(await availability.getByRole('link', { name: '打开试验工作区' }).getAttribute('href')).port, '4791')
  await screenshot('workspace-team-legacy-entry.png')
  await availability.getByRole('button', { name: '知道了' }).click()
  assert.ok(requests.filter(r => r.method === 'POST').every(r => new URL(r.path).searchParams.has('workspace')), 'Every formal team mutation is workspace-scoped')
  assert.deepEqual(errors, [])
  console.log('Workspace team browser passed: scoped menu/import, preserved history/drafts, stale-response isolation, fixed mode switch, compact graph and empty tiers, highlighted traffic, desktop/mobile/large fonts, legacy discoverability.')
} catch (error) { console.error('Stage:', stage); await page.screenshot({ path: resolve(output, 'workspace-team-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
