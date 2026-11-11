import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { ArrowUpRight, ChevronDown, Folder, GripVertical, MessageSquare, Pencil, Plus } from 'lucide-react'
import type { Approval, ThreadSummary, ThreadView, WorkspaceInfo } from '../shared/types.ts'
import { appendNavigation, moveNavigation, navigationKey, orderedNavigation, readNavigation, threadReadEvent, unreadCompletion } from '../shared/navigation-order.ts'
import { IconButton } from './components.tsx'
import { StateDot } from './dsh/StateDot.tsx'
export function workspaceFor(workspaces: WorkspaceInfo[], path: string) {
  return workspaces.filter(row => path === row.path || path.startsWith(row.path.replace(/\/$/, '') + '/')).sort((a, b) => b.path.length - a.path.length)[0]
}
interface GroupProps {
  workspaces: WorkspaceInfo[]; threads: ThreadSummary[]; selected: string | null; workspaceId?: string; views: Record<string, ThreadView>; approvals: Approval[]; busy: boolean; search: string
  onChoose: (id: string) => void; onNew: (id: string) => void; onRename: (workspace: WorkspaceInfo) => void
  reveal?: { id: string; seq: number }
}
type Drag = { kind: 'workspace' | 'thread'; id: string; scope: string }
type Drop = Drag & { after: boolean }
export const WorkspaceGroups = memo(function WorkspaceGroups(p: GroupProps) {
  const [layout, setLayout] = useState(() => { try { return readNavigation(localStorage.getItem(navigationKey)) } catch { return readNavigation(null) } })
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [dragging, setDragging] = useState<Drag | null>(null); const [drop, setDrop] = useState<Drop | null>(null); const [announcement, setAnnouncement] = useState('')
  const nav = useRef<HTMLElement>(null); const drag = useRef<Drag | null>(null); const suppressClick = useRef(false); const clickTimer = useRef<ReturnType<typeof setTimeout>>()
  const dropRef = useRef<Drop | null>(null)
  const beforeRects = useRef<Map<string, { node: HTMLElement; top: number }> | null>(null)
  const latest = useRef(p); latest.current = p
  const handledReveal = useRef(0); const query = p.search.trim().toLocaleLowerCase()
  const revealCwd = p.reveal ? p.views[p.reveal.id]?.cwd : undefined
  const orderedWorkspaces = useMemo(() => orderedNavigation(p.workspaces, layout.workspaces), [p.workspaces, layout.workspaces])
  const groups = useMemo(() => {
    const result = new Map<string, ThreadSummary[]>(); const roots = [...p.workspaces].sort((a, b) => b.path.length - a.path.length)
    for (const row of orderedNavigation(p.threads, layout.threads)) { const parent = roots.find(w => row.cwd === w.path || row.cwd.startsWith(w.path.replace(/\/$/, '') + '/')); if (parent) { const rows = result.get(parent.id) || []; rows.push(row); result.set(parent.id, rows) } }
    return result
  }, [p.workspaces, p.threads, layout.threads])
  useEffect(() => {
    setLayout(previous => { const workspaces = appendNavigation(previous.workspaces, p.workspaces.map(row => row.id)); const threads = appendNavigation(previous.threads, p.threads.map(row => row.id)); return workspaces === previous.workspaces && threads === previous.threads ? previous : { ...previous, workspaces, threads } })
  }, [p.workspaces, p.threads])
  useEffect(() => {
    if (!p.selected) return
    for (const [id, rows] of groups) { const index = rows.findIndex(row => row.id === p.selected); if (index >= 25) setLimits(previous => (previous[id] || 25) > index ? previous : { ...previous, [id]: index + 1 }) }
  }, [p.selected, groups])
  useEffect(() => { try { localStorage.setItem(navigationKey, JSON.stringify(layout)) } catch {} }, [layout])
  useEffect(() => {
    const read = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (typeof id !== 'string') return
      const view = latest.current.views[id]; const turn = view?.turnId || view?.runs?.at(-1)?.id
      setLayout(previous => ({ ...previous, read: { ...previous.read, [id]: { at: Date.now(), ...(turn ? { turn } : {}) } } }))
    }
    window.addEventListener(threadReadEvent, read); return () => window.removeEventListener(threadReadEvent, read)
  }, [])
  useEffect(() => { const sync = (event: StorageEvent) => { if (event.key === navigationKey) setLayout(readNavigation(event.newValue)) }; window.addEventListener('storage', sync); return () => { window.removeEventListener('storage', sync); clearTimeout(clickTimer.current) } }, [])
  useLayoutEffect(() => {
    const previous = beforeRects.current; beforeRects.current = null
    if (!previous || document.documentElement.dataset.animations === 'false' || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const { node, top } of previous.values()) { const delta = top - node.getBoundingClientRect().top; if (Math.abs(delta) > 1) node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }) }
  }, [layout])
  useEffect(() => {
    if (!p.reveal || handledReveal.current === p.reveal.seq) return
    // A background question can precede the throttled session-list update.
    const workspace = p.workspaces.find(row => groups.get(row.id)?.some(thread => thread.id === p.reveal!.id)) || (revealCwd ? workspaceFor(p.workspaces, revealCwd) : undefined)
    if (!workspace) return
    handledReveal.current = p.reveal.seq
    // This is an explicit notification jump, rather than a message-driven fold.
    setLayout(previous => ({ ...previous, collapsed: { ...previous.collapsed, [workspace.id]: false } }))
    const index = groups.get(workspace.id)?.findIndex(row => row.id === p.reveal!.id) ?? -1
    setLimits(previous => ({ ...previous, [workspace.id]: Math.max(previous[workspace.id] || 25, index + 1) }))
    const frame = requestAnimationFrame(() => document.querySelector(`[data-thread-id="${CSS.escape(p.reveal!.id)}"]`)?.scrollIntoView({ block: 'nearest' }))
    return () => cancelAnimationFrame(frame)
  }, [p.reveal, p.workspaces, groups, revealCwd])
  function capture(kind: Drag['kind']) {
    const nodes = [...(nav.current?.querySelectorAll<HTMLElement>(kind === 'workspace' ? '[data-workspace-id]' : '[data-thread-id]') || [])]
    beforeRects.current = new Map(nodes.map(node => [node.dataset.workspaceId || node.dataset.threadId!, { node, top: node.getBoundingClientRect().top }]))
  }
  function move(source: Drag, before: string | null) {
    capture(source.kind)
    setLayout(previous => {
      const field = source.kind === 'workspace' ? 'workspaces' : 'threads'
      const order = appendNavigation(previous[field], (source.kind === 'workspace' ? p.workspaces : p.threads).map(row => row.id))
      return { ...previous, [field]: moveNavigation(order, source.id, before) }
    })
    setAnnouncement('顺序已保存')
  }
  function finishDrag() { drag.current = null; dropRef.current = null; setDragging(null); setDrop(null); clearTimeout(clickTimer.current); clickTimer.current = setTimeout(() => { suppressClick.current = false }, 200) }
  function start(event: DragEvent, source: Drag) {
    if (p.busy) { event.preventDefault(); return }
    event.stopPropagation(); drag.current = source; setDragging(source); suppressClick.current = true
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-cweb-navigation', source.id)
  }
  function over(event: DragEvent, target: Drag) {
    const source = drag.current
    if (!source || source.kind !== target.kind || source.scope !== target.scope || source.id === target.id) return
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'
    const element = event.currentTarget as HTMLElement; const rect = (target.kind === 'workspace' ? element.querySelector('.group-heading') || element : element).getBoundingClientRect()
    const after = event.clientY > rect.top + rect.height / 2
    dropRef.current = { ...target, after }
    setDrop(previous => previous?.id === target.id && previous.after === after && previous.kind === target.kind ? previous : { ...target, after })
  }
  function dropped(event: DragEvent, target: Drag) {
    const source = drag.current
    const hint = dropRef.current
    if (!source || !hint || source.kind !== target.kind || source.scope !== target.scope || hint.id !== target.id) return
    event.preventDefault(); event.stopPropagation()
    const rows = target.kind === 'workspace' ? orderedWorkspaces : groups.get(target.scope) || []
    const index = rows.findIndex(row => row.id === target.id)
    const before = hint.after ? rows[index + 1]?.id || null : target.id
    move(source, before); finishDrag()
  }
  function keyboard(event: KeyboardEvent, source: Drag) {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const rows = source.kind === 'workspace' ? orderedWorkspaces : groups.get(source.scope) || []; const index = rows.findIndex(row => row.id === source.id)
    if (event.key === 'ArrowUp' && index > 0) move(source, rows[index - 1].id)
    else if (event.key === 'ArrowDown' && index < rows.length - 1) move(source, rows[index + 2]?.id || null)
  }
  return <nav ref={nav} className="thread-list compact-workspaces" data-sorting={dragging ? 'true' : undefined} aria-label="按工作区分类的会话"><span className="navigation-status" role="status" aria-live="polite">{announcement}</span>{orderedWorkspaces.map(workspace => {
    const rows = groups.get(workspace.id) || []; const source: Drag = { kind: 'workspace', id: workspace.id, scope: '' }
    const active = workspace.id === p.workspaceId || rows.some(row => row.id === p.selected)
    const groupMatch = `${workspace.name} ${workspace.path}`.toLocaleLowerCase().includes(query)
    const matching = query && !groupMatch ? rows.filter(row => row.title.toLocaleLowerCase().includes(query)) : rows
    if (query && !groupMatch && !matching.length) return null
    const folded = layout.collapsed[workspace.id] ?? false; const limit = limits[workspace.id] || 25
    return <section className={`workspace-group ${active ? 'active-workspace' : ''}`} key={workspace.id} data-workspace-id={workspace.id} data-dragging={dragging?.kind === 'workspace' && dragging.id === workspace.id || undefined} data-drop={drop?.kind === 'workspace' && drop.id === workspace.id ? drop.after ? 'after' : 'before' : undefined} onDragOver={event => over(event, source)} onDrop={event => dropped(event, source)}>
      <div className="group-heading"><button className="workspace-toggle" title={`${workspace.path} · 拖拽排序，Alt ↑ / ↓ 微调`} aria-expanded={!folded} draggable={!p.busy} onDragStart={event => start(event, source)} onDragEnd={finishDrag} onKeyDown={event => keyboard(event, source)} onClick={() => { if (!suppressClick.current) setLayout(previous => ({ ...previous, collapsed: { ...previous.collapsed, [workspace.id]: !folded } })) }}><GripVertical size={12} className="navigation-grip" /><ChevronDown size={13} className={folded ? 'folded' : ''} /><Folder size={16} /><span>{workspace.name}</span><small>{query ? matching.length : rows.length}</small></button>
        <IconButton label={`重命名工作区 ${workspace.name}`} onClick={() => p.onRename(workspace)}><Pencil size={13} /></IconButton><IconButton label={`在 ${workspace.name} 新建会话`} disabled={p.busy} onClick={() => p.onNew(workspace.id)}><Plus size={15} /></IconButton>
      </div>
      <div className="group-thread-fold" data-open={!folded || undefined} {...(folded ? { inert: '' } : {})}><div><div className="group-threads">{matching.slice(0, limit).map(row => {
        const source: Drag = { kind: 'thread', id: row.id, scope: workspace.id }
        const status = p.views[row.id]?.status || row.status; const waiting = row.attention || p.views[row.id]?.choicePending || p.approvals.some(approval => approval.threadId === row.id)
        const state = waiting ? 'warning' : status === 'inProgress' ? 'ongoing' : status === 'completed' && unreadCompletion(row, p.views[row.id], layout.read[row.id]) ? 'done' : status === 'failed' ? 'error' : undefined
        const label = waiting ? '等待你的选择' : status === 'inProgress' ? '正在执行' : status === 'completed' ? '任务已完成' : '执行失败'
        return <button key={row.id} data-thread-id={row.id} data-dragging={dragging?.kind === 'thread' && dragging.id === row.id || undefined} data-drop={drop?.kind === 'thread' && drop.id === row.id ? drop.after ? 'after' : 'before' : undefined} draggable={!p.busy} onDragStart={event => start(event, source)} onDragOver={event => over(event, source)} onDrop={event => dropped(event, source)} onDragEnd={finishDrag} onKeyDown={event => keyboard(event, source)} className={`thread-link ${p.selected === row.id ? 'selected' : ''}`} title={`${row.title} · 拖拽排序，Alt ↑ / ↓ 微调`} disabled={p.busy} onClick={() => { if (!suppressClick.current) p.onChoose(row.id) }}><GripVertical size={12} className="navigation-grip" /><div><span>{row.title}</span></div>{state ? <span className="thread-indicator" role="img" aria-label={label} title={label}><StateDot key={state} state={state} /></span> : <time>{new Date(row.updatedAt * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</time>}</button>
      })}{matching.length > limit && <button className="group-more" onClick={() => setLimits(old => ({ ...old, [workspace.id]: limit + 25 }))}>更多会话 · {matching.length - limit}</button>}</div></div></div>
    </section>
  })}{!p.workspaces.length && <div className="sidebar-empty">添加一个项目，开始你的第一个会话。</div>}{query && !p.workspaces.some(w => `${w.name} ${w.path}`.toLocaleLowerCase().includes(query)) && !p.threads.some(t => t.title.toLocaleLowerCase().includes(query)) && <div className="sidebar-empty">没有匹配的工作区或会话</div>}</nav>
}, (a, b) => a.workspaces === b.workspaces && a.threads === b.threads && a.selected === b.selected && a.reveal === b.reveal && a.views[a.reveal?.id || '']?.cwd === b.views[b.reveal?.id || '']?.cwd && a.workspaceId === b.workspaceId && a.busy === b.busy && a.search === b.search && a.approvals === b.approvals && a.threads.every(row => a.views[row.id]?.status === b.views[row.id]?.status && a.views[row.id]?.choicePending === b.views[row.id]?.choicePending))
export function WorkspaceHome({ workspaces, threads, onOpen, onAdd, onThread }: {
  workspaces: WorkspaceInfo[]; threads: ThreadSummary[]; onOpen: (id: string) => void; onAdd: () => void; onThread: (id: string) => void
}) {
  return <section className="workspace-home"><div className="welcome-eyebrow"><span />CWEB · 本地</div><h1>每个项目，<br /><span>都有自己的上下文。</span></h1><p>在不同工作区之间切换，接着上次的想法继续。</p>
    <div className="home-section-title"><h2>你的工作区 <span>{workspaces.length}</span></h2><button onClick={onAdd}><Plus size={16} />添加工作区</button></div>
    <div className="workspace-cards">{workspaces.map(workspace => {
      const rows = threads.filter(thread => workspaceFor(workspaces, thread.cwd)?.id === workspace.id)
      return <button key={workspace.id} className="workspace-card" onClick={() => onOpen(workspace.id)}><div><Folder size={22} /><ArrowUpRight size={17} /></div><strong>{workspace.name}</strong><span title={workspace.path}>{workspace.path}</span><small>{rows.length} 个会话{rows.length ? ` · 最近 ${new Date(rows[0].updatedAt * 1000).toLocaleDateString('zh-CN')}` : ' · 开始新的想法'}</small></button>
    })}{!workspaces.length && <button className="workspace-card add-workspace-card" onClick={onAdd}><Plus size={26} /><strong>添加第一个工作区</strong><span>选择本机项目目录，独立管理它的会话。</span></button>}</div>
    {threads.length > 0 && <><div className="home-section-title"><h2>最近会话</h2></div><div className="recent-threads">{threads.slice(0, 5).map(thread => <button key={thread.id} onClick={() => onThread(thread.id)}><MessageSquare size={17} /><strong>{thread.title}</strong><span>{workspaceFor(workspaces, thread.cwd)?.name || thread.cwd}</span><ArrowUpRight size={15} /></button>)}</div></>}
  </section>
}
