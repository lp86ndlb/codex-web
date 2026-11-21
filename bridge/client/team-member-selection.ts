import type { TeamSnapshot } from '../shared/team.ts'

type TeamPlacementState = Pick<TeamSnapshot, 'levels' | 'members' | 'groups'>
export interface MemberPlacement { level: number; parentId: string; groupId: string }
export interface MemberSelectionMemory { version: 1; lastLevel: number | null; parents: Record<string, string>; groups: Record<string, string> }
export type MemberSelectionStorage = Pick<Storage, 'getItem' | 'setItem'>
export const memberSelectionKey = (workspaceId: string) => `cweb:team-member-selection:v1:${encodeURIComponent(workspaceId)}`
export const emptyMemberSelection = (): MemberSelectionMemory => ({ version: 1, lastLevel: null, parents: {}, groups: {} })
const groupKey = (level: number, parentId: string) => `${level}:${parentId}`
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const validLevel = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10
const id = (value: unknown): value is string => typeof value === 'string' && value.length <= 200

export function readMemberSelection(storage: MemberSelectionStorage | undefined, workspaceId: string): MemberSelectionMemory {
  try {
    if (!storage || !workspaceId) return emptyMemberSelection()
    const raw = storage.getItem(memberSelectionKey(workspaceId))
    if (!raw || raw.length > 64_000) return emptyMemberSelection()
    const value = record(JSON.parse(raw))
    if (value.version !== 1) return emptyMemberSelection()
    return { version: 1, lastLevel: validLevel(value.lastLevel) ? value.lastLevel : null,
      parents: Object.fromEntries(Object.entries(record(value.parents)).filter(([key, value]) => /^(?:[1-9]|10)$/.test(key) && id(value)).slice(0, 10)) as Record<string, string>,
      groups: Object.fromEntries(Object.entries(record(value.groups)).filter(([key, value]) => /^(?:[1-9]|10):.{1,200}$/.test(key) && id(value)).slice(0, 800)) as Record<string, string> }
  } catch { return emptyMemberSelection() }
}

export function memberPlacementLevels(state: TeamPlacementState) {
  if (!state.members.length) return [1]
  return state.levels.map((_, i) => i + 1).filter(level => level > 1 && state.members.some(member => member.level === level - 1))
}

/** Resolve against the current graph each time; stored IDs never grant membership. */
export function resolveMemberPlacement(state: TeamPlacementState, memory: MemberSelectionMemory, preferred: Partial<MemberPlacement> = {}): MemberPlacement {
  const levels = memberPlacementLevels(state), recent = [...state.members].reverse()
  const level = [preferred.level, memory.lastLevel, recent.find(member => levels.includes(member.level))?.level, levels[0], 1].find(value => value !== undefined && value !== null && levels.includes(value)) || 1
  if (level === 1) return { level, parentId: '', groupId: '' }
  const parents = state.members.filter(member => member.level === level - 1)
  const validParent = (value: string | undefined) => parents.some(parent => parent.threadId === value)
  const previous = recent.find(member => member.level === level && validParent(member.parentId || undefined))
  const parentId = [preferred.parentId, memory.parents[level], previous?.parentId, parents.at(-1)?.threadId].find(value => value && validParent(value)) || ''
  const groups = state.groups.filter(group => group.level === level && group.parentId === parentId)
  const recentGroup = recent.find(member => member.level === level && member.parentId === parentId && groups.some(group => group.id === member.groupId))?.groupId
  const groupId = [preferred.groupId, memory.groups[groupKey(level, parentId)], recentGroup, ''].find(value => value === '' || typeof value === 'string' && groups.some(group => group.id === value)) || ''
  return { level, parentId, groupId }
}

export function initialMemberPlacement(state: TeamPlacementState, memory: MemberSelectionMemory, initialParent?: string) {
  const parent = state.members.find(member => member.threadId === initialParent)
  return resolveMemberPlacement(state, memory, parent && memberPlacementLevels(state).includes(parent.level + 1) ? { level: parent.level + 1, parentId: parent.threadId } : {})
}

export function rememberMemberPlacement(memory: MemberSelectionMemory, placement: MemberPlacement): MemberSelectionMemory {
  return { ...memory, lastLevel: placement.level,
    parents: placement.level > 1 && placement.parentId ? { ...memory.parents, [placement.level]: placement.parentId } : memory.parents,
    groups: placement.level > 1 && placement.parentId ? { ...memory.groups, [groupKey(placement.level, placement.parentId)]: placement.groupId } : memory.groups }
}

export function validMemberPlacement(state: TeamPlacementState, placement: MemberPlacement) {
  return memberPlacementLevels(state).includes(placement.level) && (placement.level === 1
    ? !placement.parentId && !placement.groupId
    : state.members.some(member => member.threadId === placement.parentId && member.level === placement.level - 1)
      && (!placement.groupId || state.groups.some(group => group.id === placement.groupId && group.level === placement.level && group.parentId === placement.parentId)))
}

/** Commit only the successfully submitted placement, never other draft choices. */
export function saveMemberSelection(storage: MemberSelectionStorage | undefined, workspaceId: string, state: TeamPlacementState, placement: MemberPlacement, succeeded: boolean) {
  if (!storage || !workspaceId || !succeeded || !validMemberPlacement(state, placement)) return false
  try { storage.setItem(memberSelectionKey(workspaceId), JSON.stringify(rememberMemberPlacement(readMemberSelection(storage, workspaceId), placement))); return true }
  catch { return false }
}
