import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Check, ChevronUp, Sparkles } from 'lucide-react'
import type { Item, ThreadView } from '../shared/types.ts'
import { ActivityGroup, Notice, TranscriptItem } from './components.tsx'
import { RunSummary } from './MessageMeta.tsx'

/** Keep keystrokes outside the Markdown tree; hydrate older messages on demand. */
export interface MessageJump { id: string; seq: number }
export const Transcript = memo(function Transcript({ thread, loading, approvals, expanded = false, jumpTo, follow, paused, onEdit, editDisabled = false }: { thread?: ThreadView; loading: boolean; approvals: number; expanded?: boolean; jumpTo?: MessageJump | null; follow: MutableRefObject<boolean>; paused: boolean; onEdit?: (item: Item) => void; editDisabled?: boolean }) {
  const [visible, setVisible] = useState(60)
  const [windowEnd, setWindowEnd] = useState<number | null>(null)
  const [heldForReading, setHeldForReading] = useState(false)
  const container = useRef<HTMLDivElement>(null); const handled = useRef(-1)
  const items = useMemo(() => (thread?.items || []).filter(item => !['reasoning', 'plan'].includes(item.type) || Boolean(item.text.trim())), [thread?.items])
  const [previousCount, setPreviousCount] = useState(items.length)
  if (previousCount !== items.length) {
    setPreviousCount(items.length)
    // Freeze the existing window before new items can evict the row being read.
    // Adjusting this component's own state here avoids a one-frame scroll jump.
    if (!follow.current && windowEnd === null && previousCount >= visible && items.length > previousCount) { setWindowEnd(previousCount); setHeldForReading(true) }
  }
  if (heldForReading && !paused && follow.current) { setWindowEnd(null); setHeldForReading(false) }
  const end = windowEnd === null ? items.length : Math.min(items.length, windowEnd)
  const start = Math.max(0, end - visible)
  useLayoutEffect(() => {
    if (!jumpTo || jumpTo.seq === handled.current) return
    if (!jumpTo.id) { setWindowEnd(null); setVisible(60); setHeldForReading(false); handled.current = jumpTo.seq; return }
    const index = items.findIndex(item => item.id === jumpTo.id)
    if (index < 0) return
    if (index < start || index >= end) { const nextEnd = Math.min(items.length, Math.max(60, index + 30)); setWindowEnd(nextEnd === items.length ? null : nextEnd); setHeldForReading(false); setVisible(60); return }
    const target = container.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(jumpTo.id)}"]`)
    if (!target) return
    const viewport = container.current?.closest<HTMLElement>('.conversation')
    if (viewport) viewport.scrollTo({ top: viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 4, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.animations === 'false' ? 'instant' : 'smooth' })
    target.classList.add('jump-highlight'); const timer = setTimeout(() => target.classList.remove('jump-highlight'), 1000)
    handled.current = jumpTo.seq
    return () => { clearTimeout(timer); target.classList.remove('jump-highlight') }
  }, [jumpTo, items, start, end])
  const rows = useMemo(() => {
    const result: (Item | Item[])[] = []
    for (const item of items.slice(start, end)) {
      const tool = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type) && item.tool !== 'render_ui'
      const last = result.at(-1)
      if (tool && Array.isArray(last) && last[0].turnId === item.turnId) last.push(item)
      else result.push(tool ? [item] : item)
    }
    return result
  }, [items, start, end])
  const runEnds = useMemo(() => {
    const lastItems = new Map<string, string>(); for (const item of items) if (item.turnId) lastItems.set(item.turnId, item.id)
    return new Map((thread?.runs || []).filter(run => run.status !== 'inProgress').map(run => [lastItems.get(run.id), run]))
  }, [items, thread?.runs])
  if (loading && !thread) return <div className="transcript"><div className="conversation-skeleton" aria-label="正在加载会话"><i /><i /><i /><i /></div></div>
  const hidden = start
  return <div className="transcript" ref={container}>{hidden > 0 && <button className="history-load" type="button" onClick={() => setVisible(value => value + 60)}><ChevronUp size={16} />显示更早的消息 · 还有 {hidden} 条</button>}
    {items.length ? rows.map(row => {
      const first = Array.isArray(row) ? row[0] : row; const last = Array.isArray(row) ? row.at(-1)! : row; const run = runEnds.get(last.id)
      return <Fragment key={first.id}>{Array.isArray(row) ? row.length > 1 ? <ActivityGroup items={row} expanded={expanded} /> : <TranscriptItem item={first} /> : <TranscriptItem item={row} expanded={expanded && ['reasoning', 'plan'].includes(row.type)} onEdit={row.type === 'userMessage' && row.status !== 'sending' ? onEdit : undefined} editDisabled={editDisabled} />}{run && <RunSummary run={run} latest={end === items.length && run.id === thread?.runs?.at(-1)?.id} />}</Fragment>
    }) : <div className="thread-empty"><Sparkles size={22} /><p>会话已准备好，写下你想完成的事。</p></div>}
    {end < items.length ? <button className="history-load" type="button" onClick={() => { const next = Math.min(items.length, end + 60); setWindowEnd(next === items.length ? null : next); setVisible(60) }}>显示较新的消息 · 还有 {items.length - end} 条</button> : <>{thread?.error && <Notice text={thread.error} />}
    {thread?.status === 'interrupted' && <div className="turn-end">任务已停止 · 可以继续发送消息</div>}
    {thread?.status === 'completed' && !thread.runs?.length && <div className="turn-end"><Check size={12} />本轮已完成{thread.tokens > 0 && ` · ${thread.tokens.toLocaleString()} tokens`}</div>}</>}
  </div>
})
