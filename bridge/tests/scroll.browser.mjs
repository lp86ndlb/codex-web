import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

// Exercise real Edge scrolling on a history larger than the rendering window.
const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'scroll-')); const cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const id = randomUUID()
const items = Array.from({ length: 130 }, (_, i) => i % 2 ? {
  id: `message-${i}`, type: 'agentMessage', phase: 'final_answer',
  text: `### 第 ${Math.ceil(i / 2)} 轮处理结果\n\n` + '这一段用于检验不同高度消息的滚动边界，以及向上阅读时的位置稳定性。\n\n'.repeat(i % 7 + 1),
} : { id: `message-${i}`, type: 'userMessage', content: [{ type: 'text', text: `第 ${i / 2 + 1} 条提问：检查滚动范围和消息定位。` }] })
const store = resolve(root, 'sessions.json')
await writeFile(store, JSON.stringify({ [id]: { id, name: '滚动边界验证', preview: '', cwd, updatedAt: Date.now() / 1000, turns: [{ id: 'history', status: 'completed', items }] } }))
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: store } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'codex-home'))
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old', '--hide-scrollbars'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' }); const errors = []
page.on('pageerror', error => errors.push(error.message))
const metrics = () => page.locator('.conversation').evaluate(node => ({ top: node.scrollTop, height: node.clientHeight, total: node.scrollHeight, gap: node.scrollHeight - node.clientHeight - node.scrollTop, bottom: node.getBoundingClientRect().bottom, last: node.querySelector('.transcript')?.lastElementChild?.getBoundingClientRect().bottom, bodyOverflow: document.body.scrollHeight - innerHeight }))
async function bottom() {
  for (let i = 0; i < 100; i++) {
    if ((await metrics()).gap < 3) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`Scrollbar did not reach the bottom: ${JSON.stringify(await metrics())}`)
}
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  await page.getByRole('button', { name: /滚动边界验证/ }).first().click()
  await page.locator('.turn-end').waitFor(); await bottom()
  await page.evaluate(() => document.fonts.ready)
  const initial = await metrics()
  assert.ok(initial.gap < 3 && initial.bodyOverflow === 0, JSON.stringify(initial))
  assert.equal(initial.bottom, 900, 'The actual scrollbar track must reach the window bottom beside the sticky composer')
  assert.ok(initial.last <= initial.bottom, 'Last transcript row must be reachable above the composer')
  assert.equal(await page.locator('.transcript > article').first().evaluate(node => getComputedStyle(node).contentVisibility), 'visible')
  assert.ok(await page.locator('.transcript > article').count() <= 60)

  // Go up, then drag the real scrollbar to its physical lower end.
  const box = await page.locator('.conversation').boundingBox()
  await page.mouse.move(box.x + 80, box.y + 120); await page.mouse.wheel(0, -1600)
  await page.getByRole('button', { name: '回到底部', exact: true }).waitFor()
  const middle = await metrics(); assert.equal(middle.total, initial.total, 'Offscreen row estimates must not change the scroll range')
  const thumbHeight = Math.max(18, box.height * box.height / middle.total)
  const thumbY = box.y + middle.top / (middle.total - middle.height) * (box.height - thumbHeight) + thumbHeight / 2
  await page.mouse.move(box.x + box.width - 5, thumbY); await page.mouse.down()
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 2, { steps: 12 }); await page.mouse.up()
  await bottom()
  await rpc.call('test/append', { threadId: id, text: '拖动到底后继续输出。\n\n'.repeat(20) }); await bottom()

  // New messages must not evict the first visible row while reading history.
  await page.mouse.move(box.x + 80, box.y + 120); await page.mouse.wheel(0, -1100)
  await page.getByRole('button', { name: '回到底部', exact: true }).waitFor()
  await page.locator('.conversation').evaluate(async node => {
    let top = node.scrollTop, stable = 0
    for (let frame = 0; frame < 60 && stable < 4; frame++) {
      await new Promise(requestAnimationFrame)
      const next = node.scrollTop; stable = Math.abs(next - top) < 1 ? stable + 1 : 0; top = next
    }
  })
  const input = page.getByLabel('发送给 Codex 的消息', { exact: true })
  const beforeInputFocus = (await metrics()).top
  await input.click()
  const typingStart = await metrics(), typingPositions = []
  assert.ok(Math.abs(typingStart.top - beforeInputFocus) < 3, `Focusing the sticky input moved the reading position: ${beforeInputFocus} -> ${typingStart.top}`)
  for (const character of '逐字输入保持阅读位置 abcdef') {
    await input.pressSequentially(character)
    await page.waitForTimeout(20)
    typingPositions.push((await metrics()).top)
  }
  assert.ok(typingPositions.every(top => Math.abs(top - typingStart.top) < 3), `Typing moved the paused conversation: ${JSON.stringify({ start: typingStart.top, positions: typingPositions, padding: await page.locator('.conversation').evaluate(node => getComputedStyle(node).scrollPaddingBottom) })}`)
  await input.fill('增加一行草稿也不该移动历史内容\n'.repeat(5)); await page.waitForTimeout(50)
  assert.ok(Math.abs((await metrics()).top - typingStart.top) < 3, 'Growing the draft moved the reading position')
  await input.fill('')
  const reading = await page.locator('.conversation').evaluate(node => ({ top: node.scrollTop, first: node.querySelector('article')?.textContent }))
  await rpc.call('test/append', { threadId: id, text: '阅读历史期间补充的新消息。\n\n'.repeat(20) })
  await page.locator('.agent-commentary').filter({ hasText: '阅读历史期间补充的新消息' }).waitFor({ state: 'attached' })
  assert.equal(await page.getByRole('button', { name: /显示较新的消息/ }).count(), 0, 'New output should already be rendered without a refresh')
  const unchanged = await page.locator('.conversation').evaluate(node => ({ top: node.scrollTop, first: node.querySelector('article')?.textContent }))
  assert.equal(unchanged.first, reading.first); assert.ok(Math.abs(unchanged.top - reading.top) < 3, JSON.stringify({ reading, unchanged }))
  await page.locator('.conversation').focus(); await page.keyboard.press('End'); await bottom()
  await page.locator('.agent-commentary').filter({ hasText: '阅读历史期间补充的新消息' }).waitFor()

  // The DSH-style rail must load a prompt outside the current 60-message window.
  await page.getByRole('navigation', { name: '对话回溯', exact: true }).hover()
  await page.locator('.turn-navigator-scroll').evaluate(async node => {
    node.scrollTop = 0
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)
  })
  await page.getByRole('button', { name: '定位第 1 条提问', exact: true }).hover()
  await page.getByRole('tooltip').filter({ hasText: '第 1 条提问' }).waitFor()
  await page.getByRole('button', { name: '定位第 1 条提问', exact: true }).click()
  await page.locator('.user-message').filter({ hasText: '第 1 条提问：' }).waitFor()
  assert.ok(await page.locator('.transcript > article').count() <= 60)
  const promptPosition = await page.locator('[data-message-id="message-0"]').boundingBox()
  assert.ok(Math.abs(promptPosition.y - box.y) < 35, JSON.stringify(promptPosition))
  await page.screenshot({ path: resolve(output, 'turn-history-rail.png'), fullPage: true })
  await page.getByRole('button', { name: '回到底部', exact: true }).click(); await bottom()
  await page.locator('.agent-commentary').filter({ hasText: '阅读历史期间补充的新消息' }).waitFor()

  await input.fill(''); await input.press('Shift+ArrowLeft'); await page.locator('[data-message-id="message-128"].jump-highlight').waitFor()
  await input.press('Shift+ArrowLeft'); await page.locator('[data-message-id="message-126"].jump-highlight').waitFor()
  await input.press('Shift+ArrowRight'); await page.locator('[data-message-id="message-128"].jump-highlight').waitFor()
  await input.press('Shift+ArrowRight'); await bottom()
  await input.fill('保留文字'); await input.press('End'); await input.press('Shift+ArrowLeft')
  assert.equal(await input.evaluate(node => node.selectionEnd - node.selectionStart), 1, 'Text selection must retain its native Shift+Left behavior')
  await input.fill('')

  // Reproduce the race: a stale bottom scroll event arrives after the upward
  // wheel gesture but before the browser applies its default scrolling.
  const bottomTop = (await metrics()).top
  await page.locator('.conversation').evaluate(node => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })); node.dispatchEvent(new Event('scroll')); node.scrollTop -= 160 })
  await page.waitForTimeout(100)
  assert.ok((await metrics()).top <= bottomTop - 150, 'A stale bottom event must not pull an upward gesture back down')
  const heldTop = (await metrics()).top
  for (let i = 0; i < 3; i++) await rpc.call('test/append', { threadId: id, text: `上滚期间的增量消息 ${i}。\n\n`.repeat(10) })
  await page.waitForTimeout(120)
  assert.ok(Math.abs((await metrics()).top - heldTop) < 3, 'Streaming must not steal the reading position')
  await page.getByRole('button', { name: '回到底部', exact: true }).click(); await bottom()
  await input.click(); await input.fill('草稿编辑不应中断自动跟随')
  await rpc.call('test/append', { threadId: id, text: '编辑草稿期间的新输出。\n\n'.repeat(10) }); await bottom()
  await input.fill(''); await bottom()

  // Foreground completion must notify too, and the final settlement must sit
  // close to the composer rather than accumulating three bottom spacings.
  await bridge.message(id, { text: '检查完成提示和间距', mode: 'read-only' })
  await page.locator('.thread-notice.notice-completed').filter({ hasText: '滚动边界验证' }).waitFor()
  await bottom()
  const endGap = await page.evaluate(() => document.querySelector('.composer').getBoundingClientRect().top - document.querySelector('.run-summary.turn-end').getBoundingClientRect().bottom)
  assert.ok(endGap >= 8 && endGap <= 24, `Extra settlement/composer gap: ${endGap}`)
  await page.getByLabel('发送给 Codex 的消息', { exact: true }).fill('输入框高度变化时也要保持位置\n'.repeat(5))
  await bottom()
  assert.ok((await page.locator('.composer').boundingBox()).y > 64)
  await page.getByLabel('发送给 Codex 的消息', { exact: true }).fill(''); await bottom()

  // Bottom-left quota is a light-dismiss, anchored popover, independent of settings.
  await page.getByRole('button', { name: '查看额度', exact: true }).click()
  const usage = page.getByRole('dialog', { name: '账户额度', exact: true })
  await usage.getByRole('progressbar', { name: '5 小时额度', exact: true }).waitFor()
  assert.equal(await usage.getByRole('progressbar', { name: '5 小时额度', exact: true }).getAttribute('aria-valuenow'), '65')
  const anchor = await page.getByRole('button', { name: '查看额度', exact: true }).boundingBox(); const popup = await usage.boundingBox()
  assert.ok(popup.x >= 0 && popup.y >= 0 && popup.x + popup.width <= 1366 && Math.abs(popup.x - anchor.x) < 20 && popup.y + popup.height < anchor.y)
  await page.screenshot({ path: resolve(output, 'quota-popover.png'), fullPage: true })
  await page.keyboard.press('Escape'); await usage.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '查看额度', exact: true }).click(); await usage.waitFor()
  await page.locator('.topbar .breadcrumb').click(); await usage.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '连接与设置', exact: true }).locator('.lucide-settings').count(), 1)
  await page.screenshot({ path: resolve(output, 'scroll-bottom.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log('Edge long-history checks passed: stable heights, native scrollbar reaches bottom, streamed follow, paused reading, history-window preservation, turn rail and anchored quota popover.')
} catch (error) {
  console.log(JSON.stringify({ errors, metrics: await metrics().catch(() => null) }))
  await page.screenshot({ path: resolve(output, 'scroll-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
