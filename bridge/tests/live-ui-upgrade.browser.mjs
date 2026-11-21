import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

// Exercise a UI-only release against the previous service contract, followed
// by a service upgrade. A running task must not postpone a UI release.
await mkdir('test-results', { recursive: true })
const root = await mkdtemp(resolve('test-results/live-ui-')), cwd = resolve(root, 'project'); await mkdir(cwd)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json') } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const thread = await bridge.create(cwd)
await bridge.plugin.call(thread.id, 'todo_note_update', { add_tasks: [{ title: '旧服务中的待办' }] })
await bridge.updatePreferences({ showInspector: false })
let legacy = true
const snapshot = bridge.preferences.snapshot.bind(bridge.preferences)
bridge.preferences.snapshot = async () => {
  const value = await snapshot()
  if (!legacy) return value
  const { todoPlacement, ...preferences } = value.preferences
  return { ...value, preferences }
}
const writes = [], update = bridge.updatePreferences.bind(bridge)
bridge.updatePreferences = async patch => {
  if (legacy) assert.ok(!('todoPlacement' in patch), 'Old services reject unknown preference fields')
  writes.push(patch)
  return update(patch)
}
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
const errors = []; page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(id => localStorage.setItem('cweb:thread', id), thread.id)
const pane = page.getByRole('complementary', { name: '工作区面板', exact: true })
const pending = () => page.evaluate(() => JSON.parse(localStorage.getItem('cweb:pending-todo-layout') || 'null'))
async function until(check, label) { for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(50) } assert.fail(label) }
async function placement(value) {
  await page.getByRole('button', { name: '连接与设置', exact: true }).click()
  await page.getByLabel('待办显示位置', { exact: true }).selectOption(value)
  await until(async () => (await pending())?.todoPlacement === value, 'Legacy layout preference is staged')
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await page.locator('.settings-dialog[open]').waitFor({ state: 'hidden' })
}
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  await pane.getByText('旧服务中的待办', { exact: true }).waitFor()
  assert.equal(await pane.getByRole('button', { name: '待办', exact: true }).getAttribute('aria-pressed'), 'true')
  await placement('floating')
  await page.reload(); await page.locator('.dtn-layer[data-layout="floating"]').waitFor()
  await pane.waitFor({ state: 'hidden' })
  await bridge.updatePreferences({ theme: 'light' })
  await page.locator('html[data-theme="light"]').waitFor()
  assert.equal(await page.locator('.dtn-layer[data-layout="floating"]').count(), 1, 'Legacy SSE must preserve the chosen layout')
  await placement('sidebar'); await page.reload()
  await pane.getByText('旧服务中的待办', { exact: true }).waitFor()
  await placement('floating')
  assert.ok(writes.length >= 3)
  legacy = false
  await page.reload()
  await page.locator('.dtn-layer[data-layout="floating"]').waitFor()
  await pane.waitFor({ state: 'hidden' })
  await until(async () => (await snapshot()).preferences.todoPlacement === 'floating' && await pending() === null, 'Upgrade flushes the staged choice to native storage')
  await page.reload(); await page.locator('.dtn-layer[data-layout="floating"]').waitFor()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ legacyDefaultSidebar: true, legacyWritesAccepted: true, choiceSurvivesReloadAndSse: true, stagedChoiceMigrated: true, pageErrors: errors }))
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
