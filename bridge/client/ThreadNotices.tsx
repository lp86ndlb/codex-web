import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, CheckCircle2, ChevronDown, MessageCircleQuestion, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import type { Approval, ThreadSummary, ThreadView, WorkspaceInfo } from '../shared/types.ts'
import { newThreadNotices, threadActivity, type ThreadActivity, type ThreadNotice } from '../shared/thread-notices.ts'
import { Presence, useExitList } from './Motion.tsx'
import { threadReadEvent } from '../shared/navigation-order.ts'

export function useThreadNotices(threads: ThreadSummary[], views: Record<string, ThreadView>, approvals: Approval[], connected: boolean, selected: string | null) {
  const previous = useRef<Map<string, ThreadActivity> | null>(null); const [notices, setNotices] = useState<ThreadNotice[]>([])
  const seenThreads = useRef(new Set<string>())
  useEffect(() => {
    if (!connected) return
    const listed = new Set(threads.map(row => row.id))
    const liveViews = Object.fromEntries(Object.entries(views).filter(([id]) => listed.has(id) || !seenThreads.current.has(id)))
    const current = threadActivity(threads, liveViews, approvals)
    if (previous.current) for (const row of current.values()) if (!previous.current.has(row.id) && !seenThreads.current.has(row.id) && row.loaded) row.fresh = true
    for (const id of listed) seenThreads.current.add(id)
    const added = newThreadNotices(previous.current || new Map(), current).filter(row => row.kind !== 'waiting' || row.id !== selected); previous.current = current
    setNotices(rows => {
      let next = rows.filter(row => { const state = current.get(row.id); return state && (row.kind === 'waiting' ? row.id !== selected && state.attention : state.status === 'completed' && !state.attention) }).map(row => { const state = current.get(row.id)!; return row.title === state.title && row.cwd === state.cwd ? row : { ...row, title: state.title, cwd: state.cwd } })
      for (const row of added) next = [...next.filter(value => value.id !== row.id), row]
      next = next.slice(-10)
      return next.length === rows.length && next.every((row, index) => row === rows[index]) ? rows : next
    })
  }, [threads, views, approvals, connected, selected])
  function dismiss(key: string, read = false) { const row = notices.find(row => row.key === key); if (read && row?.kind === 'completed') window.dispatchEvent(new CustomEvent(threadReadEvent, { detail: row.id })); setNotices(rows => rows.filter(row => row.key !== key)) }
  return { notices, dismiss }
}
function NoticeCard({ notice, workspace, exiting, onJump, onDismiss }: { notice: ThreadNotice; workspace: string; exiting: boolean; onJump: (id: string) => void; onDismiss: (key: string, read?: boolean) => void }) {
  const element = useRef<HTMLElement>(null); const hover = useRef(false); const dismiss = useRef(onDismiss); dismiss.current = onDismiss
  useEffect(() => {
    if (notice.kind === 'waiting') return
    let remaining = 15_000; let last = Date.now()
    const timer = setInterval(() => {
      const now = Date.now(); const paused = document.hidden || hover.current || element.current?.contains(document.activeElement)
      if (!paused) remaining -= now - last
      last = now; if (remaining <= 0) { clearInterval(timer); dismiss.current(notice.key) }
    }, 500)
    return () => clearInterval(timer)
  }, [notice.key])
  return <article ref={element} className={`thread-notice notice-${notice.kind}`} data-exiting={exiting || undefined} aria-hidden={exiting || undefined} {...(exiting ? { inert: '' } : {})} onMouseEnter={() => { hover.current = true }} onMouseLeave={() => { hover.current = false }}>
    <div className="thread-notice-icon">{notice.kind === 'waiting' ? <MessageCircleQuestion size={18} /> : <CheckCircle2 size={18} />}</div><div className="thread-notice-copy"><span className="thread-notice-state">{notice.kind === 'waiting' ? '需要你的回复' : '本轮处理完成'}</span><strong title={notice.title}>{notice.title}</strong><div className="thread-notice-footer"><small title={notice.cwd}>{workspace}</small><button type="button" onClick={() => { onJump(notice.id); onDismiss(notice.key) }}>前往会话<ArrowUpRight size={14} /></button></div></div><button type="button" className="icon-button thread-notice-close" aria-label={`关闭${notice.kind === 'waiting' ? '待回复' : '完成'}通知 ${notice.title}`} onClick={() => onDismiss(notice.key, true)}><X size={14} /></button>
  </article>
}
export function ThreadNotices({ notices, workspaces, onJump, onDismiss }: { notices: ThreadNotice[]; workspaces: WorkspaceInfo[]; onJump: (id: string) => void; onDismiss: (key: string, read?: boolean) => void }) {
  const displayed = useExitList(notices, 'key'); const [open, setOpen] = useState(false)
  const stack = useRef<HTMLDivElement>(null); const hub = useRef<HTMLButtonElement>(null); const timer = useRef<ReturnType<typeof setTimeout>>()
  const latest = notices.at(-1)?.key || ''; const waiting = notices.some(row => row.kind === 'waiting')
  useEffect(() => {
    clearTimeout(timer.current)
    if (!latest) { setOpen(false); return }
    // Background requests stay visible while another conversation is being
    // answered. Showing the toast never changes focus or the current answer.
    setOpen(true); timer.current = setTimeout(() => setOpen(false), 5000)
    return () => clearTimeout(timer.current)
  }, [latest])
  useEffect(() => {
    const focus = (event: FocusEvent) => { if (event.target instanceof Element && event.target.closest('.composer-dock')) setOpen(false) }
    const typing = (event: KeyboardEvent) => { if (event.target instanceof Element && event.target.closest('.composer') && (event.key.length === 1 || ['Backspace', 'Delete'].includes(event.key))) setOpen(false) }
    document.addEventListener('focusin', focus); document.addEventListener('keydown', typing)
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('keydown', typing) }
  }, [])
  useLayoutEffect(() => { if (open && stack.current) stack.current.scrollTop = stack.current.scrollHeight }, [latest, open])
  return createPortal(<section className="thread-notices" data-open={open || undefined} aria-label="会话通知" onMouseEnter={() => { clearTimeout(timer.current); setOpen(true) }} onMouseLeave={() => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 1500) }} onFocusCapture={() => { clearTimeout(timer.current) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); requestAnimationFrame(() => hub.current?.focus()) } }}>
    <div ref={stack} className="thread-notice-stack" aria-live="polite" aria-relevant="additions text" aria-hidden={!open || undefined} {...(!open ? { inert: '' } : {})}>{displayed.map(({ item: notice, exiting }) => {
      const workspace = [...workspaces].sort((a, b) => b.path.length - a.path.length).find(row => notice.cwd === row.path || notice.cwd.startsWith(row.path + '/'))
      return <NoticeCard key={notice.key} notice={notice} exiting={exiting} workspace={workspace?.name || '本机会话'} onJump={onJump} onDismiss={onDismiss} />
    })}</div>
    <Presence show={notices.length > 0} className="notification-hub-wrap" aria-hidden={open || undefined} {...(open ? { inert: '' } : {})}><button ref={hub} type="button" className={`notification-hub ${waiting ? 'has-waiting' : ''}`} aria-label="会话通知" aria-expanded={open} title={`${notices.length} 条会话通知`} onClick={() => { const next = !open; setOpen(next); if (next) requestAnimationFrame(() => stack.current?.querySelector<HTMLButtonElement>('button')?.focus()) }}>{open ? <ChevronDown size={14} /> : waiting ? <MessageCircleQuestion size={14} /> : <CheckCircle2 size={14} />}{notices.length > 1 && <small>{notices.length}</small>}</button></Presence>
  </section>, document.body)
}
