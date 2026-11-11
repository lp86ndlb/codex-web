import { useEffect, useRef, useState } from 'react'
import { Command, Search } from 'lucide-react'
import { useExitAction } from './Motion.tsx'
export interface PaletteItem { id: string; label: string; detail?: string; key?: string }
export function CommandPalette({ title, items, onChoose, onClose }: { title: string; items: PaletteItem[]; onChoose: (id: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState(''); const [active, setActive] = useState(0)
  const { closing, exit } = useExitAction(onClose, dialog)
  const rows = items.filter(item => `${item.id} ${item.label} ${item.detail || ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 40)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => { dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])
  return <dialog ref={dialog} className="command-palette" data-exiting={closing || undefined} aria-label={title} onCancel={event => { event.preventDefault(); exit() }} onClick={event => { if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) exit() } }}>
    <div className="palette-search"><Search size={20} /><input autoFocus aria-label={title} value={query} placeholder={title} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) { event.preventDefault(); event.stopPropagation() }
      if (event.key === 'ArrowDown' || event.key === 'Tab') setActive(index => (index + 1) % Math.max(1, rows.length))
      if (event.key === 'ArrowUp') setActive(index => (index + rows.length - 1) % Math.max(1, rows.length))
      if (event.key === 'Enter' && rows[active]) exit(() => onChoose(rows[active].id))
      if (event.key === 'Escape') exit()
    }} /><kbd>Esc</kbd></div>
    <div className="palette-results" role="listbox" aria-label="可用操作">{rows.map((item, index) => <button type="button" role="option" aria-selected={index === active} key={item.id} onMouseMove={() => setActive(index)} onClick={() => exit(() => onChoose(item.id))}><Command size={17} /><span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>{item.key && <kbd>{item.key}</kbd>}</button>)}{!rows.length && <p className="panel-hint">没有匹配的结果</p>}</div>
    <div className="palette-footer">↑ ↓ 选择 <span>Enter 确认</span></div>
  </dialog>
}
