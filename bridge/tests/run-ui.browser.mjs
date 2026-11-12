import assert from 'node:assert/strict'
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {chromium} from 'playwright'
import {CodexRpc} from '../server/rpc.ts'
import {Bridge} from '../server/bridge.ts'
import {Workspace} from '../server/workspace.ts'
import {createHttpServer} from '../server/http.ts'

const output=resolve('test-results');await mkdir(output,{recursive:true});const root=await mkdtemp(resolve(output,'run-ui-'));const cwd=resolve(root,'project');await mkdir(cwd)
process.env.TMPDIR=resolve('../.cache/tmp');await mkdir(process.env.TMPDIR,{recursive:true})
const id=randomUUID(),store=resolve(root,'sessions.json'),log=resolve(root,'rpc.jsonl')
const items=Array.from({length:130},(_,i)=>i%2?{id:`a-${i}`,type:'agentMessage',phase:'final_answer',text:`第${i}项检查\n\n`+'这是一段用于验证阅读历史时仍能查看运行状态的内容。\n\n'.repeat(4)}:{id:`u-${i}`,type:'userMessage',content:[{type:'text',text:`检查第${i}项`}]})
await writeFile(store,JSON.stringify({[id]:{id,name:'运行状态与动画方案',preview:'',cwd,updatedAt:Date.now()/1000,turns:[{id:'history',status:'completed',items}]}}))
const rpc=new CodexRpc({command:process.execPath,args:[resolve('tests/fake-codex.mjs')],cwd,env:{...process.env,FAKE_STORE:store,FAKE_LOG:log,FAKE_STARTED_OFFSET_MS:'87000'}})
const bridge=new Bridge(rpc,new Workspace(cwd),resolve(root,'home'),resolve(root,'data'));const app=createHttpServer({bridge,dist:resolve(process.env.CWEB_TEST_DIST||'dist')});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve))
const base=`http://127.0.0.1:${app.server.address().port}`
const browser=await chromium.launch({executablePath:'/usr/bin/microsoft-edge',headless:true,ignoreDefaultArgs:['--headless=old','--hide-scrollbars'],args:['--headless=new','--no-sandbox','--disable-dev-shm-usage']})
const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'no-preference'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(id=>localStorage.setItem('cweb:thread',id),id)
async function until(check,reason='Run UI did not settle'){for(let i=0;i<120;i++){if(await check())return;await page.waitForTimeout(50)}assert.fail(reason)}
const calls=async()=>(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
const messageCalls=async()=>(await calls()).filter(call=>['turn/start','turn/steer'].includes(call.method)).length
const timer=()=>page.locator('.working .run-timer')
const elapsed=async()=>Number((await timer().getAttribute('datetime')).slice(2,-1))
async function timerVisible(){const r=await timer().boundingBox(),form=await page.locator('form.composer').boundingBox();return Boolean(r&&r.y>=64&&r.y+r.height<=form.y&&r.x>=0&&r.x+r.width<=page.viewportSize().width)}
const gallery=()=>page.getByRole('group',{name:'输入框运行效果',exact:true})
async function openAppearance(){await page.keyboard.press('Control+,');await page.getByRole('button',{name:'外观与布局',exact:true}).click()}
async function closeSettings(){await page.getByRole('button',{name:'关闭对话框',exact:true}).click();await page.locator('.settings-dialog[open]').waitFor({state:'hidden'})}
try{
 await page.goto(base);await page.getByText('本地引擎已连接',{exact:true}).waitFor();const input=page.getByLabel('发送给 Codex 的消息',{exact:true})
 await input.fill('等待实时用时验证');await input.press('Enter');await timer().waitFor();assert.equal(await page.getByRole('button',{name:'选择运行效果',exact:true}).count(),0);assert.ok(await timerVisible(),'The live timer is hidden behind the input')
 await page.locator('form.composer [data-variant="underline"]').waitFor()
 const first=await elapsed();assert.ok(first>=87);await until(async()=>await elapsed()>first,'Elapsed time does not update')

 // Fresh output is appended while reading above. Preserve the reader's row
 // and scroll position, with the live timer outside the history window.
 const viewport=page.locator('.conversation');const bounds=await viewport.boundingBox();await page.mouse.move(bounds.x+70,bounds.y+140);await page.mouse.wheel(0,-900)
 await page.getByRole('button',{name:'回到底部',exact:true}).waitFor()
 await viewport.evaluate(async node=>{
  let top=node.scrollTop,stable=0
  for(let frame=0;frame<60&&stable<4;frame++){
   await new Promise(requestAnimationFrame)
   const next=node.scrollTop;stable=Math.abs(next-top)<1?stable+1:0;top=next
  }
 })
 const reading=await viewport.evaluate(node=>{
  const top=node.getBoundingClientRect().top
  const row=[...node.querySelectorAll('.transcript [data-message-id]')].find(row=>row.getBoundingClientRect().bottom>top+1)
  return {top:node.scrollTop,id:row?.dataset.messageId,rowTop:row?row.getBoundingClientRect().top-top:null}
 })
 assert.ok(reading.id,'The fixture has no visible reading anchor')
 await rpc.call('test/append',{threadId:id,text:'继续处理，阅读位置保持不变。'})
 await page.locator('.agent-commentary').filter({hasText:'继续处理，阅读位置保持不变。'}).waitFor({state:'attached'})
 assert.equal(await page.getByRole('button',{name:/显示较新的消息/}).count(),0,'Live output must not require a manual refresh')
 const afterReading=await viewport.evaluate((node,id)=>{
  const row=node.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
  return {top:node.scrollTop,rowTop:row?row.getBoundingClientRect().top-node.getBoundingClientRect().top:null}
 },reading.id)
 assert.ok(afterReading.rowTop!==null&&Math.abs(afterReading.rowTop-reading.rowTop)<3,JSON.stringify({reading,afterReading}))
 assert.ok(Math.abs(afterReading.top-reading.top)<3,JSON.stringify({reading,afterReading}))
 assert.ok(await timerVisible(),'Reading earlier messages removed or covered the running timer')
 await page.screenshot({path:resolve(output,'run-ui-reading-timer.png'),fullPage:true})
 const countBefore=await page.locator('.transcript article').count()
 await page.evaluate(()=>{window.__transcriptChanges=0;new MutationObserver(records=>window.__transcriptChanges+=records.length).observe(document.querySelector('.transcript'),{subtree:true,childList:true,characterData:true})})
 await input.fill('这段草稿尚未发送');await page.waitForTimeout(1200)
 assert.equal(await page.evaluate(()=>window.__transcriptChanges),0,'Ticking or editing rerendered the transcript')
 assert.equal(await page.locator('.transcript article').count(),countBefore)
 await page.getByRole('button',{name:'回到底部',exact:true}).click();await input.fill('')

 await openAppearance();await gallery().waitFor()
 assert.equal(await gallery().getByRole('radio').count(),5)
 const before=await messageCalls();const choices=[['环行短线','orbit'],['底边巡航','underline'],['柔和呼吸','breath'],['三点律动','dots'],['仅文字计时','none']]
 for(const [label,variant]of choices){
  await gallery().getByRole('radio',{name:label,exact:true}).check()
  await until(async()=>variant==='none'?await page.locator('form.composer [data-variant]').count()===0:await page.locator(`form.composer [data-variant="${variant}"]`).count()===1)
  assert.equal(await page.evaluate(()=>localStorage.getItem('cweb:loading-style')||'orbit'),variant)
 }
 assert.equal(await messageCalls(),before);assert.equal(bridge.queue().length,0)
 await gallery().getByRole('radio',{name:'底边巡航',exact:true}).check();await page.screenshot({path:resolve(output,'run-ui-loading-gallery.png'),fullPage:true});await closeSettings()
 const beforeReload=await elapsed();await page.reload();await timer().waitFor();assert.ok(await elapsed()>=beforeReload,'Refreshing reset the timer')
 await page.locator('form.composer [data-variant="underline"]').waitFor();assert.ok(await timerVisible())

 const second=await page.context().newPage();await second.goto(base);await second.locator('form.composer [data-variant="underline"]').waitFor()
 await openAppearance();await gallery().getByRole('radio',{name:'柔和呼吸',exact:true}).check();await second.locator('form.composer [data-variant="breath"]').waitFor();await second.close()
 await page.emulateMedia({reducedMotion:'reduce'})
 await until(async()=>await page.locator('[data-variant]').evaluateAll(nodes=>nodes.every(node=>node.getAnimations({subtree:true}).length===0)),'Reduced motion still has active animations')
 await page.emulateMedia({reducedMotion:'no-preference'});await gallery().getByRole('radio',{name:'底边巡航',exact:true}).check()
 await until(async()=>await page.locator('form.composer [data-variant]').evaluate(node=>node.getAnimations({subtree:true}).length>0))
 const animations=page.getByRole('checkbox',{name:'界面动画',exact:true});await animations.uncheck()
 await until(async()=>await page.locator('[data-variant]').evaluateAll(nodes=>nodes.every(node=>node.getAnimations({subtree:true}).length===0)),'Disabling animations did not stop the indicators')
 await animations.check();await closeSettings()

 // The GenUI entry opens the existing settings page locally, with no queued
 // model turn. It also remains available after the current task finishes.
 const spec={title:'运行效果预览',items:[{type:'button',label:'预览并选择动画',action:'cweb:loading-style-picker',tone:'primary'}]}
 await rpc.call('test/append',{threadId:id,text:'```dsh-ui\n'+JSON.stringify(spec)+'\n```',phase:'final_answer'})
 const localCalls=await messageCalls();await page.getByRole('button',{name:'预览并选择动画',exact:true}).click();await gallery().waitFor();assert.equal(await messageCalls(),localCalls);assert.equal(bridge.queue().length,0)
 await closeSettings();await page.setViewportSize({width:390,height:844});assert.ok(await timerVisible(),'Mobile timer is outside the visible input area')
 await page.screenshot({path:resolve(output,'run-ui-mobile-timer.png'),fullPage:true})
 await openAppearance();await gallery().waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.screenshot({path:resolve(output,'run-ui-mobile-gallery.png'),fullPage:true});await closeSettings()
 await rpc.call('test/finish',{threadId:id});await timer().waitFor({state:'hidden'});await page.locator('.run-summary').last().waitFor();assert.ok(bridge.threads.get(id).runs.at(-1).durationMs>=87000)
 const directCalls=await messageCalls();const direct=await context.newPage();await direct.goto(base+'/?loading-effects=1')
 const directPicker=direct.getByRole('group',{name:'输入框运行效果',exact:true});await directPicker.waitFor();assert.equal(await directPicker.getByRole('radio').count(),5)
 assert.equal(new URL(direct.url()).searchParams.has('loading-effects'),false)
 await direct.getByRole('button',{name:'关闭对话框',exact:true}).click();await direct.locator('.settings-dialog[open]').waitFor({state:'hidden'})
 await direct.reload();await direct.getByText('本地引擎已连接',{exact:true}).waitFor();assert.equal(await direct.locator('.settings-dialog[open]').count(),0)
 assert.equal(await messageCalls(),directCalls);await direct.close()
 assert.deepEqual(errors,[])
 await writeFile(resolve(output,'run-ui-validation.json'),JSON.stringify({liveTimerVisibleWhileReading:true,historyWindowPreserved:true,liveOutputAutomaticallyAppended:true,refreshPreservesStart:true,transcriptMutations:0,styles:choices.map(row=>row[1]),localSelection:true,rememberedSelection:true,crossTabSync:true,reducedMotion:true,animationsSwitch:true,genuiOpensLocally:true,directPreviewEntry:true,entryClearedAfterOpen:true,mobile:true,finalSummaryRetained:true},null,2))
 console.log('Run UI checks passed: sticky elapsed time while preserving reading position and appending live output, refresh, isolated ticks, five live styles, persistence, cross-tab sync, motion controls, local GenUI entry and mobile.')
}catch(error){await page.screenshot({path:resolve(output,'run-ui-failure.png'),fullPage:true}).catch(()=>{});console.log(JSON.stringify({errors,error:String(error)}));throw error}
finally{await browser.close();await app.close();await rm(root,{recursive:true,force:true})}
