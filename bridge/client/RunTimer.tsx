import { memo, useEffect, useState } from 'react'
import { Clock3 } from 'lucide-react'
import type { RunMetrics, ThreadView } from '../shared/types.ts'
import { activityTitle } from './components.tsx'

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
  if (!thread?.turnId) return null
  const run = thread.runs?.find(run => run.id === thread.turnId)
  const fallback = thread.items.find(item => item.turnId === thread.turnId && item.timestamp)?.timestamp
  const activity = thread.items.findLast(item => ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type) && item.status === 'inProgress')
  const label = approvals ? '等待你的确认' : activity ? activityTitle(activity) : thread.choicePending ? '有问题待回复' : '正在处理'
  return <div className="working composer-run-status" role="group" aria-label="本轮运行状态"><span className="working-dots" aria-hidden="true"><i /><i /><i /></span><span className="working-label" title={label}>{label}</span><RunTimer key={thread.turnId} run={run} fallbackStartedAt={fallback} /></div>
})
