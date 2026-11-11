import test from 'node:test'
import assert from 'node:assert/strict'
import { newThreadNotices, threadActivity, type ThreadActivity } from '../shared/thread-notices.ts'

const activity = (patch: Partial<ThreadActivity> = {}): ThreadActivity => ({ id: 't', title: '任务', cwd: '/project', status: 'idle', attention: false, updatedAt: 1, turn: 'turn', ...patch })
const state = (patch: Partial<ThreadActivity> = {}) => new Map([['t', activity(patch)]])
test('notifications represent new transitions, not existing history or repeated stream updates', () => {
  assert.deepEqual(newThreadNotices(new Map(), state({ status: 'completed' })), [])
  assert.equal(newThreadNotices(state({ status: 'inProgress' }), state({ status: 'completed', updatedAt: 2 }))[0].kind, 'completed')
  assert.deepEqual(newThreadNotices(state({ status: 'completed' }), state({ status: 'completed', updatedAt: 3 })), [])
  assert.equal(newThreadNotices(state(), state({ attention: true }))[0].kind, 'waiting')
  assert.deepEqual(newThreadNotices(state({ attention: true }), state({ attention: true, updatedAt: 2 })), [])
})
test('an explicit choice waits for a reply even when the model turn has completed', () => {
  const result = newThreadNotices(state({ status: 'inProgress' }), state({ status: 'completed', attention: true }))
  assert.equal(result.length, 1); assert.equal(result[0].kind, 'waiting')
  const summary = { id: 't', title: '任务', cwd: '/project', updatedAt: 2, attention: true }
  assert.equal(threadActivity([summary], {}, []).get('t')!.attention, true)
})
test('a fast completed turn still notifies when React batches its running state', () => {
  assert.equal(newThreadNotices(state({ loaded: true, status: 'completed', turn: 'old' }), state({ loaded: true, status: 'completed', turn: 'new', updatedAt: 2 }))[0].kind, 'completed')
  assert.deepEqual(newThreadNotices(state({ loaded: false, status: 'completed', turn: '' }), state({ loaded: true, status: 'completed', turn: 'historical', updatedAt: 1 })), [])
  assert.equal(newThreadNotices(new Map(), state({ fresh: true, loaded: true, status: 'completed', turn: 'just-finished' }))[0].kind, 'completed')
})
test('new background requests notify even before a thread snapshot or when another question was already pending', () => {
  assert.equal(newThreadNotices(new Map(), state({ attention: true, attentionKey: 'first-request' }))[0].kind, 'waiting')
  const question = newThreadNotices(state({ attention: true, attentionKey: 'first-request' }), state({ attention: true, attentionKey: 'second-request' }))
  assert.equal(question[0].kind, 'waiting'); assert.match(question[0].key, /second-request/)
  assert.deepEqual(newThreadNotices(state({ attention: true, attentionKey: 'summary' }), state({ attention: true, attentionKey: 'request-metadata' })), [])
  const approval = { id: 'request', threadId: 'new', questions: [{ id: 'q', question: '选择一个选项' }] } as never
  assert.equal(threadActivity([], {}, [approval]).get('new')?.attention, true)
})
test('resolving a pending reply after completion still produces a completion notification', () => {
  assert.equal(newThreadNotices(state({ status: 'completed', attention: true }), state({ status: 'completed', attention: false }))[0].kind, 'completed')
})

test('follow-up progress keeps the same question identity; only another question notifies again', () => {
  const question={id:'q1',type:'agentMessage',text:'请选择哪一种？\n- 方案甲\n- 方案乙',status:'completed'}
  const view={id:'t',title:'任务',cwd:'/project',status:'inProgress',choicePending:true,updatedAt:1,items:[question]} as never
  const first=threadActivity([], {t:view}, [])
  const progress=threadActivity([], {t:{...view as object,items:[question,{id:'progress',type:'agentMessage',text:'等待你的观察，同时继续核对日志。',status:'completed'}]} as never}, [])
  assert.deepEqual(newThreadNotices(first,progress),[])
  const next=threadActivity([], {t:{...view as object,items:[question,{...question,id:'q2'}]} as never}, [])
  assert.equal(newThreadNotices(progress,next)[0].kind,'waiting')
})
