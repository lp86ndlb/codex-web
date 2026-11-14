import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Archive, Copy, GitBranch, MessageSquare, Pencil, SquareTerminal } from 'lucide-react'
import { Presence } from './Motion.tsx'
import './thread-menu.css'

export interface ThreadMenuTarget { threadId: string; x: number; y: number; trigger: HTMLElement }
export type ThreadMenuAction = 'open' | 'rename' | 'fork' | 'copy-title' | 'terminal' | 'archive'

/** A top-layer menu stays outside the sidebar's scrolling and folding clips. */
export function ThreadMenu({ target, title, busy, connected, unavailable, nativeActions, onClose, onAction }: {
  target: ThreadMenuTarget | null; title: string; busy: boolean; connected: boolean; unavailable: string; nativeActions: boolean
  onClose: (restoreFocus?: boolean) => void; onAction: (id: string, action: ThreadMenuAction) => void
}) {
  const popup = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CSSProperties>({})
  const close = useRef(onClose); close.current = onClose
  useLayoutEffect(() => {
    if (!target || !popup.current) return
    const node = popup.current
    if (node.showPopover && !node.matches(':popover-open')) node.showPopover()
    const measure = () => {
      if (!target.trigger.isConnected || target.trigger.closest('[inert]')) { close.current(false); return }
      const viewport = window.visualViewport
      const left = (viewport?.offsetLeft || 0) + 8, top = (viewport?.offsetTop || 0) + 8
      const right = left + (viewport?.width || innerWidth) - 16, bottom = top + (viewport?.height || innerHeight) - 16
      const y = target.y + node.offsetHeight > bottom ? target.y - node.offsetHeight : target.y
      setPosition({ left: Math.max(left, Math.min(target.x, right - node.offsetWidth)), top: Math.max(top, Math.min(y, bottom - node.offsetHeight)) })
    }
    measure()
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    for (const animation of node.getAnimations()) if (animation instanceof CSSAnimation) animation.startTime = document.timeline.currentTime
    const size = new ResizeObserver(measure); size.observe(node)
    window.addEventListener('resize', measure); window.visualViewport?.addEventListener('resize', measure)
    return () => { size.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure) }
  }, [target])
  useEffect(() => {
    if (!target) return
    const outside = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node) && !target.trigger.contains(event.target as Node)) close.current(false) }
    const focus = (event: FocusEvent) => { if (!popup.current?.contains(event.target as Node) && !target.trigger.contains(event.target as Node)) close.current(false) }
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) close.current(true) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close.current(true) } }
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', focus); document.addEventListener('scroll', scroll, true)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', focus); document.removeEventListener('scroll', scroll, true); document.removeEventListener('keydown', escape, true) }
  }, [target])
  const disabled = busy || !connected
  const reason = !connected ? '连接就绪后可执行此操作' : busy ? '正在提交操作，请稍候' : unavailable
  const action = (value: ThreadMenuAction) => { if (!target) return; onClose(value === 'copy-title' || value === 'terminal'); onAction(target.threadId, value) }
  return createPortal(<Presence show={Boolean(target)} elementRef={popup} {...{ popover: 'manual' as const }} role="menu" aria-label="会话菜单" tabIndex={-1} className="thread-context-menu" style={position} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); onClose(true); return }
    if (event.key === 'Tab') { onClose(true); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + buttons.length + (event.key === 'ArrowDown' ? 1 : -1)) % buttons.length]?.focus()
  }}>
    <div className="thread-menu-title" title={title}>{title}</div>
    <button type="button" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => action('open')}><MessageSquare size={15} /><span>打开会话</span></button>
    <button type="button" role="menuitem" tabIndex={-1} disabled={disabled} onClick={() => action('rename')}><Pencil size={15} /><span>重命名</span></button>
    {nativeActions && <button type="button" role="menuitem" tabIndex={-1} disabled={disabled} onClick={() => action('fork')}><GitBranch size={15} /><span>创建分支话题</span></button>}
    <div role="separator" />
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => action('copy-title')}><Copy size={15} /><span>复制会话名称</span></button>
    <button type="button" role="menuitem" tabIndex={-1} disabled={disabled || Boolean(unavailable)} title={reason || '复制 codex resume 命令，在终端接续'} onClick={() => action('terminal')}><SquareTerminal size={15} /><span>复制终端继续命令</span></button>
    <div role="separator" />
    <button type="button" role="menuitem" tabIndex={-1} disabled={disabled || Boolean(unavailable)} title={reason || '归档后可在设置中恢复'} onClick={() => action('archive')}><Archive size={15} /><span>归档会话</span></button>
    {reason && <p className="thread-menu-note">{reason}</p>}
  </Presence>, document.body)
}
