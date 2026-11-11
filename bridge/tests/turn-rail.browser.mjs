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
const root = await mkdtemp(resolve(output, 'turn-rail-')), cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const store = resolve(root, 'sessions.json')
function session(name, count, paragraphs = 6) {
  const id = randomUUID()
  return { id, name, preview: '', cwd, updatedAt: Date.now() / 1000, turns: Array.from({ length: count }, (_, index) => ({
    id: `${name}-turn-${index + 1}`, status: 'completed', items: [
      { id: `${name}-user-${index + 1}`, type: 'userMessage', content: [{ type: 'text', text: `${name}问题 ${index + 1}` }] },
      { id: `${name}-answer-${index + 1}`, type: 'agentMessage', phase: 'final_answer', text: `第 ${index + 1} 题的演示回答。\n\n` + Array.from({ length: paragraphs }, () => '这段内容用于验证回溯位置，不包含真实项目或会话数据。').join('\n\n') },
    ],
  })) }
}
const short = session('短对话回溯', 2), long = session('长对话回溯', 100)
const sparse = session('长步骤回溯', 2)
for (const turn of sparse.turns) turn.items.splice(1, 0, ...Array.from({ length: 80 }, (_, index) => ({ id: `${turn.id}-detail-${index}`, type: 'agentMessage', phase: 'commentary', text: `正在检查演示步骤 ${index + 1}。\n\n` + '只读检查项目结构与文件。'.repeat(5) })))
await writeFile(store, JSON.stringify(Object.fromEntries([short, long, sparse].map(row => [row.id, row]))))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), errors = []
page.on('pageerror', error => errors.push(error.message))
const rail = page.getByRole('navigation', { name: '对话回溯', exact: true })
const list = rail.locator('.turn-navigator-scroll'), conversation = page.getByLabel('会话内容', { exact: true })
const mark = index => rail.getByRole('button', { name: `定位第 ${index} 条提问`, exact: true })
async function until(check, description) {
  for (let i = 0; i < 120; i++) { if (await check()) return; await page.waitForTimeout(25) }
  assert.fail(description)
}
async function active(index) { await until(async () => await mark(index).getAttribute('aria-current') === 'true', `Expected active topic ${index}`) }
async function visible(index) {
  await until(async () => {
    const a = await mark(index).boundingBox(), b = await list.boundingBox()
    return a && b && a.y >= b.y && a.y + a.height <= b.y + b.height
  }, `Active mark ${index} was not revealed in its own rail`)
}
async function choose(session) {
  await page.locator(`[data-thread-id="${session.id}"]`).click()
  await rail.waitFor(); await active(session.turns.length)
}
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  await choose(short)
  const position = await rail.evaluate(node => ({ bottom: node.getBoundingClientRect().bottom, height: node.getBoundingClientRect().height, dock: document.querySelector('.composer-dock').getBoundingClientRect().top }))
  assert.ok(Math.abs(position.dock - position.bottom - 16) < 2, JSON.stringify(position))
  assert.ok(position.height < 50, JSON.stringify(position))
  await page.screenshot({ path: resolve(output, 'turn-rail-short.png'), fullPage: true })

  await choose(long); await visible(100)
  assert.ok(await list.evaluate(node => node.scrollTop > 0), 'A long rail must open at its current topic, not its first mark')
  await conversation.evaluate(node => {
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }))
    const target = node.querySelector('.user-message[data-message-id="长对话回溯-user-90"]')
    const line = (node.clientHeight - (node.parentElement?.querySelector('.composer-dock')?.getBoundingClientRect().height || 0)) * .3
    node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top - line + 2
  })
  await active(90); await visible(90)
  await page.screenshot({ path: resolve(output, 'turn-rail-current.png'), fullPage: true })

  // Jump into an old pagination window. Its bottom is not the end of the
  // complete conversation and must not select the 100th topic.
  await mark(10).click(); await active(10)
  await conversation.evaluate(node => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })); node.scrollTop = node.scrollHeight })
  await active(30)
  await page.getByRole('button', { name: '回到底部', exact: true }).click(); await active(100); await visible(100)

  const before = await conversation.evaluate(node => node.scrollTop)
  await list.evaluate(node => { node.scrollTop = 0 })
  await mark(1).hover(); await page.getByRole('tooltip').waitFor()
  const preview = await page.getByRole('tooltip').boundingBox(), stage = await page.locator('.conversation-stage').boundingBox(), dock = await page.locator('.composer-dock').boundingBox()
  assert.ok(preview.y >= stage.y && preview.y + preview.height <= dock.y, JSON.stringify({ preview, stage, dock }))
  assert.ok(Math.abs(await conversation.evaluate(node => node.scrollTop) - before) < 1, 'Browsing rail marks must not move the conversation')
  await page.screenshot({ path: resolve(output, 'turn-rail-tooltip.png'), fullPage: true })
  await page.mouse.move(400, 100); await visible(100)

  // The latest prompt can precede the 60 rendered items. Boundary metadata
  // still identifies the topic when no user bubble exists in the DOM window.
  await choose(sparse)
  assert.equal(await page.locator('.transcript .user-message').count(), 0)
  await conversation.evaluate(node => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true })); node.scrollTop = 100 })
  await active(2)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ bottomAnchored: true, longRailCurrentRevealed: true, followsReadingPosition: true, pagedWindowBottom: true, jumpLatest: true, railDoesNotScrollChat: true, tooltipWithinConversation: true, absentPromptInRenderedWindow: true, pageErrors: errors }))
} catch (error) { await page.screenshot({ path: resolve(output, 'turn-rail-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
