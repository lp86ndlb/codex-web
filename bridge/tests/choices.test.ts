import test from 'node:test'
import assert from 'node:assert/strict'
import { hasPendingChoice, messageChoices, parseChoice, pendingChoiceMessage, textChoices } from '../shared/choices.ts'
import { applyNotification, projectThread } from '../server/projection.ts'
import { readFileSync } from 'node:fs'
import { applyThreadPatch, mergeView } from '../client/thread-state.ts'

const recorded = JSON.parse(readFileSync(new URL('./fixtures/plain-questions.json', import.meta.url), 'utf8'))
const native = JSON.parse(readFileSync(new URL('./fixtures/native-question.json', import.meta.url), 'utf8'))

test('explicit choice fences validate options and stop waiting after a user response', () => {
  const spec = { id: 'choice-1', question: '请选择', options: ['修复', '说明'] }
  assert.equal(parseChoice(JSON.stringify(spec))?.options.length, 2)
  assert.equal(parseChoice(JSON.stringify({ ...spec, options: ['重复', '重复'] })), null)
  assert.equal(parseChoice(JSON.stringify({ ...spec, options: [{ label: 'bad', description: {} }, 'ok'] })), null)
  const text = '```cweb-choice\n' + JSON.stringify(spec) + '\n```'
  const items = [{ type: 'userMessage', text: '帮我选择' }, { type: 'agentMessage', text }]
  assert.equal(hasPendingChoice(items), true)
  assert.equal(hasPendingChoice([...items, { type: 'userMessage', text: '修复' }]), false)
  const thread = projectThread({ id: 'thread', cwd: '/project', turns: [{ id: 'turn', status: 'completed', items: [{ id: 'agent', type: 'agentMessage', text }] }] })
  assert.equal(thread.choicePending, true)
  assert.equal(applyNotification(thread, 'turn/started', { turn: { id: 'next' } }).choicePending, false)
})

test('actual plain-list questions retain both questions and their original options', () => {
  const questions = textChoices(recorded.multi)
  assert.equal(questions.length, 2)
  assert.deepEqual(questions[0].options.map(row => row.label), ['到拦停时有震动', '到拦停时没有震动', '未能触发拦停'])
  assert.deepEqual(questions[1].options.map(row => row.label), ['有短震', '没有短震', '没有注意'])
  assert.deepEqual(textChoices(recorded.multi), questions)
  assert.equal(textChoices(recorded.single).length, 1)
  assert.equal(messageChoices('请选择哪些模块（可多选）：\n- 前端\n- 后端')[0].multiple, true)
})
test('progress, checked tasks, examples, quoted questions and fenced code never become choices', () => {
  for (const text of ['已完成检查：\n- 前端通过\n- 后端通过', '为什么会这样？\n- 输入未就绪\n- 连接中断', '例如：要选择哪一种？\n- 方案甲\n- 方案乙', '> 要选择哪一种？\n> - 方案甲\n> - 方案乙', '```text\n请选择哪一种？\n- 方案甲\n- 方案乙\n```', '请选择已完成的任务？\n- [x] 完成甲\n- [x] 完成乙']) assert.deepEqual(textChoices(text), [])
})
test('a follow-up commentary does not hide questions; streaming fragments and answered history stay inactive', () => {
  const items = [{ id:'u', type:'userMessage', text:'帮我验证' }, { id:'q',type:'agentMessage',text:recorded.multi,status:'completed' }, { id:'a',type:'agentMessage',text:'请选择实际观察结果。',status:'completed' }]
  assert.equal(pendingChoiceMessage(items)?.id, 'q')
  assert.equal(hasPendingChoice([...items, {id:'reply',type:'userMessage',text:'已确认'}]), false)
  assert.equal(hasPendingChoice([{...items[1],status:'inProgress'}]), false)
})
test('old-engine snapshots and patches derive question attention separately for each session', () => {
  const view = projectThread({ id:'old', turns:[{id:'turn',status:'inProgress',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'验证'}]},{id:'q',type:'agentMessage',text:recorded.multi}]}] })
  const values = mergeView({}, {...view,revision:1,choicePending:false})
  assert.equal(values.old.choicePending,true)
  const result = applyThreadPatch(values,{type:'threadPatch',id:'old',baseRevision:1,revision:2,items:[{id:'reply',type:'userMessage',text:'回答',status:'completed'}],order:['u','q','reply'],changes:{choicePending:true}})
  assert.equal(result.old.choicePending,false)
})

test('the reported single question works with its trailing explanation, including older CLIs', () => {
  const [choice] = textChoices(native.text)
  assert.equal(choice.question, native.questions[0].title)
  assert.deepEqual(choice.options.map(option => option.label), native.questions[0].options)
  assert.equal(textChoices(native.text.replace('我会按你的实际感受调整。', '')).length, 1)
})

test('native async questions survive history, live patches and unrelated commentary without prose parsing', () => {
  const structured = { ...native, text: '这些问题请在卡片中作答。', questions: [...native.questions, {title:'补充你的使用场景',options:null}] }
  let thread = projectThread({id:'native',turns:[{id:'turn',status:'inProgress',items:[structured]}]})
  assert.deepEqual(thread.items[0].questions, structured.questions)
  assert.equal(thread.items[0].delivery, 'async')
  assert.equal(thread.choicePending, true)
  const specs = messageChoices(thread.items[0])
  assert.equal(specs.length, 2)
  assert.equal(specs[1].question, '补充你的使用场景')
  assert.deepEqual(specs[1].options, [])
  thread = applyNotification(thread, 'item/completed', {turnId:'turn',item:{id:'progress',type:'agentMessage',text:'继续核对其他内容。'}})
  assert.equal(pendingChoiceMessage(thread.items)?.id, native.id)
  const next = applyNotification(thread, 'item/completed', {turnId:'turn',item:{...structured,id:'new-question'}})
  const values = applyThreadPatch({native:{...thread,revision:1}}, {type:'threadPatch',id:'native',baseRevision:1,revision:2,items:[next.items.at(-1)!],order:next.items.map(item=>item.id),changes:{choicePending:next.choicePending}})
  assert.equal(pendingChoiceMessage(values.native.items)?.id, 'new-question')
  assert.equal(messageChoices(values.native.items.at(-1)!).length, 2)
  const answered = applyNotification(next, 'item/completed', {turnId:'turn',item:{id:'reply',type:'userMessage',content:[{type:'text',text:'我的回答'}]}})
  assert.equal(answered.choicePending, false)
})
