import { useCallback, useEffect, useRef, useState } from 'react'
import { api, message } from './api.ts'
import { teamOutstanding, type TeamView, type TeamSnapshot } from '../shared/team.ts'

interface WorkspaceTeamSummary { id: string; enabled: boolean; members: number; pending: number }
export function teamPath(path: string, workspaceId?: string) { return workspaceId ? `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(workspaceId)}` : path }

export function useTeam(enabled: boolean, workspaceId?: string, pilot = false) {
  const scope = enabled ? pilot ? 'pilot' : workspaceId || '' : ''
  const [loaded, setLoaded] = useState<{ scope: string; value: TeamView } | null>(null)
  const [failure, setFailure] = useState({ scope: '', text: '' }), [savingScopes, setSavingScopes] = useState<string[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceTeamSummary[]>([]), [indexError, setIndexError] = useState('')
  const sequence = useRef(0), indexSequence = useRef(0), mounted = useRef(true), locked = useRef(new Set<string>())
  const currentScope = useRef(scope); currentScope.current = scope
  const state = loaded?.scope === scope ? loaded.value : null
  const error = failure.scope === scope ? failure.text : ''
  const setError = useCallback((text: string) => setFailure({ scope, text }), [scope])
  const loadIndex = useCallback(async () => {
    if (!enabled || pilot) return
    const ticket = ++indexSequence.current
    try {
      const result = await api<{ workspaces: WorkspaceTeamSummary[] }>('/teams')
      if (mounted.current && ticket === indexSequence.current) { setWorkspaces(result.workspaces); setIndexError('') }
    } catch (error) { if (mounted.current && ticket === indexSequence.current) setIndexError(message(error)) }
  }, [enabled, pilot])
  const load = useCallback(async () => {
    if (!scope) return
    const ticket = ++sequence.current
    try {
      const result = await api<TeamView>(teamPath('/team', pilot ? undefined : workspaceId))
      if (mounted.current && currentScope.current === scope && ticket === sequence.current) setLoaded({ scope, value: result })
    } catch (error) { if (mounted.current && currentScope.current === scope && ticket === sequence.current) setFailure({ scope, text: message(error) }) }
  }, [scope, pilot, workspaceId])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; indexSequence.current++ } }, [])
  useEffect(() => { if (enabled) void loadIndex(); else { setWorkspaces([]); setIndexError('') }; return () => { indexSequence.current++ } }, [enabled, loadIndex])
  useEffect(() => {
    setLoaded(null); setFailure({ scope, text: '' })
    if (!enabled) return
    void load()
    let timer: ReturnType<typeof setTimeout> | undefined, refreshCurrent = false
    const refresh = (event: Event) => {
      const changed = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId
      refreshCurrent ||= pilot || !changed || changed === workspaceId
      if (timer) return
      timer = setTimeout(() => { timer = undefined; void loadIndex(); if (refreshCurrent) void load(); refreshCurrent = false }, 80)
    }
    window.addEventListener('cweb:team-changed', refresh)
    return () => { sequence.current++; clearTimeout(timer); window.removeEventListener('cweb:team-changed', refresh) }
  }, [enabled, scope, load, loadIndex, pilot, workspaceId])
  useEffect(() => {
    if (!scope || !state?.running.length) return
    const timer = setTimeout(() => { void load() }, 2000); return () => clearTimeout(timer)
  }, [scope, state, load])
  const act = useCallback(async (path: string, value: object, targetWorkspace = workspaceId) => {
    const target = enabled ? pilot ? 'pilot' : targetWorkspace || '' : ''
    if (!target || locked.current.has(target)) return false
    locked.current.add(target); setSavingScopes([...locked.current]); setFailure({ scope: target, text: '' })
    try {
      await api(teamPath(path, pilot ? undefined : targetWorkspace), value)
      if (currentScope.current === scope && target === scope) await load()
      await loadIndex(); return true
    } catch (error) {
      if (mounted.current) setFailure({ scope: target, text: message(error) })
      await loadIndex(); return false
    } finally { locked.current.delete(target); if (mounted.current) setSavingScopes([...locked.current]) }
  }, [enabled, pilot, workspaceId, scope, load, loadIndex])
  const topology = useCallback(async (next: TeamSnapshot) => act('/team/topology', { graphVersion: next.graphVersion, members: next.members, groups: next.groups, edges: next.edges, levels: next.levels }), [act])
  const outstanding = (state?.messages.filter(row => teamOutstanding.has(row.state)).length || 0) + (state?.memberRequests.filter(row => ['pending', 'creating', 'uncertain'].includes(row.state)).length || 0)
  return { state, error, setError, saving: savingScopes.includes(scope), savingScopes, load, act, topology, outstanding, workspaces, indexError, loadIndex, pilot, workspaceId, scope }
}
export type TeamController = ReturnType<typeof useTeam>
