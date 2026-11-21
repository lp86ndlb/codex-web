import test from 'node:test'
import assert from 'node:assert/strict'
import { contentRestriction } from '../shared/model-errors.ts'
import { classifyFailure } from '../shared/connection.ts'

test('explicit content restrictions are not categorized as transport, authentication or permission failures', () => {
  for (const error of [
    'Your request was flagged for possible cybersecurity risk.',
    'Stream disconnected before completion: Your request was flagged for possible cybersecurity risk.',
    'HTTP 403: request blocked due to content safety policy; network connection closed',
    'content_policy_violation', 'content-filter', 'safety_violation',
    '模型请求被内容安全策略拒绝',
  ]) {
    const original = error
    assert.ok(contentRestriction(error), error)
    assert.equal(classifyFailure(error).kind, 'content', error)
    assert.match(classifyFailure(error).next, /无法确定触发内容/)
    assert.match(classifyFailure(error).next, /不适合自动重试/)
    assert.equal(error, original)
  }
})

test('technical vocabulary, project facts and unrelated errors are not evidence of an upstream content restriction', () => {
  for (const error of [
    '', null, undefined, 'ROS2 Packet decoder failed',
    'cybersecurity risk review is required', 'Packet parser failed after connection reset',
    '安全策略配置文件无法读取', 'Permission denied', 'HTTP 429', 'Broken pipe',
  ]) assert.equal(contentRestriction(error), undefined, String(error))
  assert.equal(classifyFailure('Packet parser failed after connection reset').kind, 'network')
  assert.equal(classifyFailure('HTTP 403 Permission denied').kind, 'permission')
})
