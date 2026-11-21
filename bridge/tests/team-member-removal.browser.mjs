// Full membership changes against a temporary Bridge and fake native CLI.
// No live workspace, daemon, model, or user approvals are touched.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'team-remove-')), cwd = resolve(root, 'project'), other = resolve(root, 'other'), log = resolve(root, 'rpc.jsonl')
await mkdir(cwd); await mkdir(other)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd,
  env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'), false, { workspaceTeams: true })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true,
  ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), errors = [], writes = []
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => { if (request.url().includes('/api/') && request.method() === 'POST') writes.push({ path: request.url(), data: request.postDataJSON() }) })
const graph = page.getByRole('region', { name: '团队关系图', exact: true }), dialog = page.getByRole('dialog', { name: '移出团队', exact: true })
const node = id => page.locator(`.react-flow__node[data-id="${id}"]`)
let stage = 'setup'
async function until(check) { const end = Date.now() + 7000; do { if (await check()) return; await page.waitForTimeout(30) } while (Date.now() < end); throw new Error(`Timed out: ${stage}`) }
async function openRemoval(id) {
  await graph.getByRole('button', { name: '全图', exact: true }).click(); await page.waitForTimeout(100)
  await node(id).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: '团队节点菜单', exact: true }); await menu.waitFor()
  await menu.getByRole('menuitem', { name: '移出团队', exact: true }).click(); await dialog.waitFor()
}
async function cancel() { await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }) }
async function reopenGraph() { await page.reload(); await page.getByText('本地引擎已连接', { exact: true }).waitFor(); await page.locator('.team-mode-switch').getByRole('button', { name: '团队', exact: true }).click(); await graph.waitFor() }
async function screenshot(name) { await page.screenshot({ path: resolve(output, name), fullPage: true }) }
try {
  const boot = await bridge.bootstrap(), workspaceId = boot.workspaces[0].id
  await bridge.renameWorkspace(workspaceId, '移出团队验收'); const otherWorkspace = await bridge.addWorkspace(other, '其他工作区')
  await bridge.updatePreferences({ animations: false, theme: 'dark', showInspector: false })
  const create = async (name, path = cwd) => { const thread = await bridge.create(path, 'fixture-next', 'medium'); await bridge.rename(thread.id, name); return thread.id }
  const lead = await create('负责人'), manager = await create('项目主管'), peer = await create('接替主管'), worker = await create('独立会话'), peerWorker = await create('其他执行成员'), otherLead = await create('其他工作区负责人', other)
  for (const [threadId, level, parentId] of [[lead, 1, null], [manager, 2, lead], [peer, 2, lead], [worker, 3, manager], [peerWorker, 3, peer]]) await bridge.importTeamMember(workspaceId, { threadId, level, parentId, groupId: null })
  await bridge.importTeamMember(otherWorkspace.id, { threadId: otherLead, level: 1, parentId: null, groupId: null })
  const service = await bridge.teamForWorkspace(workspaceId), otherService = await bridge.teamForWorkspace(otherWorkspace.id)
  await service.enable(true); const otherBefore = await otherService.snapshot()
  await bridge.message(worker, { text: '等待移出后验证独立会话继续运行', mode: 'read-only' })
  const turn = bridge.threads.get(worker).turnId
  assert.ok(turn)
  const nativeBefore = (await rpc.call('thread/read', { threadId: worker, includeTurns: true })).thread
  const message = await service.propose(manager, { to: worker, kind: 'task', title: '未投递的任务', body: '隔离验收，不执行模型任务', requestKey: 'remove-pending' })
  const callsBefore = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const removeWrites = () => writes.filter(row => new URL(row.path).pathname === '/api/team/members/remove')
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  await page.locator('.workspace-toggle').filter({ hasText: '移出团队验收' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '打开关系图', exact: true }).click(); await graph.waitFor()

  stage = 'right-click menu and cancel preserve membership'
  await graph.getByRole('button', { name: '全图', exact: true }).click(); await page.waitForTimeout(100)
  await node(worker).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: '团队节点菜单', exact: true }); await menu.waitFor()
  await screenshot('team-member-remove-menu.png')
  await menu.getByRole('menuitem', { name: '移出团队', exact: true }).click(); await dialog.waitFor()
  assert.match(await dialog.textContent(), /取消该会话尚未投递的 1 条通信/)
  await screenshot('team-member-remove-confirm.png'); await cancel()
  assert.ok((await service.snapshot()).members.some(row => row.threadId === worker))
  assert.equal(removeWrites().length, 0)

  stage = 'stale graphs cannot silently apply a removal'
  await openRemoval(worker)
  const latest = await service.snapshot(); latest.members[0].order++
  await service.topology({ graphVersion: latest.graphVersion, members: latest.members, groups: latest.groups, edges: latest.edges, levels: latest.levels })
  await until(async () => (await dialog.textContent()).includes('关系图已更新'))
  assert.equal(await dialog.getByRole('button', { name: '确认移出团队' }).isDisabled(), true)
  await cancel(); assert.equal(removeWrites().length, 0)

  stage = 'leaf removal preserves native history, active turn and the original sidebar conversation'
  await openRemoval(worker); await dialog.getByRole('button', { name: '确认移出团队' }).click(); await dialog.waitFor({ state: 'hidden' })
  await node(worker).waitFor({ state: 'hidden' })
  assert.equal((await service.snapshot()).messages.find(row => row.id === message.id).state, 'cancelled')
  assert.equal(bridge.threads.get(worker).turnId, turn)
  assert.deepEqual((await rpc.call('thread/read', { threadId: worker, includeTurns: true })).thread, nativeBefore)
  assert.equal(await page.locator(`[data-thread-id="${worker}"]`).count(), 1)
  assert.deepEqual(await otherService.snapshot(), otherBefore)
  await reopenGraph(); await node(lead).waitFor(); assert.equal(await node(worker).count(), 0)

  stage = 'the same native session can rejoin; manager removal requires explicit child reassignment'
  await graph.getByRole('button', { name: '加入会话', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '加入已有会话', exact: true }); await picker.waitFor()
  await picker.getByRole('button', { name: /独立会话/ }).click()
  await picker.getByRole('combobox', { name: '加入会话层级', exact: true }).selectOption('3')
  await picker.getByRole('combobox', { name: '加入会话直属上级', exact: true }).selectOption(manager)
  await picker.getByRole('button', { name: '确认加入团队', exact: true }).click(); await picker.waitFor({ state: 'hidden' }); await node(worker).waitFor()
  await openRemoval(manager)
  assert.equal(await dialog.getByRole('button', { name: '确认移出团队' }).isDisabled(), true)
  await dialog.getByRole('combobox', { name: '移出后的接替上级', exact: true }).selectOption(peer)
  await screenshot('team-member-remove-reassign.png')
  await dialog.getByRole('button', { name: '确认移出团队' }).click(); await dialog.waitFor({ state: 'hidden' })
  assert.equal((await service.snapshot()).members.find(row => row.threadId === worker).parentId, peer)
  assert.equal(bridge.threads.get(worker).turnId, turn)
  assert.equal(await page.locator(`[data-thread-id="${manager}"]`).count(), 1)
  await openRemoval(lead)
  assert.match(await dialog.textContent(), /最高负责人仍有下级/)
  assert.equal(await dialog.getByRole('button', { name: '确认移出团队' }).isDisabled(), true); await cancel()

  stage = 'old running backends explain availability without sending unsupported writes'
  const oldSnapshot = async route => {
    const response = await route.fetch(), value = await response.json(); delete value.capabilities
    await route.fulfill({ response, json: value })
  }
  await page.route('**/api/team?*', oldSnapshot)
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/team')
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('cweb:team-changed', { detail: { workspaceId: id } })), workspaceId); await response
  await openRemoval(peerWorker)
  assert.match(await dialog.textContent(), /服务空闲重启后启用/)
  assert.equal(await dialog.getByRole('button', { name: '确认移出团队' }).isDisabled(), true)
  assert.equal(removeWrites().length, 2)
  await cancel(); await page.unroute('**/api/team?*', oldSnapshot)

  stage = 'large text and mobile menu/dialog remain inside the viewport'
  await bridge.updatePreferences({ uiFontSize: 18, fontSize: 20 })
  await page.setViewportSize({ width: 390, height: 844 }); await reopenGraph(); await node(peerWorker).waitFor()
  await openRemoval(peerWorker)
  const box = await dialog.boundingBox()
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, JSON.stringify(box))
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await screenshot('team-member-remove-mobile.png'); await cancel()
  const callsAfter = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).slice(callsBefore.length)
  assert.equal(callsAfter.filter(row => ['thread/start', 'turn/start', 'turn/steer', 'turn/interrupt', 'thread/archive', 'thread/rollback'].includes(row.method)).length, 0, 'Removing or rejoining never spends a model turn or changes native conversation history')
  assert.ok(removeWrites().every(row => new URL(row.path).searchParams.get('workspace') === workspaceId))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ rightClick: true, cancelled: true, staleGuard: true, retainedHistory: true, activeTurnRetained: true, rejoin: true, reassignChildren: true, scoped: true, oldBackendCompatible: true, mobile: true, noModelCalls: true }))
} catch (error) { console.error('Stage:', stage); await screenshot('team-member-remove-failure.png').catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
