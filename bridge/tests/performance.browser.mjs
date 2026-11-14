import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'performance-')), cwd = resolve(root, 'project'); await mkdir(cwd)
const baseline = process.env.CWEB_PERF_BASELINE === '1', store = resolve(root, 'sessions.json')
const records = Object.fromEntries(Array.from({ length: 65 }, (_, index) => {
  const id = `performance-${index}`, turn = `turn-${index}`
  return [id, { id, name: `性能测试 ${String(index).padStart(2, '0')}`, cwd, updatedAt: 1700000000 + index, turns: [{ id: turn, status: 'completed', items: [
    { id: `user-${index}`, type: 'userMessage', content: [{ type: 'text', text: `检查问题 ${index}` }] },
    ...Array.from({ length: index === 0 ? 220 : 60 }, (_, step) => ({ id: `tool-${index}-${step}`, type: 'commandExecution', command: 'printf synthetic-check', status: 'completed', exitCode: 0, aggregatedOutput: `synthetic output ${index} ${step}\n`.repeat(60) })),
    { id: `answer-${index}`, type: 'agentMessage', phase: 'final_answer', text: `测试回答 ${index}\n\n- 保留原有功能\n- 验证缓存与输入性能` },
  ] }] }]
}))
await writeFile(store, JSON.stringify(records))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
for (let i = 0; i <= 20; i++) await bridge.open(`performance-${i}`)
await new Promise(resolve => setTimeout(resolve, 1200))
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }), errors = [], reads = []
const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable')
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(row => [row.name, row.value]))
page.on('pageerror', e => errors.push(e.message))
page.on('request', r => { if (/\/api\/threads\/[^/?]+(?:\/snapshot)?$/.test(new URL(r.url()).pathname) && r.method() === 'GET') reads.push(new URL(r.url()).pathname) })
await page.addInitScript(() => localStorage.setItem('cweb:thread', 'performance-0'))
const input = page.locator('.composer textarea'), conversation = page.getByLabel('会话内容', { exact: true })
try {
  const start = Date.now(); await page.goto(`http://127.0.0.1:${app.server.address().port}`); await page.locator('[data-message-id="answer-0"]').waitFor()
  const readyMs = Date.now() - start; await page.waitForTimeout(300)
  await input.fill(''); await input.focus(); await page.waitForTimeout(150)
  const before = await metrics(), text = 'performance typing sample '.repeat(5)
  await input.pressSequentially(text, { delay: 8 }); const typed = await metrics()
  assert.equal(await input.inputValue(), text)
  await input.fill('一行\n'.repeat(40)); assert.ok((await input.boundingBox()).height <= 301)
  await input.fill('保留当前话题的草稿'); assert.ok((await input.boundingBox()).height < 100)
  await page.setViewportSize({ width: 1000, height: 900 }); await page.waitForTimeout(80)
  assert.equal(await input.inputValue(), '保留当前话题的草稿')
  await page.setViewportSize({ width: 1440, height: 1000 })
  const count = reads.length
  for (let i = 1; i <= 20; i++) await rpc.call('test/append', { threadId: `performance-${i}`, text: '后台补充内容', phase: 'final_answer' })
  await page.waitForTimeout(1700)
  const backgroundReads = reads.length - count
  if (!baseline) assert.equal(backgroundReads, 0, 'Background output fetched complete thread snapshots')
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').filter(r => r.initiatorType === 'script').map(r => ({ file: r.name.split('/').pop(), bytes: r.decodedBodySize })))
  const result = { readyMs, typedCharacters: text.length, typingTaskMs: 1000 * (typed.TaskDuration - before.TaskDuration), typingScriptMs: 1000 * (typed.ScriptDuration - before.ScriptDuration), layouts: typed.LayoutCount - before.LayoutCount, styleRecalculations: typed.RecalcStyleCount - before.RecalcStyleCount, backgroundReads, resources }
  if (!baseline) {
    // A narrow reading viewport must remain still while the draft changes.
    await conversation.evaluate(node => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); node.scrollTop = 400 })
    const top = await conversation.evaluate(node => node.scrollTop)
    await input.pressSequentially('继续输入'); await page.waitForTimeout(100)
    assert.ok(Math.abs(await conversation.evaluate(node => node.scrollTop) - top) < 3)
    const draft = await input.inputValue()
    await input.press('Control+Alt+k')
    const palette = page.getByRole('dialog', { name: '快速切换会话', exact: true }), search = palette.getByRole('combobox')
    await palette.waitFor(); assert.equal(await palette.getByRole('option').count(), 40)
    await search.press('PageDown'); assert.equal(await palette.getByRole('option').count(), 25)
    await search.fill('性能测试 19'); assert.equal(await palette.getByRole('option').count(), 1)
    await page.screenshot({ path: resolve(output, 'performance-switcher.png'), fullPage: true })
    await search.press('Enter'); await page.locator('[data-message-id="answer-19"]').waitFor()
    await page.locator('.agent-message').filter({ hasText: '后台补充内容' }).waitFor()
    await input.press('Control+Alt+k'); await search.fill('性能测试 00'); await search.press('Enter'); await page.locator('[data-message-id="answer-0"]').waitFor()
    assert.equal(await input.inputValue(), draft)
    await input.press('Control+Shift+p')
    await page.getByRole('combobox', { name: '搜索命令…', exact: true }).fill('查找会话')
    await page.getByRole('combobox', { name: '搜索命令…', exact: true }).press('Enter')
    await palette.waitFor(); assert.equal(await search.inputValue(), '', 'Changing palette modes retained the old command filter')
    const order = await palette.getByRole('option').allTextContents()
    await rpc.call('test/append', { threadId: 'performance-9', text: '菜单打开期间的背景更新', phase: 'final_answer' })
    await page.waitForTimeout(1300)
    assert.deepEqual(await palette.getByRole('option').allTextContents(), order, 'Background updates moved keyboard targets in the open switcher')
    await search.press('Escape'); assert.equal(await input.inputValue(), draft)
    await page.setViewportSize({ width: 390, height: 844 }); await input.press('Control+Alt+k'); await palette.waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: resolve(output, 'performance-switcher-mobile.png'), fullPage: true })
    await search.press('Escape'); await page.setViewportSize({ width: 1440, height: 1000 })
    // Trigger an unvisited background question and follow its notice.
    await bridge.message('performance-21', { text: '选择框测试', mode: 'read-only' })
    const notice = page.locator('.thread-notice.notice-waiting').filter({ hasText: '性能测试 21' }); await notice.waitFor()
    await notice.getByRole('button', { name: '前往会话' }).click(); await page.getByRole('region', { name: 'Codex 需要你的选择' }).waitFor()
    await page.getByRole('radio', { name: '先解释', exact: true }).check(); await page.getByRole('button', { name: '提交回答', exact: true }).click()
    await page.getByRole('region', { name: 'Codex 需要你的选择' }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '连接与设置', exact: true }).click(); await page.getByRole('button', { name: '常规', exact: true }).waitFor()
    result.backgroundQuestionAndReply = true; result.draftPreserved = true; result.settingsLoaded = true
  }
  assert.deepEqual(errors, [])
  await writeFile(resolve(output, `performance-${baseline ? 'before' : 'after'}.json`), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
} catch (error) { await page.screenshot({ path: resolve(output, 'performance-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
