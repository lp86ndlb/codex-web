import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { Presence } from './Motion.tsx'

/** A select-only combobox: browser-native pickers cannot animate their exit. */
export function ComposerSelect({ label, value, options, onChange, icon, className, title }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; icon?: ReactNode; className?: string; title?: string }) {
  const id = useId(); const trigger = useRef<HTMLButtonElement>(null); const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false); const [active, setActive] = useState(0); const [position, setPosition] = useState<CSSProperties>({})
  const typeahead = useRef({ text: '', at: 0 })
  function measure() {
    const r = trigger.current?.getBoundingClientRect(); if (!r) return
    const width = Math.min(300, Math.max(220, r.width), innerWidth - 24)
    setPosition({ left: Math.min(Math.max(12, r.left), innerWidth - width - 12), bottom: innerHeight - r.top + 8, width, maxHeight: Math.min(360, Math.max(96, r.top - 24)) })
  }
  function reveal() {
    measure(); setActive(Math.max(0, options.findIndex(option => option.value === value)))
    trigger.current?.closest('form')?.querySelector('details.permission-menu')?.removeAttribute('open')
    setOpen(true)
  }
  function close() { setOpen(false) }
  function choose(index: number) { const option = options[index]; if (!option) return; onChange(option.value); close(); trigger.current?.focus() }
  useLayoutEffect(() => {
    const node = popup.current; if (!node) return
    if (open && node.showPopover && !node.matches(':popover-open')) node.showPopover()
    // Pin top-layer animations to this commit, including the retained exit.
    for (const animation of node.getAnimations()) if (animation instanceof CSSAnimation) animation.startTime = document.timeline.currentTime
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close() }
    const frame = requestAnimationFrame(() => popup.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' }))
    document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', measure)
    // Streaming, question exit and scroll anchoring can move the conversation
    // without user input. Keep the menu attached instead of dismissing it.
    let positionFrame = 0
    const reposition = () => { if (!positionFrame) positionFrame = requestAnimationFrame(() => { positionFrame = 0; measure() }) }
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) reposition() }
    const size = new ResizeObserver(reposition); if (trigger.current?.closest('.composer')) size.observe(trigger.current.closest('.composer')!)
    document.addEventListener('scroll', scroll, true)
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(positionFrame); size.disconnect(); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', measure); document.removeEventListener('scroll', scroll, true) }
  }, [open])
  useEffect(() => { if (open) popup.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' }) }, [active])
  const selected = options.find(option => option.value === value)
  return <><button ref={trigger} type="button" role="combobox" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="listbox" aria-activedescendant={open ? `${id}-${active}` : undefined} title={title || selected?.label} className={`composer-select-trigger ${className || ''}`} onBlur={event => { if (!popup.current?.contains(event.relatedTarget as Node)) close() }} onClick={() => open ? close() : reveal()} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Tab') { close(); return }
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation()
      if (!open) { reveal(); return }
      setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + options.length + (event.key === 'ArrowDown' ? 1 : -1)) % options.length)
    } else if ((event.key === 'Enter' || event.key === ' ') && open) { event.preventDefault(); event.stopPropagation(); choose(active) }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      event.preventDefault(); if (!open) reveal()
      const now = performance.now(); typeahead.current = { text: now - typeahead.current.at < 700 ? typeahead.current.text + event.key : event.key, at: now }
      const index = options.findIndex(option => option.label.toLocaleLowerCase().includes(typeahead.current.text.toLocaleLowerCase())); if (index >= 0) setActive(index)
    }
  }}>{icon}<span>{selected?.label || value || label}</span></button>
  {createPortal(<Presence elementRef={popup} show={open} {...{ popover: 'manual' as const }} id={id} role="listbox" aria-label={`${label}选项`} className="composer-select-popover" style={position} onPointerDown={event => { if ((event.target as Element).closest('[role="option"]')) event.preventDefault() }}>{options.map((option, index) => <button type="button" role="option" aria-selected={option.value === value} id={`${id}-${index}`} tabIndex={-1} data-active={active === index || undefined} key={option.value} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>{option.value === value ? <Check size={15} /> : <span className="select-check-space" />}<span>{option.label}</span></button>)}</Presence>, trigger.current?.closest('dialog') || document.body)}</>
}
