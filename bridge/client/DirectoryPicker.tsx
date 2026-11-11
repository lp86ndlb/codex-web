import { Checkbox } from './dsh/Checkbox.tsx'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUp, Check, ChevronRight, Folder, FolderOpen, HardDrive, Home, Link2, LoaderCircle, Pencil, RefreshCw, Search } from 'lucide-react'
import type { DirectoryListing, WorkspaceInfo } from '../shared/types.ts'
import { api, message } from './api.ts'
import { IconButton, Notice } from './components.tsx'

export function DirectoryPicker({ initialPath, workspaces, onSelect, disabled = false }: {
  initialPath?: string; workspaces: WorkspaceInfo[]; onSelect: (path: string) => void; disabled?: boolean
}) {
  const [location, setLocation] = useState(initialPath)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [selected, setSelected] = useState('')
  const [hidden, setHidden] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const select = useRef(onSelect); select.current = onSelect
  const crumbs = useRef<HTMLElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); select.current('')
    const timer = setTimeout(() => {
      api<DirectoryListing>('/workspaces/browse', { ...(location ? { path: location } : {}), hidden, query, offset }).then(value => {
        if (cancelled) return
        setListing(value); setSelected(''); select.current(value.path)
      }).catch(error => { if (!cancelled) setError(message(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    }, query ? 180 : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [location, hidden, query, offset, revision])

  useEffect(() => { if (crumbs.current) crumbs.current.scrollLeft = crumbs.current.scrollWidth }, [listing?.path])

  function change(path?: string, back = false) {
    if (disabled) return
    if (!back && listing) setHistory(old => [...old, listing.path])
    setLoading(true); setSelected(''); select.current(''); setError('')
    setLocation(path); setQuery(''); setOffset(0); setEditing(false); setRevision(value => value + 1)
  }
  function filter(value: string) { setQuery(value); setOffset(0); setSelected(''); setLoading(true); select.current('') }
  const pending = disabled || loading
  const chosen = selected || listing?.path || ''

  return <div className="directory-picker" aria-label="选择本机文件夹">
    <div className="directory-toolbar">
      <IconButton label="返回上一位置" disabled={pending || !history.length} onClick={() => { const previous = history.at(-1); setHistory(old => old.slice(0, -1)); change(previous, true) }}><ArrowLeft size={17} /></IconButton>
      <IconButton label="上一级文件夹" disabled={pending || !listing?.parent} onClick={() => change(listing?.parent || undefined)}><ArrowUp size={17} /></IconButton>
      {editing ? <div className="directory-address"><input autoFocus aria-label="输入完整路径" maxLength={4096} value={pathDraft} placeholder="/home/用户名/projects" onChange={event => setPathDraft(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (pathDraft.trim()) change(pathDraft.trim()) }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false) }
      }} /><button type="button" disabled={pending || !pathDraft.trim()} onClick={() => change(pathDraft.trim())}>前往</button></div>
        : <nav className="directory-crumbs" aria-label="文件夹路径" ref={crumbs}>{listing?.breadcrumbs.map((crumb, index) => <span key={crumb.path}>{index > 0 && <ChevronRight size={13} />}<button type="button" disabled={pending} aria-current={index === listing.breadcrumbs.length - 1 ? 'location' : undefined} title={crumb.path} onClick={() => change(crumb.path)}>{crumb.name}</button></span>) || <span>正在打开文件夹…</span>}</nav>}
      <IconButton label={editing ? '返回图形浏览' : '输入路径'} disabled={disabled} onClick={() => { setPathDraft(listing?.path || ''); setEditing(!editing) }}><Pencil size={15} /></IconButton>
    </div>
    <div className="directory-layout">
      <aside className="directory-locations" aria-label="快捷位置"><span className="directory-section-label">位置</span>
        <button type="button" disabled={pending} onClick={() => change()}><Home size={17} />主目录</button>
        <button type="button" disabled={pending} onClick={() => change(listing?.root || '/')}><HardDrive size={17} />文件系统</button>
        {workspaces.length > 0 && <span className="directory-section-label">工作区</span>}
        {workspaces.map(workspace => <button type="button" key={workspace.id} title={workspace.path} disabled={pending} className={listing?.path === workspace.path ? 'active' : ''} onClick={() => change(workspace.path)}><Folder size={17} /><span>{workspace.name}</span></button>)}
      </aside>
      <div className="directory-content">
        <label className="directory-search"><Search size={16} /><input aria-label="筛选文件夹" maxLength={200} placeholder="筛选当前文件夹…" value={query} disabled={disabled} onChange={event => filter(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} /></label>
        <div className="directory-list" aria-label="文件夹列表" aria-busy={loading}>
          {loading ? <div className="directory-empty" role="status"><LoaderCircle className="spin" size={23} /><span>正在读取文件夹…</span></div>
            : error ? <div className="directory-error"><Notice text={error} /><button type="button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} />重试</button></div>
              : listing?.directories.length ? listing.directories.map(folder => <div className={`directory-row ${selected === folder.path ? 'selected' : ''}`} key={folder.path}>
                <button type="button" className="directory-select" disabled={disabled} aria-label={`选择文件夹 ${folder.name}`} aria-pressed={selected === folder.path} title={folder.path}
                  onClick={() => { setSelected(folder.path); select.current(folder.path) }} onDoubleClick={() => change(folder.path)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); change(folder.path) } }}>
                  {selected === folder.path ? <FolderOpen size={21} /> : <Folder size={21} />}<span>{folder.name}</span>{folder.symlink && <Link2 size={14} aria-label="目录链接" />}{selected === folder.path && <Check size={16} />}
                </button><IconButton label={`进入文件夹 ${folder.name}`} disabled={disabled} onClick={() => change(folder.path)}><ChevronRight size={17} /></IconButton>
              </div>) : <div className="directory-empty"><FolderOpen size={28} /><span>{query ? '没有匹配的文件夹' : '这里没有子文件夹'}</span><small>{query ? '试试其他名称，或清空筛选' : '可以直接使用当前文件夹'}</small></div>}
        </div>
        <div className="directory-list-footer"><Checkbox label="显示隐藏文件夹" checked={hidden} disabled={disabled} onChange={value => { setHidden(value); setOffset(0); setSelected(''); setLoading(true); select.current('') }} />
          {listing && !loading && !error && <span>{listing.total} 个文件夹</span>}
        </div>
        {listing && listing.total > listing.limit && !error && <div className="directory-pages"><button type="button" disabled={pending || offset === 0} onClick={() => setOffset(Math.max(0, offset - listing.limit))}>上一页</button><span>{Math.floor(offset / listing.limit) + 1} / {Math.ceil(listing.total / listing.limit)}</span><button type="button" disabled={pending || offset + listing.limit >= listing.total} onClick={() => setOffset(offset + listing.limit)}>下一页</button></div>}
      </div>
    </div>
    <div className="directory-selection"><FolderOpen size={18} /><div><span>{selected ? '已选择文件夹' : '当前文件夹'}</span><strong title={chosen}>{loading ? '正在读取…' : error ? '请选择可访问的文件夹' : chosen}</strong></div></div>
    <p className="directory-help">单击选择文件夹，双击或点击右侧箭头进入。</p>
  </div>
}
