import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutTeam, layoutTeamEdge, reorderTeamSlots, teamCurvePoint, teamNodeSize, validateTeamGraph, type TeamLayout, type TeamPoint } from '../shared/team-topology.ts'
import type { TeamMember, TeamGroup, TeamEdge } from '../shared/team.ts'

function fixture(sizes = [3, 9, 2]) {
  const member = (threadId: string, level: number, parentId: string | null, groupId: string | null, order: number): TeamMember => ({ threadId, name: threadId, cwd: '/test', role: level === 1 ? 'lead' : level === 2 ? 'manager' : 'worker', level, parentId, groupId, order, useDefaults: true, model: '', effort: '' })
  const members = [member('lead', 1, null, null, 0), member('manager', 2, 'lead', 'leaders', 1)]
  const groups: TeamGroup[] = [{ id: 'leaders', name: '主管', parentId: 'lead', level: 2, order: 0 }]
  const edges: TeamEdge[] = [{ id: 'lead-manager', source: 'lead', target: 'manager', direction: 'both' }]
  sizes.forEach((size, g) => {
    const id = `group-${g}`; groups.push({ id, name: `组 ${g}`, parentId: 'manager', level: 3, order: g + 1 })
    for (let i = 0; i < size; i++) { const name = `member-${g}-${i}`; members.push(member(name, 3, 'manager', id, i)); edges.push({ id: name, source: 'manager', target: name, direction: 'both' }) }
  })
  return { members, groups, edges, levels: Array.from({ length: 10 }, (_, i) => `层 ${i + 1}`) }
}
function intersects(a: TeamPoint & { width: number; height: number }, b: TeamPoint & { width: number; height: number }) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y }
function curveAvoidsMembers(layout: TeamLayout, source: string, target: string) {
  const route = layoutTeamEdge(layout, source, target)!
  assert.equal(route.points.length, 4, 'Every route is one smooth cubic, with no elbow segments')
  for (let i = 1; i < 300; i++) {
    const point = teamCurvePoint(route.points, i / 300)
    for (const [id, box] of Object.entries(layout.positions)) if (id !== source && id !== target) {
      assert.ok(!(point.x > box.x && point.x < box.x + teamNodeSize.width && point.y > box.y && point.y < box.y + teamNodeSize.height), `${source} → ${target} passes through ${id}`)
    }
  }
  const reversed = layoutTeamEdge(layout, target, source)!
  assert.deepEqual(reversed.points, [...route.points].reverse())
  assert.equal(reversed.sourceHandle, route.targetHandle)
}

test('16 members form three horizontal levels with ordered, contiguous vertical groups', () => {
  const state = fixture(), before = structuredClone(state), layout = layoutTeam(state)
  assert.equal(validateTeamGraph(state.members, state.groups, state.edges, state.levels), null)
  assert.deepEqual(state, before)
  assert.ok(layout.width <= 840 && layout.height > 1200 && layout.height < 1500, `${layout.width} × ${layout.height}`)
  assert.deepEqual(layout.levelColumns.map(column => column.level), [1, 2, 3], 'Unused configured levels do not consume canvas width')
  assert.ok(layout.positions.lead.x < layout.positions.manager.x && layout.positions.manager.x < layout.positions['member-0-0'].x)
  assert.equal(layout.positions.lead.y, layout.positions.manager.y, 'A leader and sole manager align exactly')
  const workerPositions = state.members.filter(member => member.level === 3).map(member => layout.positions[member.threadId])
  assert.equal(new Set(workerPositions.map(point => point.x)).size, 1, 'Every peer uses the same column')
  assert.equal(new Set(workerPositions.map(point => point.y)).size, 14)
  const boxes = Object.entries(layout.positions).map(([id, point]) => ({ id, ...point, ...teamNodeSize }))
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!intersects(boxes[i], boxes[j]), `${boxes[i].id} overlaps ${boxes[j].id}`)
  for (const band of layout.bands) for (const [row, id] of band.memberIds.entries()) {
    const point = layout.positions[id]
    assert.ok(point.x >= band.x && point.y >= band.y && point.x + teamNodeSize.width <= band.x + band.width && point.y + teamNodeSize.height <= band.y + band.height)
    if (row) assert.ok(layout.positions[band.memberIds[row - 1]].y < point.y)
  }
  for (const level of layout.levelColumns) {
    const bands = layout.bands.filter(band => band.group.level === level.level)
    for (let i = 1; i < bands.length; i++) assert.ok(bands[i - 1].y + bands[i - 1].height < bands[i].y)
  }
  assert.deepEqual(layout, layoutTeam(structuredClone(state)), 'A status refresh never perturbs geometry')
})

test('direct hierarchy and adjacent peers never take detours, blocked peers use outside curves', () => {
  const state = fixture(), layout = layoutTeam(state)
  for (const edge of state.edges) {
    const route = layoutTeamEdge(layout, edge.source, edge.target)!
    assert.equal(route.kind, 'direct'); assert.equal(route.sourceHandle, 'right'); assert.equal(route.targetHandle, 'left')
    assert.ok(route.points.every((point, i) => i === 0 || point.x >= route.points[i - 1].x), 'Direct hierarchy curves cannot fold back')
    curveAvoidsMembers(layout, edge.source, edge.target)
  }
  const aligned = layoutTeamEdge(layout, 'lead', 'manager')!
  assert.equal(new Set(aligned.points.map(point => point.y)).size, 1, 'An aligned hierarchy edge is completely straight')
  const neighbour = layoutTeamEdge(layout, 'member-1-0', 'member-1-1')!
  assert.equal(neighbour.kind, 'direct'); assert.equal(neighbour.sourceHandle, 'bottom'); assert.equal(neighbour.targetHandle, 'top')
  assert.equal(new Set(neighbour.points.map(point => point.x)).size, 1)
  const distant = layoutTeamEdge(layout, 'member-1-0', 'member-1-8')!
  assert.equal(distant.kind, 'arc'); assert.equal(distant.sourceHandle, distant.targetHandle)
  for (const a of state.members.slice(2)) for (const b of state.members.slice(2)) if (a !== b) curveAvoidsMembers(layout, a.threadId, b.threadId)
})

test('branching subtrees stay in separate intervals and parents align with descendant centres', () => {
  const state = fixture([3, 3]), manager = state.members.find(member => member.threadId === 'manager')!
  state.members.push({ ...manager, threadId: 'manager-b', name: 'manager-b', order: 2 })
  state.groups.find(group => group.id === 'group-1')!.parentId = 'manager-b'
  for (const member of state.members.filter(member => member.groupId === 'group-1')) member.parentId = 'manager-b'
  for (const edge of state.edges.filter(edge => edge.target.startsWith('member-1'))) edge.source = 'manager-b'
  state.edges.push({ id: 'lead-manager-b', source: 'lead', target: 'manager-b', direction: 'both' })
  const worker = state.members.find(member => member.threadId === 'member-0-0')!
  state.groups.push({ id: 'deep', name: '第四层', parentId: worker.threadId, level: 4, order: 0 })
  for (let i = 0; i < 4; i++) {
    state.members.push({ ...worker, threadId: `deep-${i}`, name: `deep-${i}`, level: 4, groupId: 'deep', parentId: worker.threadId, order: i })
    state.edges.push({ id: `deep-${i}`, source: worker.threadId, target: `deep-${i}`, direction: 'both' })
  }
  assert.equal(validateTeamGraph(state.members, state.groups, state.edges, state.levels), null)
  const layout = layoutTeam(state), upper = layout.bands.find(band => band.group.id === 'group-0')!, lower = layout.bands.find(band => band.group.id === 'group-1')!
  assert.ok(upper.y + upper.height < lower.y)
  assert.ok(layout.positions.manager.y < layout.positions['manager-b'].y)
  assert.equal(layout.positions[worker.threadId].y, (layout.positions['deep-0'].y + layout.positions['deep-3'].y) / 2)
  for (const edge of state.edges) curveAvoidsMembers(layout, edge.source, edge.target)
  curveAvoidsMembers(layout, 'manager', 'manager-b')
})

test('80-member layout remains bounded horizontally with disjoint groups and safe arrows', () => {
  const state = fixture([26, 26, 26]), layout = layoutTeam(state)
  assert.equal(Object.keys(layout.positions).length, 80)
  assert.ok(layout.width <= 840)
  for (let i = 0; i < layout.bands.length; i++) for (let j = i + 1; j < layout.bands.length; j++) assert.ok(!intersects(layout.bands[i], layout.bands[j]))
  for (const edge of state.edges) curveAvoidsMembers(layout, edge.source, edge.target)
  curveAvoidsMembers(layout, 'member-0-0', 'member-2-25')
})

test('vertical dragging reorders within the same occupied slots', () => {
  const layout = layoutTeam(fixture()), band = layout.bands.find(band => band.group.id === 'group-1')!
  const slots = band.memberIds.map(id => ({ id, position: layout.positions[id] }))
  const first = slots[0], lower = slots[6]
  assert.equal(first.position.x, lower.position.x)
  const order = reorderTeamSlots(slots, first.id, lower.position)
  assert.equal(order[6], first.id); assert.deepEqual([...order].sort(), band.memberIds.slice().sort())
  assert.deepEqual(reorderTeamSlots(slots, first.id, first.position), band.memberIds)
})
