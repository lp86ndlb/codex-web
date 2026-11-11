import { Check, CircleAlert, Clock3 } from 'lucide-react'
import type { Item, RunMetrics } from '../shared/types.ts'

export function formatDuration(milliseconds: number) {
  if (milliseconds < 1000) return '不足 1 秒'
  const seconds = Math.round(milliseconds / 1000); const minutes = Math.floor(seconds / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`
}
export function MessageTime({ item }: { item: Item }) {
  if (!item.timestamp) return <span className="message-time" tabIndex={0} title="这条历史消息没有记录时间">未记录时间</span>
  const date = new Date(item.timestamp)
  if (!Number.isFinite(date.getTime())) return <span className="message-time" tabIndex={0} title="历史消息时间无效">未记录时间</span>
  const source = item.timeSource === 'turn' ? '本轮时间（历史消息未单独记录）' : item.timeSource === 'observed' ? '网页接收时间' : 'CLI 消息时间'
  return <time className="message-time" tabIndex={0} dateTime={date.toISOString()} title={`${date.toLocaleString('zh-CN', { hour12: false })} · ${source}`}>{date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
}
export function RunSummary({ run, latest = false }: { run: RunMetrics; latest?: boolean }) {
  const complete = run.status === 'completed'; const changes = run.quota?.windows || []
  return <div className={`run-summary ${latest ? 'turn-end' : ''}`} aria-label="任务结算">
    <span>{complete ? <Check size={12} /> : <CircleAlert size={12} />}{complete ? latest ? '本轮已完成' : '已完成' : run.status === 'interrupted' ? '任务已停止' : '任务结束'}</span>
    {run.durationMs !== undefined && <span title={run.observed ? '网页观测的本轮经过时间' : 'CLI 记录的本轮经过时间'}><Clock3 size={12} />{formatDuration(run.durationMs)}</span>}
    {run.tokens !== undefined && <span>{run.tokens.toLocaleString()} tokens</span>}
    <details className="run-usage"><summary>用量详情</summary><div><strong>本轮统计</strong><p>{run.tokens === undefined ? 'CLI 未提供可归因到本轮的 token 增量。' : `本轮累计 ${run.tokens.toLocaleString()} tokens，包含模型报告的输入与输出。`}</p>{changes.length ? <><strong>任务期间的账户窗口变化</strong>{changes.map(row => <p key={row.name}>{row.name} · {row.change > 0 ? `约 +${row.change} 个百分点` : '未报告变化（可能低于统计精度）'}</p>)}</> : <p>账户窗口缺少可比较数据，或期间发生重置。</p>}<small>CLI 没有提供单任务额度百分比。账户窗口变化可能包含其他会话，不能视为本任务独占消耗。</small></div></details>
  </div>
}
