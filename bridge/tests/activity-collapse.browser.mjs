import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'collapse-')), cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const id = randomUUID(), store = resolve(root, 'sessions.json')
await writeFile(store, JSON.stringify({ [id]: { id, name: '工作步骤收起验证', preview: '', cwd, updatedAt: Date.now() / 1000, turns: [{ id: 'first-turn', status: 'completed', items: [
  { id: 'first-user', type: 'userMessage', content: [{ type: 'text', text: '首轮检查项目' }] },
  { id: 'first-reason', type: 'reasoning', summary: ['先检查结构，再核对类型。'], content: [] },
  { id: 'first-tool', type: 'commandExecution', command: 'cat README.md', status: 'completed', aggregatedOutput: '原始内容按需查看', exitCode: 0 },
  { id: 'second-tool', type: 'commandExecution', command: 'npm run check', status: 'completed', aggregatedOutput: '检查通过', exitCode: 0 },
  { id: 'first-answer', type: 'agentMessage', phase: 'final_answer', text: '首轮回答已完成。\n\n```js\nconst done = true\n```' },
] }] } }))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${app.server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' }), errors = []
page.on('pageerror', error => errors.push(error.message))
const input = page.getByLabel('发送给 Codex 的消息', { exact: true })
const first = page.locator('.activity-group[data-turn-id="first-turn"] [data-disclosure-row]')
const groups = page.locator('.activity-group [data-disclosure-row]')
async function until(predicate, message) {
  const deadline = Date.now() + 8000
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(message || 'State did not settle'); await page.waitForTimeout(20) }
}
async function setting(value) {
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: '常规', exact: true }).click()
  const select = page.getByLabel('工作步骤收起时机', { exact: true })
  if (value) {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/preferences' && response.request().method() === 'POST')
    await select.selectOption(value)
    assert.equal((await (await response).json()).preferences.activityCollapseTiming, value)
  } else assert.equal(await select.inputValue(), 'next-input')
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await page.locator('.settings-dialog[open]').waitFor({ state: 'hidden' })
}
try {
  await page.goto(base); await page.getByRole('button', { name: /工作步骤收起验证/ }).first().click()
  await first.waitFor(); await setting()
  assert.equal(await first.getAttribute('aria-expanded'), 'true', 'The latest completed round stays visible by default')
  assert.equal(await page.locator('details[data-activity-id="first-reason"]').evaluate(node => node.open), true)
  assert.equal(await page.locator('.activity-group details[open]').count(), 0, 'Expanded steps must not expand raw command output')
  await page.locator('.agent-message pre').filter({ hasText: 'const done = true' }).waitFor()

  await input.fill('等待第二轮'); await input.press('Enter')
  await until(() => Boolean(bridge.threads.get(id)?.turnId), 'The next native turn did not start')
  await until(async () => await first.getAttribute('aria-expanded') === 'false', 'A new user round did not fold the previous steps')
  await first.click(); assert.equal(await first.getAttribute('aria-expanded'), 'true')
  await rpc.call('test/finish', { threadId: id })
  await until(() => !bridge.threads.get(id)?.turnId)
  assert.equal(await first.getAttribute('aria-expanded'), 'true', 'Explicit history expansion must survive later completion')

  await setting('completion')
  await input.fill('排版测试'); await input.press('Enter')
  await until(async () => await groups.count() === 2)
  await until(() => !bridge.threads.get(id)?.turnId)
  assert.equal(await groups.last().getAttribute('aria-expanded'), 'false', 'Completion mode must fold finished steps')
  await page.locator('.agent-message pre').filter({ hasText: 'const formula' }).waitFor()
  await page.reload(); await first.waitFor()
  assert.equal(await groups.last().getAttribute('aria-expanded'), 'false', 'The saved completion policy must survive refresh')

  await setting('never')
  await until(async () => (await groups.evaluateAll(nodes => nodes.every(node => node.getAttribute('aria-expanded') === 'true'))))
  await input.fill('排版测试'); await input.press('Enter')
  await until(async () => await groups.count() === 3)
  await until(() => !bridge.threads.get(id)?.turnId)
  assert.equal(await groups.last().getAttribute('aria-expanded'), 'true', 'Never mode must keep completed steps open')
  await page.screenshot({ path: resolve(output, 'activity-collapse-never.png'), fullPage: true })

  await setting('next-input')
  await until(async () => await groups.first().getAttribute('aria-expanded') === 'false' && await groups.last().getAttribute('aria-expanded') === 'true')
  await first.click(); assert.equal(await first.getAttribute('aria-expanded'), 'true')
  await input.fill('等待第三轮'); await input.press('Enter')
  await until(() => Boolean(bridge.threads.get(id)?.turnId))
  await until(async () => await groups.last().getAttribute('aria-expanded') === 'false')
  assert.equal(await first.getAttribute('aria-expanded'), 'true', 'A manual history expansion must remain open when new input arrives')
  await rpc.call('test/finish', { threadId: id }); await until(() => !bridge.threads.get(id)?.turnId)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ defaultNextInput: true, completion: true, never: true, persisted: true, manualHistoryOverride: true, rawCommandsCollapsed: true, finalCodeVisible: true, pageErrors: errors }))
} catch (error) { await page.screenshot({ path: resolve(output, 'activity-collapse-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
