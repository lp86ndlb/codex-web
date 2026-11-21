import { useEffect, useRef, useState } from 'react'
import type { TeamView } from '../shared/team.ts'
import { initialMemberPlacement, readMemberSelection, rememberMemberPlacement, resolveMemberPlacement, saveMemberSelection, type MemberPlacement } from './team-member-selection.ts'

function storage() { try { return localStorage } catch { return undefined } }

/** Import and new-member forms share successful defaults, but keep edits local. */
export function useTeamMemberSelection(state: TeamView, workspaceId?: string, initialParent?: string) {
  const scope = workspaceId || state.workspaceId || (state.workspace ? `path:${state.workspace}` : '')
  const initial = () => {
    const memory = readMemberSelection(storage(), scope)
    return { scope, initialParent, memory, selection: initialMemberPlacement(state, memory, initialParent) }
  }
  const [draft, setDraft] = useState(initial)
  const lifetime = useRef({ active: true })
  useEffect(() => { lifetime.current.active = true; return () => { lifetime.current.active = false } }, [])
  // A context change must not briefly reuse the previous workspace's IDs.
  if (draft.scope !== scope || draft.initialParent !== initialParent) {
    lifetime.current.active = false; lifetime.current = { active: true }
    const next = initial(); setDraft(next); return current(next)
  }
  return current(draft)

  function current(value: ReturnType<typeof initial>) {
    const alive = lifetime.current
    const resolved = resolveMemberPlacement(state, value.memory, value.selection)
    const selection = value.selection.level === resolved.level && value.selection.level > 1 && value.selection.parentId === ''
      ? { ...resolved, parentId: '', groupId: '' } : resolved
    const update = (next: MemberPlacement) => setDraft({ ...value, selection: next, memory: rememberMemberPlacement(rememberMemberPlacement(value.memory, selection), next) })
    return {
      ...selection,
      setLevel: (level: number) => update(resolveMemberPlacement(state, rememberMemberPlacement(value.memory, selection), { level })),
      setParent: (parentId: string) => update(parentId ? resolveMemberPlacement(state, rememberMemberPlacement(value.memory, selection), { level: selection.level, parentId }) : { ...selection, parentId: '', groupId: '' }),
      setGroup: (groupId: string) => update({ ...selection, groupId }),
      rememberSuccess: () => alive.active && saveMemberSelection(storage(), scope, state, selection, true),
      discard: () => { alive.active = false },
    }
  }
}
