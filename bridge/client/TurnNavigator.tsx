import { memo, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import type { Item } from '../shared/types.ts'

/** DSH-style turn rail, adapted to native Codex message ids and paged rendering. */
export const TurnNavigator = memo(function TurnNavigator({ items, viewport, onNavigate }: { items: Item[]; viewport: RefObject<HTMLDivElement>; onNavigate: (id: string) => void }) {
  const prompts = useMemo(() => items.filter(item => item.type === 'userMessage').map((item, index) => ({ id: item.id, index, text: item.text.slice(0, 300).replace(/\s+/g, ' ').trim() || (item.attachments?.length ? '附件消息' : '用户提问') })), [items])
  const [active, setActive] = useState(''); const [preview, setPreview] = useState<{ index: number; top: number } | null>(null)
  const frame = useRef<HTMLElement>(null); const scroller = useRef<HTMLDivElement>(null); const tooltip = useId()
  const keys = prompts.map(row => row.id).join(',')
  useEffect(() => {
    const node = viewport.current; if (!node) return
    let pending = 0
    const update = () => {
      pending = 0; const top = node.getBoundingClientRect().top + node.clientHeight * .3
      const rows = [...node.querySelectorAll<HTMLElement>('[data-message-id]')]
      const current = rows.findLast(row => row.getBoundingClientRect().top <= top) || rows[0]
      if (current) setActive(current.dataset.messageId || '')
    }
    const schedule = () => { if (!pending) pending = requestAnimationFrame(update) }
    node.addEventListener('scroll', schedule, { passive: true }); schedule()
    return () => { cancelAnimationFrame(pending); node.removeEventListener('scroll', schedule) }
  }, [keys, viewport])
  if (prompts.length < 2) return null
  function show(index: number, button: HTMLButtonElement) {
    const parent = frame.current
    if (parent) setPreview({ index, top: Math.max(0, Math.min(parent.clientHeight - 88, button.getBoundingClientRect().top - parent.getBoundingClientRect().top - 30)) })
  }
  return <nav ref={frame} className="turn-navigator" aria-label="对话回溯" onMouseLeave={() => setPreview(null)}><div ref={scroller} className="turn-navigator-scroll">{prompts.map(row => <button key={row.id} type="button" className="turn-mark" aria-label={`定位第 ${row.index + 1} 条提问`} aria-current={active === row.id ? 'true' : undefined} aria-describedby={preview?.index === row.index ? tooltip : undefined} onMouseEnter={event => show(row.index, event.currentTarget)} onFocus={event => show(row.index, event.currentTarget)} onBlur={() => setPreview(null)} onClick={() => onNavigate(row.id)} />)}</div>{preview && <div id={tooltip} role="tooltip" className="turn-preview" style={{ top: preview.top }}><small>第 {preview.index + 1} 条提问</small><p>{prompts[preview.index]?.text}</p></div>}</nav>
})
