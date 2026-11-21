// Only an isolated fake-native fixture is used. No model turn or real workspace
// is touched; the browser exercises the two real member dialogs and local cache.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'
import { memberSelectionKey } from '../client/team-member-selection.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'team-member-selection-')), cwd = resolve(root, 'project-a'), other = resolve(root, 'project-b'), log = resolve(root, 'rpc.jsonl')
await mkdir(cwd); await mkdir(other)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'), false, { workspaceTeams: true })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }), errors = []
page.on('pageerror', error => errors.push(error.message))
const base = `http://127.0.0.1:${app.server.address().port}`
const graph = page.getByRole('region', { name: '团队关系图', exact: true })
const picker = page.getByRole('dialog', { name: '加入已有会话', exact: true })
const creator = page.getByRole('dialog', { name: '申请新增团队会话', exact: true })
let stage = 'setup'
async function until(fn) { const end = Date.now() + 7000; do { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 25)) } while (Date.now() < end); throw new Error(`Timed out: ${stage}`) }
async function openWorkspace(name) {
  await page.locator('.workspace-toggle').filter({ hasText: name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '打开关系图', exact: true }).click(); await graph.waitFor()
}
async function openImport() { await graph.getByRole('button', { name: '加入会话', exact: true }).click(); await picker.waitFor() }
async function openCreate() { await graph.getByRole('button', { name: '新建会话', exact: true }).click(); await creator.waitFor() }
async function cancel(dialog) { await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }) }
async function selection(dialog, prefix) {
  const level = Number(await dialog.getByRole('combobox', { name: `${prefix}层级`, exact: true }).inputValue())
  return { level, parentId: level > 1 ? await dialog.getByRole('combobox', { name: `${prefix}直属上级`, exact: true }).inputValue() : '', groupId: level > 1 ? await dialog.getByRole('combobox', { name: `${prefix}分组`, exact: true }).inputValue() : '' }
}
const cache = workspace => page.evaluate(key => localStorage.getItem(key), memberSelectionKey(workspace))
const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
async function native(name, path) { const thread = await bridge.create(path, 'fixture-next', 'medium'); await bridge.rename(thread.id, name); return thread.id }
try {
  const boot = await bridge.bootstrap(), a = boot.workspaces[0], b = await bridge.addWorkspace(other, 'Memory B')
  await bridge.renameWorkspace(a.id, 'Memory A')
  await bridge.updatePreferences({ theme: 'dark', animations: false, showInspector: false })
  const lead = await native('A 负责人', cwd), managerA = await native('A 项目主管', cwd), managerB = await native('A 视觉主管', cwd)
  const workerA = await native('A 执行成员', cwd), workerA2 = await native('A 备用成员', cwd), workerB = await native('A 视觉成员', cwd)
  const candidate = await native('候选会话一', cwd), candidate2 = await native('候选会话二', cwd), candidate3 = await native('候选会话三', cwd)
  for (const [threadId, level, parentId, groupId] of [[lead, 1, null, null], [managerA, 2, lead, 'managers'], [managerB, 2, lead, 'managers'], [workerA, 3, managerA, 'a-main'], [workerA2, 3, managerA, 'a-second'], [workerB, 3, managerB, 'b-main']]) {
    await bridge.importTeamMember(a.id, { threadId, level, parentId, groupId })
  }
  const aTeam = await bridge.teamForWorkspace(a.id), bLead = await native('B 负责人', other)
  await native('B 候选会话', other)
  await bridge.importTeamMember(b.id, { threadId: bLead, level: 1, parentId: null, groupId: null })
  const baselineStarts = (await calls()).filter(row => row.method === 'thread/start').length
  await page.goto(base); await page.getByText('本地引擎已连接', { exact: true }).waitFor(); await openWorkspace('Memory A')

  stage = 'initial defaults follow recent members and local draft choices survive layer changes'
  await openImport()
  assert.deepEqual(await selection(picker, '加入会话'), { level: 3, parentId: managerB, groupId: 'b-main' })
  await picker.getByRole('combobox', { name: '加入会话直属上级' }).selectOption(managerA)
  await picker.getByRole('combobox', { name: '加入会话分组' }).selectOption('a-main')
  await picker.getByRole('combobox', { name: '加入会话直属上级' }).selectOption(managerB)
  assert.equal((await selection(picker, '加入会话')).groupId, 'b-main')
  await picker.getByRole('combobox', { name: '加入会话直属上级' }).selectOption(managerA)
  assert.equal((await selection(picker, '加入会话')).groupId, 'a-main')
  await picker.getByRole('combobox', { name: '加入会话分组' }).selectOption('a-second')
  await picker.getByRole('combobox', { name: '加入会话层级' }).selectOption('2')
  await picker.getByRole('combobox', { name: '加入会话层级' }).selectOption('3')
  assert.deepEqual(await selection(picker, '加入会话'), { level: 3, parentId: managerA, groupId: 'a-second' })
  await cancel(picker)
  assert.equal(await cache(a.id), null)
  await openImport()
  assert.deepEqual(await selection(picker, '加入会话'), { level: 3, parentId: managerB, groupId: 'b-main' })

  stage = 'a successful import becomes the shared default in the new-member dialog'
  await picker.getByRole('button', { name: /候选会话一/ }).click()
  await picker.getByRole('combobox', { name: '加入会话直属上级' }).selectOption(managerA)
  await picker.getByRole('combobox', { name: '加入会话分组' }).selectOption('a-second')
  await picker.getByRole('button', { name: '确认加入团队' }).click(); await picker.waitFor({ state: 'hidden' })
  assert.ok((await aTeam.snapshot()).members.some(member => member.threadId === candidate))
  await openCreate()
  assert.deepEqual(await selection(creator, '新成员'), { level: 3, parentId: managerA, groupId: 'a-second' })
  assert.equal(await creator.getByRole('checkbox', { name: '采用设置中的默认模型与强度' }).isChecked(), true)
  await creator.getByRole('textbox', { name: '团队会话名称' }).fill('待审批的主管')
  await creator.getByRole('combobox', { name: '新成员层级' }).selectOption('2')
  await creator.getByRole('combobox', { name: '新成员分组' }).selectOption('')
  await creator.getByRole('button', { name: '提交成员申请' }).click(); await creator.waitFor({ state: 'hidden' })
  assert.equal((await aTeam.snapshot()).memberRequests.at(-1).state, 'pending')
  assert.equal((await calls()).filter(row => row.method === 'thread/start').length, baselineStarts, 'Saving a member request does not bypass creation approval')

  stage = 'successful defaults survive page refresh and restore the previous level when revisited'
  await page.reload(); await page.getByText('本地引擎已连接', { exact: true }).waitFor(); await openWorkspace('Memory A'); await openImport()
  assert.deepEqual(await selection(picker, '加入会话'), { level: 2, parentId: lead, groupId: '' })
  await picker.getByRole('combobox', { name: '加入会话层级' }).selectOption('3')
  assert.deepEqual(await selection(picker, '加入会话'), { level: 3, parentId: managerA, groupId: 'a-second' })

  stage = 'failed import keeps saved defaults and cancelling the dialog discards its local edits'
  const beforeFailure = await cache(a.id)
  await page.route('**/api/team/members/import?*', route => route.fulfill({ status: 409, json: { error: { code: 'TEST_CONFLICT', message: '测试：关系变化，请重新选择' } } }))
  await picker.getByRole('button', { name: /候选会话二/ }).click()
  await picker.getByRole('combobox', { name: '加入会话直属上级' }).selectOption(managerB)
  await picker.getByRole('button', { name: '确认加入团队' }).click(); await picker.getByRole('alert').waitFor()
  assert.equal(await cache(a.id), beforeFailure)
  await page.unroute('**/api/team/members/import?*'); await cancel(picker)
  await openImport(); assert.deepEqual(await selection(picker, '加入会话'), { level: 2, parentId: lead, groupId: '' }); await cancel(picker)

  stage = 'right-click parent context overrides last level while recalling its own group'
  await page.locator(`.react-flow__node[data-id="${managerA}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加入已有下级', exact: true }).click(); await picker.waitFor()
  assert.deepEqual(await selection(picker, '加入会话'), { level: 3, parentId: managerA, groupId: 'a-second' }); await cancel(picker)
  await page.locator(`.react-flow__node[data-id="${managerB}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '申请新增下级', exact: true }).click(); await creator.waitFor()
  assert.deepEqual(await selection(creator, '新成员'), { level: 3, parentId: managerB, groupId: 'b-main' }); await cancel(creator)

  stage = 'other workspaces keep independent defaults'
  await openWorkspace('Memory B'); await openCreate()
  assert.deepEqual(await selection(creator, '新成员'), { level: 2, parentId: bLead, groupId: '' })
  await creator.getByRole('textbox', { name: '团队会话名称' }).fill('B 待审批成员')
  await creator.getByRole('button', { name: '提交成员申请' }).click(); await creator.waitFor({ state: 'hidden' })
  assert.equal(await cache(a.id), beforeFailure)
  assert.ok(await cache(b.id))

  stage = 'expired group records are validated after graph updates and refresh'
  const topology = await aTeam.snapshot()
  await aTeam.topology({ graphVersion: topology.graphVersion, levels: topology.levels, edges: topology.edges,
    members: topology.members.map(member => member.groupId === 'a-second' ? { ...member, groupId: 'a-main' } : member), groups: topology.groups.filter(group => group.id !== 'a-second') })
  await page.reload(); await page.getByText('本地引擎已连接', { exact: true }).waitFor(); await openWorkspace('Memory A'); await openImport()
  await picker.getByRole('combobox', { name: '加入会话层级' }).selectOption('3')
  assert.deepEqual(await selection(picker, '加入会话'), { level: 3, parentId: managerA, groupId: 'a-main' })
  await page.screenshot({ path: resolve(output, 'team-member-selection.png'), fullPage: true }); await cancel(picker)

  stage = 'closing an in-flight form does not let its late success overwrite remembered defaults'
  let held
  await page.route('**/api/team/members/import?*', route => { held = route })
  await openImport()
  await picker.getByRole('button', { name: /候选会话三/ }).click()
  await picker.getByRole('combobox', { name: '加入会话层级' }).selectOption('3')
  await picker.getByRole('combobox', { name: '加入会话直属上级' }).selectOption(managerB)
  const beforeClose = await cache(a.id)
  await picker.getByRole('button', { name: '确认加入团队' }).click(); await until(() => Boolean(held)); await cancel(picker)
  await held.continue(); await page.unroute('**/api/team/members/import?*')
  await until(async () => (await aTeam.snapshot()).members.some(member => member.threadId === candidate3))
  await until(async () => !(await graph.getByRole('button', { name: '开启团队', exact: true }).isDisabled()))
  assert.equal(await cache(a.id), beforeClose)
  assert.ok(!(await aTeam.snapshot()).members.some(member => member.threadId === candidate2))
  assert.equal((await calls()).filter(row => ['turn/start', 'turn/steer'].includes(row.method)).length, 0)
  assert.deepEqual(errors, [])
  console.log('Team member selection browser passed: shared successful defaults, per-layer/per-parent drafts, cancellation/failure, reload, workspace isolation, explicit parent priority, stale groups, creation approval, late-response cancellation; no model turns.')
} catch (error) { console.error('Stage:', stage); await page.screenshot({ path: resolve(output, 'team-member-selection-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
