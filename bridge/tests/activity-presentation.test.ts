import test from 'node:test'
import assert from 'node:assert/strict'
import { activityExpansion } from '../shared/activity-presentation.ts'
import type { Item, ThreadView } from '../shared/types.ts'

const item = (id: string, type: string, turnId?: string, status = 'completed'): Item => ({ id, type, turnId, status, text: id })
const state = (status: ThreadView['status'] = 'completed', turnId: string | null = null, runs: ThreadView['runs'] = []) => ({ status, turnId, runs })
const first = [item('u1', 'userMessage', 't1'), item('s1', 'commandExecution', 't1')]

test('completion folds only settled work while next-input keeps the latest completed interaction visible', () => {
  assert.equal(activityExpansion(first, state(), true, 'completion').get('s1'), false)
  assert.equal(activityExpansion(first, state(), true, 'next-input').get('s1'), true)
  assert.equal(activityExpansion(first, state('inProgress', 't1'), true, 'completion').get('s1'), true)
  const next = [...first, item('u2', 'userMessage', 't2'), item('s2', 'commandExecution', 't2')]
  const policy = activityExpansion(next, state('inProgress', 't2'), true, 'next-input')
  assert.equal(policy.get('s1'), false); assert.equal(policy.get('s2'), true)
})

test('delivered steering starts a new message segment while queued input and autonomous continuation do not', () => {
  const items = [...first, item('steer', 'userMessage', 't1'), item('background', 'commandExecution', 'background')]
  let policy = activityExpansion(items, state(), true, 'next-input')
  assert.equal(policy.get('s1'), false); assert.equal(policy.get('background'), true)
  policy = activityExpansion([...first, item('pending', 'userMessage', undefined, 'sending')], state('inProgress', 't1'), true, 'next-input')
  assert.equal(policy.get('s1'), true)
  policy = activityExpansion([...items, item('u2', 'userMessage', 't2')], state('inProgress', 't2'), true, 'next-input')
  assert.equal(policy.get('s1'), false); assert.equal(policy.get('background'), false)
})

test('a completed native turn with several user messages folds all earlier message segments after reload', () => {
  const items = [
    ...first, item('u2', 'userMessage', 't1'), item('s2', 'reasoning', 't1'),
    item('u3', 'userMessage', 't1'), item('s3', 'commandExecution', 't1'),
  ]
  const policy = activityExpansion(items, state('completed', null, [{ id: 't1', status: 'completed' }]), true, 'next-input')
  assert.equal(policy.get('s1'), false)
  assert.equal(policy.get('s2'), false)
  assert.equal(policy.get('s3'), true)
})

test('historical failed and interrupted runs fold when a later user message is delivered', () => {
  const items = [
    ...first, item('u2', 'userMessage', 't2'), item('s2', 'commandExecution', 't2', 'failed'),
    item('u3', 'userMessage', 't3'), item('s3', 'reasoning', 't3'),
  ]
  const runs = [{ id: 't1', status: 'interrupted' }, { id: 't2', status: 'failed' }, { id: 't3', status: 'completed' }]
  for (const timing of ['next-input', 'completion'] as const) {
    const policy = activityExpansion(items, state('completed', null, runs), true, timing)
    assert.equal(policy.get('s1'), false)
    assert.equal(policy.get('s2'), false)
    assert.equal(policy.get('s3'), timing === 'next-input')
  }
})

test('steering folds completed work in the same running turn but keeps the actual in-progress operation visible', () => {
  const items = [...first, item('working', 'commandExecution', 't1', 'inProgress'), item('steer', 'userMessage', 't1'), item('new-work', 'reasoning', 't1')]
  for (const timing of ['next-input', 'completion'] as const) {
    const policy = activityExpansion(items, state('inProgress', 't1'), true, timing)
    assert.equal(policy.get('s1'), false)
    assert.equal(policy.get('working'), true)
    assert.equal(policy.get('new-work'), true)
  }
})

test('an unsent failed user bubble does not fold the latest completed question', () => {
  const policy = activityExpansion([...first, item('failed-send', 'userMessage', undefined, 'failed')], state(), true, 'next-input')
  assert.equal(policy.get('s1'), true)
})

test('a completed transcript does not keep steps open because of stale run metrics', () => {
  assert.equal(activityExpansion(first, state('completed', null, [{ id: 't1', status: 'inProgress' }]), true, 'completion').get('s1'), false)
})

test('a new optimistic idle input folds the preceding interaction, and legacy history resolves without turn ids', () => {
  const pending = [...first, item('pending', 'userMessage', undefined, 'sending')]
  assert.equal(activityExpansion(pending, state(), true, 'next-input').get('s1'), false)
  const legacy = [item('old-user', 'userMessage'), item('old-step', 'reasoning'), item('new-user', 'userMessage'), item('new-step', 'reasoning')]
  const policy = activityExpansion(legacy, state(), true, 'next-input')
  assert.equal(policy.get('old-step'), false); assert.equal(policy.get('new-step'), true)
})

test('never leaves all steps visible, hidden-details preference stays respected, and failed work remains inspectable', () => {
  const items = [...first, item('u2', 'userMessage', 't2'), item('s2', 'commandExecution', 't2')]
  assert.deepEqual([...activityExpansion(items, state(), true, 'never').values()], [true, true, true, true])
  assert.deepEqual([...activityExpansion(items, state('inProgress', 't2'), false, 'never').values()], [false, false, false, false])
  assert.equal(activityExpansion(first, state('failed', null, [{ id: 't1', status: 'failed' }]), true, 'completion').get('s1'), true)
})
