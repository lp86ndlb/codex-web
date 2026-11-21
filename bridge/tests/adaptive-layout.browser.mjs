import assert from 'node:assert/strict'
import {mkdir,mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {chromium} from 'playwright'
import {CodexRpc} from '../server/rpc.ts'
import {Bridge} from '../server/bridge.ts'
import {Workspace} from '../server/workspace.ts'
import {createHttpServer} from '../server/http.ts'
const out=resolve('test-results');await mkdir(out,{recursive:true})
const root=await mkdtemp(resolve(out,'adaptive-')),cwd=resolve(root,'project');await mkdir(cwd)
const rpc=new CodexRpc({command:process.execPath,args:[resolve('tests/fake-codex.mjs')],cwd,env:{...process.env,FAKE_STORE:resolve(root,'store.json')}})
const bridge=new Bridge(rpc,new Workspace(cwd),resolve(root,'home'),resolve(root,'data'));await bridge.updatePreferences({uiFontSize:12,fontSize:16})
const seeded=await bridge.create(cwd);await bridge.rename(seeded.id,'布局验证会话')
const app=createHttpServer({bridge,dist:resolve(process.env.CWEB_TEST_DIST||'dist')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:'/usr/bin/microsoft-edge',headless:true,ignoreDefaultArgs:['--headless=old'],args:['--headless=new','--no-sandbox','--disable-dev-shm-usage']})
const page=await browser.newPage({viewport:{width:1536,height:760},reducedMotion:'reduce'}),errors=[],results=[];page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(id=>localStorage.setItem('cweb:thread',id),seeded.id)
const question=page.getByRole('region',{name:'Codex 需要你的选择',exact:true}),input=page.getByLabel('发送给 Codex 的消息',{exact:true})
async function until(check){for(let i=0;i<100;i++){if(await check())return;await page.waitForTimeout(50)}assert.fail('State did not settle')}
const fonts=()=>page.evaluate(()=>Object.fromEntries(Object.entries({body:'.composer textarea',prompt:'.choice-question',toolbar:'.composer-select-trigger',todo:'.dtn-task-title',tab:'.inspector .tabs button',sidebar:'.thread-link > div > span'}).map(([key,selector])=>[key,parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)])))
try{
 await page.goto(`http://127.0.0.1:${app.server.address().port}`);await page.getByText('本地引擎已连接',{exact:true}).waitFor();await input.waitFor()
 await input.fill('等待布局验证');await input.press('Enter');await page.locator('.composer[data-running]').waitFor()
 await until(async()=>{const saved=JSON.parse(await readFile(resolve(root,'store.json'),'utf8'));return saved[bridge.list()[0]?.id]?.turns.length>0})
 const id=bridge.list()[0].id
 await bridge.plugin.call(id,'todo_note_update',{add_tasks:[{title:'界面字号应同步改变',note:'侧栏任务、菜单、问题、按钮都应跟随设置。'}]})
 await rpc.call('test/append',{threadId:id,id:'context',type:'agentMessage',phase:'final_answer',text:'这里是问题之前的上下文。\n\n'+('请保留可阅读的对话区域。\n\n').repeat(12)})
 const prompt='请确认新电脑的部署环境和文件位置，再选择后续操作。这个问题包含较长的说明，用于验证问答区域能够保留先前对话并让各个选项完整可达。'
 await rpc.call('test/append',{threadId:id,id:'layout-question',type:'agentMessage',phase:'final_answer',delivery:'async',questions:[{title:prompt,options:['环境已就绪','继续查看部署说明','暂时回到对话']}],text:prompt})
 await question.waitFor();await page.locator('.dtn-task-title').first().waitFor();assert.equal(await page.locator('.local-status').count(),0)
 const before=await fonts()
 await page.getByRole('button',{name:'连接与设置',exact:true}).click();await page.getByRole('button',{name:'外观与布局',exact:true}).click()
 await page.getByLabel('界面字号',{exact:true}).focus();await page.keyboard.press('End');await page.getByLabel('正文字号',{exact:true}).focus();await page.keyboard.press('End')
 await until(async()=>{const p=(await bridge.preferences.snapshot()).preferences;return p.uiFontSize===18&&p.fontSize===22})
 await page.getByRole('button',{name:'关闭对话框',exact:true}).click();await page.locator('.settings-dialog[open]').waitFor({state:'hidden'})
 const after=await fonts();for(const key of ['toolbar','todo','tab','sidebar'])assert.ok(after[key]>before[key]+1,`${key}: ${before[key]} -> ${after[key]}`)
 assert.equal(after.body,22);assert.equal(after.prompt,22)
 await bridge.updatePreferences({fontSize:14});await until(async()=>(await fonts()).body===14);assert.equal((await fonts()).toolbar,after.toolbar)
 for(const [width,height,uiFontSize,fontSize] of [[1536,760,12,16],[1280,600,18,22],[1024,640,14,18],[390,700,18,22],[844,390,14,16]]){
  await page.setViewportSize({width,height});await bridge.updatePreferences({uiFontSize,fontSize});await page.waitForTimeout(250)
  await input.fill(('这里是一份较长的输入草稿。\n').repeat(30));await page.waitForTimeout(100)
  const m=await page.evaluate(()=>{const r=s=>{const b=document.querySelector(s).getBoundingClientRect();return {y:b.y,height:b.height,bottom:b.bottom}};return {stage:r('.conversation-stage'),dock:r('.composer-dock'),editor:r('.composer'),overflow:document.documentElement.scrollWidth>innerWidth}})
  const ratio=m.dock.height/m.stage.height,limit=height<=500?.71:Math.min(.68,Math.max(.58,.58+((uiFontSize-14)*8+(fontSize-16)*4)/m.stage.height))+.01
  assert.ok(ratio<=limit,JSON.stringify({width,height,ratio,...m}));assert.ok(m.editor.bottom<=height+1&&!m.overflow,JSON.stringify({width,height,...m}))
  await input.fill('');await question.getByRole('radio',{name:'环境已就绪',exact:true}).check();await question.getByRole('button',{name:'提交回答',exact:true}).scrollIntoViewIfNeeded()
  assert.equal(await question.locator('.question-panel-heading').evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),true,`Question heading stays visible at ${width}x${height}`)
  await question.getByRole('radio',{name:'环境已就绪',exact:true}).scrollIntoViewIfNeeded()
  assert.deepEqual(await page.evaluate(()=>({page:window.scrollY,app:document.querySelector('.app').scrollTop})),{page:0,app:0},'Focusing a question must not scroll the app header out of view')
  results.push({width,height,uiFontSize,fontSize,dockRatio:ratio});await page.screenshot({path:resolve(out,`adaptive-${width}x${height}.png`),fullPage:true})
 }
 await question.getByRole('button',{name:'提交回答',exact:true}).click();await question.waitFor({state:'hidden'});assert.deepEqual(errors,[])
 const result={fontControlsLinked:true,contentAndUiIndependent:true,questionAnswered:true,fontBefore:before,fontAfter:after,viewports:results,pageErrors:errors}
 await writeFile(resolve(out,'adaptive-layout-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}catch(e){await page.screenshot({path:resolve(out,'adaptive-failure.png'),fullPage:true}).catch(()=>{});throw e}
finally{await browser.close();await app.close();await rm(root,{recursive:true,force:true})}
