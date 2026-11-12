import test from 'node:test'
import assert from 'node:assert/strict'
import { applyNotification, projectItem, projectThread } from '../server/projection.ts'
import { describeCommand } from '../shared/activity.ts'

test('reasoning renders public summaries only and does not erase streamed summary text on completion', () => {
  assert.equal(projectItem({ id: 'r', type: 'reasoning', summary: [], content: ['not a public summary'] }).text, '')
  let thread = projectThread({ id: 't', turns: [] })
  thread = applyNotification(thread, 'item/started', { item: { id: 'r', type: 'reasoning', summary: [] } })
  thread = applyNotification(thread, 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: '检查文件' })
  thread = applyNotification(thread, 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 1, delta: '验证结果' })
  thread = applyNotification(thread, 'item/completed', { item: { id: 'r', type: 'reasoning', summary: [] } })
  assert.equal(thread.items[0].text, '检查文件\n\n验证结果')
  assert.equal(thread.items[0].status, 'completed')
})

test('observable commands and MCP calls have short action descriptions and readable results', () => {
  assert.equal(describeCommand('cat /project/file.ts', [{ type: 'read', name: 'file.ts', path: '/project/file.ts' }]), '读取 file.ts')
  assert.equal(describeCommand('npm run check'), '检查代码类型与静态错误')
  assert.equal(describeCommand('npm test'), '运行测试并检查结果')
  assert.equal(describeCommand('git diff'), '检查代码变更')
  const tool = projectItem({ type: 'mcpToolCall', id: 'm', tool: 'todo_note_update', status: 'completed', result: { content: [{ type: 'text', text: '已更新' }] } })
  assert.equal(tool.activity, '更新待办便签'); assert.equal(tool.text, '已更新')
  assert.equal(projectItem({ type: 'dynamicToolCall', id: 'd' }).text, '')
})

test('native context compaction exposes its lifecycle and survives history hydration', () => {
  const item = { id: 'compact', type: 'contextCompaction', startedAtMs: 1000, completedAtMs: null }
  assert.equal(projectItem(item).status, 'inProgress')
  assert.equal(projectItem({ ...item, completedAtMs: 2000 }).status, 'completed')
  const active = projectThread({ id: 't', turns: [{ id: 'current', status: 'inProgress', startedAt: 1, items: [item] }] })
  assert.equal(active.progress?.stage, 'compacting')
  const done = projectThread({ id: 't', turns: [{ id: 'old', status: 'completed', items: [item] }, { id: 'new', status: 'inProgress', items: [] }] })
  assert.equal(done.progress?.stage, 'working', 'An unfinished historic compaction must not label a newer turn')
})

test('model retry is visible, keeps the turn alive and clears only on model progress', () => {
  let thread = applyNotification(projectThread({ id: 't', turns: [] }), 'turn/started', { turn: { id: 'run', status: 'inProgress' } })
  thread = applyNotification(thread, 'item/started', { turnId: 'run', item: { id: 'c', type: 'contextCompaction' } })
  assert.equal(thread.progress?.stage, 'compacting')
  thread = applyNotification(thread, 'error', { turnId: 'run', willRetry: true, error: { message: 'stream disconnected', additionalDetails: 'Retrying request' } })
  assert.equal(thread.status, 'inProgress'); assert.equal(thread.turnId, 'run'); assert.equal(thread.error, null)
  assert.equal(thread.progress?.stage, 'retrying'); assert.equal(thread.progress?.attempt, 1)
  assert.match(thread.progress?.message || '', /Retrying request/)
  thread = applyNotification(thread, 'item/completed', { turnId: 'run', item: { id: 'background', type: 'commandExecution', status: 'completed' } })
  assert.equal(thread.progress?.stage, 'retrying', 'Background tool completion cannot prove model recovery')
  thread = applyNotification(thread, 'error', { turnId: 'run', willRetry: true, error: { message: 'retry again' } })
  assert.equal(thread.progress?.attempt, 2)
  thread = applyNotification(thread, 'item/reasoning/summaryTextDelta', { turnId: 'run', itemId: 'summary', delta: '恢复后的进展' })
  assert.equal(thread.progress?.stage, 'working'); assert.equal(thread.error, null)
  thread = applyNotification(thread, 'turn/completed', { turn: { id: 'run', status: 'completed' } })
  assert.equal(thread.progress, undefined); assert.equal(thread.turnId, null)
})

test('permanent errors end UI running state and cannot terminate a newer turn', () => {
  let thread = applyNotification(projectThread({ id: 't', turns: [] }), 'turn/started', { turn: { id: 'first', status: 'inProgress' } })
  thread = applyNotification(thread, 'item/started', { turnId: 'first', item: { id: 'c', type: 'contextCompaction' } })
  const failed = applyNotification(thread, 'error', { turnId: 'first', willRetry: false, error: { message: 'request failed' } })
  assert.equal(failed.status, 'failed'); assert.equal(failed.turnId, null); assert.equal(failed.progress, undefined)
  assert.equal(failed.runs?.at(-1)?.status, 'failed'); assert.ok(failed.runs?.at(-1)?.completedAt)
  assert.equal(failed.items.at(-1)?.status, 'failed')
  const newer = applyNotification(failed, 'turn/started', { turn: { id: 'second', status: 'inProgress' } })
  assert.equal(applyNotification(newer, 'error', { turnId: 'first', willRetry: false, error: { message: 'late error' } }), newer)
  assert.equal(applyNotification(newer, 'turn/completed', { turn: { id: 'first', status: 'completed' } }), newer)
  assert.equal(applyNotification(failed, 'error', { turnId: 'first', willRetry: true, error: { message: 'late retry' } }), failed)
  const complete = applyNotification(newer, 'turn/completed', { turn: { id: 'second', status: 'completed' } })
  assert.equal(applyNotification(complete, 'error', { turnId: 'first', willRetry: false, error: { message: 'outdated error' } }), complete)
  assert.equal(applyNotification(complete, 'error', { turnId: 'second', willRetry: false, error: { message: 'terminal duplicate' } }), complete)
})

test('the deprecated compaction-complete event also restores normal progress', () => {
  let thread = applyNotification(projectThread({ id: 't', turns: [] }), 'turn/started', { turn: { id: 'run', status: 'inProgress' } })
  thread = applyNotification(thread, 'item/started', { turnId: 'run', item: { id: 'c', type: 'contextCompaction' } })
  thread = applyNotification(thread, 'thread/compacted', { turnId: 'run' })
  assert.equal(thread.progress?.stage, 'working'); assert.equal(thread.items.at(-1)?.status, 'completed')
})
