import type { TeamEdge, TeamGroup, TeamMember, TeamSnapshot } from './team.ts'

export function teamRoute(state: Pick<TeamSnapshot, 'members' | 'edges'>, from: string, to: string): { error?: string; supervisors: string[] } {
  const a = state.members.find(m => m.threadId === from), b = state.members.find(m => m.threadId === to)
  if (!a || !b || a === b) return { error: '请选择团队内的其他会话', supervisors: [] }
  if (Math.abs(a.level - b.level) > 1) return { error: '不能越级通信，请通过直属上级或下级转达', supervisors: [] }
  if (a.level !== b.level && a.parentId !== b.threadId && b.parentId !== a.threadId) return { error: '不同层级只允许直属上下级通信', supervisors: [] }
  const edge = state.edges.find(e => e.source === from && e.target === to || e.target === from && e.source === to)
  const allowed = edge && (edge.direction === 'both' || edge.direction === 'forward' && edge.source === from || edge.direction === 'backward' && edge.target === from)
  if (!allowed) return { error: '此方向未开放通信，请由用户调整连线权限', supervisors: [] }
  return { supervisors: a.level === b.level ? [...new Set([a.parentId, b.parentId].filter((id): id is string => Boolean(id)))] : [] }
}

export function validateTeamGraph(members: TeamMember[], groups: TeamGroup[], edges: TeamEdge[], levels: string[]) {
  if (levels.length < 3 || levels.length > 10) return '团队应有 3–10 个层级'
  if (members.length > 80) return '本轮试验最多支持 80 个成员'
  if (groups.length > 80 || edges.length > 500) return '试验最多支持 80 个分组和 500 条连线'
  if (new Set(members.map(m => m.threadId)).size !== members.length) return '会话不能重复归组'
  if (members.length && members.filter(m => m.level === 1).length !== 1) return '第一层级必须且只能有一位负责人'
  if (new Set(groups.map(g => g.id)).size !== groups.length) return '分组标识不能重复'
  if (new Set(edges.map(e => e.id)).size !== edges.length) return '连线标识不能重复'
  const byId = new Map(members.map(m => [m.threadId, m]))
  for (const g of groups) if (g.level < 2 || g.level > levels.length || byId.get(g.parentId)?.level !== g.level - 1) return '分组必须隶属上一层级的一位成员'
  for (const m of members) {
    if (m.level < 1 || m.level > levels.length) return '成员层级不存在'
    if (m.level === 1) { if (m.parentId || m.groupId) return '最高负责人不属于下级分组'; continue }
    if (byId.get(m.parentId || '')?.level !== m.level - 1) return '成员只能有一位上一层级的直属上级'
    const g = groups.find(g => g.id === m.groupId)
    if (!g || g.level !== m.level || g.parentId !== m.parentId) return '分组与直属上级不一致，不能交叉归组'
  }
  const pairs = new Set<string>()
  for (const e of edges) {
    const a = byId.get(e.source), b = byId.get(e.target), pair = [e.source, e.target].sort().join('|')
    if (!a || !b || a === b || pairs.has(pair)) return '连线端点无效或重复'
    pairs.add(pair)
    if (Math.abs(a.level - b.level) > 1 || a.level !== b.level && a.parentId !== b.threadId && b.parentId !== a.threadId) return '连线不可越级或连接非直属的上下级'
  }
  return null
}

export interface TeamPoint { x: number; y: number }
export interface TeamBand { group: TeamGroup; x: number; y: number; width: number; height: number; memberIds: string[] }
export interface TeamMemberSlot { level: number; groupId: string | null; row: number; column: number }
export interface TeamLevelColumn { level: number; x: number; width: number }
export interface TeamLayout {
  positions: Record<string, TeamPoint>; bands: TeamBand[]; memberSlots: Record<string, TeamMemberSlot>
  levelColumns: TeamLevelColumn[]; width: number; height: number; bounds: { x: number; y: number; width: number; height: number }
}
export const teamNodeSize = { width: 180, height: 72 }
const levelStep = 300, siblingGap = 18, groupGap = 20, groupPadding = 16, headerHeight = 28, bottomPadding = 12
const memberOrder = (a: TeamMember, b: TeamMember) => a.order - b.order || a.threadId.localeCompare(b.threadId)
const groupOrder = (a: TeamGroup, b: TeamGroup) => a.order - b.order || a.id.localeCompare(b.id)

/** Every level owns one column. Recursively allocating contiguous subtree
 * intervals keeps groups and branches separate without changing authority.
 * Geometry is independent of the viewport, polling and transient run status. */
export function layoutTeam(state: Pick<TeamSnapshot, 'members' | 'groups' | 'levels'>): TeamLayout {
  const positions: TeamLayout['positions'] = {}, memberSlots: TeamLayout['memberSlots'] = {}, bands: TeamBand[] = []
  const levels = [...new Set(state.members.map(member => member.level))].sort((a, b) => a - b)
  const levelColumns = levels.map((level, column) => ({ level, x: column * levelStep, width: teamNodeSize.width }))
  const columns = new Map(levelColumns.map((column, index) => [column.level, index]))
  const children = new Map<string, TeamMember[]>(), groups = new Map(state.groups.map(group => [group.id, group]))
  for (const member of state.members) if (member.parentId) {
    const list = children.get(member.parentId) || []; list.push(member); children.set(member.parentId, list)
  }
  const placed = new Set<string>()
  function place(member: TeamMember, top: number): { height: number; first: number; last: number } {
    placed.add(member.threadId)
    const grouped = new Map<string, TeamMember[]>()
    for (const child of children.get(member.threadId) || []) if (!placed.has(child.threadId)) {
      const key = child.groupId || '', list = grouped.get(key) || []; list.push(child); grouped.set(key, list)
    }
    const ordered = [...grouped.entries()].sort(([a], [b]) => groups.has(a) && groups.has(b) ? groupOrder(groups.get(a)!, groups.get(b)!) : a.localeCompare(b))
    let cursor = top, first = Infinity, last = -Infinity
    for (const [index, [groupId, members]] of ordered.entries()) {
      if (index) cursor += groupGap
      cursor += headerHeight
      for (const [row, child] of members.sort(memberOrder).entries()) {
        if (row) cursor += siblingGap
        const subtree = place(child, cursor)
        first = Math.min(first, subtree.first); last = Math.max(last, subtree.last); cursor += subtree.height
        memberSlots[child.threadId].row = row
      }
      cursor += bottomPadding
      const group = groups.get(groupId)
      if (group) {
        const points = members.map(child => positions[child.threadId]), y = Math.min(...points.map(point => point.y)) - headerHeight
        const bottom = Math.max(...points.map(point => point.y + teamNodeSize.height)) + bottomPadding
        bands.push({ group, x: points[0].x - groupPadding, y, width: teamNodeSize.width + groupPadding * 2, height: bottom - y, memberIds: members.map(child => child.threadId) })
      }
    }
    if (!ordered.length) { first = last = top + teamNodeSize.height / 2; cursor = top + teamNodeSize.height }
    const column = columns.get(member.level) || 0
    positions[member.threadId] = { x: column * levelStep, y: (first + last) / 2 - teamNodeSize.height / 2 }
    memberSlots[member.threadId] = { level: member.level, groupId: member.groupId, row: 0, column }
    return { height: cursor - top, first, last }
  }
  let height = 0
  // Valid snapshots have one root. The fallback also keeps an incomplete import
  // visible instead of producing undefined node coordinates during refresh.
  for (const member of [...state.members].sort((a, b) => a.level - b.level || memberOrder(a, b))) if (!placed.has(member.threadId)) {
    if (height) height += groupGap
    height += place(member, height).height
  }
  bands.sort((a, b) => a.group.level - b.group.level || a.y - b.y || groupOrder(a.group, b.group))
  const width = levelColumns.length ? (levelColumns.length - 1) * levelStep + teamNodeSize.width + groupPadding * 2 : 0
  return { positions, bands, memberSlots, levelColumns, width, height, bounds: { x: -groupPadding, y: 0, width, height } }
}

export type TeamHandle = 'top' | 'bottom' | 'left' | 'right'
export type TeamCurve = [TeamPoint, TeamPoint, TeamPoint, TeamPoint]
export interface TeamEdgeLayout { sourceHandle: TeamHandle; targetHandle: TeamHandle; kind: 'direct' | 'arc'; points: TeamCurve }
/** Evaluate the same cubic used by the browser, for label placement and checks. */
export function teamCurvePoint(points: TeamCurve, t: number): TeamPoint {
  const u = 1 - t, weights = [u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3]
  return { x: points.reduce((value, point, i) => value + point.x * weights[i], 0), y: points.reduce((value, point, i) => value + point.y * weights[i], 0) }
}
function reverseRoute(route: TeamEdgeLayout): TeamEdgeLayout {
  const [a, b, c, d] = route.points
  return { ...route, sourceHandle: route.targetHandle, targetHandle: route.sourceHandle, points: [d, c, b, a] }
}

/** Adjacent levels connect directly across their free column gap. Same-level
 * neighbours use the nearest top/bottom ports; only obstructed peers use an
 * outside arc. A reversible route has the same geometry in both directions. */
export function layoutTeamEdge(layout: TeamLayout, source: string, target: string): TeamEdgeLayout | null {
  const a = layout.memberSlots[source], b = layout.memberSlots[target], pa = layout.positions[source], pb = layout.positions[target]
  if (!a || !b || !pa || !pb || source === target) return null
  const reverse = a.level > b.level || a.level === b.level && pa.y > pb.y
  const startId = reverse ? target : source, endId = reverse ? source : target, up = reverse ? pb : pa, down = reverse ? pa : pb
  let route: TeamEdgeLayout
  if (a.level !== b.level) {
    const start = { x: up.x + teamNodeSize.width, y: up.y + teamNodeSize.height / 2 }, end = { x: down.x, y: down.y + teamNodeSize.height / 2 }
    const reach = (end.x - start.x) / 2
    route = { sourceHandle: 'right', targetHandle: 'left', kind: 'direct', points: [start, { x: start.x + reach, y: start.y }, { x: end.x - reach, y: end.y }, end] }
  } else {
    const start = { x: up.x + teamNodeSize.width / 2, y: up.y + teamNodeSize.height }, end = { x: down.x + teamNodeSize.width / 2, y: down.y }
    const blocked = Object.entries(layout.positions).some(([id, point]) => id !== startId && id !== endId && start.x > point.x && start.x < point.x + teamNodeSize.width && end.y > point.y && start.y < point.y + teamNodeSize.height)
    if (!blocked) {
      const reach = (end.y - start.y) / 2
      route = { sourceHandle: 'bottom', targetHandle: 'top', kind: 'direct', points: [start, { x: start.x, y: start.y + reach }, { x: end.x, y: end.y - reach }, end] }
    } else {
      const span = down.y - up.y, preferred = Math.min(96, 32 + Math.sqrt(span) * 3)
      const candidates = (['right', 'left'] as const).map(side => {
        const sign = side === 'right' ? 1 : -1, x = side === 'right' ? up.x + teamNodeSize.width : up.x
        const neighbours = Object.values(layout.positions).filter(point => side === 'right' ? point.x > up.x : point.x < up.x)
        const room = neighbours.length ? Math.min(...neighbours.map(point => side === 'right' ? point.x - x : x - point.x - teamNodeSize.width)) - 16 : preferred
        // Equal controls put the maximum excursion at 3/4 of their offset.
        // Stay inside the clear lane, without touching either adjacent column.
        const reach = Math.max(8, Math.min(preferred, room)) * 4 / 3
        const first = { x, y: up.y + teamNodeSize.height / 2 }, last = { x, y: down.y + teamNodeSize.height / 2 }
        return { sourceHandle: side, targetHandle: side, kind: 'arc' as const, points: [first, { x: x + sign * reach, y: first.y }, { x: x + sign * reach, y: last.y }, last] as TeamCurve, reach }
      })
      // The right side wins ties, away from incoming hierarchy arrows.
      candidates.sort((a, b) => a.reach - b.reach)
      const { reach: _reach, ...nearest } = candidates[0]; route = nearest
    }
  }
  return reverse ? reverseRoute(route) : route
}

/** Row/column insertion is based on the nearest occupied slot, so dragging
 * vertically reorders members as predictably as dragging horizontally. */
export function reorderTeamSlots<T extends { id: string; position: TeamPoint }>(slots: T[], movingId: string, position: TeamPoint): string[] {
  const current = slots.findIndex(slot => slot.id === movingId)
  if (current < 0 || slots.length < 2) return slots.map(slot => slot.id)
  let nearest = 0, distance = Infinity
  for (const [i, slot] of slots.entries()) {
    const value = (slot.position.x - position.x) ** 2 + (slot.position.y - position.y) ** 2
    if (value < distance) { nearest = i; distance = value }
  }
  const order = slots.map(slot => slot.id); order.splice(current, 1); order.splice(nearest, 0, movingId); return order
}
