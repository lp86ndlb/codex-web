import { memo, useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, ListOrdered, ShieldCheck } from 'lucide-react'
import type { TeamView } from '../shared/team.ts'
import { buildTeamQueue } from '../shared/team-queue.ts'
import { shouldAutoBatchTeamMessages, nextTeamBatch } from '../shared/team-batch.ts'
import './team-queue.css'

export const TeamQueue = memo(function TeamQueue({ team, threadId, manualQueueCount = 0, onReview, onCombine, saving }: {
  team: TeamView | null | undefined; threadId?: string; manualQueueCount?: number; onReview: (messageId: string) => void
  onCombine: (threadId: string, firstId: string) => void; saving?: boolean
}) {
  const [expanded, setExpanded] = useState(false), [limit, setLimit] = useState(12), listId = useId()
  const queue = useMemo(() => buildTeamQueue(team, threadId), [team?.enabled, team?.members, team?.messages, threadId])
  const nextBatch = useMemo(() => team?.enabled && team.capabilities?.batchDelivery && threadId ? nextTeamBatch(team.messages, threadId) : [], [team, threadId])
  useEffect(() => { setExpanded(false); setLimit(12) }, [threadId])
  if (!queue) return null
  const { counts, rows, paused } = queue
  const requested = nextBatch[0]?.batchRequested
  const hint = paused ? '团队已暂停，未投递请求保留。'
    : counts.receipt > 0 ? '核对回执后继续投递。'
    : manualQueueCount > 0 ? `当前有 ${manualQueueCount} 条手动排队消息，将优先投递。`
    : requested ? `空闲后合并前 ${nextBatch.length} 条已批准通信。`
    : shouldAutoBatchTeamMessages(nextBatch) ? `空闲后自动合并前 ${nextBatch.length} 条已批准通信。`
    : '当前轮结束后，已批准项按顺序自动投递。'
  const summary = [counts.queued && `排队 ${counts.queued}`, counts.approval && `待你审批 ${counts.approval}`, counts.review && `待审核 ${counts.review}`, counts.sending && `投递中 ${counts.sending}`, counts.receipt && `核对回执 ${counts.receipt}`, counts.attention && `需处理 ${counts.attention}`].filter(Boolean).join(' · ')
  return <section className="team-queue" aria-label="当前会话的团队队列" data-paused={paused || undefined}>
    <button type="button" className="team-queue-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
      <ListOrdered size={15} /><strong>团队队列 <span>{rows.length}</span></strong>
      <span className="team-queue-summary" title={summary}>{paused ? '已暂停 · 请求保留' : summary}</span>
      {manualQueueCount > 0 && <small className="team-queue-manual" title="按 Tab 排队的手动消息优先投递">手动优先 {manualQueueCount}</small>}
      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button>
    {expanded && <div id={listId} className="team-queue-expanded">
      <div className="team-queue-actions">
        <p className="team-queue-hint">{hint}</p>
        {threadId && nextBatch.length >= 2 && <button type="button" className="team-queue-combine" disabled={saving || requested || counts.receipt > 0} title={counts.receipt ? '请先核对投递回执' : '会话空闲后按队列顺序合并发送'} onClick={() => onCombine(threadId, nextBatch[0].id)}>{requested ? '已安排合并' : '合并投递'}</button>}
      </div>
      <ol className="team-queue-list" aria-label="待处理团队通信与审核">
        {rows.slice(0, limit).map(row => <li key={row.id} data-queue-id={row.id} data-message-id={row.messageId} data-phase={row.phase}>
          <div className="team-queue-row-heading">
            {row.position ? <span className="team-queue-position" aria-label={`排队第 ${row.position} 项`}>{row.position}</span> : row.kind === 'review' ? <ShieldCheck size={13} /> : <span className="team-queue-dot" />}
            <strong title={row.title}>{row.title}</strong><span className={`team-queue-state ${row.phase}`}>{row.status}</span>
          </div>
          <div className="team-queue-row-detail"><div>
            <p className="team-queue-source" title={`${row.kind === 'review' ? '上级／风险审核 · ' : ''}${row.fromName} → ${row.toName}`}>{row.kind === 'review' && <span>上级／风险审核 · </span>}{row.fromName} → {row.toName}</p>
            <p className="team-queue-reason" title={[row.blockedReason, row.reason].filter(Boolean).join(' ')}>{row.blockedReason || row.reason}</p>
          </div><button type="button" disabled={paused} title={paused ? '开启团队后查看审批' : undefined} onClick={() => onReview(row.messageId)} aria-label={`查看审批：${row.title}`}>查看审批</button></div>
        </li>)}
        {rows.length > limit && <li className="team-queue-more"><button type="button" onClick={() => setLimit(value => value + 12)}>再显示 {Math.min(12, rows.length - limit)} 项 · 还有 {rows.length - limit} 项</button></li>}
      </ol>
      <p className="team-queue-footnote">送达后移出投递队列；任务是否完成，以会话后续反馈为准。</p>
    </div>}
  </section>
})
