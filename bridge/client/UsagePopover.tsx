import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Gauge, X } from 'lucide-react'
import { StatusPanel } from './StatusPanel.tsx'
import { Presence } from './Motion.tsx'

export function UsagePopover() {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null); const popup = useRef<HTMLDivElement>(null); const [open, setOpen] = useState(false)
  useEffect(() => {
    const node = popup.current
    const toggle = (event: Event) => setOpen((event as ToggleEvent).newState === 'open')
    node?.addEventListener('beforetoggle', toggle); return () => node?.removeEventListener('beforetoggle', toggle)
  }, [])
  function position() {
    const button = trigger.current; const node = popup.current
    if (!button || !node) return
    const rect = button.getBoundingClientRect()
    node.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 352))}px`
    node.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 10)}px`
  }
  // Native invokers participate in light-dismiss: clicking this trigger must
  // toggle once, rather than dismiss on pointerdown then reopen on click.
  return <><button ref={trigger} type="button" {...{ popovertarget: id, popovertargetaction: 'toggle' }} className="usage-trigger" aria-label="查看额度" aria-expanded={open} aria-controls={id} aria-haspopup="dialog" onClick={position}><Gauge size={16} /><span>额度</span></button>{createPortal(<div id={id} ref={popup} {...{ popover: 'auto' }} className="usage-popover" role="dialog" aria-label="账户额度" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { popup.current?.hidePopover(); trigger.current?.focus() } }}><div className="usage-popover-title"><span><Gauge size={16} />Codex 额度</span><button type="button" className="icon-button" aria-label="关闭额度" onClick={() => { popup.current?.hidePopover(); trigger.current?.focus() }}><X size={16} /></button></div><Presence show={open}><StatusPanel compact /></Presence></div>, document.body)}</>
}
