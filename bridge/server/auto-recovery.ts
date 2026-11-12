import type { ThreadView } from '../shared/types.ts'
import { record, string } from './errors.ts'

/** Conservative replay policy. Native retries and activity are not failures. */
export function recoveryPolicy(thread: ThreadView, turnId: string, pending = false): { allowed: boolean; message: string } {
  const deny = (message: string) => ({ allowed: false, message })
  if (thread.turnId || thread.status !== 'failed' || thread.runs?.at(-1)?.id !== turnId) return deny('任务尚未明确失败，未自动重发。')
  if (thread.externalOwner || pending || thread.choicePending) return deny('会话正在等待确认或由其他端管理，请手动继续。')
  const usage = thread.contextUsage
  if (usage && usage.windowTokens > 0 && usage.inputTokens / usage.windowTokens >= .7) return deny('上下文较大，请先检查会话并考虑压缩后继续。')
  const items = thread.items.filter(item => item.turnId === turnId)
  if (items.some(item => !['userMessage', 'reasoning', 'agentMessage', 'contextCompaction'].includes(item.type))) return deny('本轮已有工具或文件操作，需确认结果后手动重试。')
  if (items.some(item => item.type === 'agentMessage' && item.phase !== 'commentary' && Boolean(item.text.trim()))) return deny('本轮已有最终回复，请检查结果后手动继续。')
  const error = thread.error || ''
  if (/429|rate.?limit|quota|billing|usage.?limit|budget|401|403|unauthori[sz]ed|forbidden|permission|invalid.request|bad.request|content.?filter|content.?policy|safety|context.{0,25}(?:limit|length|exceed)|too.{0,5}(?:large|long)|额度|配额|权限|鉴权|内容|安全策略|上下文.{0,10}(?:超|限制)/i.test(error)) return deny('此错误不适合自动重试，请检查提示后手动处理。')
  if (!/broken.?pipe|econn(?:reset|refused|aborted)|connection.{0,45}(?:closed|reset|abort|lost|failed)|stream.{0,45}(?:disconnect|closed|interrupt|timeout)|websocket.{0,45}(?:closed|fail)|timed?\s*out|timeout|network.{0,25}(?:error|unreachable|fail)|连接.{0,12}(?:断|失败|超时)|网络.{0,12}(?:断|失败|超时)|请求超时/i.test(error)) return deny('无法确认是临时连接问题，未自动重试。')
  return { allowed: true, message: /timed?\s*out|timeout|超时/i.test(error) ? '模型请求超时' : '模型连接中断' }
}

export function hasRecoveryOutput(method: string, params: Record<string, unknown>): boolean {
  if (['item/agentMessage/delta', 'item/reasoning/summaryTextDelta'].includes(method)) return Boolean(string(params.delta).trim())
  const item = record(params.item)
  if (method === 'item/completed' && ['agentMessage', 'reasoning'].includes(string(item.type))) return Boolean(string(item.text).trim() || Array.isArray(item.summary) && item.summary.length)
  return method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(string(item.type))
}
