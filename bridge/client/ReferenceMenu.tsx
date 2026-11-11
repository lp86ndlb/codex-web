import { useEffect, useState } from 'react'
import { Check, File, LoaderCircle } from 'lucide-react'
import type { FileEntry } from '../shared/types.ts'
import { Checkbox } from './dsh/Checkbox.tsx'
import { api, message } from './api.ts'

export function ReferenceMenu({ workspaceId, query, selected, onToggle, onDone, indexed = false }: {
  workspaceId: string; query: string; selected: string[]; onToggle: (path: string) => void; onDone: () => void; indexed?: boolean
}) {
  const [rows, setRows] = useState<FileEntry[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false; setLoading(true)
    const timer = setTimeout(() => {
      const directory = query.includes('/') ? query.slice(0, query.lastIndexOf('/')) || '.' : '.'
      const endpoint = indexed ? `/references?workspace=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}` : `/files?workspace=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(directory)}`
      void api<FileEntry[]>(endpoint).then(value => { if (!cancelled) { setRows(value.filter(row => !row.directory && row.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()))); setError('') } }).catch(error => { if (!cancelled) setError(message(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    }, 140)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [workspaceId, query, indexed])
  return <div className="reference-menu input-picker" role="region" aria-label="选择引用文件" onKeyDown={event => {
    if (event.key === 'Escape' || event.shiftKey && event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); onDone() }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const inputs = [...event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]; const index = inputs.indexOf(event.target as HTMLInputElement)
      event.preventDefault(); inputs[(index + inputs.length + (event.key === 'ArrowDown' ? 1 : -1)) % inputs.length]?.focus()
    }
  }}><div className="input-picker-heading"><span><File size={15} />引用项目文件</span><button type="button" onClick={onDone}><Check size={14} />完成{selected.length > 0 && ` · ${selected.length}`}</button></div><div className="input-picker-list">
    {loading && !rows.length ? <p className="picker-hint"><LoaderCircle size={15} className="spin" />正在查找文件…</p> : rows.map(row => <div className="input-picker-row" key={row.path}><Checkbox checked={selected.includes(row.path)} label={row.path} onChange={() => onToggle(row.path)} /></div>)}
    {!loading && !rows.length && <p className="picker-hint">{error || '没有匹配的文件，试试输入名称或路径。'}</p>}
  </div><div className="input-picker-footer">可以勾选多个文件 · 继续输入筛选 · Esc 返回</div></div>
}
