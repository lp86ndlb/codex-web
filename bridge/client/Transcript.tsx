import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Check, ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import type { ActivityCollapseTiming, Item, ThreadView } from '../shared/types.ts'
import { activityExpansion } from '../shared/activity-presentation.ts'
import { ActivityGroup, Notice, TranscriptItem } from './components.tsx'
import { RunSummary } from './MessageMeta.tsx'

const PAGE_SIZE = 60
const PAGE_STEP = 30
interface Row { id: string; items: Item[]; process: boolean; first: number; last: number }
interface HistoryPage { endId: string; liveAfter: number }
interface ReadingAnchor { id: string; top: number }

/** Keep complete message rows and their lazy process together. Missing phases
 * in older CLI replies must never hide a real answer. */
function transcriptRows(items: Item[]): Row[] {
  const result: Row[] = []
  items.forEach((item, index) => {
    const process = item.type === 'agentMessage' ? item.phase === 'commentary' : item.type !== 'userMessage' && !(item.tool === 'render_ui' && item.ui)
    const last = result.at(-1)
    if (process && last?.process && last.items[0].turnId === item.turnId) { last.items.push(item); last.last = index }
    else result.push({ id: item.id, items: [item], process, first: index, last: index })
  })
  return result
}

/** Keep keystrokes outside the Markdown tree; hydrate older messages on demand. */
export interface MessageJump { id: string; seq: number }
export const Transcript = memo(function Transcript({ thread, loading, approvals, expanded = false, collapseTiming = 'next-input', jumpTo, follow, paused, onEdit, editDisabled = false }: { thread?: ThreadView; loading: boolean; approvals: number; expanded?: boolean; collapseTiming?: ActivityCollapseTiming; jumpTo?: MessageJump | null; follow: MutableRefObject<boolean>; paused: boolean; onEdit?: (item: Item) => void; editDisabled?: boolean }) {
  const [page, setPage] = useState<HistoryPage | null>(null)
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({})
  const container = useRef<HTMLDivElement>(null); const handled = useRef(-1)
  const anchor = useRef<ReadingAnchor | null>(null)
  const paging = useRef(false)
  const lastAutoLoad = useRef(-Infinity)
  const items = useMemo(() => (thread?.items || []).filter(item => !['reasoning', 'plan'].includes(item.type) || Boolean(item.text.trim())), [thread?.items])
  const rows = useMemo(() => transcriptRows(items), [items])
  const [observed, setObserved] = useState({ count: items.length, last: rows.at(-1)?.id })
  if (observed.count !== items.length) {
    setObserved({ count: items.length, last: rows.at(-1)?.id })
    // Freeze the reader's page and append a bounded live tail. New output must
    // neither evict the first visible question nor accumulate an unlimited DOM.
    if (items.length > observed.count && !follow.current && !page && observed.last) setPage({ endId: observed.last, liveAfter: observed.count })
    else if (items.length < observed.count) setPage(null)
  }
  if (page && !paused && follow.current) setPage(null)
  const pageIndex = page ? rows.findIndex(row => row.id === page.endId) : -1
  const end = pageIndex < 0 ? rows.length : pageIndex + 1
  const start = Math.max(0, end - PAGE_SIZE)
  const arrival = page ? rows.findIndex(row => row.last >= page.liveAfter) : -1
  const tailStart = arrival < 0 ? rows.length : Math.max(end, arrival, rows.length - PAGE_SIZE)
  const rendered = useMemo(() => [...rows.slice(start, end), ...rows.slice(tailStart)], [rows, start, end, tailStart])
  const automatic = useMemo(() => activityExpansion(items, thread, expanded, collapseTiming), [items, thread?.turnId, thread?.status, thread?.runs, expanded, collapseTiming])
  const automaticOpen = (row: Row) => row.items.some(item => automatic.get(item.id))
  const isOpen = (row: Row) => manualOpen[row.id] ?? automaticOpen(row)
  const toggle = (row: Row) => setManualOpen(previous => ({ ...previous, [row.id]: !(previous[row.id] ?? automaticOpen(row)) }))

  const remember = useCallback(() => {
    const root = container.current; const viewport = root?.closest<HTMLElement>('.conversation')
    if (!root || !viewport) return
    const top = viewport.getBoundingClientRect().top
    const target = [...root.querySelectorAll<HTMLElement>('[data-message-id], .activity-group[data-activity-id]')].find(node => node.getBoundingClientRect().bottom > top + 1)
    if (target) anchor.current = { id: target.dataset.messageId || target.dataset.activityId!, top: target.getBoundingClientRect().top - top }
  }, [])
  const earlier = useCallback(() => {
    if (!start || paging.current) return
    paging.current = true; follow.current = false; remember()
    const nextEnd = Math.max(1, end - PAGE_STEP)
    setPage({ endId: rows[nextEnd - 1].id, liveAfter: page?.liveAfter ?? items.length })
  }, [start, end, rows, page, items.length, remember, follow])
  const newer = () => {
    follow.current = false; remember()
    const nextEnd = Math.min(rows.length, end + PAGE_STEP)
    setPage(nextEnd === rows.length ? null : { endId: rows[nextEnd - 1].id, liveAfter: page?.liveAfter ?? items.length })
  }
  useLayoutEffect(() => {
    const saved = anchor.current; anchor.current = null; paging.current = false
    if (!saved) return
    const root = container.current; const viewport = root?.closest<HTMLElement>('.conversation')
    const id = CSS.escape(saved.id)
    const target = root?.querySelector<HTMLElement>(`[data-message-id="${id}"], .activity-group[data-activity-id="${id}"]`)
    if (viewport && target) {
      // Native anchoring may already retain the row: compensate only the error.
      viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - saved.top
    }
  }, [page, start, end])
  useEffect(() => {
    const root = container.current; const viewport = root?.closest<HTMLElement>('.conversation')
    if (!root || !viewport || !start) return
    let touchY = 0
    const nearTop = () => {
      const button = root.querySelector<HTMLElement>('.history-load-older')
      return button && button.getBoundingClientRect().bottom >= viewport.getBoundingClientRect().top && button.getBoundingClientRect().top < viewport.getBoundingClientRect().top + 100
    }
    const upward = () => {
      if (paging.current || performance.now() - lastAutoLoad.current < 450 || !nearTop()) return false
      lastAutoLoad.current = performance.now(); earlier(); return true
    }
    const nested = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('pre,textarea,input,select,[role="dialog"],.genui-host'))
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0 && !nested(event.target) && upward()) event.preventDefault() }
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY || 0 }
    const touch = (event: TouchEvent) => { const y = event.touches[0]?.clientY ?? touchY; if (y - touchY > 12 && !nested(event.target)) upward(); touchY = y }
    const key = (event: KeyboardEvent) => { if (['PageUp', 'ArrowUp'].includes(event.key) && !nested(event.target) && upward()) event.preventDefault() }
    viewport.addEventListener('wheel', wheel, { passive: false }); viewport.addEventListener('touchstart', touchStart, { passive: true }); viewport.addEventListener('touchmove', touch, { passive: true }); viewport.addEventListener('keydown', key)
    return () => { viewport.removeEventListener('wheel', wheel); viewport.removeEventListener('touchstart', touchStart); viewport.removeEventListener('touchmove', touch); viewport.removeEventListener('keydown', key) }
  }, [earlier, start])
  useLayoutEffect(() => {
    if (!jumpTo || jumpTo.seq === handled.current) return
    if (!jumpTo.id) { setPage(null); handled.current = jumpTo.seq; return }
    const index = rows.findIndex(row => row.items.some(item => item.id === jumpTo.id))
    if (index < 0) return
    if (index < start || index >= end && index < tailStart) {
      const nextEnd = Math.min(rows.length, Math.max(PAGE_SIZE, index + PAGE_STEP))
      setPage(nextEnd === rows.length ? null : { endId: rows[nextEnd - 1].id, liveAfter: items.length }); return
    }
    const target = container.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(jumpTo.id)}"]`)
    if (!target) return
    const viewport = container.current?.closest<HTMLElement>('.conversation')
    if (viewport) viewport.scrollTo({ top: viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 4, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.animations === 'false' ? 'instant' : 'smooth' })
    target.classList.add('jump-highlight'); const timer = setTimeout(() => target.classList.remove('jump-highlight'), 1000)
    handled.current = jumpTo.seq
    return () => { clearTimeout(timer); target.classList.remove('jump-highlight') }
  }, [jumpTo, rows, items.length, start, end, tailStart])
  const runEnds = useMemo(() => {
    const lastItems = new Map<string, string>(); for (const item of items) if (item.turnId) lastItems.set(item.turnId, item.id)
    return new Map((thread?.runs || []).filter(run => run.status !== 'inProgress').map(run => [lastItems.get(run.id), run]))
  }, [items, thread?.runs])
  const recoveryTurns = useMemo(() => new Set((thread?.runs || []).filter(run => run.recoveryOf).map(run => run.id)), [thread?.runs])
  if (loading && !thread) return <div className="transcript"><div className="conversation-skeleton" aria-label="正在加载会话"><i /><i /><i /><i /></div></div>
  const hidden = rows[start]?.first || 0
  const gap = end < tailStart ? <button className="history-load history-load-newer" type="button" onClick={newer}><ChevronDown size={16} />{arrival < 0 ? '显示较新的消息' : '显示中间的消息'} · 还有 {(rows[tailStart]?.first ?? items.length) - (rows[end - 1]?.last ?? -1) - 1} 条</button> : null
  return <div className="transcript" ref={container} data-window-first-id={rendered[0]?.items[0].id} data-window-last-id={rendered.at(-1)?.items.at(-1)?.id} data-window-rows={rendered.length}>{hidden > 0 && <button className="history-load history-load-older" type="button" onClick={earlier}><ChevronUp size={16} />显示更早的消息 · 还有 {hidden} 条</button>}
    {items.length ? rendered.map(row => {
      const item = row.items[0]; const last = row.items.at(-1)!; const run = runEnds.get(last.id)
      return <Fragment key={row.id}>{row.id === rows[tailStart]?.id && gap}{row.process ? <ActivityGroup items={row.items} expanded={isOpen(row)} onToggle={() => toggle(row)} /> : <TranscriptItem item={item} autoRecovery={Boolean(item.turnId && recoveryTurns.has(item.turnId))} onEdit={item.type === 'userMessage' && item.status !== 'sending' ? onEdit : undefined} editDisabled={editDisabled} />}{run && <RunSummary run={run} latest={(!page || arrival >= 0) && run.id === thread?.runs?.at(-1)?.id} />}</Fragment>
    }) : <div className="thread-empty"><Sparkles size={22} /><p>会话已准备好，写下你想完成的事。</p></div>}
    {tailStart === rows.length && gap}{(!page || arrival >= 0) && <>{thread?.error && <Notice text={thread.error} />}
    {thread?.status === 'interrupted' && <div className="turn-end">任务已停止 · 可以继续发送消息</div>}
    {thread?.status === 'completed' && !thread.runs?.length && <div className="turn-end"><Check size={12} />本轮已完成{thread.tokens > 0 && ` · ${thread.tokens.toLocaleString()} tokens`}</div>}</>}
  </div>
})
