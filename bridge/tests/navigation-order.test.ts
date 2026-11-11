import test from 'node:test'
import assert from 'node:assert/strict'
import type { ThreadView } from '../shared/types.ts'
import { appendNavigation, moveNavigation, orderedNavigation, readNavigation, unreadCompletion } from '../shared/navigation-order.ts'
test('manual order survives activity reordering, new ids append and unrelated ids retain order', () => {
  const order = ['a', 'b', 'c']
  assert.deepEqual(orderedNavigation([{ id: 'c' }, { id: 'a' }, { id: 'b' }], order).map(row => row.id), order)
  assert.deepEqual(appendNavigation(order, ['new', 'c', 'a', 'b']), ['a', 'b', 'c', 'new'])
  assert.deepEqual(moveNavigation(['a', 'other', 'b', 'c'], 'c', 'a'), ['c', 'a', 'other', 'b'])
  assert.deepEqual(moveNavigation(order, 'a', null), ['b', 'c', 'a'])
  assert.equal(moveNavigation(order, 'a', 'a'), order)
})
test('navigation preferences preserve explicit folder state and safely read damaged storage', () => {
  assert.deepEqual(readNavigation('bad json'), { version: 1, workspaces: [], threads: [], collapsed: {}, read: {} })
  const value = readNavigation('{"workspaces":["a","a",2],"threads":["t"],"collapsed":{"a":true,"b":false,"bad":"yes"}}')
  assert.deepEqual(value, { version: 1, workspaces: ['a'], threads: ['t'], collapsed: { a: true, b: false }, read: {} })
})

test('completion marks clear when opened, survive hydration and return only for a later run', () => {
  const summary = { id:'t', title:'task', cwd:'/project', updatedAt:Date.now()/1000-1 }
  const read = { at:Date.now(), turn:'old' }
  const view = { runs:[{id:'old', status:'completed', completedAt:read.at-1000}] } as ThreadView
  assert.equal(unreadCompletion(summary, undefined, read), false)
  assert.equal(unreadCompletion(summary, view, read), false)
  assert.equal(unreadCompletion(summary, {...view,runs:[{id:'hydrated-after-click',status:'completed',completedAt:read.at-1}]},read),false)
  assert.equal(unreadCompletion(summary, {...view,runs:[{id:'new',status:'completed',completedAt:read.at+1}]},read),true)
  assert.equal(unreadCompletion(summary, undefined, undefined),true)
})
