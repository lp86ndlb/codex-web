import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeActivity, retainThreadViews } from '../client/view-cache.ts'
import { applyThreadPatch } from '../client/thread-state.ts'
import { newThreadNotices, threadActivity } from '../shared/thread-notices.ts'
import type { ThreadView } from '../shared/types.ts'

const view = (id: string): ThreadView => ({ id, revision: 1, title: id, cwd: '/project', status: 'inProgress', updatedAt: 1, turnId: 'turn', model: '', tokens: 0, error: null, diff: 'large diff', plan: [], items: [{ id: 'tool', type: 'commandExecution', text: 'large output', status: 'inProgress' }], runs: [{ id: 'old', status: 'completed', startedAt: 1, completedAt: 2 }, { id: 'turn', status: 'inProgress', startedAt: 3 }] })
test('background activity keeps badges and notices without raw history', () => {
  const original = view('one'), first = observeActivity({}, original)
  assert.equal(first.one.items, undefined); assert.equal(first.one.runs?.length, 1)
  assert.ok(!JSON.stringify(first).includes('large'))
  const before = threadActivity([], first, [])
  const finished = observeActivity(first, { type: 'threadPatch', id: 'one', baseRevision: 1, revision: 2, items: [], changes: { status: 'completed', turnId: null, updatedAt: 2, runs: [{ id: 'turn', status: 'completed', startedAt: 3, completedAt: 4 }] } })
  assert.equal(newThreadNotices(before, threadActivity([], finished, []))[0]?.kind, 'completed')
  const question = observeActivity(finished, { type: 'threadPatch', id: 'one', baseRevision: 2, revision: 3, items: [{ id: 'question', type: 'agentMessage', text: '', status: 'completed', delivery: 'async', questions: [{ title: '选择哪种方式？', options: ['甲', '乙'] }] }], changes: { choicePending: true } })
  assert.equal(newThreadNotices(threadActivity([], finished, []), threadActivity([], question, []))[0]?.kind, 'waiting')
  assert.equal(question.one.choiceId, 'question'); assert.equal(question.one.items, undefined)
  assert.equal(observeActivity(question, original), question, 'stale snapshots cannot replace a new question')
})
test('output-only patches keep activity and item identities stable', () => {
  const original = view('one'), first = observeActivity({}, original)
  assert.equal(observeActivity(first, { type: 'threadPatch', id: 'one', baseRevision: 1, revision: 2, items: [{ ...original.items[0], text: 'more output' }], changes: {} }), first)
  const updated = applyThreadPatch({ one: original }, { type: 'threadPatch', id: 'one', baseRevision: 1, revision: 2, items: [], changes: { tokens: 42 } })
  assert.equal(updated.one.items, original.items); assert.equal(updated.one.tokens, 42)
})
test('cache limit retains current, pending and action targets, without deleting drafts/history', () => {
  const views = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [String(index), view(String(index))]))
  const result = retainThreadViews(views, new Set(['0', '1']), ['2', '3', '10', '11'])
  assert.deepEqual(Object.keys(result), ['0', '1', '10', '11'])
  assert.equal(Object.keys(views).length, 12); assert.equal(result['0'], views['0'])
  assert.equal(retainThreadViews(result, new Set(['0']), ['1', '10', '11']), result)
  assert.equal(Object.keys(retainThreadViews(views, new Set(['0', '1', '2', '3', '4']), [])).length, 5, 'in-flight targets are never evicted')
})
