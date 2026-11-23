import assert from 'node:assert/strict'
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {chromium} from 'playwright'
import {CodexRpc} from '../server/rpc.ts'
import {Bridge} from '../server/bridge.ts'
import {Workspace} from '../server/workspace.ts'
import {createHttpServer} from '../server/http.ts'

const output=resolve('test-results');await mkdir(output,{recursive:true})
const root=await mkdtemp(resolve(output,'history-loading-')),cwd=resolve(root,'project');await mkdir(cwd)
const id=randomUUID(),store=resolve(root,'sessions.json'),log=resolve(root,'rpc.jsonl'),count=200
const turns=Array.from({length:count},(_,i)=>({id:'turn-'+(i+1),status:'completed',startedAt:1700000000+i*10,completedAt:1700000005+i*10,items:[
  {id:'user-'+(i+1),type:'userMessage',content:[{type:'text',text:'历史问题 '+(i+1)}]},
  {id:'tool-'+(i+1),type:'commandExecution',command:'pwd',status:'completed',exitCode:0,aggregatedOutput:'SYNTHETIC RAW OUTPUT\n'.repeat(500)},
  {id:'comment-'+(i+1),type:'agentMessage',phase:'commentary',text:'简短过程说明 '+(i+1)},
  {id:'answer-'+(i+1),type:'agentMessage',phase:'final_answer',text:'历史回答 '+(i+1)},
]}))
// More than two native pages collapse into one row, as in a team member's inbox.
const memberId=randomUUID()
const privateTurns=turns.slice(0,16)
const teamTurns=Array.from({length:18},(_,i)=>({
  id:'team-turn-'+i, status:'completed', startedAt:1700000300+i*10, completedAt:1700000305+i*10,
  items:[{id:'delivery-'+i,type:'userMessage',content:[{type:'text',text:'团队任务 '+i}]},
    {id:'team-result-'+i,type:'agentMessage',phase:'final_answer',text:'团队回复 '+i}],
}))
await writeFile(store,JSON.stringify({
  [id]:{id,name:'按需历史加载验证',cwd,historyMode:'paginated',updatedAt:1700002000,turns},
  [memberId]:{id:memberId,name:'连续折叠团队回溯',cwd,historyMode:'paginated',updatedAt:1700001000,turns:[...privateTurns,...teamTurns]},
}))
const rpc=new CodexRpc({command:process.execPath,args:[resolve('tests/fake-codex.mjs')],cwd,env:{...process.env,FAKE_STORE:store,FAKE_LOG:log}}),bridge=new Bridge(rpc,new Workspace(cwd),resolve(root,'home'),resolve(root,'data'),false,{workspaceTeams:true})
await bridge.plugin.setEnabled(false)
const app=createHttpServer({bridge,dist:resolve(process.env.CWEB_TEST_DIST||'dist')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:'/usr/bin/microsoft-edge',headless:true,ignoreDefaultArgs:['--headless=old'],args:['--headless=new','--no-sandbox','--disable-dev-shm-usage']}),page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'}),errors=[]
page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(id=>localStorage.setItem('cweb:thread',id),id)
const transcript=page.locator('.transcript'),conversation=page.getByLabel('会话内容',{exact:true}),older=page.locator('.history-load-older')
const calls=async()=>(await readFile(log,'utf8')).trim().split('\n').map(x=>JSON.parse(x)).filter(x=>x.method==='thread/turns/list')
const until=async(check,label='History UI did not settle')=>{for(let i=0;i<200;i++){if(await check())return;await page.waitForTimeout(25)}assert.fail(label)}
async function top(){await conversation.evaluate(node=>{node.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));node.scrollTop=0});await page.waitForTimeout(50)}
let release,historyRequests=0;const requestPaths=[]
page.on('request',request=>{if(request.url().includes('/history'))requestPaths.push(new URL(request.url()).pathname)})
try{
  const start=Date.now();await page.goto('http://127.0.0.1:'+app.server.address().port)
  await page.locator('[data-message-id="answer-200"]').waitFor();const readyMs=Date.now()-start
  const initial=await bridge.open(id),initialReads=(await calls()).length
  assert.ok(initial.runs.length<=8);assert.ok(initial.history.hasOlder)
  assert.equal(initialReads,1,'Opening a topic eagerly requested more than one native history page')
  assert.equal(await page.locator('[data-message-id="user-1"]').count(),0)
  assert.equal(await page.locator('.tool-output').count(),0)
  const first=initial.items.find(x=>x.type==='userMessage').id
  const gate=new Promise(r=>release=r)
  await page.route('**/api/threads/*/history?**',async route=>{historyRequests++;await gate;await route.continue()})
  await top()
  const before=await page.locator(`[data-message-id="${first}"]`).evaluate(n=>n.getBoundingClientRect().top-n.closest('.conversation').getBoundingClientRect().top)
  await older.click();await until(()=>historyRequests===1)
  assert.equal(await older.isDisabled(),true)
  await conversation.evaluate(n=>{for(let i=0;i<8;i++)n.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true}))})
  assert.equal(historyRequests,1)
  await rpc.call('test/append',{threadId:id,text:'分页期间的新回复',phase:'final_answer'})
  release();await until(async()=>!(await older.isDisabled()))
  await until(()=>Promise.resolve(bridge.threads.get(id).runs.length>initial.runs.length))
  const after=await page.locator(`[data-message-id="${first}"]`).evaluate(n=>n.getBoundingClientRect().top-n.closest('.conversation').getBoundingClientRect().top)
  assert.ok(Math.abs(before-after)<3,`Remote prepend shifted the reading anchor by ${after-before}px`)
  assert.equal(await page.locator('.agent-message').filter({hasText:'分页期间的新回复'}).count(),1)
  assert.ok(Number(await transcript.getAttribute('data-window-rows'))<=120)
  await page.unroute('**/api/threads/*/history?**')
  await page.screenshot({path:resolve(output,'history-loading-older.png'),fullPage:true})

  await top();let rejected=false
  await page.route('**/api/threads/*/history?**',async route=>{if(!rejected){rejected=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SYNTHETIC',message:'历史加载暂时失败，请重试'}})})}else await route.continue()})
  await older.click();await page.getByText('历史加载暂时失败，请重试',{exact:true}).waitFor()
  await older.click();await until(async()=>await page.getByText('历史加载暂时失败，请重试',{exact:true}).count()===0)
  await until(async()=>await older.isDisabled()===false)
  assert.ok(await transcript.locator('*').count()<6000)
  // Check real native pagination with a fixture delivery ledger. Ordinary topics above still open with one read.
  await page.unroute('**/api/threads/*/history?**')
  await page.route('**/api/team?*', async route => {
    const response=await route.fetch(), state=await response.json()
    state.messages=teamTurns.map((t,i)=>({id:'row-'+i,to:memberId,deliveryId:t.items[0].id,state:'delivered',title:'团队任务 '+i,reviews:[]}))
    await route.fulfill({response,json:state})
  })
  let foldedRequests=0
  const foldedHistory='**/api/threads/'+memberId+'/history?**'
  await page.route(foldedHistory,async route=>{
    foldedRequests++
    if(foldedRequests===2) return route.fulfill({status:503,json:{error:{code:'FIXTURE',message:'折叠回溯暂不可用'}}})
    await route.continue()
  })
  await page.reload()
  await page.locator(`[data-thread-id="${memberId}"]`).click()
  await transcript.getByText('折叠回溯暂不可用',{exact:true}).waitFor()
  await page.waitForTimeout(500)
  assert.equal(foldedRequests,2,'Failed page cannot spin in an automatic retry loop')
  await transcript.getByText('当前载入范围内没有个人对话',{exact:true}).waitFor()
  await older.click()
  await transcript.getByText('历史问题 16',{exact:true}).waitFor()
  assert.equal(await transcript.getByText('团队回复 0',{exact:true}).count(),0)
  await page.waitForTimeout(450)
  assert.equal(foldedRequests,4,'Three distinct pages, one retry; stop once visible history fills the viewport')
  assert.deepEqual(errors,[])
  const result={initialTurns:initial.runs.length,initialBytes:Buffer.byteLength(JSON.stringify(initial)),initialNativeReads:initialReads,readyMs,oldestNotMounted:true,remoteSingleFlight:true,anchorError:Math.abs(before-after),liveReplyOnce:true,retryWorks:true,boundedDom:true,pageErrors:errors}
  await writeFile(resolve(output,'history-loading-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}catch(error){console.log(JSON.stringify({historyRequests,requestPaths}));await page.screenshot({path:resolve(output,'history-loading-failure.png'),fullPage:true}).catch(()=>{});throw error}
finally{release?.();await browser.close();await app.close();await rm(root,{recursive:true,force:true})}
