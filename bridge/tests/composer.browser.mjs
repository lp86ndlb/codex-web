import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'composer-')); const cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json') } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old', '--hide-scrollbars'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); const errors = []
await page.addInitScript(() => localStorage.setItem('cweb:loading-style', 'orbit'))
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`); await page.getByText('本地引擎已连接', { exact: true }).waitFor(); await page.locator('.workspace-card').first().click()
  await page.getByRole('heading', { name: /让想法/ }).waitFor()
  const input = page.getByLabel('发送给 Codex 的消息', { exact: true }); const add = page.getByRole('button', { name: '添加功能', exact: true })
  await input.fill('/')
  const menu = page.getByRole('region', { name: '快捷命令与 Skills', exact: true }); await menu.waitFor()
  const alignment = await menu.locator('.command-menu-row').evaluateAll(nodes => nodes.slice(0, 6).map(node => { const title = node.querySelector('strong').getBoundingClientRect(); const detail = node.querySelector('small').getBoundingClientRect(); return { title: title.x, detail: detail.x, direction: getComputedStyle(node).textAlign } }))
  assert.ok(alignment.every(row => Math.abs(row.title - row.detail) < 1 && row.direction === 'left'))
  assert.ok(Math.max(...alignment.map(row => row.title)) - Math.min(...alignment.map(row => row.title)) < 1)
  await page.screenshot({ path: resolve(output, 'commands-aligned.png'), fullPage: true }); await input.press('Escape')
  assert.equal(await page.locator('.model-select').evaluate(node => { const r=node.querySelector('svg').getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[role="combobox"]')===node }), true)
  await page.getByRole('combobox', { name: '模型', exact: true }).click(); await page.getByRole('option', { name: '测试备用模型', exact: true }).click()
  await page.getByRole('combobox', { name: '推理强度', exact: true }).click(); await page.getByRole('option', { name: '中', exact: true }).click()
  await input.fill('保留这段输入')
  await add.click(); await page.getByRole('menu', { name: '添加到会话', exact: true }).waitFor()
  const positions = await page.locator('.composer-toolbar').evaluate(node => [...node.querySelectorAll('.composer-add-trigger,.composer-options > .icon-button,.model-select,.effort-select,.permission-menu > summary,.send-button')].map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }))
  assert.ok(Math.max(...positions) - Math.min(...positions) < 3, JSON.stringify(positions))
  await page.screenshot({ path: resolve(output, 'composer-add-menu.png'), fullPage: true })
  await page.getByRole('menuitemcheckbox', { name: /Plan/ }).click(); await page.locator('.plan-mode-banner').waitFor(); assert.equal(await input.inputValue(), '保留这段输入')
  await add.click(); assert.equal(await page.getByRole('menuitemcheckbox', { name: /Plan/ }).getAttribute('aria-checked'), 'true')
  await page.getByRole('menuitemcheckbox', { name: /Plan/ }).click(); await page.locator('.plan-mode-banner').waitFor({ state: 'hidden' })
  await add.click(); await page.getByRole('menuitem', { name: /Skills/ }).click()
  const skills = page.getByRole('region', { name: '选择本轮 Skills', exact: true }); await skills.getByRole('checkbox', { name: 'fixture-skill', exact: true }).check()
  await skills.getByRole('checkbox', { name: 'genui', exact: true }).check(); await page.screenshot({ path: resolve(output, 'composer-add-skills.png'), fullPage: true })
  const genuiCheck = skills.getByRole('checkbox', { name: 'genui', exact: true }); await genuiCheck.focus(); await genuiCheck.press('Enter'); assert.equal(await genuiCheck.isChecked(), false); await genuiCheck.press('Enter'); assert.equal(await genuiCheck.isChecked(), true)
  assert.equal(await page.locator('.user-message').count(), 0, 'Selecting Skills must not submit the draft')
  await skills.getByRole('button', { name: /完成 · 2/ }).click(); assert.equal(await input.inputValue(), '保留这段输入'); assert.equal(await page.locator('.skill-chip').count(), 2)
  await page.getByRole('button', { name: '移除 Skill fixture-skill' }).click(); await page.getByRole('button', { name: '移除 Skill genui' }).click()
  await add.click(); await page.keyboard.press('Escape'); assert.equal(await add.getAttribute('aria-expanded'), 'false')
  await add.click(); await input.click(); assert.equal(await add.getAttribute('aria-expanded'), 'false')

  await input.fill('等待光条验证'); await input.press('Enter'); await page.locator('.composer[data-running]').waitFor()
  const primary = bridge.list()[0].id
  await bridge.plugin.call(primary, 'todo_note_update', { focus: { current: '验证当前任务脉冲' }, add_tasks: [{ title: '验证当前任务脉冲' }, { title: '验证脉冲随任务切换' }] })
  const working = page.locator('.dtn-card .dtn-task[data-working="true"][data-task-id]')
  await working.filter({ hasText: '验证当前任务脉冲' }).waitFor(); assert.equal(await working.count(), 1)
  assert.equal(await page.locator('.send-button .lucide-arrow-up').count(), 1); assert.equal(await page.locator('.send-button .lucide-loader-circle').count(), 0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const light = page.locator('.composer-run-light')
  // Poll through CDP evaluation: Playwright 1.48's waitForFunction uses eval,
  // which current Edge correctly rejects under the application's strict CSP.
  async function waitForOrbit(moving) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await light.evaluate(node => node.getAnimations().some(animation => animation.id === 'composer-orbit')) === moving) return
      await page.waitForTimeout(30)
    }
    assert.fail(`Composer orbit did not become ${moving ? 'active' : 'static'}`)
  }
  await waitForOrbit(true)
  const firstPosition = await light.evaluate(node => getComputedStyle(node).transform)
  await page.waitForTimeout(180)
  const secondPosition = await light.evaluate(node => getComputedStyle(node).transform); assert.notEqual(firstPosition, secondPosition)
  const orbit = await light.evaluate(node => {
    const animation = node.getAnimations().find(animation => animation.id === 'composer-orbit'); animation.pause()
    const box = node.parentElement.getBoundingClientRect(); const points = []; const extents = []
    const duration = Number(animation.effect.getTiming().duration)
    for (let i = 0; i < 64; i++) { animation.currentTime = i * duration / 64; const r = node.getBoundingClientRect(); points.push({ x: r.x + r.width / 2 - box.x, y: r.y + r.height / 2 - box.y }); extents.push({width:r.width,height:r.height}) }
    animation.currentTime = 2400; animation.play(); return { width: box.width, height: box.height, points, extents }
  })
  assert.ok(orbit.points.every(p => p.x >= -1 && p.x <= orbit.width + 1 && p.y >= -1 && p.y <= orbit.height + 1), JSON.stringify(orbit))
  assert.ok(Math.max(...orbit.points.map(p => p.x)) - Math.min(...orbit.points.map(p => p.x)) > orbit.width * .75)
  assert.ok(Math.max(...orbit.points.map(p => p.y)) - Math.min(...orbit.points.map(p => p.y)) > orbit.height * .8)
  assert.ok(orbit.extents.every(rect=>rect.height<orbit.height-12&&rect.width<orbit.width-12),'The running marker must never reach opposite edges at the same time')
  assert.equal(await working.evaluate(node => getComputedStyle(node, '::before').animationName), 'todo-working-breathe')
  assert.equal(await working.locator('.dtn-tick').evaluate(node => getComputedStyle(node, '::before').animationName), 'todo-working-halo')
  assert.equal(await working.locator('.dtn-task-title').evaluate(node => getComputedStyle(node).opacity), '1')
  await page.locator('.dtn-card').screenshot({ path: resolve(output, 'todo-working-pulse.png') })
  await bridge.plugin.call(primary, 'todo_note_update', { focus: { current: '验证脉冲随任务切换' } })
  await working.filter({ hasText: '验证脉冲随任务切换' }).waitFor(); assert.equal(await working.count(), 1)
  await page.evaluate(() => document.documentElement.dataset.animations = 'false')
  assert.equal(await working.evaluate(node => getComputedStyle(node, '::before').animationName), 'none')
  await waitForOrbit(false)
  await page.evaluate(() => document.documentElement.dataset.animations = 'true')
  await waitForOrbit(true)
  await input.fill('补充一条指令'); assert.equal(await page.getByRole('button', { name: '补充指令', exact: true }).isEnabled(), true)
  await page.screenshot({ path: resolve(output, 'composer-running-border.png'), fullPage: true }); await input.press('Enter')
  await page.locator('.user-message').filter({ hasText: '补充一条指令' }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' }); await waitForOrbit(false)
  assert.equal(await working.evaluate(node => getComputedStyle(node, '::before').animationName), 'none')
  await page.getByRole('button', { name: '停止执行', exact: true }).click(); await page.locator('.composer[data-running]').waitFor({ state: 'hidden' })
  await working.waitFor({ state: 'hidden' }); assert.equal(await light.count(), 0)

  await add.click(); await page.getByRole('menuitem', { name: /Goal/ }).click()
  const goal = page.getByRole('dialog', { name: '会话目标', exact: true }); await goal.waitFor()
  await goal.getByLabel('目标与验收条件').fill('旧目标展示测试'); await goal.getByRole('checkbox', { name: '保存后开始执行', exact: true }).uncheck()
  await goal.getByRole('button', { name: '保存目标', exact: true }).click(); await goal.waitFor({ state: 'hidden' })
  await rpc.call('test/complete-goal', { threadId: primary }); await page.locator('.goal-complete').waitFor()
  await input.fill('开始新的独立任务'); await input.press('Enter'); await page.locator('.user-message').filter({ hasText: '开始新的独立任务' }).waitFor()
  await page.locator('.goal-bar').waitFor({ state: 'hidden' }); assert.equal((await rpc.call('thread/goal/get', { threadId: primary })).goal.status, 'complete')
  await add.click(); await page.getByRole('menuitem', { name: /Goal/ }).click(); await goal.getByText(/这个目标已经完成/).waitFor(); await page.keyboard.press('Escape')

  for (const name of ['资料', '演示']) { const path = resolve(root, name); await mkdir(path); await bridge.addWorkspace(path, name) }
  await page.locator('.workspace-group').filter({ hasText: '演示' }).waitFor()
  const spacing = await page.locator('.workspace-group').evaluateAll(nodes => { const a = nodes[1].querySelector('.group-heading').getBoundingClientRect(); const b = nodes[2].querySelector('.group-heading').getBoundingClientRect(); return b.top - a.bottom })
  assert.ok(spacing >= 3 && spacing <= 12, `${spacing}`)
  const background = await bridge.create(cwd); await bridge.rename(background.id, '后台会话完成通知'); await bridge.message(background.id, { text: '等待后台任务', mode: 'read-only' })
  await page.locator(`[data-thread-id="${background.id}"]`).getByRole('img', { name: '正在执行' }).waitFor()
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click(); await input.fill('不要打断这段草稿')
  await rpc.call('test/finish', { threadId: background.id })
  const completed = page.locator('.thread-notice.notice-completed').filter({ hasText: '后台会话完成通知' }); await completed.waitFor()
  assert.equal(await page.locator('.app').evaluate(node => node.classList.contains('sidebar-collapsed')), true); assert.equal(await input.inputValue(), '不要打断这段草稿')
  assert.equal(await page.evaluate(() => localStorage.getItem('cweb:thread')), primary)
  const noticeBox = await completed.boundingBox(); assert.ok(Math.abs(1000-noticeBox.y-noticeBox.height-15)<2, 'The actual notification card must sit at the window bottom')
  assert.ok(Math.abs(1440-noticeBox.x-noticeBox.width-15)<2)
  await page.screenshot({ path: resolve(output, 'thread-complete-notice.png'), fullPage: true })
  await completed.getByRole('button', { name: '前往会话', exact: true }).click(); await page.locator(`[data-thread-id="${background.id}"].selected`).waitFor()
  assert.equal(await page.locator('.app').evaluate(node => node.classList.contains('sidebar-collapsed')), false)
  await page.locator(`[data-thread-id="${primary}"]`).click(); assert.equal(await input.inputValue(), '不要打断这段草稿')
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click(); await page.reload(); await input.waitFor()
  assert.equal(await page.locator('.app').evaluate(node => node.classList.contains('sidebar-collapsed')), true)
  await bridge.message(background.id, { text: '提问', mode: 'read-only' })
  const waiting = page.locator('.thread-notice.notice-waiting').filter({ hasText: '后台会话完成通知' }); await waiting.waitFor()
  assert.equal(await page.locator('.app').evaluate(node => node.classList.contains('sidebar-collapsed')), true)
  await page.screenshot({ path: resolve(output, 'thread-waiting-notice.png'), fullPage: true })
  await waiting.getByRole('button', { name: '前往会话', exact: true }).click(); await page.getByRole('region', { name: 'Codex 需要你的选择' }).waitFor()
  await page.getByRole('radio', { name: '中文', exact: true }).check(); await page.getByRole('button', { name: '提交回答', exact: true }).click()
  await page.getByRole('region', { name: 'Codex 需要你的选择' }).waitFor({ state: 'hidden' })
  await page.screenshot({ path: resolve(output, 'sidebar-compact-groups.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 }); await input.fill('手机上的草稿'); await add.click()
  await page.screenshot({ path: resolve(output, 'composer-add-mobile.png'), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  const smallMenu = await page.getByRole('menu', { name: '添加到会话' }).boundingBox(); assert.ok(smallMenu.x >= 0 && smallMenu.x + smallMenu.width <= 390)
  assert.deepEqual(errors, [])
  console.log('Edge composer checks passed: aligned menus, native chips without arrows, plus Plan/Goal/Skills preserving drafts, border orbit and steer, active-task pulse and focus changes, reduced/disabled motion, completed goal hiding, compact groups, persistent collapse, background notifications and explicit navigation, mobile layout.')
} catch (error) {
  console.log(JSON.stringify({ errors, tail: (await page.locator('main').textContent().catch(() => '')).slice(-1400) }))
  await page.screenshot({ path: resolve(output, 'composer-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
