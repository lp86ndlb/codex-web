import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'feedback-')); const cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const log = resolve(root, 'rpc.jsonl')
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old', '--hide-scrollbars'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' }); const errors = []
await page.addInitScript(() => localStorage.setItem('cweb:loading-style', 'orbit'))
page.on('pageerror', error => errors.push(error.message))
async function closing(selector, action) {
  const node = page.locator(selector); await node.waitFor(); await page.waitForTimeout(320)
  // Observe in the browser so a slow CDP round trip cannot miss the whole fade.
  await node.evaluate(element => {
    window.__exitProbe = new Promise(resolve => {
      let frame; let observer
      const finish = value => { clearTimeout(timer); cancelAnimationFrame(frame); observer?.disconnect(); resolve(value) }
      const timer = setTimeout(() => finish({ faded: false, reason: 'exit timed out' }), 1200)
      function tick() {
        if (!element.isConnected) { finish({ faded: false, reason: 'removed before visible fade' }); return }
        const style = getComputedStyle(element); const opacity = Number(style.opacity)
        if (style.animationName.includes('exit') && opacity > 0 && opacity < .98) finish({ faded: true, name: style.animationName, opacity })
        else frame = requestAnimationFrame(tick)
      }
      observer = new MutationObserver(() => { if (element.getAttribute('data-exiting') === 'true') { observer.disconnect(); frame = requestAnimationFrame(tick) } })
      observer.observe(element, { attributes: true, attributeFilter: ['data-exiting'] })
    })
  })
  await action()
  const result = await page.evaluate(() => window.__exitProbe)
  assert.ok(result.faded, JSON.stringify({ selector, result }))
  await node.waitFor({ state: 'hidden' })
}
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`); await page.getByText('本地引擎已连接', { exact: true }).waitFor(); await page.locator('.workspace-card').first().click()
  const input = page.getByLabel('发送给 Codex 的消息', { exact: true })
  // Opening immediately after entering a workspace must not inherit an empty
  // dialog's pending close timer from the first mount.
  await input.fill('/goal'); await input.press('Enter')
  const goal = page.getByRole('dialog', { name: '会话目标', exact: true }); await goal.waitFor(); await page.waitForTimeout(320)
  assert.equal(await goal.isVisible(), true)
  await closing('.goal-dialog[open]', () => goal.getByRole('button', { name: '关闭目标设置', exact: true }).click())
  await input.fill('等待视觉复核'); await input.press('Enter'); await page.locator('.composer[data-running]').waitFor()
  const id = bridge.list()[0].id
  await bridge.plugin.call(id, 'todo_note_update', { focus: { current: '检查运行态辨识度' }, add_tasks: [{ title: '检查运行态辨识度' }, { title: '非当前执行任务' }] })
  const working = page.locator('.dtn-card .dtn-task[data-working="true"][data-task-id]'); await working.waitFor()
  const workingId = await working.getAttribute('data-task-id'); await page.waitForTimeout(400)
  const low = await working.evaluate(node => { for (const a of node.getAnimations({ subtree: true })) { if (a.effect.getTiming().iterations === Infinity) { a.pause(); a.currentTime = 0 } }; return Number(getComputedStyle(node, '::before').opacity) })
  await page.locator('.dtn-card').screenshot({ path: resolve(output, 'feedback-pulse-low.png') })
  const high = await working.evaluate(node => { for (const a of node.getAnimations({ subtree: true })) { if (a.effect.getTiming().iterations === Infinity) a.currentTime = 1600 }; return Number(getComputedStyle(node, '::before').opacity) })
  assert.ok(high - low >= .65, JSON.stringify({ low, high })); assert.equal(await working.locator('.dtn-task-title').evaluate(node => getComputedStyle(node).opacity), '1')
  await page.locator('.dtn-card').screenshot({ path: resolve(output, 'feedback-pulse-high.png') })
  await working.evaluate(node => { for (const a of node.getAnimations({ subtree: true })) a.play() })
  const beam = await page.locator('.composer-run-light').evaluate(node => ({ height: node.getBoundingClientRect().height, background: getComputedStyle(node).backgroundImage, shadow: getComputedStyle(node).boxShadow, filter: getComputedStyle(node).filter }))
  assert.ok(beam.background.includes('linear-gradient') && !beam.background.includes('radial-gradient'))
  assert.equal(beam.shadow, 'none'); assert.equal(beam.filter, 'none')
  await page.locator('.composer-run-light').evaluate(node => { const a = node.getAnimations().find(a => a.id === 'composer-orbit'); a.pause(); a.currentTime = Number(a.effect.getTiming().duration) * .14 })
  await page.screenshot({ path: resolve(output, 'feedback-running.png'), fullPage: true })
  await page.getByRole('button', { name: '停止执行', exact: true }).click(); await page.locator('.composer[data-running]').waitFor({ state: 'hidden' }); await working.waitFor({ state: 'hidden' })
  await bridge.plugin.call(id, 'todo_note_complete', { id: workingId, note: '已对比两种脉冲帧，确认标记更加清楚，文字保持稳定。\n请核对效果后再确认。' })
  const reviewNote = page.locator('.dtn-card[data-view="note"] > .dtn-fade .dtn-task[data-state="awaiting"] .dtn-task-note')
  await reviewNote.filter({ hasText: '已对比两种脉冲帧' }).waitFor(); await page.waitForTimeout(320)
  assert.ok(await reviewNote.evaluate(node => getComputedStyle(node).display !== 'none'))
  const reviewBox = await reviewNote.boundingBox(); const cardBox = await page.locator('.dtn-card').boundingBox()
  assert.ok(reviewBox.y >= cardBox.y && reviewBox.y + reviewBox.height <= cardBox.y + cardBox.height, 'Approval details must fit the regular note card')
  await page.locator('.dtn-card').screenshot({ path: resolve(output, 'feedback-todo-review.png') })

  await input.fill('多步提问'); await input.press('Enter')
  const question = page.getByRole('region', { name: 'Codex 需要你的选择', exact: true }); await question.waitFor(); await page.waitForTimeout(320)
  assert.equal(await working.count(), 0, 'The task must not pulse while waiting for the user')
  const questionBox = await question.boundingBox(); const inputBox = await page.locator('.composer').boundingBox(); assert.ok(questionBox.y + questionBox.height <= inputBox.y && Math.abs(questionBox.x - inputBox.x) < 2 && Math.abs(questionBox.width - inputBox.width) < 2, JSON.stringify({questionBox,inputBox}))
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Questions must be docked above the composer')
  await question.getByRole('radio', { name: 'English', exact: true }).check(); await question.getByRole('button', { name: '下一项', exact: true }).click()
  await question.getByRole('radio', { name: '完整说明', exact: true }).check(); await page.keyboard.press('Shift+ArrowLeft')
  await question.getByRole('radio', { name: 'English', exact: true }).waitFor(); assert.equal(await question.getByRole('radio', { name: 'English', exact: true }).isChecked(), true)
  await page.screenshot({ path: resolve(output, 'feedback-choice-back.png'), fullPage: true })
  await question.getByRole('button', { name: '自定义回答', exact: true }).click()
  const custom = question.getByRole('textbox', { name: '选择输出语言', exact: true }); await custom.fill('保留输入'); await custom.press('End'); await custom.press('Shift+ArrowLeft')
  assert.equal(await custom.evaluate(node => node.selectionEnd - node.selectionStart), 1)
  await question.getByRole('button', { name: '返回选项', exact: true }).click(); await question.getByRole('radio', { name: 'English', exact: true }).focus()
  await page.keyboard.press('Shift+ArrowLeft'); await page.waitForTimeout(280); assert.equal(await question.locator('.question-panel-body').getAttribute('data-open'), null)
  await question.getByRole('button', { name: '展开问题', exact: true }).click(); assert.equal(await question.getByRole('radio', { name: 'English', exact: true }).isChecked(), true)
  await question.getByRole('button', { name: '下一项', exact: true }).click(); await question.getByRole('radio', { name: '完整说明', exact: true }).waitFor(); assert.equal(await question.getByRole('radio', { name: '完整说明', exact: true }).isChecked(), true)
  await closing('.question-panel', () => question.getByRole('button', { name: '提交回答', exact: true }).click())
  const reply = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(row => row.id === 9002 && row.result)
  assert.deepEqual(reply.result.answers, { language: { answers: ['English'] }, detail: { answers: ['完整说明'] } })
  const notice = page.locator('.thread-notice.notice-completed').filter({ hasText: '等待视觉复核' }); await notice.waitFor()
  await page.screenshot({ path: resolve(output, 'feedback-complete-notice.png'), fullPage: true })
  await closing('.thread-notice.notice-completed', () => notice.getByRole('button', { name: /关闭完成通知/ }).click())

  await page.getByRole('button', { name: '添加功能', exact: true }).click()
  await closing('.composer-add-menu', () => page.keyboard.press('Escape'))
  await input.fill('/'); await closing('.slash-menu', () => input.press('Escape'))
  await page.getByRole('button', { name: '快捷命令', exact: true }).click(); await closing('.command-palette', () => page.keyboard.press('Escape'))
  await page.getByRole('button', { name: '连接与设置', exact: true }).click(); await closing('.settings-dialog[open]', () => page.getByRole('button', { name: '关闭对话框', exact: true }).click())
  await page.getByRole('button', { name: '显示工作区面板', exact: true }).click(); await closing('.inspector', () => page.getByRole('button', { name: '关闭工作区面板', exact: true }).click())
  await page.getByRole('button', { name: 'GenUI 交互面板', exact: true }).click(); await closing('.genui-panel', () => page.getByRole('button', { name: '关闭交互面板', exact: true }).click())

  await input.fill('选择框测试'); await input.press('Enter'); await question.waitFor()
  await question.getByRole('radio', { name: '先修复', exact: true }).check(); await question.getByRole('button', { name: '提交回答', exact: true }).click(); await question.waitFor({ state: 'hidden' })
  await page.evaluate(() => {
    window.__choiceClicks=[]
    document.addEventListener('click',event=>window.__choiceClicks.push({at:performance.now(),target:event.target.closest('button')?.textContent,panel:Boolean(document.querySelector('.choice-dock .question-panel'))}),true)
  })
  await page.locator('.choice-summary').getByRole('button', { name: '查看选择', exact: true }).click(); await question.waitFor({timeout:5000})
  await question.getByText('已提交：先修复', { exact: true }).waitFor(); assert.equal(await question.getByRole('radio', { name: '先修复', exact: true }).isDisabled(), true)
  await page.keyboard.press('Shift+ArrowLeft'); await question.waitFor({ state: 'hidden' })

  const demo = { title: '呼吸节奏 · 交互预览', items: [{ type: 'plot', title: '柔和脉冲示意', xMin: 0, xMax: 12.56, series: [{ expr: '0.5-0.5*cos(a*x)', label: '呼吸强度', params: [{ name: 'a', value: 1, min: .5, max: 2.5 }] }] }, { type: 'text', size: 'caption', content: '拖动参数即时更新曲线。' }] }
  await rpc.call('test/append', { threadId: id, text: '```dsh-ui\n' + JSON.stringify(demo) + '\n```' })
  const plot = page.getByRole('img', { name: '柔和脉冲示意', exact: true }); await plot.waitFor()
  const points = await plot.locator('polyline').last().getAttribute('points')
  await page.locator('.cweb-genui input[type="range"]').focus(); await page.keyboard.press('ArrowRight')
  assert.notEqual(await plot.locator('polyline').last().getAttribute('points'), points)
  await page.screenshot({ path: resolve(output, 'feedback-genui.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.deepEqual(errors, [])
  console.log('Edge feedback checks passed: stronger pulse and border, no pulse during user input, multi-step answers retained on back/reopen, native text selection, native/fenced choice submission and history review, foreground completion notice, real exit fades, interactive GenUI plot.')
} catch (error) { console.log(JSON.stringify({ errors, choice:await page.evaluate(()=>{const app=document.querySelector('.app');let fiber=app?.[Object.keys(app).find(key=>key.startsWith('__reactFiber'))];for(;fiber;fiber=fiber.return){const value=fiber.memoizedProps?.value;if(value?.submit&&value?.show)return {clicks:window.__choiceClicks,threadId:value.threadId,activeMessageId:value.activeMessageId,panel:value.panel}}return{clicks:window.__choiceClicks}}), tail: (await page.locator('main').textContent().catch(() => '')).slice(-900) })); await page.screenshot({ path: resolve(output, 'feedback-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
