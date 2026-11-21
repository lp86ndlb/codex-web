import test from 'node:test'
import assert from 'node:assert/strict'
import { recoveryPolicy, hasRecoveryOutput } from '../server/auto-recovery.ts'
import { projectThread } from '../server/projection.ts'

function failed(error = 'stream disconnected before completion: Broken pipe') {
  return projectThread({ id: 't', turns: [{ id: 'failed', status: 'failed', error: { message: error }, items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Read the fixture' }] }] }] })
}

test('a confirmed transport failure before any execution is eligible; active work and ambiguous failures are not', () => {
  assert.equal(recoveryPolicy(failed(), 'failed').allowed, true)
  assert.equal(recoveryPolicy(failed('request timed out'), 'failed').allowed, true)
  for (const error of ['Unknown error', 'permission denied after connection reset', 'HTTP 429 stream disconnected', 'Quota exceeded: network error', 'invalid request: WebSocket failed', '上下文超出限制，请求超时']) {
    assert.equal(recoveryPolicy(failed(error), 'failed').allowed, false, error)
  }
  assert.equal(recoveryPolicy({ ...failed(), status: 'inProgress', turnId: 'failed' }, 'failed').allowed, false)
  assert.equal(recoveryPolicy({ ...failed(), status: 'interrupted' }, 'failed').allowed, false)
  assert.equal(recoveryPolicy(failed(), 'another-turn').allowed, false)
})

test('side effects, final replies, approvals, external ownership and large context fence automatic replay', () => {
  for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'unrecognizedFutureOperation']) {
    const thread = failed()
    thread.items.push({ id: 'operation', turnId: 'failed', type, status: 'failed', text: '' })
    assert.equal(recoveryPolicy(thread, 'failed').allowed, false, `A ${type} must not be silently replayed`)
  }
  const answered = failed()
  answered.items.push({ id: 'answer', turnId: 'failed', type: 'agentMessage', phase: 'final_answer', status: 'completed', text: 'Already delivered' })
  assert.equal(recoveryPolicy(answered, 'failed').allowed, false)
  assert.equal(recoveryPolicy(failed(), 'failed', true).allowed, false)
  assert.equal(recoveryPolicy({ ...failed(), choicePending: true }, 'failed').allowed, false)
  assert.equal(recoveryPolicy({ ...failed(), externalOwner: 1234 }, 'failed').allowed, false)
  assert.equal(recoveryPolicy({ ...failed(), contextUsage: { inputTokens: 350_000, windowTokens: 475_000, updatedAt: 1 } }, 'failed').allowed, false)
})

test('upstream cybersecurity/content restrictions never retry, including mixed transport text and already executed tools', () => {
  const error = 'Stream disconnected before completion: Your request was flagged for possible cybersecurity risk.'
  const thread = failed(error)
  const plain = recoveryPolicy(thread, 'failed')
  assert.equal(plain.allowed, false)
  assert.match(plain.message, /上游模型报告内容安全拦截/)
  assert.match(plain.message, /无法确定触发内容/)
  for (let i = 0; i < 43; i++) thread.items.push({ id: `tool-${i}`, turnId: 'failed', type: 'commandExecution', status: 'completed', text: 'fixture' })
  const afterExecution = recoveryPolicy(thread, 'failed')
  assert.equal(afterExecution.allowed, false)
  assert.equal(afterExecution.message, plain.message, 'Show the precise reported reason without blaming the first message')
  assert.equal(thread.error, error, 'Classification must not replace the original error')
})

test('only model output or a newly started tool marks response recovery, not a heartbeat or user echo', () => {
  assert.equal(hasRecoveryOutput('item/agentMessage/delta', { delta: 'Recovered response' }), true)
  assert.equal(hasRecoveryOutput('item/agentMessage/delta', { delta: ' ' }), false)
  assert.equal(hasRecoveryOutput('item/started', { item: { type: 'userMessage' } }), false)
  assert.equal(hasRecoveryOutput('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 10 } } }), false)
  assert.equal(hasRecoveryOutput('item/started', { item: { type: 'commandExecution' } }), true)
})
