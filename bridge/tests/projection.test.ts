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
