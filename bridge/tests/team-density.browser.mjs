// Dense-team acceptance uses its own fake native engine and workspace.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'team-density-')), cwd = resolve(root, 'workspace'), log = resolve(root, 'rpc.jsonl')
await mkdir(cwd)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd,
  env: { ...process.env, FAKE_STORE: resolve(root, 'native.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'), false, { workspaceTeams: true })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true,
  ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [], metrics = {}
page.on('pageerror', error => errors.push(error.message))
let stage = 'seed'
async function until(check, label = stage) {
  const end = Date.now() + 8000
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)) } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}
const graph = page.getByRole('region', { name: '团队关系图', exact: true })
const shape = () => page.evaluate(() => {
  const transform = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
  const nodes = [...document.querySelectorAll('.react-flow__node-member')].map(node => {
    const box = node.getBoundingClientRect()
    return { id: node.dataset.id, x: box.x, y: box.y, width: box.width, height: box.height }
  })
  const box = document.querySelector('.team-flow').getBoundingClientRect()
  return { zoom: transform.a, x: transform.e, y: transform.f, nodes, canvas: { x: box.x, y: box.y, width: box.width, height: box.height } }
})
function noOverlap(nodes) {
  for (let i = 0; i < nodes.length; i++) for (const b of nodes.slice(i + 1)) {
    const a = nodes[i]
    assert.ok(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1,
      `Member nodes overlap: ${a.id} and ${b.id}`)
  }
}
async function screenshot(name) { await page.waitForTimeout(250); await page.screenshot({ path: resolve(output, name), fullPage: true }) }
try {
  const boot = await bridge.bootstrap(), workspaceId = boot.workspaces[0].id, team = await bridge.teamForWorkspace(workspaceId)
  await bridge.renameWorkspace(workspaceId, '密集团队验收')
  await bridge.updatePreferences({ theme: 'dark', showInspector: true, animations: false })
  const seed = async (name, level, parentId = null) => {
    const thread = await bridge.create(cwd, 'fixture-next', 'medium'); await bridge.rename(thread.id, name)
    await team.register({ threadId: thread.id, name, cwd, level, role: level === 1 ? 'lead' : level === 2 ? 'manager' : 'worker', parentId, model: 'fixture-next', effort: 'medium' })
    return thread.id
  }
  const lead = await seed('项目负责人', 1), manager = await seed('项目主管', 2, lead)
  const groups = [
    { id: 'algorithms', name: '算法', names: ['视觉识别', '夹爪优化', '运动控制'] },
    { id: 'support', name: '辅助', names: ['桥接驱动', '深度相机', '数据回放', '回零流程', '数据采集', '网页交互', '键鼠与手柄输入', '模型优化', '手柄输入'] },
    { id: 'management', name: '管理', names: ['项目拓扑', '插件格式'] },
  ]
  const ids = {}
  for (const group of groups) { ids[group.id] = []; for (const name of group.names) ids[group.id].push(await seed(name, 3, manager)) }
  const state = await team.snapshot()
  state.groups = [...state.groups.filter(group => group.level === 2), ...groups.map((group, order) => ({ id: group.id, name: group.name, level: 3, parentId: manager, order }))]
  for (const member of state.members) for (const group of groups) if (ids[group.id].includes(member.threadId)) member.groupId = group.id
  state.levels = ['负责人', '主管', '执行成员', ...Array.from({ length: 7 }, (_, i) => `第 ${i + 4} 层`)]
  await team.topology({ graphVersion: state.graphVersion, members: state.members, groups: state.groups, edges: state.edges, levels: state.levels }); await team.enable(true)
  const before = await team.snapshot()
  const signature = s => JSON.stringify([s.members, s.groups, s.edges, s.levels])

  stage = 'horizontal levels with vertical peers remain readable'
  await page.goto(`http://127.0.0.1:${app.server.address().port}/?team=1`)
  await graph.waitFor(); await until(async () => await page.locator('.react-flow__node-member').count() === 16)
  await until(async () => (await shape()).nodes.every(n => n.width > 0)); await page.waitForTimeout(350)
  const initial = await shape(); noOverlap(initial.nodes)
  assert.ok(initial.zoom >= .77, `Dense default is too small: ${initial.zoom}`)
  const support = initial.nodes.filter(node => ids.support.includes(node.id)), span = Math.max(...support.map(n => n.x + n.width)) - Math.min(...support.map(n => n.x))
  assert.ok(Math.abs(span / initial.zoom - 180) < 2, `Peers must occupy one column: ${span / initial.zoom}`)
  assert.equal(new Set(support.map(node => Math.round(node.y))).size, 9, 'Peers stack vertically')
  const rootNode = initial.nodes.find(node => node.id === lead), managerNode = initial.nodes.find(node => node.id === manager)
  assert.ok(rootNode.x < managerNode.x && managerNode.x < support[0].x, 'Levels progress from left to right')
  assert.ok(Math.abs(rootNode.y - managerNode.y) < 1, 'Leader and sole manager align horizontally')
  assert.equal(await page.locator('.team-level-header').count(), 3, 'Only populated level columns have headers')
  const labels = await page.locator('.team-level-header').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: box.x, width: box.width } }))
  assert.ok(labels.every(label => label.x >= initial.canvas.x - 2 && label.x + label.width <= initial.canvas.x + initial.canvas.width + 2), 'Tier labels remain complete in the initial clear view')
  assert.equal(await page.locator('.team-permission-edge').count(), 15)
  metrics.initial = { zoom: initial.zoom, supportWidth: span / initial.zoom, nodes: initial.nodes.length }
  await screenshot('team-density-1440.png')

  stage = 'locating a group and refresh preserve the chosen view'
  await graph.getByRole('combobox', { name: '定位分组', exact: true }).selectOption('support')
  await page.waitForTimeout(250)
  const located = await shape(); assert.ok(located.zoom >= .77)
  for (let i = 0; i < 5; i++) {
    const fetched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/team')
    await page.evaluate(workspaceId => window.dispatchEvent(new CustomEvent('cweb:team-changed', { detail: { workspaceId } })), workspaceId)
    await fetched; await page.waitForTimeout(60)
  }
  const refreshed = await shape()
  assert.ok(Math.abs(refreshed.zoom - located.zoom) < .002 && Math.abs(refreshed.x - located.x) < 2 && Math.abs(refreshed.y - located.y) < 2, 'Status refresh must not reset group focus')
  assert.equal(await page.locator('.team-permission-edge').count(), 15)
  await screenshot('team-density-group.png')
  await graph.getByRole('button', { name: '全图', exact: true }).click(); await page.waitForTimeout(220)
  const overview = await shape(); noOverlap(overview.nodes)
  assert.ok(overview.nodes.every(n => n.x >= overview.canvas.x - 2 && n.x + n.width <= overview.canvas.x + overview.canvas.width + 2), 'Full overview contains every level column')
  assert.ok(overview.nodes.every(n => n.y >= overview.canvas.y + 35 && n.y + n.height <= overview.canvas.y + overview.canvas.height - 30), 'Full overview contains the complete vertical tree')
  await graph.getByRole('button', { name: '清晰视图', exact: true }).click(); await page.waitForTimeout(250)
  assert.ok((await shape()).zoom >= .77)
  assert.equal(signature(await team.snapshot()), signature(before), 'Viewing/reflow never changes authority or membership')

  stage = 'traffic uses a direct, smooth curve and remains visible'
  const task = await team.propose(manager, { to: ids.support[8], kind: 'task', title: '核对接口边界', body: '仅验证图中待审批路线，不执行任务。', requestKey: 'dense-route' })
  await page.locator('.team-traffic-edge').waitFor(); assert.match(await page.locator('.team-traffic-edge').textContent(), /核对接口边界/)
  await graph.getByRole('combobox', { name: '定位分组', exact: true }).selectOption('support'); await screenshot('team-density-traffic.png')
  assert.equal((await team.snapshot()).messages.find(row => row.id === task.id).state, 'pending')
  const traffic = await page.locator('.team-traffic-edge .react-flow__edge-path').getAttribute('d')
  assert.equal((traffic.match(/C/g) || []).length, 1); assert.ok(!/[LQ]/.test(traffic), 'Traffic uses one curve without returning elbows')
  stage = 'parallel traffic uses short labels without covering members'
  for (let i = 0; i < 6; i++) await team.propose(manager, { to: ids.support[i], kind: 'task', title: `核查模块 ${i + 1} 的完整接口约束与边界条件`, body: '仅验证并行审批显示，不执行任务。', requestKey: `dense-parallel-${i}` })
  await until(async () => await page.locator('.team-traffic-edge').count() === 7)
  const badges = await page.locator('.team-traffic-edge .react-flow__edge-textbg').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height } }))
  const memberBoxes = (await shape()).nodes
  for (const badge of badges) for (const node of memberBoxes) assert.ok(badge.x + badge.width <= node.x || node.x + node.width <= badge.x || badge.y + badge.height <= node.y || node.y + node.height <= badge.y, `Traffic badge covers ${node.id}`)
  const captions = await page.locator('.team-traffic-edge .react-flow__edge-text').allTextContents()
  assert.ok(captions.every(label => label === '待批准'), 'Visible captions contain status only')
  const descriptions = await page.locator('.team-traffic-edge title').allTextContents()
  assert.equal(descriptions.length, 7); assert.ok(descriptions.some(label => label.includes('完整接口约束与边界条件')), 'Hover titles retain complete task names')
  assert.ok((await page.locator('.team-traffic-edge').evaluateAll(edges => edges.map(edge => edge.getAttribute('aria-label')))).every(label => label?.includes('→')), 'Every edge has an accessible sender, receiver and task name')
  await screenshot('team-density-parallel-traffic.png')
  await graph.getByRole('button', { name: '全图', exact: true }).click()

  stage = 'different screens and larger UI font'
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.waitForTimeout(350); noOverlap((await shape()).nodes)
  const headerOffsets = await page.locator('.team-level-header').evaluateAll(headers => headers.filter(header => getComputedStyle(header).visibility !== 'hidden').map(header => {
    const level = Number(header.querySelector('b').textContent), node = document.querySelector(`.react-flow__node-member:has(.tier-${level})`)
    const a = header.getBoundingClientRect(), b = node.getBoundingClientRect(); return Math.abs(a.x + a.width / 2 - b.x - b.width / 2)
  }))
  assert.ok(headerOffsets.every(offset => offset < 1), 'Sticky level headers follow zoom, pan and canvas resize')
  await screenshot('team-density-1920.png')
  await bridge.updatePreferences({ uiFontSize: 18, fontSize: 20 }); await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(350); await screenshot('team-density-large-font.png')
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300)
  const hide = page.getByRole('button', { name: '隐藏工作区面板', exact: true }); if (await hide.count()) await hide.click()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page-wide horizontal overflow')
  await graph.getByRole('combobox', { name: '定位分组', exact: true }).selectOption('management'); await screenshot('team-density-mobile.png')
  const controls = await graph.getByRole('combobox', { name: '定位分组', exact: true }).boundingBox()
  assert.ok(controls.x >= 0 && controls.x + controls.width <= 391)

  stage = 'vertical member dragging updates order without changing group or authority'
  await page.setViewportSize({ width: 1440, height: 900 }); await bridge.updatePreferences({ uiFontSize: 14, fontSize: 16 })
  await page.waitForTimeout(300)
  await graph.getByRole('combobox', { name: '定位分组', exact: true }).selectOption('support'); await page.waitForTimeout(250)
  const first = await page.locator(`.react-flow__node[data-id="${ids.support[0]}"] .team-node`).boundingBox()
  const lower = await page.locator(`.react-flow__node[data-id="${ids.support[6]}"] .team-node`).boundingBox()
  const originalOrder = (await team.snapshot()).members.filter(member => member.groupId === 'support').sort((a, b) => a.order - b.order).map(member => member.threadId)
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2); await page.mouse.down()
  // Cross the drag threshold with a small movement before the long gesture;
  // React Flow captures the grab offset on this first drag event.
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2 + 3)
  await page.mouse.move(lower.x + lower.width / 2, lower.y + lower.height / 2, { steps: 12 }); await page.mouse.up()
  await until(async () => (await team.snapshot()).members.filter(member => member.groupId === 'support').sort((a, b) => a.order - b.order)[6]?.threadId === ids.support[0])
  const reordered = await team.snapshot(), newOrder = reordered.members.filter(member => member.groupId === 'support').sort((a, b) => a.order - b.order).map(member => member.threadId)
  assert.deepEqual([...newOrder].sort(), originalOrder.sort())
  assert.deepEqual(reordered.members.map(({ order, ...member }) => member), before.members.map(({ order, ...member }) => member))
  assert.deepEqual(reordered.edges, before.edges); assert.deepEqual(reordered.groups, before.groups)
  metrics.verticalSort = true

  stage = '80 members keep bounded visible rendering and responsive navigation'
  await page.setViewportSize({ width: 1440, height: 900 }); await bridge.updatePreferences({ uiFontSize: 14, fontSize: 16 })
  for (let i = 0; i < 64; i++) await team.register({ threadId: `dense-stress-${i}`, name: `压力成员 ${i + 1}`, role: 'worker', level: 3, parentId: manager, groupId: 'support', cwd })
  await until(async () => (await graph.locator('.team-graph-header').textContent()).includes('80 个会话'))
  await graph.getByRole('button', { name: '清晰视图', exact: true }).click()
  await until(async () => { const count = await page.locator('.react-flow__node-member').count(); return count > 0 && count < 80 })
  metrics.stressVisible = await page.locator('.react-flow__node-member').count()
  assert.ok((await shape()).zoom >= .77)
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.filter(call => ['turn/start', 'turn/steer', 'turn/interrupt'].includes(call.method)).length, 0, 'Layout and navigation consume no model turns')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ denseTeam: true, untouchedTopology: true, readableDefault: true, groupNavigation: true, refreshStable: true, traffic: true, responsive: true, noModelCalls: true, ...metrics }))
} catch (error) { console.error('Stage:', stage); await page.screenshot({ path: resolve(output, 'team-density-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
