import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {chromium} from 'playwright'
import {CodexRpc} from '../server/rpc.ts'
import {Bridge} from '../server/bridge.ts'
import {Workspace} from '../server/workspace.ts'
import {createHttpServer} from '../server/http.ts'
import {messageChoices} from '../shared/choices.ts'

const output=resolve('test-results');await mkdir(output,{recursive:true})
const root=await mkdtemp(resolve(output,'native-'));const cwd=resolve(root,'project');await mkdir(cwd)
process.env.TMPDIR=resolve('../.cache/tmp');await mkdir(process.env.TMPDIR,{recursive:true})
const log=resolve(root,'rpc.jsonl')
const rpc=new CodexRpc({command:process.execPath,args:[resolve('tests/fake-codex.mjs')],cwd,env:{...process.env,FAKE_STORE:resolve(root,'sessions.json'),FAKE_LOG:log,FAKE_STARTED_OFFSET_MS:'87000'}})
const bridge=new Bridge(rpc,new Workspace(cwd),resolve(root,'home'),resolve(root,'data'))
const app=createHttpServer({bridge,dist:resolve(process.env.CWEB_TEST_DIST||'dist')});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({executablePath:'/usr/bin/microsoft-edge',headless:true,ignoreDefaultArgs:['--headless=old','--hide-scrollbars'],args:['--headless=new','--no-sandbox','--disable-dev-shm-usage']})
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'no-preference'});const errors=[];page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(()=>localStorage.setItem('cweb:loading-style','orbit'))
const fixture=JSON.parse(await readFile(resolve('tests/fixtures/native-question.json'),'utf8'))
const calls=async()=> (await readFile(log,'utf8')).trim().split('\n').map(row=>JSON.parse(row))
async function until(check,message='Native state did not settle'){for(let i=0;i<120;i++){if(await check())return;await page.waitForTimeout(50)}assert.fail(message)}
const question=()=>page.getByRole('region',{name:'Codex 需要你的选择',exact:true})
const elapsed=async()=>Number((await page.locator('.working .run-timer').getAttribute('datetime')).slice(2,-1))
const notice=title=>page.locator('.thread-notice.notice-waiting').filter({hasText:title})
const selectThread=async title=>{await page.locator('.thread-link').filter({hasText:title}).click();await until(async()=>await page.locator('.topbar .breadcrumb strong').textContent()===title)}
try{
 await page.goto(`http://127.0.0.1:${app.server.address().port}`);await page.getByText('本地引擎已连接',{exact:true}).waitFor();await page.locator('.workspace-card').first().click()
 const input=page.getByLabel('发送给 Codex 的消息',{exact:true});await input.fill('等待原生会话甲');await input.press('Enter');await page.locator('.composer[data-running]').waitFor()
 const a=bridge.list()[0].id;await bridge.rename(a,'原生会话甲')
 await page.locator('.working .run-timer').waitFor();const initialTime=await elapsed();assert.ok(initialTime>=87&&initialTime<95)
 await until(async()=>await elapsed()>initialTime,'Timer did not tick')
 await rpc.call('test/append',{threadId:a,...fixture})
 await question().getByRole('radio',{name:'高光覆盖范围仍太短',exact:true}).check()
 assert.deepEqual(bridge.threads.get(a).items.at(-1).questions,fixture.questions)
 await rpc.call('test/append',{threadId:a,text:'仍在继续核对其他工作。'})
 assert.equal(await question().getByRole('radio',{name:'高光覆盖范围仍太短',exact:true}).isChecked(),true)

 // Three concurrent native threads: receiving a new request must not steal
 // focus or discard a selection made in the foreground thread.
 const b=await bridge.create(cwd);await bridge.rename(b.id,'原生会话乙');await bridge.message(b.id,{text:'等待原生乙',mode:'read-only'})
 const bQuestions=[{title:'调整偏好',options:['收敛反光','保留当前效果']},{title:'补充你的使用场景',options:null}]
 await rpc.call('test/append',{threadId:b.id,text:'原生题目已准备好。',questions:bQuestions})
 await notice('原生会话乙').waitFor();assert.equal(await question().getByRole('radio',{name:'高光覆盖范围仍太短',exact:true}).isChecked(),true)
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'高光覆盖范围仍太短')
 const c=await bridge.create(cwd);await bridge.rename(c.id,'原生会话丙');await bridge.message(c.id,{text:'等待原生丙',mode:'read-only'})
 await rpc.call('test/append',{threadId:c.id,text:'请使用原生卡片。',questions:[{title:'单个建议也可以选择',options:['继续当前方案']}]})
 await notice('原生会话丙').waitFor()
 await question().getByRole('button',{name:'提交回答',exact:true}).click();await question().waitFor({state:'hidden'})
 const aReply=(await calls()).filter(row=>row.method==='turn/steer').at(-1)
 assert.equal(aReply.params.threadId,a);assert.match(aReply.params.input[0].text,/我的选择：高光覆盖范围仍太短/)
 assert.equal(bridge.threads.get(a).choicePending,false);assert.equal(bridge.threads.get(b.id).choicePending,true);assert.equal(bridge.threads.get(c.id).choicePending,true)
 assert.equal(bridge.queue().length,0)

 // Keep records submitted before the native metadata upgrade. Existing
 // browser answer keys came from the old question-plus-list parser.
 await page.locator('.choice-summary').getByRole('button',{name:'查看选择',exact:true}).waitFor()
 const asked=bridge.threads.get(a).items.find(item=>item.questions?.length);const spec=messageChoices(asked)[0]
 await page.evaluate(({thread,slot,spec})=>{localStorage.setItem(`cweb:answer:${thread}:${slot}:${spec.legacyId}`,'高光覆盖范围仍太短');localStorage.removeItem(`cweb:answer:${thread}:${slot}:${spec.id}`)},{thread:a,slot:asked.id,spec})
 await page.reload();await page.locator('.choice-summary').getByRole('button',{name:'查看选择',exact:true}).click()
 await question().getByText('已提交：高光覆盖范围仍太短',{exact:true}).waitFor()
 await question().getByRole('button',{name:'关闭记录',exact:true}).click();await question().waitFor({state:'hidden'})

 await selectThread('原生会话乙');await question().getByRole('radio',{name:'收敛反光',exact:true}).check();await question().getByRole('button',{name:'下一项',exact:true}).click()
 const custom=()=>question().getByRole('textbox',{name:'自定义回答',exact:true})
 await custom().fill('Edge 浏览器，偏好深色模式')
 await page.screenshot({path:resolve(output,'native-freeform-and-timer.png'),fullPage:true})
 const beforeReload=await elapsed();await page.reload();await custom().waitFor();assert.equal(await custom().inputValue(),'Edge 浏览器，偏好深色模式')
 const afterReload=await elapsed();assert.ok(afterReload>=beforeReload&&afterReload-beforeReload<10,'Reload reset the native start timestamp')
 await page.keyboard.press('Shift+ArrowLeft'); // Filled free text keeps normal text selection.
 await custom().fill('');await page.keyboard.press('Shift+ArrowLeft')
 await question().getByRole('radio',{name:'收敛反光',exact:true}).waitFor();assert.equal(await question().getByRole('radio',{name:'收敛反光',exact:true}).isChecked(),true)
 await question().getByRole('button',{name:'下一项',exact:true}).click();await custom().fill('Edge 浏览器，偏好深色模式')
 await selectThread('原生会话丙');await question().getByRole('radio',{name:'继续当前方案',exact:true}).check()
 await question().getByRole('button',{name:'提交回答',exact:true}).click();await question().waitFor({state:'hidden'})
 assert.equal((await calls()).filter(row=>row.method==='turn/steer').at(-1).params.threadId,c.id)
 await selectThread('原生会话乙');await custom().waitFor();assert.equal(await custom().inputValue(),'Edge 浏览器，偏好深色模式')

 // Drop the actual SSE transport. Native snapshots and draft recovery must
 // retain the same active question, without sending any response twice.
 const requestCount=(await calls()).filter(row=>row.method==='turn/steer').length
 app.server.closeAllConnections();await page.getByText('本地引擎已连接',{exact:true}).waitFor();await page.waitForTimeout(3500)
 assert.equal(await custom().inputValue(),'Edge 浏览器，偏好深色模式');assert.equal((await calls()).filter(row=>row.method==='turn/steer').length,requestCount)
 await custom().press('Enter');await question().waitFor({state:'hidden'})
 const bReply=(await calls()).filter(row=>row.method==='turn/steer').at(-1)
 assert.equal(bReply.params.threadId,b.id);assert.match(bReply.params.input[0].text,/我的选择：收敛反光[\s\S]*我的选择：Edge 浏览器，偏好深色模式/)
 assert.equal(bridge.threads.get(b.id).choicePending,false)
 const start=bridge.threads.get(b.id).runs.at(-1).startedAt
 assert.ok(Math.abs((Date.now()-start)/1000-await elapsed())<2,'Steering a response reset the timer')

 // Capture both straight-edge and corner phases; turning the light must not
 // reintroduce the former broad reflection.
 const beam=page.locator('.composer-run-light')
 const beamBox=await beam.evaluate(node=>({width:node.clientWidth,height:node.clientHeight,filter:getComputedStyle(node).filter}))
 assert.ok(beamBox.width<100&&beamBox.height<=4);assert.equal(beamBox.filter,'none')
 for(const phase of ['edge','corner']){
  await beam.evaluate((node,phase)=>{const animation=node.getAnimations().find(a=>a.id==='composer-orbit');const frames=animation.effect.getKeyframes();animation.pause();animation.currentTime=animation.effect.getTiming().duration*(phase==='corner'?frames[1].offset:frames[1].offset/2)},phase)
  await page.waitForTimeout(80);await page.locator('.composer-dock').screenshot({path:resolve(output,`native-beam-${phase}.png`)})
 }
 await rpc.call('test/finish',{threadId:b.id});await page.locator('.composer[data-running]').waitFor({state:'hidden'});assert.equal(await page.locator('.working .run-timer').count(),0)
 const settled=bridge.threads.get(b.id).runs.at(-1);assert.ok(settled.durationMs>=87000)
 assert.match(await page.locator('.run-summary').last().textContent(),/分/)

 // Native blocking requests still use their JSON-RPC request IDs and answers,
 // rather than posting a text response into whichever thread is selected.
 const d=await bridge.create(cwd);await bridge.rename(d.id,'原生阻塞问答');await bridge.message(d.id,{text:'提问',mode:'read-only'})
 await selectThread('原生阻塞问答');await question().waitFor();await question().getByRole('radio').first().check()
 await question().getByRole('button',{name:/提交/}).click();await question().waitFor({state:'hidden'})
 const nativeReply=(await calls()).find(row=>row.id===9002&&!row.method)
 assert.ok(nativeReply?.result?.answers);assert.equal(Object.keys(nativeReply.result.answers).length,1)

 // The native question can arrive before the original message's HTTP reply.
 // Finishing that request must not take focus away from a chosen answer.
 let acknowledged=false
 const delayed=async route=>{const response=await route.fetch();await rpc.call('test/append',{threadId:d.id,text:'原生问题已准备好。',questions:[{title:'延迟回执时保持当前选择',options:['保持当前选项','另一项']}]});await new Promise(resolve=>setTimeout(resolve,1400));await route.fulfill({response});acknowledged=true}
 await page.route(`**/api/threads/${d.id}/message`,delayed)
 await input.fill('延迟回执验证');await input.press('Enter')
 const keptFocus=question().getByRole('radio',{name:'保持当前选项',exact:true});await keptFocus.check()
 await until(()=>acknowledged);await page.waitForTimeout(250)
 assert.equal(await keptFocus.evaluate(node=>node===document.activeElement),true,'A late message acknowledgement stole the question focus')
 await page.unroute(`**/api/threads/${d.id}/message`,delayed)
 assert.deepEqual(errors,[])
 await writeFile(resolve(output,'native-validation.json'),JSON.stringify({sessions:4,structuredQuestions:true,legacyTrailingExplanation:true,legacyAnswerRecords:true,draftsAcrossRefreshAndThreads:true,sseRecovery:true,blockingNativeReply:true,lateReplyKeepsQuestionFocus:true,timer:{initialTime,beforeReload,afterReload,settledMs:settled.durationMs},beam:beamBox},null,2))
 console.log('Native question protocol, four sessions, refresh/reconnect, drafts, timer and edge-light checks passed')
}catch(error){
 await page.screenshot({path:resolve(output,'native-failure.png'),fullPage:true}).catch(()=>{})
 await writeFile(resolve(output,'native-failure.json'),JSON.stringify({error:String(error),threads:[...bridge.threads.values()],dom:await page.locator('.conversation').textContent().catch(()=>''),errors},null,2))
 throw error
}finally{await browser.close();await app.close();await rm(root,{recursive:true,force:true})}
