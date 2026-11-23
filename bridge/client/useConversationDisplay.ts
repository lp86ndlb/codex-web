import { useEffect, useMemo, useState } from 'react'
import type { Item, ThreadView } from '../shared/types.ts'
import type { TeamMessage } from '../shared/team.ts'
import { classifyConversation, projectConversation, readTeamDisplay, teamReceiptIndex, type TeamDisplay } from './team-transcript.ts'

const emptyItems: Item[] = []
const emptyMessages: TeamMessage[] = []
export function useConversationDisplay(thread: ThreadView | undefined, workspace: string, messages?: TeamMessage[]) {
  const [preference, setPreference] = useState(() => ({ workspace, value: readTeamDisplay(workspace) }))
  if (workspace !== preference.workspace) setPreference({ workspace, value: readTeamDisplay(workspace) })
  const setDisplay = (value: TeamDisplay) => {
    try { localStorage.setItem('cweb:team-display:' + workspace, value) } catch { /* Keep current tab usable. */ }
    setPreference({ workspace, value })
  }
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === null || e.key === 'cweb:team-display:' + workspace) setPreference({ workspace, value: readTeamDisplay(workspace) })
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [workspace])
  const index = useMemo(() => teamReceiptIndex(messages || emptyMessages, thread?.id || ''), [messages, thread?.id])
  const raw = thread?.items || emptyItems
  const sources = useMemo(() => classifyConversation(raw, index), [raw, index])
  const hasDeliveries = index.deliveries.size > 0
  const display = preference.value
  const items = useMemo(() => projectConversation(raw, sources, display), [raw, sources, display])
  const view = useMemo(() => thread && items !== raw ? { ...thread, items } : thread, [thread, items, raw])
  return { view, items, sources, display, setDisplay, hasDeliveries }
}
