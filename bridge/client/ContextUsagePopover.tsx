import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, Gauge, LoaderCircle, Minimize2, X } from 'lucide-react'
import type { ThreadView } from '../shared/types.ts'
import { Presence } from './Motion.tsx'

/** The circle represents the CLI's latest input report, never lifetime tokens. */
export function ContextUsagePopover({ thread, disabled = false, compactPending = false, onCompact }: {
  thread?: ThreadView; disabled?: boolean; compactPending?: boolean; onCompact: () => Promise<void>
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null); const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false); const [position, setPosition] = useState<CSSProperties>({})
  const [pending, setPending] = useState(false); const [error, setError] = useState(''); const [accepted, setAccepted] = useState(false)
  const request = useRef(0); const selected = useRef(thread?.id); selected.current = thread?.id
  const inFlight = useRef(false)
  const acceptedReport = useRef(0)
  const usage = thread?.contextUsage
  const known = Boolean(usage && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0 && Number.isFinite(usage.windowTokens) && usage.windowTokens > 0)
  const percentage = known ? usage!.inputTokens / usage!.windowTokens * 100 : 0
  const amount = known ? Number.isFinite(percentage) ? `${Math.round(percentage)}%` : '>100%' : '—'
  const filled = known ? Math.min(100, Math.max(0, percentage)) : 0
  const level = !known ? 'unknown' : percentage >= 90 ? 'critical' : percentage >= 70 ? 'warning' : 'normal'
  const running = Boolean(thread?.turnId && !['failed', 'completed', 'interrupted'].includes(thread.status))
  const compacting = pending || compactPending || Boolean(thread?.compacting)
  const reason = !thread ? '选择一个会话后可压缩上下文' : compacting ? '正在压缩上下文，等待 CLI 返回结果' : thread.externalOwner ? '这个会话仍在另一端执行，请在该端操作或等任务结束' : running ? '任务运行中可查看用量，等任务结束后再压缩' : disabled ? '连接就绪后可压缩上下文' : ''
  const unavailable = Boolean(reason)
  const tokens = (value: number) => Math.round(value).toLocaleString('zh-CN')
  const remaining = known ? Math.max(0, usage!.windowTokens - usage!.inputTokens) : 0
  const remainingPercent = known ? Math.max(0, 100 - percentage) : 0
  const reportUpdated = accepted && usage && Number.isFinite(usage.updatedAt) && usage.updatedAt > acceptedReport.current

  function measure() {
    const rect = trigger.current?.getBoundingClientRect(); if (!rect) return
    const width = Math.max(0, Math.min(340, innerWidth - 24))
    const roomAbove = Math.max(0, rect.top - 20)
    setPosition({ left: Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)), bottom: Math.max(12, innerHeight - rect.top + 8), width, maxHeight: Math.max(0, Math.min(440, roomAbove)) })
  }
  function reveal() {
    measure(); setOpen(true)
    trigger.current?.closest('form')?.querySelector('details.permission-menu')?.removeAttribute('open')
  }
  function close(restore = true) {
    setOpen(false)
    if (restore) trigger.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    request.current++
    inFlight.current = false
    setOpen(false); setError(''); setAccepted(false); setPending(false)
  }, [thread?.id])
  useLayoutEffect(() => {
    const node = popup.current; if (!node) return
    if (open && node.showPopover && !node.matches(':popover-open')) node.showPopover()
    for (const animation of node.getAnimations()) if (animation instanceof CSSAnimation) animation.startTime = document.timeline.currentTime
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close(Boolean(popup.current?.contains(document.activeElement)))
    }
    let frame = 0
    const reposition = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) reposition() }
    const focus = (event: FocusEvent) => { if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false) }
    // Disabling the focused compact button can return focus to document.body.
    // Escape must still close this open panel in that state.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault(); event.stopPropagation(); close()
    }
    const focusFrame = requestAnimationFrame(() => popup.current?.focus({ preventScroll: true }))
    const size = new ResizeObserver(reposition)
    if (trigger.current?.closest('.composer')) size.observe(trigger.current.closest('.composer')!)
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', focus)
    document.addEventListener('keydown', escape)
    document.addEventListener('scroll', scroll, true); window.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('resize', reposition)
    return () => {
      cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame); size.disconnect()
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', focus)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('resize', reposition)
    }
  }, [open])
  useEffect(() => () => { request.current++ }, [])
  async function compact() {
    if (unavailable || pending || inFlight.current) return
    const ticket = ++request.current, threadId = thread?.id
    const reportAtStart = usage?.updatedAt || 0
    inFlight.current = true
    setPending(true); setError(''); setAccepted(false)
    try {
      await onCompact()
      if (ticket === request.current && selected.current === threadId) { acceptedReport.current = reportAtStart; setAccepted(true) }
    } catch (error) {
      if (ticket === request.current && selected.current === threadId) setError(error instanceof Error ? error.message : '压缩请求未提交，请重试')
    } finally {
      if (ticket === request.current && selected.current === threadId) { inFlight.current = false; setPending(false) }
    }
  }
  const updated = usage?.updatedAt && Number.isFinite(usage.updatedAt) ? new Date(usage.updatedAt) : null
  return <><button ref={trigger} type="button" className="context-usage-trigger" data-level={level} aria-label="查看上下文用量" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} title={known ? `上下文最近报告 ${amount}` : '上下文用量尚未报告'} onClick={() => open ? close() : reveal()} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); reveal() }
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
  }}><svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true"><circle className="context-ring-track" cx="12" cy="12" r="9" pathLength="100" />{known && <circle className="context-ring-value" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${filled} 100`} />}</svg><span>{amount}</span></button>
    {createPortal(<Presence elementRef={popup} show={open} {...{ popover: 'manual' as const }} id={id} role="dialog" aria-label="上下文用量" tabIndex={-1} className="context-usage-popover" style={position} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); close() }
    }}>
      <header className="context-usage-heading"><span><Gauge size={16} />上下文用量</span><button type="button" className="icon-button" aria-label="关闭上下文用量" onClick={() => close()}><X size={15} /></button></header>
      <div className="context-usage-report"><span>最近报告</span>{updated && Number.isFinite(updated.getTime()) && <time dateTime={updated.toISOString()} title={updated.toLocaleString('zh-CN', { hour12: false })}>{updated.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}</time>}</div>
      <dl className="context-usage-numbers"><div><dt>已用占比</dt><dd>{amount}</dd></div><div><dt>最近输入</dt><dd>{known ? <>{tokens(usage!.inputTokens)} <small>tokens</small></> : '—'}</dd></div><div><dt>上下文窗口</dt><dd>{known ? <>{tokens(usage!.windowTokens)} <small>tokens</small></> : '—'}</dd></div><div><dt>剩余占比</dt><dd>{known ? <>{Math.round(remainingPercent)}% <small>约 {tokens(remaining)} tokens</small></> : '—'}</dd></div></dl>
      <p className="context-usage-note">这是 CLI 最近报告的输入用量，并非当前请求尺寸或会话累计用量。{!known && '当前会话尚未提供可比较的上下文窗口。'}</p>
      <div className="context-usage-actions"><button type="button" className="context-compact-button" aria-label="压缩上下文" aria-busy={compacting} disabled={unavailable} title={reason || '调用 CLI 原生 /compact，保留当前草稿'} onClick={() => void compact()}>{compacting ? <LoaderCircle size={14} className="spin" /> : <Minimize2 size={14} />}<span>/compact 压缩上下文</span></button>{reason && <p className="context-usage-note compact-unavailable">{reason}</p>}{accepted && !error && <p className="context-compact-accepted" role="status"><Check size={13} />{reportUpdated ? '上下文用量已更新' : 'CLI 已接受压缩请求，等待上下文更新'}</p>}{error && <p className="context-compact-error" role="alert">{error}</p>}</div>
    </Presence>, trigger.current?.closest('dialog') || document.body)}</>
}
