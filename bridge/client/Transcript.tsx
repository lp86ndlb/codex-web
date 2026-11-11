import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Check, ChevronUp, Sparkles } from 'lucide-react'
import type { ActivityCollapseTiming, Item, ThreadView } from '../shared/types.ts'
import { activityExpansion } from '../shared/activity-presentation.ts'
import { ActivityGroup, Notice, TranscriptItem } from './components.tsx'
import { RunSummary } from './MessageMeta.tsx'

/** Keep keystrokes outside the Markdown tree; hydrate older messages on demand. */
export interface MessageJump { id: string; seq: number }
export const Transcript = memo(function Transcript({ thread, loading, approvals, expanded = false, collapseTiming = 'next-input', jumpTo, follow, paused, onEdit, editDisabled = false }: { thread?: ThreadView; loading: boolean; approvals: number; expanded?: boolean; collapseTiming?: ActivityCollapseTiming; jumpTo?: MessageJump | null; follow: MutableRefObject<boolean>; paused: boolean; onEdit?: (item: Item) => void; editDisabled?: boolean }) {
  const [visible, setVisible] = useState(60)
  const [windowEnd, setWindowEnd] = useState<number | null>(null)
  const [liveStart, setLiveStart] = useState<number | null>(null)
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({})
  const container = useRef<HTMLDivElement>(null); const handled = useRef(-1)
  const items = useMemo(() => (thread?.items || []).filter(item => !['reasoning', 'plan'].includes(item.type) || Boolean(item.text.trim())), [thread?.items])
  const [previousCount, setPreviousCount] = useState(items.length)
  if (previousCount !== items.length) {
    setPreviousCount(items.length)
    if (items.length > previousCount) {
      // Keep the beginning of the reader's window while still appending live
      // output. Freezing its end would hide new messages until manual refresh.
      if (!follow.current && windowEnd === null) setVisible(value => value + items.length - previousCount)
      // An explicit jump may leave thousands of messages between this page and
      // the live tail. Append only arrivals instead of eagerly rendering them all.
      if (windowEnd !== null && liveStart === null) setLiveStart(previousCount)
    } else if (liveStart !== null && liveStart >= items.length) setLiveStart(null)
  }
  if (windowEnd !== null && !paused && follow.current) { setWindowEnd(null); setLiveStart(null); setVisible(60) }
  const end = windowEnd === null ? items.length : Math.min(items.length, windowEnd)
  const start = Math.max(0, end - visible)
  const tailStart = windowEnd !== null && liveStart !== null ? Math.max(end, liveStart) : items.length
  const renderedItems = useMemo(() => [...items.slice(start, end), ...items.slice(tailStart)], [items, start, end, tailStart])
  const automatic = useMemo(() => activityExpansion(items, thread, expanded, collapseTiming), [items, thread?.turnId, thread?.status, thread?.runs, expanded, collapseTiming])
  const isOpen = (id: string) => manualOpen[id] ?? automatic.get(id) ?? false
  const toggle = (id: string) => setManualOpen(previous => ({ ...previous, [id]: !(previous[id] ?? automatic.get(id) ?? false) }))
  useLayoutEffect(() => {
    if (!jumpTo || jumpTo.seq === handled.current) return
    if (!jumpTo.id) { setWindowEnd(null); setLiveStart(null); setVisible(60); handled.current = jumpTo.seq; return }
    const index = items.findIndex(item => item.id === jumpTo.id)
    if (index < 0) return
    if (index < start || index >= end && index < tailStart) { const nextEnd = Math.min(items.length, Math.max(60, index + 30)); setWindowEnd(nextEnd === items.length ? null : nextEnd); setVisible(60); return }
    const target = container.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(jumpTo.id)}"]`)
    if (!target) return
    const viewport = container.current?.closest<HTMLElement>('.conversation')
    if (viewport) viewport.scrollTo({ top: viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 4, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.animations === 'false' ? 'instant' : 'smooth' })
    target.classList.add('jump-highlight'); const timer = setTimeout(() => target.classList.remove('jump-highlight'), 1000)
    handled.current = jumpTo.seq
    return () => { clearTimeout(timer); target.classList.remove('jump-highlight') }
  }, [jumpTo, items, start, end, tailStart])
  const rows = useMemo(() => {
    const result: (Item | Item[])[] = []
    for (const item of renderedItems) {
      const tool = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type) && item.tool !== 'render_ui'
      const last = end < tailStart && item.id === items[tailStart]?.id ? undefined : result.at(-1)
      if (tool && Array.isArray(last) && last[0].turnId === item.turnId) last.push(item)
      else result.push(tool ? [item] : item)
    }
    return result
  }, [renderedItems, end, tailStart, items])
  const runEnds = useMemo(() => {
    const lastItems = new Map<string, string>(); for (const item of items) if (item.turnId) lastItems.set(item.turnId, item.id)
    return new Map((thread?.runs || []).filter(run => run.status !== 'inProgress').map(run => [lastItems.get(run.id), run]))
  }, [items, thread?.runs])
  if (loading && !thread) return <div className="transcript"><div className="conversation-skeleton" aria-label="正在加载会话"><i /><i /><i /><i /></div></div>
  const hidden = start
  const gap = end < tailStart ? <button className="history-load" type="button" onClick={() => { const next = Math.min(tailStart, end + 60); if (next === tailStart) { setWindowEnd(null); setLiveStart(null); setVisible(60 + items.length - tailStart) } else { setWindowEnd(next); setVisible(60) } }}>{liveStart === null ? '显示较新的消息' : '显示中间的消息'} · 还有 {tailStart - end} 条</button> : null
  return <div className="transcript" ref={container} data-window-first-id={renderedItems[0]?.id} data-window-last-id={renderedItems.at(-1)?.id}>{hidden > 0 && <button className="history-load" type="button" onClick={() => setVisible(value => value + 60)}><ChevronUp size={16} />显示更早的消息 · 还有 {hidden} 条</button>}
    {items.length ? rows.map(row => {
      const first = Array.isArray(row) ? row[0] : row; const last = Array.isArray(row) ? row.at(-1)! : row; const run = runEnds.get(last.id)
      return <Fragment key={first.id}>{first.id === items[tailStart]?.id && gap}{Array.isArray(row) ? <ActivityGroup items={row} expanded={isOpen(first.id)} onToggle={() => toggle(first.id)} /> : <TranscriptItem item={row} expanded={['reasoning', 'plan'].includes(row.type) && isOpen(row.id)} onExpandedToggle={['reasoning', 'plan'].includes(row.type) ? () => toggle(row.id) : undefined} onEdit={row.type === 'userMessage' && row.status !== 'sending' ? onEdit : undefined} editDisabled={editDisabled} />}{run && <RunSummary run={run} latest={(windowEnd === null || liveStart !== null) && run.id === thread?.runs?.at(-1)?.id} />}</Fragment>
    }) : <div className="thread-empty"><Sparkles size={22} /><p>会话已准备好，写下你想完成的事。</p></div>}
    {tailStart === items.length && gap}{(windowEnd === null || liveStart !== null) && <>{thread?.error && <Notice text={thread.error} />}
    {thread?.status === 'interrupted' && <div className="turn-end">任务已停止 · 可以继续发送消息</div>}
    {thread?.status === 'completed' && !thread.runs?.length && <div className="turn-end"><Check size={12} />本轮已完成{thread.tokens > 0 && ` · ${thread.tokens.toLocaleString()} tokens`}</div>}</>}
  </div>
})
