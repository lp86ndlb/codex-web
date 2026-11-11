import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Item } from '../shared/types.ts'

interface Prompt { id: string; index: number; position: number; text: string }

/** DSH-style turn rail, adapted to native Codex message ids and paged rendering. */
export const TurnNavigator = memo(function TurnNavigator({ items, viewport, onNavigate }: { items: Item[]; viewport: RefObject<HTMLDivElement>; onNavigate: (id: string) => void }) {
  const prompts = useMemo(() => {
    const rows: Prompt[] = []
    items.forEach((item, position) => {
      if (item.type === 'userMessage') rows.push({ id: item.id, index: rows.length, position, text: item.text.slice(0, 300).replace(/\s+/g, ' ').trim() || (item.attachments?.length ? '附件消息' : '用户提问') })
    })
    return rows
  }, [items])
  const [active, setActive] = useState(''); const [preview, setPreview] = useState<{ id: string; index: number; top: number } | null>(null)
  const frame = useRef<HTMLElement>(null); const scroller = useRef<HTMLDivElement>(null); const previewBox = useRef<HTMLDivElement>(null); const tooltip = useId()
  const keys = prompts.map(row => row.id).join(',')
  const identities = useMemo(() => new Set(prompts.map(row => row.id)), [keys])
  const snapshot = useRef({ items, prompts, identities }); snapshot.current = { items, prompts, identities }

  function revealCurrent() {
    const list = scroller.current
    const mark = list?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!list || !mark || frame.current?.matches(':hover, :focus-within')) return
    const bounds = list.getBoundingClientRect(), target = mark.getBoundingClientRect()
    // Scroll this rail only: scrollIntoView would also move the conversation.
    if (target.top < bounds.top + 5) list.scrollTop -= bounds.top + 5 - target.top
    else if (target.bottom > bounds.bottom - 5) list.scrollTop += target.bottom - bounds.bottom + 5
  }
  useLayoutEffect(() => { revealCurrent() }, [active, keys])

  useEffect(() => {
    const node = viewport.current; if (!node) return
    let pending = 0
    let boundary = { first: '', last: '', before: '', after: '' }
    const update = () => {
      pending = 0
      const { items: currentItems, prompts: currentPrompts, identities: currentIds } = snapshot.current
      if (!currentPrompts.length) { setActive(''); return }
      const transcript = node.querySelector<HTMLElement>('.transcript')
      const first = transcript?.dataset.windowFirstId || '', last = transcript?.dataset.windowLastId || ''
      if (first !== boundary.first || last !== boundary.last) {
        const firstPosition = currentItems.findIndex(item => item.id === first)
        const lastPosition = currentItems.findIndex(item => item.id === last)
        boundary = {
          first, last,
          before: currentPrompts.findLast(row => row.position <= firstPosition)?.id || '',
          after: currentPrompts.findLast(row => row.position <= lastPosition)?.id || '',
        }
      }
      const rows = [...node.querySelectorAll<HTMLElement>('.user-message[data-message-id]')].filter(row => currentIds.has(row.dataset.messageId || ''))
      const atBottom = node.scrollHeight - node.clientHeight - node.scrollTop <= 8
      const height = Math.max(0, node.clientHeight - (dock?.getBoundingClientRect().height || 0))
      const readingLine = node.getBoundingClientRect().top + height * .3
      const current = rows.findLast(row => row.getBoundingClientRect().top <= readingLine)
      const next = atBottom
        ? boundary.after || rows.at(-1)?.dataset.messageId || currentPrompts.at(-1)!.id
        : current?.dataset.messageId || boundary.before || rows[0]?.dataset.messageId || currentPrompts[0].id
      setActive(value => value === next ? value : next)
    }
    const schedule = () => { if (!pending) pending = requestAnimationFrame(update) }
    const body = node.querySelector('.conversation-content') || node
    const resize = new ResizeObserver(schedule)
    resize.observe(node); resize.observe(body)
    const dock = node.parentElement?.querySelector('.composer-dock'); if (dock) resize.observe(dock)
    // Pagination may replace rows without changing their total height.
    const changes = new MutationObserver(schedule)
    changes.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-window-first-id', 'data-window-last-id'] })
    node.addEventListener('scroll', schedule, { passive: true }); schedule()
    return () => { cancelAnimationFrame(pending); resize.disconnect(); changes.disconnect(); node.removeEventListener('scroll', schedule) }
  }, [keys, viewport])

  useEffect(() => { setPreview(null) }, [keys])
  useLayoutEffect(() => {
    if (!preview || !previewBox.current || !frame.current) return
    const bounds = frame.current.getBoundingClientRect()
    const stage = frame.current.parentElement?.getBoundingClientRect()
    const height = previewBox.current.offsetHeight
    const top = Math.max((stage?.top || 0) + 8 - bounds.top, Math.min(bounds.height - height, preview.top))
    if (Math.abs(top - preview.top) > .5) setPreview(value => value ? { ...value, top } : value)
  }, [preview])

  if (prompts.length < 2) return null
  function show(row: Prompt, button: HTMLButtonElement) {
    const parent = frame.current
    if (parent) setPreview({ id: row.id, index: row.index, top: button.getBoundingClientRect().top - parent.getBoundingClientRect().top - 40 })
  }
  return <nav ref={frame} className="turn-navigator" aria-label="对话回溯" onMouseLeave={() => { setPreview(null); requestAnimationFrame(revealCurrent) }}><div ref={scroller} className="turn-navigator-scroll" onScroll={() => setPreview(null)}>{prompts.map(row => <button key={row.id} type="button" className="turn-mark" aria-label={`定位第 ${row.index + 1} 条提问`} aria-current={active === row.id ? 'true' : undefined} aria-describedby={preview?.id === row.id ? tooltip : undefined} onMouseEnter={event => show(row, event.currentTarget)} onFocus={event => show(row, event.currentTarget)} onBlur={() => setPreview(null)} onClick={() => onNavigate(row.id)} />)}</div>{preview && <div ref={previewBox} id={tooltip} role="tooltip" className="turn-preview" style={{ top: preview.top }}><small>第 {preview.index + 1} 条提问</small><p>{prompts[preview.index]?.text}</p></div>}</nav>
})
