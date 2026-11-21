import { teamOutstanding, type TeamMessage, type TeamSnapshot } from './team.ts'
import { teamRoute, validateTeamGraph } from './team-topology.ts'

type Graph = Pick<TeamSnapshot, 'members' | 'groups' | 'edges' | 'levels'>

export function memberRemovalOptions(state: Graph, threadId: string) {
  const member = state.members.find(row => row.threadId === threadId)
  const children = state.members.filter(row => row.parentId === threadId)
  const replacements = state.members.filter(row => row.threadId !== threadId && row.level === member?.level)
  const reason = !member ? '该会话已不在团队中。' : !children.length ? '' : member.level === 1
    ? '最高负责人仍有下级，请先移出下级，再移出负责人。'
    : !replacements.length ? '请先加入一位同层级上级，或调整直属下级的归属，再移出该会话。' : ''
  return { member, children, replacements, reason }
}

/** Remove one membership, preserving other sessions and hierarchy levels.
 * A user's explicit replacement inherits only the removed parent's existing
 * child links, including their original allowed direction. */
export function graphWithoutMember(state: Graph, threadId: string, reassignTo?: string): { graph: Graph; error?: never } | { error: string; graph?: never } {
  const { member, children, replacements, reason } = memberRemovalOptions(state, threadId)
  if (reason || !member) return { error: reason }
  if (children.length && !replacements.some(row => row.threadId === reassignTo)) return { error: '请选择同层级的接替上级。' }
  if (!children.length && reassignTo) return { error: '该会话没有直属下级，无需设置接替上级。' }
  const graph: Graph = structuredClone({ members: state.members, groups: state.groups, edges: state.edges, levels: state.levels })
  graph.members = graph.members.filter(row => row.threadId !== threadId)
  for (const row of graph.members) if (row.parentId === threadId) row.parentId = reassignTo!
  graph.groups = graph.groups.filter(group => {
    if (group.parentId === threadId) {
      if (!children.length) return false
      group.parentId = reassignTo!
    }
    return group.id !== member.groupId || graph.members.some(row => row.groupId === group.id)
  })
  const childIds = new Set(children.map(row => row.threadId))
  graph.edges = graph.edges.filter(edge => {
    if (edge.source !== threadId && edge.target !== threadId) return true
    const childId = edge.source === threadId ? edge.target : edge.source
    if (!reassignTo || !childIds.has(childId)) return false
    if (edge.source === threadId) edge.source = reassignTo
    else edge.target = reassignTo
    return true
  })
  const error = validateTeamGraph(graph.members, graph.groups, graph.edges, graph.levels)
  return error ? { error } : { graph }
}

export function removalChangesRequest(before: Graph, after: Graph, message: TeamMessage, threadId: string) {
  if (!teamOutstanding.has(message.state)) return false
  return message.from === threadId || message.to === threadId || message.reviews.some(review => review.reviewerId === threadId)
    || before.members.find(row => row.threadId === message.from)?.parentId !== after.members.find(row => row.threadId === message.from)?.parentId
    || JSON.stringify(teamRoute(before, message.from, message.to)) !== JSON.stringify(teamRoute(after, message.from, message.to))
}
