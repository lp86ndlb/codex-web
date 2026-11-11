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
const id = randomUUID(), groupedId = randomUUID(), runningId = randomUUID(), store = resolve(root, 'sessions.json')
const nativeSteps = [
  { id: 'native-subagent', type: 'subAgentActivity', status: 'completed', detail: 'Keep raw English: Synthetic subagent output' },
  { id: 'native-search', type: 'webSearch', status: 'completed', query: 'Synthetic English search query' },
  { id: 'native-image', type: 'imageView', status: 'completed', path: '/synthetic/image.png' },
]
const histories = { [id]: { id, name: '工作步骤收起验证', preview: '', cwd, updatedAt: Date.now() / 1000, turns: [{ id: 'first-turn', status: 'completed', items: [
  { id: 'first-user', type: 'userMessage', content: [{ type: 'text', text: '首轮检查项目' }] },
  { id: 'first-reason', type: 'reasoning', summary: ['先检查结构，再核对类型。'], content: [] },
  { id: 'first-commentary', type: 'agentMessage', phase: 'commentary', text: '正在核对 Synthetic fixture 的项目结构。' },
  { id: 'first-tool', type: 'commandExecution', command: 'cat README.md', status: 'completed', aggregatedOutput: '原始内容按需查看', exitCode: 0 },
  { id: 'second-tool', type: 'commandExecution', command: 'npm run check', status: 'completed', aggregatedOutput: '检查通过', exitCode: 0 },
  ...nativeSteps,
  { id: 'first-answer', type: 'agentMessage', phase: 'final_answer', text: '首轮回答已完成。\n\n```js\nconst done = true\n```' },
] }] } }
const tool = (id, status = 'completed') => ({ id, type: 'commandExecution', command: 'printf fixture', status, aggregatedOutput: 'Synthetic output', exitCode: status === 'completed' ? 0 : null })
const user = id => ({ id, type: 'userMessage', content: [{ type: 'text', text: id }] })
// These small invented histories reproduce the real shapes: failed historical
// runs and multiple delivered human messages inside one native Codex turn.
histories[groupedId] = { id: groupedId, name: '同轮多次提问验证', cwd, updatedAt: Date.now() / 1000, turns: [
  { id: 'old-failed', status: 'failed', items: [user('failed-user'), tool('failed-step', 'failed')] },
  { id: 'old-interrupted', status: 'interrupted', items: [user('interrupted-user'), tool('interrupted-step')] },
  { id: 'shared-turn', status: 'completed', items: [
    user('segment-one'), { id: 'segment-one-reason', type: 'reasoning', summary: ['First segment summary'], content: [] }, tool('segment-one-step'),
    user('segment-two'), tool('segment-two-step'),
    user('segment-three'), tool('latest-step'),
    { id: 'latest-answer', type: 'agentMessage', phase: 'final_answer', text: '最新提问的回答。' },
  ] },
] }
histories[runningId] = { id: runningId, name: '插话运行步骤验证', cwd, updatedAt: Date.now() / 1000, turns: [
  { id: 'running-shared-turn', status: 'inProgress', items: [
    user('running-first'), tool('mixed-done'), tool('mixed-working', 'inProgress'),
    user('running-follow-up'), tool('current-step'),
  ] },
] }
await writeFile(store, JSON.stringify(histories))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
await bridge.preferences.update({ effort: 'ultra' })
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
  assert.equal(await page.getByRole('combobox', { name: '推理强度', exact: true }).textContent(), '极致', 'The composer must localize ultra without changing its protocol value')
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: '模型与权限', exact: true }).click()
  for (const label of ['默认推理强度', '当前会话推理强度']) {
    const effort = page.getByLabel(label, { exact: true })
    assert.equal(await effort.inputValue(), 'ultra')
    assert.equal(await effort.locator('option:checked').textContent(), '极致', 'Settings and composer must use the same visible effort label')
  }
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await page.locator('.settings-dialog[open]').waitFor({ state: 'hidden' })
  assert.equal((await (await page.request.get(`${base}/api/preferences`)).json()).preferences.effort, 'ultra')
  assert.equal(await first.getAttribute('aria-expanded'), 'true', 'The latest completed round stays visible by default')
  const firstReason = page.locator('details[data-activity-id="first-reason"]')
  assert.equal(await firstReason.evaluate(node => node.open), false, 'An expanded outer process must keep raw reasoning closed')
  assert.equal(await firstReason.locator('.markdown').count(), 0, 'Closed raw reasoning must not mount Markdown')
  assert.equal(await page.locator('.activity-group details[open]').count(), 0, 'Expanded steps must not expand raw command output')
  await page.locator('.agent-message pre').filter({ hasText: 'const done = true' }).waitFor()
  const firstGroup = page.locator('.activity-group[data-activity-id="first-reason"]')
  const subagent = firstGroup.locator('details[data-activity-id="native-subagent"]')
  const commentary = firstGroup.locator('.agent-commentary[data-message-id="first-commentary"]')
  assert.equal(await page.locator('.activity-group[data-turn-id="first-turn"]').count(), 1, 'Native activities and commands in the same message segment belong to one step group')
  assert.equal(await commentary.count(), 1, 'Commentary belongs to the complete outer process group')
  assert.ok((await commentary.textContent()).includes('Synthetic fixture'))
  for (const native of nativeSteps) assert.equal(await firstGroup.locator(`details[data-activity-id="${native.id}"]`).count(), 1)
  assert.equal(await subagent.locator('summary').textContent(), '子代理活动')
  assert.equal(await firstGroup.locator('details[data-activity-id="native-search"] summary').textContent(), '搜索网页')
  assert.equal(await firstGroup.locator('details[data-activity-id="native-image"] summary').textContent(), '查看图片')
  assert.equal(await subagent.locator('.markdown').count(), 0, 'A closed native detail must not parse its raw JSON')
  assert.equal(await firstGroup.locator('.tool-output').count(), 0, 'Command bodies load only when their own detail is opened')

  await input.fill('等待第二轮'); await input.press('Enter')
  await until(() => Boolean(bridge.threads.get(id)?.turnId), 'The next native turn did not start')
  await until(async () => await first.getAttribute('aria-expanded') === 'false', 'A new user round did not fold the previous steps')
  await until(async () => await firstGroup.locator('.activity-group-body').count() === 0, 'The old process body was hidden instead of unmounted')
  assert.equal(await firstReason.count(), 0)
  assert.equal(await commentary.count(), 0)
  assert.equal(await subagent.count(), 0, 'All native rows must unload with the collapsed outer process')
  assert.equal(await page.locator('.agent-message[data-message-id="first-answer"]').count(), 1, 'The final answer stays visible after its process unloads')
  await first.click(); assert.equal(await first.getAttribute('aria-expanded'), 'true')
  await subagent.locator('summary').waitFor()
  assert.equal(await commentary.count(), 1)
  assert.equal(await firstReason.evaluate(node => node.open), false)
  assert.equal(await firstReason.locator('.markdown').count(), 0)
  await subagent.locator('summary').click()
  assert.equal(await subagent.evaluate(node => node.open), true)
  assert.ok((await subagent.innerText()).includes('"type": "subAgentActivity"'), 'Raw protocol identifiers must remain intact in expanded details')
  assert.ok((await subagent.innerText()).includes(nativeSteps[0].detail), 'Raw English tool content must not be translated')
  for (const native of nativeSteps) assert.equal(bridge.threads.get(id).items.find(item => item.id === native.id).text, JSON.stringify(native, null, 2))
  const firstCommand = firstGroup.locator('details.tool-card').filter({ has: page.locator('.tool-description') }).first()
  await firstCommand.locator('summary').click()
  assert.equal(await firstCommand.locator('.full-command').textContent(), '$ cat README.md', 'Command source must remain intact')
  assert.equal(await firstCommand.locator('.tool-output pre').textContent(), '原始内容按需查看')
  await firstCommand.locator('summary').click(); await subagent.locator('summary').click()
  await until(async () => await firstCommand.locator('.tool-output').count() === 0 && await subagent.locator('.markdown').count() === 0, 'Closed leaf bodies did not unload')
  assert.equal(await firstCommand.locator('summary').count(), 1, 'Native detail summaries remain mounted after closing')
  await rpc.call('test/finish', { threadId: id })
  await until(() => !bridge.threads.get(id)?.turnId)
  assert.equal(await first.getAttribute('aria-expanded'), 'true', 'Explicit history expansion must survive later completion')

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  assert.equal(await page.locator('html').getAttribute('data-animations'), 'true')
  await first.click()
  assert.equal(await first.getAttribute('aria-expanded'), 'false')
  assert.equal(await firstGroup.locator('.activity-group-body').count(), 1, 'Closing must retain the body throughout its exit animation')
  await first.click()
  assert.equal(await first.getAttribute('aria-expanded'), 'true')
  await page.waitForTimeout(450)
  assert.equal(await firstGroup.locator('.activity-group-body').count(), 1, 'A quick reopen must cancel the previous delayed unmount')
  assert.equal(await commentary.count(), 1)
  await first.click()
  await until(async () => await firstGroup.locator('.activity-group-body').count() === 0, 'An animated close must eventually release its contents')
  assert.equal(await first.getAttribute('aria-expanded'), 'false')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await first.click()
  await subagent.locator('summary').waitFor()

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
  await page.getByRole('button', { name: /同轮多次提问验证/ }).first().click()
  const activity = itemId => page.locator(`.activity-group[data-activity-id="${itemId}"] [data-disclosure-row]`)
  await activity('latest-step').waitFor()
  for (const step of ['failed-step', 'interrupted-step', 'segment-one-reason', 'segment-two-step']) assert.equal(await activity(step).getAttribute('aria-expanded'), 'false', `Historical segment ${step} stayed open`)
  assert.equal(await activity('latest-step').getAttribute('aria-expanded'), 'true')
  assert.equal(await page.locator('details[data-activity-id="segment-one-reason"]').count(), 0, 'The old segment must not mount raw reasoning before expansion')
  await activity('segment-one-reason').click()
  const oldReason = page.locator('details[data-activity-id="segment-one-reason"]')
  assert.equal(await oldReason.evaluate(node => node.open), false)
  assert.equal(await oldReason.locator('.markdown').count(), 0)
  await page.reload(); await activity('latest-step').waitFor()
  for (const step of ['failed-step', 'interrupted-step', 'segment-one-reason', 'segment-two-step']) assert.equal(await activity(step).getAttribute('aria-expanded'), 'false', `Reload reopened ${step}`)
  assert.equal(await oldReason.count(), 0, 'A refresh must restore the collapsed lazy history policy')
  await page.screenshot({ path: resolve(output, 'activity-collapse-same-turn-history.png'), fullPage: true })

  // A history-only read intentionally clears turnId. Activate this native
  // fixture first so the view represents a genuinely managed running turn.
  await bridge.open(runningId, true)
  await page.getByRole('button', { name: /插话运行步骤验证/ }).first().click()
  await activity('mixed-done').waitFor()
  assert.equal(await activity('mixed-done').getAttribute('aria-expanded'), 'true', 'A running member after a completed first row must keep the whole step group visible')
  assert.equal(await activity('current-step').getAttribute('aria-expanded'), 'true')
  assert.equal(await page.locator('.activity-group details[open]').count(), 0)
  await page.screenshot({ path: resolve(output, 'activity-collapse-steering-running.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ defaultNextInput: true, completion: true, never: true, persisted: true, manualHistoryOverride: true, rawCommandsCollapsed: true, finalCodeVisible: true, completeProcessGrouped: true, outerBodyLazy: true, leafBodiesLazy: true, animatedExitRetained: true, quickReopenRetained: true, nativeActivitiesGrouped: true, nativeHeadingsLocalized: true, rawProtocolIntact: true, effortLocalized: true, sameTurnSegments: true, historicalFailuresFolded: true, mixedRunningGroupVisible: true, pageErrors: errors }))
} catch (error) { await page.screenshot({ path: resolve(output, 'activity-collapse-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
