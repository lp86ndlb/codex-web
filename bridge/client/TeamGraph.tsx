import { describeModel } from '../shared/activity.ts'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Controls, Handle, Position, MarkerType, ConnectionMode, applyNodeChanges, BaseEdge, getBezierPath, useViewport, type EdgeProps, type Node, type NodeProps, type Edge, type Connection, type NodeChange, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Crown, Focus, Layers, Maximize2, MessageSquare, Network, Play, Plus, Settings2, UserMinus, Users, X } from 'lucide-react'
import { ContextMenu, type ContextTarget } from './ContextMenu.tsx'
import { TeamMemberDialog } from './TeamMemberDialog.tsx'
import { TeamImportDialog } from './TeamImportDialog.tsx'
import { TeamRemoveMemberDialog } from './TeamRemoveMemberDialog.tsx'
import { useExitAction } from './Motion.tsx'
import { api, uncertainSubmission } from './api.ts'
import type { TeamController } from './useTeam.ts'
import { teamOutstanding, teamStateLabels, type TeamDirection } from '../shared/team.ts'
import { layoutTeam, layoutTeamEdge, reorderTeamSlots, teamCurvePoint, teamNodeSize, teamRoute, validateTeamGraph, type TeamCurve, type TeamLayout } from '../shared/team-topology.ts'
import type { ModelOption, SessionOptions } from '../shared/types.ts'
import './team.css'

type MemberData = { label: string; level: number; model: string; running: boolean; pending: number }
const MemberNode = memo(function MemberNode({ data }: NodeProps<Node<MemberData>>) {
  return <div className={`team-node tier-${data.level} ${data.running ? 'running' : ''}`} title={`${data.label} · 第 ${data.level} 层`}>
    <span className="team-node-symbol">{data.level === 1 ? <Crown size={20} /> : <MessageSquare size={19} />}</span><div><strong>{data.label}</strong><small>{data.running ? '处理中' : data.pending ? `${data.pending} 项待处理` : describeModel(data.model || '默认模型')}</small></div>
    {(['top', 'bottom', 'left', 'right'] as const).map(side => <Handle key={side} id={side} type="source" position={Position[({ top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' } as const)[side]]} aria-label={`${side} 通信连接点`} />)}
  </div>
})
const GroupNode = memo(function GroupNode({ data }: NodeProps) { return <div className="team-group-label" title={`${data.label} · ${data.count} 个成员 · 上级：${data.parent}`}><strong>{String(data.label)}</strong><span>{String(data.count)}</span>{!String(data.label).includes(String(data.parent)) && <small>{String(data.parent)}</small>}</div> })
const nodeTypes = { member: MemberNode, teamGroup: GroupNode }
function LevelHeaders({ layout, labels, width }: { layout: TeamLayout; labels: string[]; width: number }) {
  const { x, zoom } = useViewport(), headerWidth = Math.max(38, Math.min(180, teamNodeSize.width * zoom))
  return <div className="team-level-headers" aria-label="团队层级">{layout.levelColumns.map(column => {
    const left = x + (column.x + teamNodeSize.width / 2) * zoom - headerWidth / 2
    return <div key={column.level} className="team-level-header" style={{ left, width: headerWidth, visibility: left < 0 || left + headerWidth > width ? 'hidden' : undefined }} title={`第 ${column.level} 层 · ${labels[column.level - 1]}`}><b>{String(column.level).padStart(2, '0')}</b>{zoom >= .35 && <span>{labels[column.level - 1]}</span>}</div>
  })}</div>
}
function mergeNodes(previous: Node[], projected: Node[]) {
  const byId = new Map(previous.map(node => [node.id, node]))
  return projected.map(node => ({ ...byId.get(node.id), ...node, measured: byId.get(node.id)?.measured }))
}
const RoutedEdge = memo(function RoutedEdge(props: EdgeProps) {
  const [bezier, x, y] = getBezierPath(props), route = props.data?.route as TeamCurve | undefined
  // Keep each tangent attached while a member is being dragged. The canonical
  // curve is recalculated after the drop, without extra orthogonal segments.
  const points: TeamCurve | undefined = route && [
    { x: props.sourceX, y: props.sourceY },
    { x: route[1].x + props.sourceX - route[0].x, y: route[1].y + props.sourceY - route[0].y },
    { x: route[2].x + props.targetX - route[3].x, y: route[2].y + props.targetY - route[3].y },
    { x: props.targetX, y: props.targetY },
  ]
  const description = typeof props.data?.description === 'string' ? props.data.description : undefined
  const shortVertical = points && points[0].x === points[3].x && points[1].x === points[0].x && points[2].x === points[0].x
  const label = points ? teamCurvePoint(points, description && !shortVertical ? .7 : .5) : { x, y }
  // A short peer-to-peer gap cannot fit a badge between the two pills. Keep
  // that badge just outside the column; direct hierarchy labels fit in its gap.
  if (description && shortVertical) label.x += teamNodeSize.width / 2 + 28
  const path = points ? `M${points[0].x},${points[0].y} C${points[1].x},${points[1].y} ${points[2].x},${points[2].y} ${points[3].x},${points[3].y}` : bezier
  return <g>{description && <title>{description}</title>}<BaseEdge path={path} markerStart={props.markerStart} markerEnd={props.markerEnd} style={props.style} label={props.label} labelX={label.x} labelY={label.y} labelBgPadding={[5, 3]} labelBgBorderRadius={5} interactionWidth={props.interactionWidth || 18} /></g>
})
const edgeTypes = { traffic: RoutedEdge, routed: RoutedEdge }
type Editor = { kind: 'member' | 'edge' | 'group'; id: string } | { kind: 'new-group' }

function GraphEditor({ editor, team, onClose }: { editor: Editor; team: TeamController; onClose: () => void }) {
  const state = team.state!, member = editor.kind === 'member' ? state.members.find(m => m.threadId === editor.id) : undefined
  const group = editor.kind === 'group' ? state.groups.find(g => g.id === editor.id) : undefined, edge = editor.kind === 'edge' ? state.edges.find(e => e.id === editor.id) : undefined
  const [level, setLevel] = useState(member?.level || group?.level || 2), [parent, setParent] = useState(member ? member.parentId || '' : group?.parentId || state.members.find(m => m.level === 1)?.threadId || ''), [groupId, setGroup] = useState(member?.groupId || ''), [name, setName] = useState(group?.name || member?.name || ''), [direction, setDirection] = useState<TeamDirection>(edge?.direction || 'both')
  const dialog = useRef<HTMLDialogElement>(null), { closing, exit } = useExitAction(onClose, dialog)
  useEffect(() => { dialog.current?.showModal() }, [])
  const title = editor.kind === 'member' ? '层级与分组' : editor.kind === 'edge' ? '通信方向' : '设置分组'
  async function save() {
    const next = structuredClone(state)
    if (edge) next.edges.find(e => e.id === edge.id)!.direction = direction
    else if (member) {
      const descendants = new Set<string>([member.threadId]); let size = 0
      while (size !== descendants.size) { size = descendants.size; for (const m of state.members) if (m.parentId && descendants.has(m.parentId)) descendants.add(m.threadId) }
      if (descendants.has(parent)) { team.setError('不能把成员归到自己或自己的下级'); return }
      const delta = level - member.level
      for (const m of next.members) if (descendants.has(m.threadId)) { m.level += delta; m.role = m.level === 1 ? 'lead' : m.level === 2 ? 'manager' : 'worker' }
      for (const g of next.groups) if (descendants.has(g.parentId)) g.level += delta
      const changed = next.members.find(m => m.threadId === member.threadId)!
      changed.name = name.trim() || member.name; changed.parentId = level === 1 ? null : parent; changed.groupId = level === 1 ? null : groupId || `group-${parent}`
      if (changed.groupId && !next.groups.some(g => g.id === changed.groupId)) next.groups.push({ id: changed.groupId, name: `${next.members.find(m => m.threadId === parent)?.name || '成员'}组`, level, parentId: parent, order: next.groups.length })
      next.edges = next.edges.filter(e => {
        const a = next.members.find(m => m.threadId === e.source)!, b = next.members.find(m => m.threadId === e.target)!
        const oldA = state.members.find(m => m.threadId === e.source)!, oldB = state.members.find(m => m.threadId === e.target)!
        return (a.level === b.level) === (oldA.level === oldB.level) && (a.level === b.level || a.parentId === b.threadId || b.parentId === a.threadId)
      })
      if (changed.parentId && !next.edges.some(e => [e.source, e.target].includes(changed.threadId) && [e.source, e.target].includes(changed.parentId!))) next.edges.push({ id: crypto.randomUUID(), source: changed.parentId, target: changed.threadId, direction: 'both' })
      next.groups = next.groups.filter(g => next.members.some(m => m.groupId === g.id) || state.groups.some(old => old.id === g.id && !state.members.some(m => m.groupId === old.id)))
    } else {
      if (!name.trim() || !parent) return
      if (group) { const g = next.groups.find(g => g.id === group.id)!; g.name = name.trim() }
      else next.groups.push({ id: crypto.randomUUID(), name: name.trim(), level, parentId: parent, order: next.groups.length })
    }
    const invalid = validateTeamGraph(next.members, next.groups, next.edges, next.levels)
    if (invalid) { team.setError(invalid); return }
    if (await team.topology(next)) exit()
  }
  return <dialog ref={dialog} className="team-editor-dialog" data-exiting={closing || undefined} aria-label={title} onCancel={e => { e.preventDefault(); exit() }}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭关系设置" onClick={() => exit()}><X size={16} /></button></header><form onSubmit={e => { e.preventDefault(); void save() }}>
    {edge ? <><p>{state.members.find(m => m.threadId === edge.source)?.name} · {state.members.find(m => m.threadId === edge.target)?.name}</p><label>允许的方向<select aria-label="通信方向" value={direction} onChange={e => setDirection(e.target.value as TeamDirection)}><option value="forward">单向：起点 → 终点</option><option value="backward">单向：终点 → 起点</option><option value="both">双向通信</option><option value="none">不通信</option></select></label><p className="team-card-note">同层连线需要双方直属上级审批；连线不能绕过层级。</p></> : <>
      <label>{member ? '节点名称' : '分组名称'}<input aria-label={member ? '节点名称' : '分组名称'} required value={name} onChange={e => setName(e.target.value)} maxLength={100} /></label>
      {!group && <><div className="team-form-row"><label>层级<select aria-label="节点层级" value={level} disabled={member?.level === 1} onChange={e => { const value = Number(e.target.value); setLevel(value); setParent(state.members.find(m => m.level === value - 1)?.threadId || ''); setGroup('') }}>{state.levels.map((label, i) => <option key={i} value={i + 1} disabled={i === 0 && member?.level !== 1}>{i + 1} · {label}</option>)}</select></label>{level > 1 && <label>直属上级<select aria-label="节点直属上级" value={parent} required onChange={e => { setParent(e.target.value); setGroup('') }}><option value="">选择上级</option>{state.members.filter(m => m.level === level - 1 && m.threadId !== member?.threadId).map(m => <option key={m.threadId} value={m.threadId}>{m.name}</option>)}</select></label>}</div>
      {member && level > 1 && <label>所属分组<select aria-label="节点所属分组" value={groupId} onChange={e => setGroup(e.target.value)}><option value="">上级默认分组</option>{state.groups.filter(g => g.level === level && g.parentId === parent).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>}</>}
      <p className="team-card-note">每名成员只属于一个分组和上级。调整层级会同时移动其下级；通信关系变化后重新审批未投递的任务。</p>
    </>}{team.error && <p className="team-error" role="alert">{team.error}</p>}<footer><button type="button" onClick={() => exit()}>取消</button><button className="team-primary" disabled={team.saving}>保存设置</button></footer></form></dialog>
}

export function TeamGraph({ team, models, defaults, focusId, onSelect, onApprovals, onChoose }: { team: TeamController; models: ModelOption[]; defaults: SessionOptions; focusId?: string; onSelect: (id: string) => void; onApprovals: () => void; onChoose: (id: string) => void }) {
  const state = team.state, flow = useRef<ReactFlowInstance>(), canvas = useRef<HTMLDivElement>(null), dragging = useRef(false)
  const [nodes, setNodes] = useState<Node[]>([]), [editor, setEditor] = useState<Editor | null>(null), [adding, setAdding] = useState<{ parent?: string } | null>(null), [importing, setImporting] = useState<{ parent?: string } | null>(null), [menu, setMenu] = useState<(ContextTarget & { id: string; kind: 'member' | 'group' }) | null>(null), [demo, setDemo] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 }), [viewMode, setViewMode] = useState<'clear' | 'all' | 'group' | 'manual'>('clear'), [groupFocus, setGroupFocus] = useState('')
  const manualViewport = useRef(false), requestedFrame = useRef({ kind: 'clear' as 'clear' | 'all' | 'group', groupId: '' })
  const [now, setNow] = useState(Date.now()), layout = useMemo(() => state ? layoutTeam(state) : null, [state?.graphVersion, state?.members, state?.groups, state?.levels])
  const projected = useMemo<Node[]>(() => {
    if (!state || !layout) return []
    return [
      ...layout.bands.filter(b => state.members.some(member => member.groupId === b.group.id)).map(b => ({ id: `group:${b.group.id}`, type: 'teamGroup', position: { x: b.x, y: b.y }, style: { width: b.width, height: b.height }, data: { label: b.group.name, count: b.memberIds.length, parent: state.members.find(m => m.threadId === b.group.parentId)?.name || '' }, className: 'team-group-band', zIndex: -1, draggable: true, connectable: false })),
      ...state.members.map(m => ({ id: m.threadId, type: 'member', position: layout.positions[m.threadId], data: { label: m.name, level: m.level, model: m.model || '默认模型', running: state.running.includes(m.threadId), pending: state.messages.filter(r => teamOutstanding.has(r.state) && (r.from === m.threadId || r.to === m.threadId)).length }, draggable: m.level !== 1, width: teamNodeSize.width, height: teamNodeSize.height, zIndex: 2, ariaLabel: `${m.name}，第 ${m.level} 层` })),
    ]
  }, [state, layout])
  function frame(kind: 'clear' | 'all' | 'group', groupId = '', animate = false) {
    if (!flow.current || !canvas.current || !layout?.height) return
    let bounds = { ...layout.bounds }
    const band = layout.bands.find(row => row.group.id === groupId)
    if (band) {
      bounds = { x: band.x - 20, y: band.y, width: band.width + 20, height: band.height }
      const parent = layout.positions[band.group.parentId]
      if (parent) {
        const left = Math.min(bounds.x, parent.x), top = Math.min(bounds.y, parent.y), right = Math.max(bounds.x + bounds.width, parent.x + teamNodeSize.width), bottom = bounds.y + bounds.height
        if ((bottom - top) * .78 + 64 <= canvas.current.clientHeight) bounds = { x: left, y: top, width: right - left, height: bottom - top }
      }
    }
    const width = canvas.current.clientWidth, height = canvas.current.clientHeight
    const zoom = Math.max(kind === 'all' ? .05 : .78, Math.min(1, (width - 64) / Math.max(1, bounds.width), (height - 96) / Math.max(1, bounds.height)))
    const x = (kind === 'clear' ? Math.max(24, (width - bounds.width * zoom) / 2) : (width - bounds.width * zoom) / 2) - bounds.x * zoom
    const lead = state?.members.find(member => member.level === 1), anchor = lead && layout.positions[lead.threadId]
    // Readable mode starts at the leader's subtree centre, not an empty corner
    // above a tall tree. Overview and group focus remain explicit alternatives.
    const centreY = kind === 'clear' && anchor && bounds.height * zoom > height - 96 ? anchor.y + teamNodeSize.height / 2 : bounds.y + bounds.height / 2
    const y = height / 2 - centreY * zoom
    const reduced = document.documentElement.dataset.animations === 'false' || matchMedia('(prefers-reduced-motion: reduce)').matches
    void flow.current.setViewport({ x, y, zoom }, { duration: animate && !reduced ? 180 : 0 })
  }
  const currentFrame = useRef(frame); currentFrame.current = frame
  function showFrame(kind: 'clear' | 'all' | 'group', groupId = '') {
    manualViewport.current = false; requestedFrame.current = { kind, groupId }; setViewMode(kind); setGroupFocus(groupId); frame(kind, groupId, true)
  }
  useEffect(() => {
    if (dragging.current) return
    // Keep measured connection handles across status-only refreshes.
    setNodes(previous => mergeNodes(previous, projected))
  }, [projected])
  useEffect(() => {
    if (manualViewport.current) return
    const timer = setTimeout(() => { if (!manualViewport.current) currentFrame.current(requestedFrame.current.kind, requestedFrame.current.groupId) }, 80)
    return () => clearTimeout(timer)
  }, [layout?.width, layout?.height, state?.members.length, viewportSize.width, viewportSize.height])
  useEffect(() => {
    if (!canvas.current) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect; if (!rect) return
      clearTimeout(timer); timer = setTimeout(() => setViewportSize(previous => previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height }), 80)
    })
    observer.observe(canvas.current)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [Boolean(state)])
  useEffect(() => {
    const row = state?.messages.find(m => m.id === focusId), from = row && layout?.positions[row.from], to = row && layout?.positions[row.to]
    if (!from || !to) return
    const timer = setTimeout(() => { const reduced = document.documentElement.dataset.animations === 'false' || matchMedia('(prefers-reduced-motion: reduce)').matches; void flow.current?.setCenter((from.x + to.x) / 2 + 90, (from.y + to.y) / 2 + 36, { zoom: Math.max(.85, flow.current.getZoom()), duration: reduced ? 0 : 180 }) }, 90)
    return () => clearTimeout(timer)
  }, [focusId])
  useEffect(() => {
    const latest = Math.max(0, ...(state?.messages.filter(m => m.state === 'delivered').map(m => m.updatedAt) || [])), remaining = latest + 12000 - Date.now()
    if (remaining > 0) { const timer = setTimeout(() => setNow(Date.now()), remaining + 30); return () => clearTimeout(timer) }
  }, [state?.messages])
  const edges = useMemo<Edge[]>(() => {
    if (!state || !layout) return []
    const route = (source: string, target: string) => layoutTeamEdge(layout, source, target)!
    const arrow = { type: MarkerType.ArrowClosed, width: 17, height: 17, color: 'var(--muted)' }
    const result: Edge[] = state.edges.map(e => { const path = route(e.source, e.target); return { ...e, sourceHandle: path.sourceHandle, targetHandle: path.targetHandle, type: 'routed', markerStart: ['both', 'backward'].includes(e.direction) ? arrow : undefined, markerEnd: ['both', 'forward'].includes(e.direction) ? arrow : undefined, className: `team-permission-edge ${e.direction === 'none' ? 'disabled' : ''}`, label: e.direction === 'none' ? '不通信' : undefined, interactionWidth: 18, data: { permissionId: e.id, route: path.points }, zIndex: 0 } })
    const byPair = new Map<string, typeof state.messages[number]>()
    for (const row of state.messages) if (row.id === focusId || teamOutstanding.has(row.state) || row.state === 'delivered' && row.updatedAt + 12000 > Math.max(now, Date.now())) {
      const key = [row.from, row.to].sort().join('|'), previous = byPair.get(key)
      if (!previous || previous.id !== focusId || row.id === focusId) byPair.set(key, row)
    }
    for (const row of byPair.values()) {
      if (!layout.positions[row.from] || !layout.positions[row.to]) continue
      const color = row.state === 'delivered' ? 'var(--success)' : row.state === 'rejected' || row.state === 'cancelled' ? 'var(--muted)' : 'var(--amber)'
      const path = route(row.from, row.to)
      const status = row.state === 'pending' ? '待批准' : row.state === 'reviewing' ? '待授权' : row.state === 'waiting' ? '等空闲' : teamStateLabels[row.state]
      const description = `${teamStateLabels[row.state]} · ${state.members.find(member => member.threadId === row.from)?.name || row.from} → ${state.members.find(member => member.threadId === row.to)?.name || row.to} · ${row.title}`
      result.push({ id: `traffic:${row.id}`, type: 'traffic', source: row.from, target: row.to, sourceHandle: path.sourceHandle, targetHandle: path.targetHandle, markerEnd: { ...arrow, color }, style: { stroke: color }, label: status, ariaLabel: description, className: `team-traffic-edge ${(row.state === 'sending' || row.state === 'reviewing' && row.reviews.some(r => ['sending', 'sent'].includes(r.state))) ? 'flowing' : ''} ${row.id === focusId ? 'focused' : ''}`, interactionWidth: 24, zIndex: 3, data: { messageId: row.id, route: path.points, description } })
    }
    return result
  }, [state, layout, focusId, now])
  if (!state || !layout) return <section className="team-workspace" aria-label="团队关系图加载状态"><div className="team-load-status">{team.error ? <><p className="team-error" role="alert">{team.error}</p><button onClick={() => { team.setError(''); void team.load() }}>重试读取关系图</button></> : <p role="status">正在读取关系图…</p>}</div></section>
  const closeMenu = (restore?: boolean) => { if (restore) menu?.trigger.focus({ preventScroll: true }); setMenu(null) }
  function connect(connection: Connection) {
    if (!state || !connection.source || !connection.target) return
    const existing = state.edges.find(e => [e.source, e.target].includes(connection.source!) && [e.source, e.target].includes(connection.target!))
    if (existing) { setEditor({ kind: 'edge', id: existing.id }); return }
    const next = structuredClone(state), edge = { id: crypto.randomUUID(), source: connection.source, target: connection.target, direction: 'forward' as const }
    next.edges.push(edge); const error = teamRoute(next, edge.source, edge.target).error
    if (error) { team.setError(error); onApprovals(); return }
    void team.topology(next)
  }
  function changes(changes: NodeChange[]) {
    setNodes(current => applyNodeChanges(changes.filter(change => change.type !== 'remove'), current))
  }
  function drop(node: Node) {
    dragging.current = false
    if (!state || !layout) return
    const next = structuredClone(state), member = next.members.find(m => m.threadId === node.id)
    if (member) {
      const peers = next.members.filter(m => m.groupId === member.groupId).sort((a, b) => a.order - b.order || a.threadId.localeCompare(b.threadId))
      const order = reorderTeamSlots(peers.map(m => ({ id: m.threadId, position: layout.positions[m.threadId] })), member.threadId, node.position)
      peers.forEach(m => { m.order = order.indexOf(m.threadId) })
    } else {
      const group = next.groups.find(g => `group:${g.id}` === node.id); if (!group) return
      const peers = next.groups.filter(g => g.level === group.level && g.parentId === group.parentId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      const order = reorderTeamSlots(peers.map(g => ({ id: g.id, position: layout.bands.find(band => band.group.id === g.id) || { x: 0, y: 0 } })), group.id, node.position)
      peers.forEach(g => { g.order = order.indexOf(g.id) })
    }
    manualViewport.current = true
    void team.topology(next).then(ok => { if (!ok) setNodes(previous => mergeNodes(previous, projected)) })
  }
  async function start() {
    if (demo) return
    setDemo(true); onApprovals()
    let key = ''
    try { key = localStorage.getItem('cweb:team-pilot-start') || crypto.randomUUID(); localStorage.setItem('cweb:team-pilot-start', key); await api('/team/start', { clientMessageId: key }); localStorage.removeItem('cweb:team-pilot-start') }
    catch (e) { team.setError(e instanceof Error ? e.message : '提交失败'); if (!uncertainSubmission(e)) localStorage.removeItem('cweb:team-pilot-start') }
    finally { setDemo(false); await team.load() }
  }
  return <section className="team-workspace" aria-label="团队关系图" data-view-mode={viewMode} data-narrow={viewportSize.width > 0 && viewportSize.width < 650 || undefined}>
    <header className="team-graph-header"><div className="team-graph-heading"><h1><Network size={17} />团队关系</h1><p>{state.members.length} 个会话 · {state.enabled ? '已开启' : '已关闭'}</p></div>
    <div className="team-graph-toolbar" aria-label="团队关系工具">{!team.pilot && <button onClick={() => setImporting({})}><MessageSquare size={14} />加入会话</button>}<button onClick={() => setAdding({})}><Plus size={14} />{team.pilot ? '成员' : '新建会话'}</button><button disabled={!state.members.length} onClick={() => setEditor({ kind: 'new-group' })}><Users size={14} />分组</button><button disabled={team.saving || state.levels.length >= 10} onClick={() => void team.topology({ ...structuredClone(state), levels: [...state.levels, `第 ${state.levels.length + 1} 层`] })}><Layers size={14} />层级</button>{team.pilot && <button disabled={demo || team.saving || !state.enabled || state.members.length < 3 || team.outstanding > 0 || state.running.length > 0} onClick={() => void start()}><Play size={13} />运行演示</button>}<button disabled={team.saving} onClick={() => void team.act('/team/enabled', { enabled: !state.enabled })}>{state.enabled ? '暂停通信' : '开启团队'}</button>{state.enabled && <button className="team-approval-button" onClick={onApprovals}>审批 <b>{team.outstanding}</b></button>}</div></header>
    <div className="team-flow" ref={canvas}><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={instance => { flow.current = instance; requestAnimationFrame(() => currentFrame.current('clear')) }} onMoveStart={event => { if (event) { manualViewport.current = true; setViewMode('manual') } }} onNodesChange={changes} onConnect={connect} connectionMode={ConnectionMode.Loose} onNodeDragStart={() => { dragging.current = true }} onNodeDragStop={(_, n) => drop(n)} zoomOnDoubleClick={false} onNodeDoubleClick={(event, n) => { event.stopPropagation(); if (state.members.some(m => m.threadId === n.id)) onChoose(n.id) }} onNodeContextMenu={(e, n) => { if (!['member', 'teamGroup'].includes(n.type || '')) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, trigger: document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`)!, id: n.type === 'member' ? n.id : n.id.slice(6), kind: n.type === 'member' ? 'member' : 'group' }) }} onEdgeClick={(_, e) => { if (e.data?.messageId) onSelect(String(e.data.messageId)); else if (e.data?.permissionId) setEditor({ kind: 'edge', id: String(e.data.permissionId) }) }} onPaneClick={() => setMenu(null)} minZoom={.05} maxZoom={1.7} deleteKeyCode={null} nodesConnectable={!team.saving} onlyRenderVisibleElements={nodes.length > 40} proOptions={{ hideAttribution: false }}>
      <LevelHeaders layout={layout} labels={state.levels} width={viewportSize.width} />
      <Controls showInteractive={false} showFitView={false} onZoomIn={() => { manualViewport.current = true; setViewMode('manual') }} onZoomOut={() => { manualViewport.current = true; setViewMode('manual') }} />
    </ReactFlow>{state.members.length > 0 && <div className="team-view-tools" aria-label="关系图视图"><button aria-pressed={viewMode === 'all'} onClick={() => showFrame('all')}><Maximize2 size={13} />全图</button><button aria-pressed={viewMode === 'clear'} onClick={() => showFrame('clear')}><Focus size={13} />清晰视图</button><select aria-label="定位分组" value={groupFocus} onChange={e => showFrame(e.target.value ? 'group' : 'clear', e.target.value)}><option value="">定位分组</option>{layout.bands.map(band => <option key={band.group.id} value={band.group.id}>{band.group.name} · {band.memberIds.length}</option>)}</select></div>}{!state.members.length && <div className="team-empty-graph"><Crown size={34} /><h2>先指定最高负责人</h2><p>{team.pilot ? '申请通过后建立原生会话，再逐层添加成员。' : '选择本工作区的已有会话作为负责人，再逐层加入成员。历史对话与模型设置会保留。'}</p>{!team.pilot && <button className="team-primary" onClick={() => setImporting({})}>选择已有负责人</button>}<button className={team.pilot ? 'team-primary' : ''} onClick={() => setAdding({})}>申请新增负责人</button>{!team.pilot && <small>默认手动审批；配置关系不会调用模型。</small>}</div>}</div>
    <footer className="team-graph-footer"><span>拖动画布 · 滚轮缩放 · 右键设置 · 双击进入会话</span><span><i />允许通信 <i className="pending" />待处理 <i className="done" />已送达</span></footer>
    <ContextMenu target={menu} title={menu?.kind === 'member' ? state.members.find(m => m.threadId === menu.id)?.name || '' : state.groups.find(g => g.id === menu?.id)?.name || ''} label="团队节点菜单" onClose={closeMenu}>
      {menu?.kind === 'member' && <><button role="menuitem" onClick={() => { onChoose(menu.id); closeMenu() }}><MessageSquare size={14} />进入原会话</button><button role="menuitem" onClick={() => { setEditor({ kind: 'member', id: menu.id }); closeMenu() }}><Layers size={14} />设置层级与分组</button><button role="menuitem" disabled={(state.members.find(m => m.threadId === menu.id)?.level || 0) >= state.levels.length} onClick={() => { setAdding({ parent: menu.id }); closeMenu() }}><Plus size={14} />申请新增下级</button></>}
      {menu?.kind === 'member' && !team.pilot && <button role="menuitem" disabled={(state.members.find(m => m.threadId === menu.id)?.level || 0) >= state.levels.length} onClick={() => { setImporting({ parent: menu.id }); closeMenu() }}><MessageSquare size={14} />加入已有下级</button>}
      {menu?.kind === 'member' && <><div role="separator" /><button role="menuitem" className="team-remove-menu-item" disabled={team.saving} onClick={() => { team.setError(''); setRemoving(menu.id); closeMenu() }}><UserMinus size={14} />移出团队</button></>}
      {menu?.kind === 'group' && <button role="menuitem" onClick={() => { setEditor({ kind: 'group', id: menu.id }); closeMenu() }}><Settings2 size={14} />设置分组名称</button>}
    </ContextMenu>
    {editor && <GraphEditor editor={editor} team={team} onClose={() => setEditor(null)} />}
    {adding && <TeamMemberDialog team={team} models={models} defaults={defaults} initialParent={adding.parent} onClose={() => setAdding(null)} onRequested={onApprovals} />}
    {importing && <TeamImportDialog team={team} initialParent={importing.parent} onClose={() => setImporting(null)} />}
    {removing && <TeamRemoveMemberDialog team={team} threadId={removing} onClose={() => setRemoving(null)} />}
  </section>
}
