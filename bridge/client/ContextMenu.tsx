import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Presence } from './Motion.tsx'
import './thread-menu.css'

export interface ContextTarget { x: number; y: number; trigger: HTMLElement }
/** Shared popover behavior for threads, workspaces and graph nodes. */
export function ContextMenu({ target, title, label, onClose, children }: { target: ContextTarget | null; title: string; label: string; onClose: (restoreFocus?: boolean) => void; children: ReactNode }) {
  const popup = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose
  const [position, setPosition] = useState<CSSProperties>({})
  useLayoutEffect(() => {
    if (!target || !popup.current) return
    const node = popup.current
    if (node.showPopover && !node.matches(':popover-open')) node.showPopover()
    const measure = () => {
      if (!target.trigger.isConnected || target.trigger.closest('[inert]')) { close.current(false); return }
      const viewport = window.visualViewport, left = (viewport?.offsetLeft || 0) + 8, top = (viewport?.offsetTop || 0) + 8
      const right = left + (viewport?.width || innerWidth) - 16, bottom = top + (viewport?.height || innerHeight) - 16
      setPosition({ left: Math.max(left, Math.min(target.x, right - node.offsetWidth)), top: Math.max(top, Math.min(target.y + node.offsetHeight > bottom ? target.y - node.offsetHeight : target.y, bottom - node.offsetHeight)) })
    }
    measure(); node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    const observer = new ResizeObserver(measure); observer.observe(node)
    window.addEventListener('resize', measure); window.visualViewport?.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure) }
  }, [target])
  useEffect(() => {
    if (!target) return
    const outside = (event: Event) => { if (!popup.current?.contains(event.target as Node) && !target.trigger.contains(event.target as Node)) close.current(false) }
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) close.current(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close.current(true) } }
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside); document.addEventListener('wheel', scroll, { capture: true, passive: true }); document.addEventListener('touchmove', scroll, { capture: true, passive: true }); document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside); document.removeEventListener('wheel', scroll, true); document.removeEventListener('touchmove', scroll, true); document.removeEventListener('keydown', escape, true) }
  }, [target])
  return createPortal(<Presence show={Boolean(target)} elementRef={popup} {...{ popover: 'manual' as const }} role="menu" aria-label={label} tabIndex={-1} className="thread-context-menu" style={position} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    event.stopPropagation()
    if (['Escape', 'Tab'].includes(event.key)) { if (event.key === 'Escape') event.preventDefault(); onClose(true); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + buttons.length + (event.key === 'ArrowDown' ? 1 : -1)) % buttons.length]?.focus()
  }}><div className="thread-menu-title" title={title}>{title}</div>{children}</Presence>, document.body)
}
