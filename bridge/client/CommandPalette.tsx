import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Command, Search } from 'lucide-react'
import { useExitAction } from './Motion.tsx'
export interface PaletteItem { id: string; label: string; detail?: string; key?: string }
export function CommandPalette({ title, items, stableOrder = false, onChoose, onClose }: { title: string; items: PaletteItem[]; stableOrder?: boolean; onChoose: (id: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const order = useRef(new Map<string, number>())
  if (stableOrder) for (const item of items) if (!order.current.has(item.id)) order.current.set(item.id, order.current.size)
  const listId = useId()
  const [query, setQuery] = useState(''); const [active, setActive] = useState(0)
  const [page, setPage] = useState(0)
  const { closing, exit } = useExitAction(onClose, dialog)
  const matches = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const result = items.filter(item => { const text = `${item.id} ${item.label} ${item.detail || ''}`.toLocaleLowerCase(); return terms.every(term => text.includes(term)) })
    return stableOrder ? result.sort((a, b) => order.current.get(a.id)! - order.current.get(b.id)!) : result
  }, [items, query, stableOrder])
  const lastPage = Math.max(0, Math.ceil(matches.length / 40) - 1), currentPage = Math.min(page, lastPage)
  const rows = matches.slice(currentPage * 40, currentPage * 40 + 40), index = Math.min(active, Math.max(0, rows.length - 1))
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  useEffect(() => { setActive(0); setPage(0) }, [query])
  useEffect(() => { dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index, currentPage])
  return <dialog ref={dialog} className="command-palette" data-exiting={closing || undefined} aria-label={title} onCancel={event => { event.preventDefault(); exit() }} onClick={event => { if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) exit() } }}>
    <div className="palette-search"><Search size={20} /><input autoFocus role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={rows[index] ? `${listId}-${index}` : undefined} aria-label={title} value={query} placeholder={title} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab', 'PageUp', 'PageDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation() }
      if (event.key === 'ArrowDown' || event.key === 'Tab' && !event.shiftKey) setActive((index + 1) % Math.max(1, rows.length))
      if (event.key === 'ArrowUp' || event.key === 'Tab' && event.shiftKey) setActive((index + rows.length - 1) % Math.max(1, rows.length))
      if (event.key === 'PageDown') { setPage(Math.min(lastPage, currentPage + 1)); setActive(0) }
      if (event.key === 'PageUp') { setPage(Math.max(0, currentPage - 1)); setActive(0) }
      if (event.key === 'Enter' && rows[index]) exit(() => onChoose(rows[index].id))
      if (event.key === 'Escape') exit()
    }} /><kbd>Esc</kbd></div>
    <div id={listId} className="palette-results" role="listbox" aria-label="可用操作">{rows.map((item, row) => <button id={`${listId}-${row}`} type="button" role="option" aria-selected={row === index} key={item.id} onMouseMove={() => setActive(row)} onClick={() => exit(() => onChoose(item.id))}><Command size={17} /><span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>{item.key && <kbd>{item.key}</kbd>}</button>)}{!rows.length && <p className="panel-hint">没有匹配的结果</p>}</div>
    <div className="palette-footer"><div>↑ ↓ 选择 <span>Enter 确认</span></div>{matches.length > 40 && <nav aria-label="搜索结果分页"><button type="button" aria-label="上一页结果" disabled={!currentPage} onClick={() => { setPage(currentPage - 1); setActive(0) }}>上一页</button><span>{currentPage + 1} / {lastPage + 1}</span><button type="button" aria-label="下一页结果" disabled={currentPage === lastPage} onClick={() => { setPage(currentPage + 1); setActive(0) }}>下一页</button></nav>}</div>
  </dialog>
}
