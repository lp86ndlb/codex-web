import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'review-')); const cwd = resolve(root, 'project'); await mkdir(cwd)
process.env.TMPDIR = resolve('../.cache/tmp'); await mkdir(process.env.TMPDIR, { recursive: true })
const log = resolve(root, 'rpc.jsonl')
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old', '--hide-scrollbars'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' }); const errors = []
await page.addInitScript(() => localStorage.setItem('cweb:loading-style', 'orbit'))
page.on('pageerror', error => errors.push(error.message))
async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(50) }; assert.fail('Review state did not settle') }
const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
const recorded = JSON.parse(await readFile(resolve('tests/fixtures/plain-questions.json'), 'utf8'))
async function captureMotion(selector, action, duration = 360) {
  await page.evaluate(({selector,duration}) => {
    window.__menuProbe = new Promise(resolve => { const start = performance.now(); const samples=[]; function frame() { const node=document.querySelector(selector); if(node){const s=getComputedStyle(node);samples.push({at:performance.now()-start,y:s.transform==='none'?0:new DOMMatrixReadOnly(s.transform).m42,opacity:Number(s.opacity)})}; if(performance.now()-start<duration)requestAnimationFrame(frame);else resolve(samples) };frame() })
  }, {selector,duration})
  await action(); return page.evaluate(() => window.__menuProbe)
}
try {
  await page.goto(`http://127.0.0.1:${app.server.address().port}`); await page.getByText('本地引擎已连接', { exact: true }).waitFor(); await page.locator('.workspace-card').first().click()
  const input = page.getByLabel('发送给 Codex 的消息', { exact: true })
  await input.fill('复核交互'); await input.press('Enter'); await page.locator('.turn-end').waitFor()
  const id = bridge.list()[0].id
  await bridge.plugin.call(id, 'todo_note_update', { focus: { current: '检查动画' }, add_tasks: [{ title: '等待用户批准的任务' }, { title: '保持在下方的任务' }] })
  const note = await bridge.plugin.get(id); const taskId = note.tasks[0].id
  await bridge.plugin.call(id, 'todo_note_complete', { id: taskId, note: '完成说明：内容已实现。\n验证说明：已逐项复核。\n验收前应当完整保留这三行文字。' })
  const row = page.locator(`.dtn-card .dtn-task[data-task-id="${taskId}"][data-ghost="false"]`); await row.waitFor(); await page.waitForTimeout(500)
  let confirms = 0
  const slowConfirm = async route => { const data = route.request().postDataJSON(); if (data.action?.type === 'confirm_task') { confirms++; await new Promise(resolve => setTimeout(resolve, 950)) }; await route.continue() }
  await page.route('**/api/plugins/todo-note/act', slowConfirm)
  let staleCaptured=false
  const stalePoll=async route=>{const response=await route.fetch({postData:JSON.stringify({sessionId:id})});const body=await response.text();staleCaptured=true;await new Promise(resolve=>setTimeout(resolve,1400));await route.fulfill({response,body})}
  await page.route('**/api/plugins/todo-note/get',stalePoll,{times:1});await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await until(()=>staleCaptured)
  await page.evaluate(taskId => {
    window.__confirmFrames = []; window.__confirmProbe = new Promise(resolve => { const start = performance.now(); function frame() { const card = document.querySelector('.dtn-card'); const task = card.querySelector(`[data-task-id="${taskId}"][data-ghost="false"]`); window.__confirmFrames.push({ at: performance.now() - start, visible: Boolean(task), height: card.getBoundingClientRect().height }); if (performance.now() - start < 1800) requestAnimationFrame(frame); else resolve(window.__confirmFrames) }; frame() })
  }, taskId)
  await row.locator('.dtn-confirm button').first().click()
  const frames = await page.evaluate(() => window.__confirmProbe)
  const presence = frames.filter((frame, index) => index === 0 || frame.visible !== frames[index - 1].visible).map(frame => frame.visible)
  assert.deepEqual(presence, [true, false], 'Approved task must never reappear while the server reply is pending')
  assert.equal(confirms, 1)
  const settled = frames.filter(frame => frame.at > 650); assert.ok(Math.max(...settled.map(f => f.height)) - Math.min(...settled.map(f => f.height)) < 2, 'A late confirmation response must not start a second resize')
  await page.unroute('**/api/plugins/todo-note/act', slowConfirm)
  await page.locator('.dtn-card').screenshot({ path: resolve(output, 'review-confirm-settled.png') })

  // A width/view change may reflow text, but rows must stay on their layout
  // positions rather than play a second translation after the card settles.
  await bridge.plugin.call(id,'todo_note_update',{focus:{current:'这是用于复核视图缩放的较长焦点说明，需要在窄便签中自动换行，展开后保持任务稳定'}})
  await page.waitForTimeout(1400)
  for(const button of ['展开详情','收成便利贴']) {
    await page.evaluate(() => { window.__resizeProbe=new Promise(resolve=>{const start=performance.now(),samples=[];function frame(){const card=document.querySelector('.dtn-card');for(const row of card.querySelectorAll('.dtn-task[data-task-id][data-ghost="false"]')){const parent=row.offsetParent;const scroll=row.closest('.dtn-scroll');samples.push(row.getBoundingClientRect().top+(scroll?.scrollTop||0)-parent.getBoundingClientRect().top-row.offsetTop)}if(performance.now()-start<800)requestAnimationFrame(frame);else resolve(samples)}frame()}) })
    await page.locator('.dtn-card').getByRole('button',{name:button,exact:true}).click()
    const offsets=await page.evaluate(()=>window.__resizeProbe);assert.ok(Math.max(...offsets)-Math.min(...offsets)<2,`${button}: task rows moved away from their layout positions`)
  }
  await page.locator('.dtn-card').screenshot({ path: resolve(output,'review-todo-resize.png') })

  // A failed approval restores the task, explains the failure and permits retry.
  const remaining=(await bridge.plugin.get(id)).tasks[0].id
  await bridge.plugin.call(id,'todo_note_complete',{id:remaining,note:'这项说明用于验证失败后恢复与重新批准。'})
  const retryRow=page.locator(`.dtn-card .dtn-task[data-task-id="${remaining}"][data-ghost="false"]`);await retryRow.getByText('已完成？',{exact:true}).waitFor()
  const failed=async route=>{if(route.request().postDataJSON().action?.type==='confirm_task'){await new Promise(r=>setTimeout(r,550));await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST',message:'测试批准失败，请重试'}})})}else await route.continue()}
  await page.route('**/api/plugins/todo-note/act',failed);await retryRow.locator('.dtn-confirm button').first().click()
  await page.getByRole('alert').filter({hasText:'测试批准失败'}).waitFor();await retryRow.waitFor();await page.unroute('**/api/plugins/todo-note/act',failed)
  await retryRow.locator('.dtn-confirm button').first().click();await until(async()=>!(await bridge.plugin.get(id)).tasks.length);await page.locator('.dtn-card > .dtn-fade .dtn-empty').waitFor()

  await bridge.plugin.call(id,'todo_note_update',{add_tasks:[{title:'并行确认甲'},{title:'并行确认乙'},{title:'保持顺序丙'}]})
  const rapid=(await bridge.plugin.get(id)).tasks
  for(const task of rapid.slice(0,2))await bridge.plugin.call(id,'todo_note_complete',{id:task.id,note:'供连续批准的简短说明。'})
  const rapidRow=task=>page.locator(`.dtn-card .dtn-task[data-task-id="${task.id}"][data-ghost="false"]`)
  await rapidRow(rapid[0]).getByText('已完成？',{exact:true}).waitFor();await rapidRow(rapid[1]).getByText('已完成？',{exact:true}).waitFor();await page.waitForTimeout(400)
  await page.evaluate(ids=>{window.__rapidProbe=new Promise(resolve=>{const samples=[],start=performance.now();function frame(){const rows=[...document.querySelectorAll('.dtn-card > .dtn-fade .dtn-task[data-task-id]')].filter(row=>row.getBoundingClientRect().height>1).map(row=>ids.indexOf(row.dataset.taskId));samples.push(rows);if(performance.now()-start<1300)requestAnimationFrame(frame);else resolve(samples)}frame()})},rapid.map(task=>task.id))
  await rapidRow(rapid[0]).locator('.dtn-confirm button').first().click();await page.waitForTimeout(220);await rapidRow(rapid[1]).locator('.dtn-confirm button').first().click()
  const sequences=await page.evaluate(()=>window.__rapidProbe);assert.ok(sequences.every(rows=>rows.every((value,index)=>index===0||value>rows[index-1])),JSON.stringify(sequences))

  // The actual user's plain questions are replayed without asking another live
  // agent or operating their simulator. Both answers must be sent together.
  await input.fill('等待实际题目重放');await input.press('Enter');await page.locator('.composer[data-running]').waitFor()
  const beam=await page.locator('.composer-run-light').evaluate(node=>({width:node.clientWidth,height:parseFloat(getComputedStyle(node).height)}));assert.ok(beam.width<100&&beam.height>=3&&beam.height<=4)
  await page.locator('.composer-run-light').evaluate(node=>{const a=node.getAnimations().find(a=>a.id==='composer-orbit');a.pause();a.currentTime=Number(a.effect.getTiming().duration)*.14})
  await page.locator('.composer').screenshot({path:resolve(output,'review-running-border.png')})
  await rpc.call('test/append',{threadId:id,text:recorded.multi});await rpc.call('test/append',{threadId:id,text:'请按实际观察结果回答。'})
  const question=page.getByRole('region',{name:'Codex 需要你的选择',exact:true});await question.waitFor()
  await question.getByRole('radio',{name:'到拦停时有震动',exact:true}).check();await question.getByRole('button',{name:'下一项',exact:true}).click()
  await question.getByRole('radio',{name:'没有短震',exact:true}).check();await page.keyboard.press('Shift+ArrowLeft')
  await question.getByRole('radio',{name:'到拦停时有震动',exact:true}).waitFor();assert.equal(await question.getByRole('radio',{name:'到拦停时有震动',exact:true}).isChecked(),true)
  await question.getByRole('button',{name:'下一项',exact:true}).click();await question.getByRole('radio',{name:'没有短震',exact:true}).waitFor();assert.equal(await question.getByRole('radio',{name:'没有短震',exact:true}).isChecked(),true)
  await page.screenshot({path:resolve(output,'review-real-questions.png'),fullPage:true})
  const before=(await calls()).filter(row=>row.method==='turn/steer').length
  await question.getByRole('button',{name:'提交回答',exact:true}).click();await question.waitFor({state:'hidden'})
  const steers=(await calls()).filter(row=>row.method==='turn/steer');assert.equal(steers.length,before+1);assert.match(steers.at(-1).params.input[0].text,/我的选择：到拦停时有震动[\s\S]*我的选择：没有短震/);assert.equal(bridge.queue().length,0)
  await page.getByRole('button',{name:'停止执行',exact:true}).click();await page.locator('.composer[data-running]').waitFor({state:'hidden'})

  const model=page.getByRole('combobox',{name:'模型',exact:true})
  const enter=await captureMotion('.composer-select-popover',()=>model.click())
  assert.ok(enter.some(f=>f.y>1&&f.opacity<.95)&&Math.abs(enter.at(-1).y)<1,JSON.stringify(enter))
  const popup=page.getByRole('listbox',{name:'模型选项',exact:true});const box=await popup.boundingBox();const trigger=await model.boundingBox();assert.ok(box.y+box.height<trigger.y)
  await page.locator('.conversation').evaluate(node=>node.dispatchEvent(new Event('scroll')));await page.waitForTimeout(250)
  assert.equal(await popup.isVisible(),true,'Automatic transcript scrolling must not dismiss the model menu')
  await page.screenshot({path:resolve(output,'review-model-menu.png'),fullPage:true})
  const exit=await captureMotion('.composer-select-popover',()=>page.keyboard.press('Escape'))
  assert.ok(exit.some(f=>f.y>1&&f.opacity>0&&f.opacity<.95),JSON.stringify(exit));await popup.waitFor({state:'hidden'})
  await model.press('ArrowDown');await model.press('ArrowDown');await model.press('Enter');await until(async()=>(await model.textContent())==='测试模型')
  await model.click();await page.keyboard.press('Control+k');await popup.waitFor({state:'hidden'});assert.equal(await input.evaluate(n=>n===document.activeElement),true)
  await page.getByRole('combobox',{name:'推理强度',exact:true}).click();await page.getByRole('option',{name:'medium',exact:true}).click()

  await rpc.call('test/append',{threadId:id,text:'最终回复的代码：\n```bash\nnode --version\n```',phase:'final_answer'})
  const finalCode=page.locator('.agent-message:not(.agent-commentary) .genui-code').filter({hasText:'node --version'});await finalCode.locator('pre').waitFor();assert.equal(await finalCode.evaluate(n=>n.tagName),'DIV')
  await rpc.call('test/append',{threadId:id,text:'执行过程的代码：\n```bash\npwd\n```'})
  const processCode=page.locator('.agent-commentary .markdown-code').filter({hasText:'pwd'});await processCode.waitFor();assert.equal(await processCode.evaluate(n=>n.open),false)

  const background=await bridge.create(cwd);await bridge.rename(background.id,'后台实际题目重放');await bridge.message(background.id,{text:'等待后台观察',mode:'read-only'});await rpc.call('test/append',{threadId:background.id,text:recorded.single})
  const notice=page.locator('.thread-notice.notice-waiting').filter({hasText:'后台实际题目重放'});await notice.waitFor();await page.waitForTimeout(400)
  const corner=await notice.boundingBox();assert.ok(Math.abs(1000-corner.y-corner.height-15)<2&&Math.abs(1440-corner.x-corner.width-15)<2,JSON.stringify(corner))
  await page.screenshot({path:resolve(output,'review-notice-bottom.png'),fullPage:true})
  await page.setViewportSize({width:1100,height:760});await page.waitForTimeout(160)
  const small=await notice.boundingBox();assert.ok(Math.abs(760-small.y-small.height-15)<2,JSON.stringify(small))
  await notice.getByRole('button',{name:/关闭待回复通知/}).click();await notice.waitFor({state:'hidden'})
  await rpc.call('test/append',{threadId:background.id,text:'保持仿真运行，等待你的观察结果。'});await page.waitForTimeout(600);assert.equal(await notice.isVisible(),false,'Progress must not reopen the same dismissed question')
  await rpc.call('test/append',{threadId:background.id,text:recorded.single});await notice.waitFor()
  await notice.getByRole('button',{name:'前往会话',exact:true}).click();await question.getByRole('radio',{name:'拦停时有震动',exact:true}).waitFor()
  await question.getByRole('button',{name:'自定义回答',exact:true}).click();const custom=question.getByRole('textbox',{name:'自定义回答',exact:true});await custom.fill('用户自定义的观察结果');await custom.press('Enter');await question.waitFor({state:'hidden'})
  assert.match((await calls()).filter(row=>row.method==='turn/steer').at(-1).params.input[0].text,/用户自定义的观察结果/)

  // The new user item can arrive before the HTTP acknowledgement. Reopening
  // that record while awaiting the reply must survive the late acknowledgement.
  await rpc.call('test/append',{threadId:background.id,text:recorded.single});await question.waitFor()
  const delayedReply=async route=>{const response=await route.fetch();await new Promise(resolve=>setTimeout(resolve,1000));await route.fulfill({response})}
  await page.route(`**/api/threads/${background.id}/message`,delayedReply)
  await question.getByRole('radio',{name:'拦停时有震动',exact:true}).check();await question.getByRole('button',{name:'提交回答',exact:true}).click();await question.waitFor({state:'hidden'})
  await page.locator('.choice-summary').last().getByRole('button',{name:'查看选项',exact:true}).click();await question.waitFor()
  await question.getByText('已提交：拦停时有震动',{exact:true}).waitFor();await page.waitForTimeout(250);assert.equal(await question.isVisible(),true)
  await question.getByRole('button',{name:'关闭记录',exact:true}).click();await question.waitFor({state:'hidden'});await page.unroute(`**/api/threads/${background.id}/message`,delayedReply)
  assert.deepEqual(errors, [])
  console.log('Edge review checks passed: slow approval stays gone, one card resize, failure and retry, stable task positions during resize, real plain-question replay with combined immediate answers, upward menus and visible exits, final/process code defaults, background questions and actual notification cards anchored to the viewport bottom across sizes.')
} catch (error) { console.log(JSON.stringify({ errors, frames: await page.evaluate(() => window.__confirmFrames?.filter((frame, index, frames) => index === 0 || frame.visible !== frames[index - 1].visible || index % 10 === 0)).catch(() => []) })); await page.screenshot({ path: resolve(output, 'review-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
