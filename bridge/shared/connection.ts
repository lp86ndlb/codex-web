export type FailureKind = 'authentication' | 'quota' | 'context' | 'network' | 'permission' | 'unknown'
export function classifyFailure(message = ''): { kind: FailureKind; title: string; next: string } {
  if (/401|unauthori[sz]ed|authentication|invalid.api.key|token.*expired/i.test(message)) return { kind: 'authentication', title: '认证需要处理', next: '检查 CLI 登录或模型服务凭据，再核对本轮状态。' }
  if (/429|rate.?limit|quota|usage.limit|insufficient.*credit/i.test(message)) return { kind: 'quota', title: '额度或速率受限', next: '查看额度与重置时间；不要连续重试。' }
  if (/context.{0,20}(length|window|limit|exceed)|maximum.*token|too.many.tokens/i.test(message)) return { kind: 'context', title: '上下文容量不足', next: '等当前任务结束后压缩上下文，或从摘要接续新话题。' }
  if (/403|permission.denied|access.denied|sandbox|policy.denied/i.test(message)) return { kind: 'permission', title: '权限受限', next: '查看请求的权限与 CLI 策略。' }
  if (/broken.pipe|disconnect|connect|timed?.?out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|TLS|SSL|502|503|504|network|断流|连接.*(断|失败|超时)/i.test(message)) return { kind: 'network', title: '模型连接异常', next: '查看原生重试状态，运行只读网络诊断；先核对结果再决定是否重试任务。' }
  return { kind: 'unknown', title: '需要核对运行状态', next: '查看原始错误及最近活动；没有输出不能证明断网或任务失败。' }
}

export interface DiagnosticEvent { id: string; at: number; layer: 'bridge' | 'engine' | 'model' | 'tools'; level: 'info' | 'warning' | 'error'; title: string; threadId?: string; code?: string }
export interface DiagnosticReport { state: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'; startedAt?: number; completedAt?: number; exitCode?: number | null; result?: unknown; message?: string }
export interface ConnectionSnapshot {
  checkedAt: number; bridge: { version: string; build: string; startedAt: number; node: string }
  engine: { state: string; shared: boolean; userAgent?: string; connectedAt?: number; installedVersion?: string }
  events: DiagnosticEvent[]; report: DiagnosticReport
}
