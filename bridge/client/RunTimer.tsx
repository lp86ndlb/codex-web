import { memo, useEffect, useState } from 'react'
import { Check, CircleAlert, Clock3, RefreshCw } from 'lucide-react'
import type { RunMetrics, ThreadView } from '../shared/types.ts'
import { activityTitle } from './components.tsx'

export function isThreadRunning(thread?: ThreadView) {
  return Boolean(thread?.turnId && !['completed', 'failed', 'interrupted'].includes(thread.status))
}

/** Older running servers expose compaction as a native item without a status.
 * Only inspect this turn's explicit compaction timestamps, never old history. */
export function runStage(thread?: ThreadView): 'working' | 'compacting' | 'retrying' {
  if (thread?.compacting) return 'compacting'
  if (!isThreadRunning(thread)) return 'working'
  if (thread?.progress) return thread.progress.stage
  const item = thread?.items.findLast(item => item.turnId === thread.turnId && item.type === 'contextCompaction')
  if (!item || ['completed', 'failed', 'interrupted'].includes(item.status)) return 'working'
  if (item.status === 'inProgress') return 'compacting'
  try {
    const value = JSON.parse(item.text)
    if (typeof value.startedAtMs === 'number' && Number.isFinite(value.startedAtMs) && value.startedAtMs > 0 && value.completedAtMs == null) return 'compacting'
  } catch { /* Raw details remain available in the transcript. */ }
  return 'working'
}

function elapsedText(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ` : ''}${minutes ? `${minutes % 60} 分 ` : ''}${seconds % 60} 秒`
}

/** Tick this small label alone, never rerender the conversation every second.
 * Absolute CLI timestamps survive navigation, refresh and timer throttling. */
export function RunTimer({ run, fallbackStartedAt }: { run?: RunMetrics; fallbackStartedAt?: number }) {
  const startedAt = run?.startedAt || fallbackStartedAt
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!startedAt || !Number.isFinite(startedAt)) return
    let timer: ReturnType<typeof setInterval> | undefined
    const sync = () => {
      clearInterval(timer); timer = undefined
      if (!document.hidden) { setNow(Date.now()); timer = setInterval(() => setNow(Date.now()), 1000) }
    }
    sync(); document.addEventListener('visibilitychange', sync)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', sync) }
  }, [run?.id, startedAt])
  if (!startedAt || !Number.isFinite(startedAt)) return <span className="run-timer is-syncing"><Clock3 size={13} />用时同步中…</span>
  const elapsed = Math.max(0, now - startedAt)
  return <time className="run-timer" aria-live="off" aria-label={`本轮用时 ${elapsedText(elapsed)}`} dateTime={`PT${Math.floor(elapsed / 1000)}S`} title={`${run?.observed || !run?.startedAt ? '网页记录' : 'CLI 记录'}的本轮开始时间；用时包含等待确认的时间`}><Clock3 size={13} /><span>用时 {elapsedText(elapsed)}</span></time>
}

/** Keep live status in the sticky input area, independent of the history window. */
export const RunStatus = memo(function RunStatus({ thread, approvals }: { thread?: ThreadView; approvals: number }) {
  const [now, setNow] = useState(Date.now)
  const running = isThreadRunning(thread)
  useEffect(() => {
    if (!running) return
    const sync = () => { if (!document.hidden) setNow(Date.now()) }
    const timer = setInterval(sync, 5000)
    document.addEventListener('visibilitychange', sync); sync()
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', sync) }
  }, [running, thread?.turnId])
  if (!running || !thread?.turnId) return null
  const run = thread.runs?.find(run => run.id === thread.turnId)
  const fallback = thread.items.find(item => item.turnId === thread.turnId && item.timestamp)?.timestamp
  const stage = runStage(thread)
  const activity = thread.items.findLast(item => item.turnId === thread.turnId && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type) && item.status === 'inProgress')
  const lastEventAt = thread.progress?.lastEventAt || Math.max(thread.updatedAt * 1000, fallback || 0)
  const waiting = !approvals && !thread.choicePending && lastEventAt > 0 && now - lastEventAt >= 90_000
  const attempt = thread.progress?.attempt
  const label = approvals ? '等待你的确认' : thread.choicePending ? '有问题待回复' : stage === 'compacting' ? '正在压缩上下文' : stage === 'retrying' ? '模型请求重试中' : activity ? activityTitle(activity) : '正在处理'
  const detail = approvals || thread.choicePending ? '' : waiting ? '较长时间未收到新进展，等待状态更新' : stage === 'compacting' ? '正在整理历史记录，完成后继续处理' : stage === 'retrying' ? `等待 CLI 恢复模型响应${attempt ? ` · 第 ${attempt} 次重试` : ''}` : ''
  return <div className="working composer-run-status" data-stage={stage} data-waiting={waiting || undefined} role="group" aria-label="本轮运行状态"><span className="working-dots" aria-hidden="true"><i /><i /><i /></span><span className="working-label" title={thread.progress?.message || label}>{label}</span><RunTimer key={thread.turnId} run={run} fallbackStartedAt={fallback} />{detail && <span className="run-progress-detail" title={thread.progress?.message || detail}>{detail}</span>}</div>
})

/** Recovery remains separate from the running indicator: a failed source turn
 * can be waiting for a retry without pretending that model output is active. */
export const SessionFeedback = memo(function SessionFeedback({ thread }: { thread?: ThreadView }) {
  const recovery = thread?.recovery
  if (!recovery) return null
  const titles = { scheduled: '准备自动重试', retrying: '正在自动重试', manual: '需要手动继续', recovered: '响应已恢复' }
  return <div className="session-feedback">
    {recovery && <div className="session-feedback-row recovery-status" data-recovery={recovery.state} role="status" aria-label="自动恢复状态">{recovery.state === 'recovered' ? <Check size={14} /> : recovery.state === 'manual' ? <CircleAlert size={14} /> : <RefreshCw size={14} />}<span className="session-feedback-copy"><strong>{titles[recovery.state]}</strong>{recovery.maxAttempts > 0 && <small className="recovery-count">{recovery.attempt}/{recovery.maxAttempts}</small>}{recovery.message && <span className="session-feedback-message" title={recovery.message}>{recovery.message}</span>}</span></div>}
  </div>
})
