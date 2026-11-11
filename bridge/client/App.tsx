import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Archive, ArrowDown, ArrowRight, ArrowUp, Check, ChevronDown, Code2, Command, FileSearch, Folder, GitBranch, Upload, RefreshCw, Braces, SquareTerminal, LoaderCircle, Menu, MessageSquare, Moon, PanelLeftClose, PanelLeftOpen, PanelRight, Pencil, Plus, Search, Settings, Settings2, ShieldCheck, Sparkles, Square, Sun, X } from 'lucide-react'
import { defaultPreferences, type Approval, type Bootstrap, type WorkspaceInfo, type RuntimeStatus, type StreamEvent, type ThreadSummary, type ThreadView, type Preferences, type SessionOptions, type AttachmentInfo, type SkillInfo, type QueuedMessage, type GenuiPanelInfo, type ThreadGoal, type Item } from '../shared/types.ts'
import { api, message, setToken, upload, ApiError } from './api.ts'
import { ApprovalStack, IconButton, Notice, TranscriptItem } from './components.tsx'
import { TodoNote } from './TodoNote.tsx'

import { WorkspaceGroups, WorkspaceHome, workspaceFor } from './Workspaces.tsx'
import { Inspector } from './Inspector.tsx'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import { BrandMark } from './BrandMark.tsx'
import { Composer } from './Composer.tsx'
import { SettingsPanel, type SettingsTab } from './SettingsPanel.tsx'
import { CommandPalette } from './CommandPalette.tsx'
import { commands } from './commands.ts'
import { GenuiProvider, GenuiPanel } from './GenuiHost.tsx'
import { Transcript, type MessageJump } from './Transcript.tsx'
import { mergeView, applyThreadPatch } from './thread-state.ts'
import { ChoiceDock, ChoiceProvider, type ChoiceAnswer } from './ChoiceHost.tsx'
import { FilePreviewProvider } from './FilePreview.tsx'
import { pendingChoiceMessage } from '../shared/choices.ts'
import { useConversationScroll } from './useConversationScroll.ts'
import { UsagePopover } from './UsagePopover.tsx'
import { TurnNavigator } from './TurnNavigator.tsx'
import { GoalPanel, type GoalPanelHandle } from './GoalPanel.tsx'
import { ThreadNotices, useThreadNotices } from './ThreadNotices.tsx'
import { Presence, useExitAction } from './Motion.tsx'
import { threadReadEvent } from '../shared/navigation-order.ts'
import { RunStatus } from './RunTimer.tsx'
import { defaultRunningStyle, isRunningStyle, type RunningStyle } from './RunningBorder.tsx'
import { echoedMessage, withPendingMessage, type DraftContents, type PendingMessage } from './pending-message.ts'

interface EditingMessage { itemId: string; turnId: string; saved: DraftContents; merged: boolean }

const starters = [
  { icon: <FileSearch size={19} />, title: '读懂这个项目', detail: '梳理结构，找到关键入口', prompt: '请先只读检查这个项目，介绍目录结构、主要技术和运行方式。' },
  { icon: <GitBranch size={19} />, title: '检查代码改动', detail: '发现问题，给出修改建议', prompt: '请审查当前工作区的未提交改动，优先找出真实的 bug 和风险，先不要修改文件。' },
  { icon: <Code2 size={19} />, title: '一起实现功能', detail: '从想法到可以运行的代码', prompt: '我想在这个项目中实现一个功能：' },
]

function baseName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) || '工作区' }
function localValue(key: string, fallback: string) { try { return localStorage.getItem(key) || fallback } catch { return fallback } }
function loadingPreviewEntry() { return new URLSearchParams(window.location.search).get('loading-effects') === '1' }

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: 'starting', error: null })
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [views, setViews] = useState<Record<string, ThreadView>>({})
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([])
  const [editingMessages, setEditingMessages] = useState<Record<string, EditingMessage>>({})
  const sending = useRef(false)
  const viewsRef = useRef<Record<string, ThreadView>>({})
  const resyncing = useRef(new Set<string>())
  const updateViews = useCallback((update: (previous: Record<string, ThreadView>) => Record<string, ThreadView>) => {
    const value = update(viewsRef.current)
    if (value !== viewsRef.current) { viewsRef.current = value; setViews(value) }
  }, [])
  const [selected, setSelected] = useState<string | null>(null)
  const [jumpTarget, setJumpTarget] = useState<MessageJump | null>(null)
  const [historyNavigation, setHistoryNavigation] = useState(false); const jumpSequence = useRef(0)
  const goalPanel = useRef<GoalPanelHandle>(null); const [goalUpdate, setGoalUpdate] = useState<{ threadId: string; goal: ThreadGoal | null }>()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingThread, setLoadingThread] = useState(false)
  const [streamConnected, setStreamConnected] = useState(false)
  const [sidebar, setSidebar] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localValue('cweb:sidebar-collapsed', 'false') === 'true')
  const [loadingStyle, setLoadingStyle] = useState<RunningStyle>(() => { const value = localValue('cweb:loading-style', defaultRunningStyle); return isRunningStyle(value) ? value : defaultRunningStyle })
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === 'cweb:loading-style') setLoadingStyle(isRunningStyle(event.newValue) ? event.newValue : defaultRunningStyle) }
    addEventListener('storage', sync); return () => removeEventListener('storage', sync)
  }, [])
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [revealThread, setRevealThread] = useState<{ id: string; seq: number }>(); const revealSequence = useRef(0)
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 760px)').matches)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(210, Math.min(420, Number(localValue('cweb:sidebar-width', '276')) || 276)))
  const sidebarDrag = useRef(false)
  useEffect(() => { const query = matchMedia('(max-width: 760px)'); const update = () => { setMobile(query.matches); setSidebar(false) }; query.addEventListener('change', update); return () => query.removeEventListener('change', update) }, [])
  const [inspector, setInspector] = useState(false)
  const [settings, setSettings] = useState(loadingPreviewEntry)
  const [workspaceDialog, setWorkspaceDialog] = useState(false)
  const [renameDialog, setRenameDialog] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [workspaceEditing, setWorkspaceEditing] = useState<string | null>(null)
  const [pluginEnabled, setPluginEnabled] = useState(true)
  const [pluginSaving, setPluginSaving] = useState(false)
  const [prefs, setPrefs] = useState<Preferences>(defaultPreferences)
  const [sessionOptions, setSessionOptions] = useState<Record<string, SessionOptions>>({})
  const [optionDrafts, setOptionDrafts] = useState<Record<string, SessionOptions>>({})
  const [fileDrafts, setFileDrafts] = useState<Record<string, AttachmentInfo[]>>({})
  const [skillDrafts, setSkillDrafts] = useState<Record<string, SkillInfo[]>>({})
  const [referenceDrafts, setReferenceDrafts] = useState<Record<string, string[]>>({})
  const [uploads, setUploads] = useState<Record<string, number>>({})
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => loadingPreviewEntry() ? 'appearance' : 'general')
  const [loadingFocus, setLoadingFocus] = useState(loadingPreviewEntry)
  useEffect(() => {
    if (!loadingPreviewEntry()) return
    const url = new URL(window.location.href); url.searchParams.delete('loading-effects')
    // This is a one-time entry: reloading after closing settings returns to chat.
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  }, [])
  const [palette, setPalette] = useState<'commands' | 'skills' | 'history' | null>(null)
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsRevision, setSkillsRevision] = useState(0)
  const [dropping, setDropping] = useState(false)
  const [toast, setToast] = useState('')
  const [genuiOpen, setGenuiOpen] = useState(false)
  const [genuiPanels, setGenuiPanels] = useState<GenuiPanelInfo[]>([])
  const inspectorExit = useExitAction(() => setInspector(false))
  const genuiExit = useExitAction(() => setGenuiOpen(false))
  const selectedRef = useRef<string | null>(null); selectedRef.current = selected
  const [handoffBusy, setHandoffBusy] = useState(false)
  const prefWrites = useRef(Promise.resolve()); const pendingPrefs = useRef(0)
  const optionWrites = useRef(Promise.resolve())
  const uploadPending = useRef(new Set<string>())
  const dragDepth = useRef(0)
  const [directoryDraft, setDirectoryDraft] = useState('')
  const [workspaceSaving, setWorkspaceSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const main = useRef<HTMLElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const restoreComposerFocus = useRef<{ key: string; start: number; end: number } | null>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const transcriptContent = useRef<HTMLDivElement>(null)
  const composerDock = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const { away: awayFromBottom, jump: jumpToBottom, pause: pauseFollowing } = useConversationScroll(transcript, transcriptContent, follow, selected || `new:${workspaceId || ''}`, composerDock)
  const showLatest = useCallback(() => { setHistoryNavigation(false); setJumpTarget({ id: '', seq: ++jumpSequence.current }); jumpToBottom() }, [jumpToBottom])
  const navigateMessage = useCallback((id: string) => { pauseFollowing(); setHistoryNavigation(true); setJumpTarget({ id, seq: ++jumpSequence.current }) }, [pauseFollowing])
  useEffect(() => { setHistoryNavigation(false); setJumpTarget(null) }, [selected])
  const dialog = useRef<HTMLDialogElement>(null)
  const dialogExit = useExitAction(() => { setSettings(false); setWorkspaceDialog(false); setRenameDialog(false); setWorkspaceEditing(null); requestAnimationFrame(() => composer.current?.focus()) }, dialog)
  const source = useRef<EventSource | null>(null)
  const thread = selected ? views[selected] : undefined
  const activeWorkspace = (thread ? workspaceFor(workspaces, thread.cwd) : undefined) || workspaces.find(row => row.id === workspaceId)
  const activeCwd = thread?.cwd || activeWorkspace?.path || ''
  const home = !selected && !activeWorkspace
  const draftKey = selected || `new:${workspaceId || ''}`
  const draft = drafts[draftKey] || ''
  const currentDraftKey = useRef(draftKey); currentDraftKey.current = draftKey
  useLayoutEffect(() => {
    const restore = restoreComposerFocus.current
    if (!restore || restore.key !== draftKey) return
    restoreComposerFocus.current = null
    if (!document.activeElement || document.activeElement === document.body) { composer.current?.focus(); composer.current?.setSelectionRange(restore.start, restore.end) }
  }, [draftKey])
  const editing = editingMessages[draftKey]
  const pendingMessage = useMemo(() => pendingMessages.find(row => row.key === draftKey && !echoedMessage(row, thread)), [pendingMessages, draftKey, thread])
  const displayedThread = useMemo(() => withPendingMessage(thread, pendingMessage), [thread, pendingMessage])
  useEffect(() => { setPendingMessages(previous => previous.some(row => echoedMessage(row, views[row.key])) ? previous.filter(row => !echoedMessage(row, views[row.key])) : previous) }, [views])
  const running = Boolean(thread?.turnId)
  const todoLinkPending = queue.some(row => row.threadId === selected && row.kind === 'todo-link' && !row.error) || Boolean(running && thread?.items.findLast(item => item.type === 'userMessage')?.text.startsWith('请关联本会话的待办便签：'))
  const currentApprovals = useMemo(() => approvals.filter(approval => approval.threadId === selected), [approvals, selected])
  const connected = runtime.state === 'ready' && streamConnected
  const { notices, dismiss: dismissNotice } = useThreadNotices(threads, views, approvals, connected, selected)
  useEffect(() => { setAvailableSkills([]) }, [activeWorkspace?.id])
  useEffect(() => {
    if (!boot || !activeWorkspace) return
    let cancelled = false; setSkillsLoading(true)
    void api<{ skills: SkillInfo[] }>(`/skills?workspace=${encodeURIComponent(activeWorkspace.id)}`).then(value => { if (!cancelled) setAvailableSkills(value.skills.filter(skill => skill.enabled)) }).catch(() => {}).finally(() => { if (!cancelled) setSkillsLoading(false) })
    return () => { cancelled = true }
  }, [boot, activeWorkspace?.id, skillsRevision, settings, draft.startsWith('/')])

  const currentOptions = optionDrafts[draftKey] || (selected ? sessionOptions[selected] : undefined) || { model: prefs.model, effort: prefs.effort, mode: prefs.mode, approvalPolicy: prefs.approvalPolicy }
  const files = fileDrafts[draftKey] || []; const skills = skillDrafts[draftKey] || []
  const references = referenceDrafts[draftKey] || []
  const editorContext = useRef({ draftKey, draft, files, skills, references, availableSkills, canEdit: false, externalOwner: false })
  editorContext.current = { draftKey, draft, files, skills, references, availableSkills, canEdit: Boolean(boot?.capabilities?.messageEditing), externalOwner: Boolean(thread?.externalOwner) }
  const editMessage = useCallback((item: Item) => {
    const context = editorContext.current; const current = viewsRef.current[context.draftKey]
    if (sending.current || !current || context.externalOwner) return
    if (!context.canEdit) { setError('会话编辑将在服务空闲更新后可用。'); return }
    if (current.historyMode === 'legacy') { setError('这个会话使用旧版 CLI 记录格式，当前 CLI 不支持原地回退。消息仍可复制；新格式会话可直接编辑。'); return }
    const index = current.items.findIndex(row => row.id === item.id)
    const prompts = current.items.slice(0, index + 1).filter(row => row.type === 'userMessage' && row.turnId === item.turnId)
    if (!item.turnId || !prompts.length) return
    // A CLI steer belongs to its original turn. Make the merged replacement
    // explicit in the editor, so earlier instructions cannot disappear silently.
    setEditingMessages(previous => ({ ...previous, [context.draftKey]: { itemId: prompts[0].id, turnId: item.turnId!, merged: prompts.length > 1, saved: previous[context.draftKey]?.saved || { text: context.draft, files: context.files, skills: context.skills, references: context.references } } }))
    setDrafts(previous => ({ ...previous, [context.draftKey]: prompts.map(row => row.text).join('\n\n') }))
    setFileDrafts(previous => ({ ...previous, [context.draftKey]: [...new Map(prompts.flatMap(row => row.attachments || []).map(file => [file.id, file])).values()] }))
    setSkillDrafts(previous => ({ ...previous, [context.draftKey]: [...new Map(prompts.flatMap(row => row.skills || []).map(skill => [skill.path, context.availableSkills.find(available => available.path === skill.path) || { ...skill, description: '', scope: '', enabled: true, uses: 0, lastUsed: 0 }])).values()] }))
    setReferenceDrafts(previous => ({ ...previous, [context.draftKey]: [] })); setError('')
    requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(0, composer.current.value.length) })
  }, [])
  const history = useMemo(() => [...new Set((thread?.items || []).filter(item => item.type === 'userMessage' && item.text).map(item => item.text).reverse())], [thread?.items])
  const activeChoiceMessage = useMemo(() => pendingChoiceMessage(thread?.items || [])?.id || '', [thread?.items])
  const theme = prefs.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : prefs.theme
  useEffect(() => {
    const root = document.documentElement; const media = matchMedia('(prefers-color-scheme: dark)')
    const update = () => { root.dataset.theme = prefs.theme === 'system' ? media.matches ? 'dark' : 'light' : prefs.theme }
    update(); media.addEventListener('change', update)
    root.style.setProperty('--chat-font-size', `${prefs.fontSize}px`); root.style.setProperty('--ui-font-size', `${prefs.uiFontSize}px`)
    root.dataset.animations = String(prefs.animations); root.dataset.codeWrap = String(prefs.codeWrap)
    const syncPluginTheme = () => { document.body.toggleAttribute('data-ds-dark-theme', root.dataset.theme === 'dark') }
    syncPluginTheme(); media.addEventListener('change', syncPluginTheme)
    return () => { media.removeEventListener('change', update); media.removeEventListener('change', syncPluginTheme) }
  }, [prefs])
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer) } }, [toast])

  useEffect(() => {
    let cancelled = false
    let recovery: ReturnType<typeof setTimeout> | undefined
    setRuntime({ state: 'starting', error: null })
    api<Bootstrap>('/bootstrap').then(value => {
      if (cancelled) return
      setToken(value.token); setError(''); setBoot(value); setRuntime(value.runtime); setThreads(value.threads)
      viewsRef.current = {}; setViews(viewsRef.current); setPrefs(value.preferences || defaultPreferences); setSessionOptions(value.sessionOptions || {}); setQueue(value.queue || []); setInspector(value.preferences?.showInspector ?? false)
      setWorkspaces(value.workspaces || []); setPluginEnabled(value.plugins?.todoNote ?? true)
      const previous = localValue('cweb:thread', localValue('dsh-local-thread', ''))
      if (previous && value.threads.some(thread => thread.id === previous)) setSelected(previous)
      const events = new EventSource('/api/events')
      source.current = events
      events.onopen = () => {
        if (cancelled) return
        clearTimeout(recovery); recovery = undefined; setStreamConnected(true)
        const id = selectedRef.current
        if (id) void api<ThreadView>(`/threads/${encodeURIComponent(id)}`).then(value => { if (!cancelled) updateViews(previous => mergeView(previous, value)) }).catch(() => {})
      }
      events.onerror = () => {
        if (cancelled || recovery) return
        setStreamConnected(false)
        recovery = setTimeout(() => { if (!cancelled) { events.close(); setReload(value => value + 1) } }, 5000)
      }
      events.onmessage = event => {
        if (cancelled) return
        const value = JSON.parse(event.data) as StreamEvent
        if (value.type === 'thread') updateViews(previous => mergeView(previous, value.thread))
        else if (value.type === 'threadPatch') {
          const current = viewsRef.current[value.id]
          if (!current || (current.revision < value.revision && current.revision !== value.baseRevision)) {
            if (!resyncing.current.has(value.id)) {
              resyncing.current.add(value.id)
              void api<ThreadView>(`/threads/${encodeURIComponent(value.id)}/snapshot`).then(snapshot => { if (!cancelled) updateViews(previous => mergeView(previous, snapshot)) }).catch(() => {}).finally(() => resyncing.current.delete(value.id))
            }
          } else updateViews(previous => applyThreadPatch(previous, value))
        }
        else if (value.type === 'threads') setThreads(value.threads)
        else if (value.type === 'approvals') setApprovals(value.approvals)
        else if (value.type === 'runtime') setRuntime(value.runtime)
        else if (value.type === 'workspaces') setWorkspaces(value.workspaces)
        else if (value.type === 'plugins') setPluginEnabled(value.plugins.todoNote)
        else if (value.type === 'preferences') { if (!pendingPrefs.current) setPrefs(value.preferences); setSessionOptions(value.sessionOptions) }
        else if (value.type === 'queue') setQueue(value.queue)
        else if (value.type === 'goal' && value.threadId === selectedRef.current) setGoalUpdate(value)
        else if (value.type === 'genui' && value.threadId === selectedRef.current) { setGenuiPanels(value.panels); if ((value.panels.at(-1)?.spec as { panel?: boolean } | undefined)?.panel) { setGenuiOpen(true); setInspector(false) } }
      }
    }).catch(error => { if (!cancelled) setRuntime({ state: 'failed', error: message(error) }) })
    return () => { cancelled = true; clearTimeout(recovery); source.current?.close(); source.current = null; setStreamConnected(false) }
  }, [reload])

  useEffect(() => {
    if (!selected || !boot) return
    let cancelled = false
    setLoadingThread(true); follow.current = true
    api<ThreadView>(`/threads/${encodeURIComponent(selected)}`).then(value => {
      if (!cancelled) updateViews(previous => mergeView(previous, value))
    }).catch(error => { if (!cancelled) setError(message(error)) }).finally(() => { if (!cancelled) setLoadingThread(false) })
    try { localStorage.setItem('cweb:thread', selected); localStorage.removeItem('dsh-local-thread') } catch { /* Resume selection is optional. */ }
    return () => { cancelled = true }
  }, [selected, boot])

  useEffect(() => {
    if (settings || workspaceDialog || renameDialog) dialog.current?.showModal()
    else dialog.current?.close()
  }, [settings, workspaceDialog, renameDialog])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const mod = event.ctrlKey || event.metaKey; const key = event.key.toLowerCase()
      const inComposer = document.activeElement === composer.current
      if (palette || settings || workspaceDialog || renameDialog) return
      if (event.shiftKey && !mod && !event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) && thread && (inComposer && !draft || document.activeElement === document.body || document.activeElement === transcript.current) && !window.getSelection()?.toString()) {
        const prompts = thread.items.filter(item => item.type === 'userMessage')
        if (!prompts.length) return
        const current = jumpTarget?.id ? prompts.findIndex(item => item.id === jumpTarget.id) : prompts.length
        if (event.key === 'ArrowLeft') { event.preventDefault(); navigateMessage(prompts[Math.max(0, current - 1)]?.id || prompts.at(-1)!.id) }
        else if (historyNavigation) { event.preventDefault(); if (current >= prompts.length - 1) showLatest(); else navigateMessage(prompts[current + 1].id) }
        return
      }
      if (mod && key === 'k') { event.preventDefault(); requestAnimationFrame(() => composer.current?.focus()) }
      else if (mod && event.shiftKey && key === 'p') { event.preventDefault(); setPalette('commands') }
      else if (mod && key === ',') { event.preventDefault(); openSettings('general') }
      else if (mod && event.altKey && key === 'n') { event.preventDefault(); if (!busy) newThread() }
      else if (mod && key === '/') { event.preventDefault(); openSettings('shortcuts') }
      else if (mod && key === 'o') { event.preventDefault(); if (inComposer) void copyReply(); else addWorkspaceDialog() }
      else if (mod && key === 'r' && inComposer) { event.preventDefault(); setPalette('history') }
      else if (event.ctrlKey && key === 'c' && (inComposer || document.activeElement === document.body) && running && !window.getSelection()?.toString() && (!inComposer || composer.current?.selectionStart === composer.current?.selectionEnd)) { event.preventDefault(); void interrupt() }
      else if (event.key === 'Escape') { setSidebar(false); if (inComposer && running && !draft) { event.preventDefault(); void interrupt() } }
    }
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener)
  })

  useEffect(() => {
    if (!boot) return
    let cancelled = false; let refreshing = false
    const refresh = async () => {
      if (document.hidden || refreshing) return
      refreshing = true
      try {
        const list = await api<ThreadSummary[]>('/threads')
        if (!cancelled) setThreads(list)
        if (selected && !running && (thread?.externalOwner || list.some(row => row.id === selected && row.updatedAt !== thread?.updatedAt))) {
          const value = await api<ThreadView>(`/threads/${encodeURIComponent(selected)}`)
          if (!cancelled) updateViews(previous => mergeView(previous, value))
        }
      } catch { /* The connection banner handles connectivity; retry on next focus. */ }
      finally { refreshing = false }
    }
    const listener = () => { void refresh() }; const timer = setInterval(listener, 15000)
    window.addEventListener('focus', listener); document.addEventListener('visibilitychange', listener)
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', listener); document.removeEventListener('visibilitychange', listener) }
  }, [boot, selected, running, thread?.updatedAt, thread?.externalOwner])

  const genuiCurrent = useRef({ selected, currentOptions, busy, connected, running })
  genuiCurrent.current = { selected, currentOptions, busy, connected, running }
  const genuiAction = useCallback(async (action: string, payload: Record<string, unknown>) => {
    if (action === 'cweb:loading-style-picker') { openSettings('appearance', true); return }
    const current = genuiCurrent.current
    if (!current.selected || !current.connected || current.busy) throw new Error('请等待连接就绪后再发送交互')
    const text = `[genui-action] ${action}\n${JSON.stringify(payload)}\n这是用户对现有界面的操作，请按需要响应并更新界面。`
    await api(`/threads/${encodeURIComponent(current.selected)}/queue`, { text, ...current.currentOptions })
    follow.current = true
    setToast('交互已发送，Codex 将继续处理')
    if (genuiCurrent.current.selected === current.selected && follow.current) showLatest()
  }, [])
  const openGenui = useCallback(() => { const show = () => { setGenuiOpen(true); setInspector(false) }; if (inspector) inspectorExit.exit(show); else show() }, [inspector, inspectorExit.exit])
  const choiceAnswer = useCallback(async (answers: ChoiceAnswer[]) => {
    const current = genuiCurrent.current
    if (!current.selected || !current.connected || current.busy) throw new Error('请等待连接就绪后再选择')
    const payload = { text: `[选择回答]\n${answers.map(answer => `${answer.question}\n我的选择：${answer.answers.join('、')}`).join('\n\n')}`, ...current.currentOptions, steer: current.running }
    try { await api(`/threads/${encodeURIComponent(current.selected)}/message`, payload) }
    catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_RUNNING') await api(`/threads/${encodeURIComponent(current.selected)}/message`, { ...payload, steer: false })
      else if (error instanceof ApiError && error.code === 'BUSY' && !payload.steer) await api(`/threads/${encodeURIComponent(current.selected)}/message`, { ...payload, steer: true })
      else throw error
    }
    if (genuiCurrent.current.selected === current.selected && follow.current) showLatest()
  }, [])
  useEffect(() => {
    setGenuiPanels([])
    if (!selected || !prefs.genui || !boot) return
    let cancelled = false
    void api<{ panels: GenuiPanelInfo[] }>(`/plugins/genui/${encodeURIComponent(selected)}`).then(value => { if (!cancelled) setGenuiPanels(value.panels) }).catch(() => {})
    return () => { cancelled = true }
  }, [selected, prefs.genui, boot])
  async function handoff() {
    if (!selected || handoffBusy) return
    setHandoffBusy(true); setError('')
    try { const value = await api<ThreadView>(`/threads/${encodeURIComponent(selected)}/handoff`, {}); updateViews(previous => mergeView(previous, value)); setToast('已连接，可以在网页继续'); requestAnimationFrame(() => composer.current?.focus()) }
    catch (error) { setToast(message(error)); if (selected) void api<ThreadView>(`/threads/${encodeURIComponent(selected)}`).then(value => updateViews(previous => mergeView(previous, value))).catch(() => {}) }
    finally { setHandoffBusy(false) }
  }
  async function connectTodo() {
    if (!selected || handoffBusy) return
    setHandoffBusy(true)
    try {
      const value = await api<ThreadView>(`/threads/${encodeURIComponent(selected)}/todo-connect`, {})
      updateViews(previous => mergeView(previous, value))
      setToast(value.todoTools === 'waiting' ? '仍在等待会话释放，稍后会自动检查' : '待办工具已连接')
    } catch (error) { setToast(message(error)) }
    finally { setHandoffBusy(false) }
  }
  useEffect(() => {
    if (!selected || thread?.todoTools !== 'waiting' || running || !connected || !pluginEnabled) return
    const id = selected; let cancelled = false; let checking = false
    const timer = setInterval(() => {
      if (document.hidden || checking) return
      checking = true
      void api<ThreadView>(`/threads/${encodeURIComponent(id)}/todo-connect`, {}).then(value => {
        if (!cancelled) updateViews(previous => mergeView(previous, value))
      }).catch(() => {}).finally(() => { checking = false })
    }, 10000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [selected, thread?.todoTools, running, connected, pluginEnabled])

  async function updatePreferences(patch: Partial<Preferences>) {
    setPrefs(value => ({ ...value, ...patch })); pendingPrefs.current++
    const work = prefWrites.current.catch(() => {}).then(async () => {
      try {
        const value = await api<{ preferences: Preferences; sessionOptions: Record<string, SessionOptions> }>('/preferences', patch)
        if (pendingPrefs.current === 1) setPrefs(value.preferences)
        setSessionOptions(value.sessionOptions)
      } catch (error) {
        if (pendingPrefs.current === 1) { const snapshot = await api<{ preferences: Preferences }>('/preferences').catch(() => null); if (snapshot) setPrefs(snapshot.preferences) }
        throw error
      } finally { pendingPrefs.current-- }
    })
    prefWrites.current = work; await work
  }
  function changeOptions(patch: Partial<SessionOptions>) {
    setOptionDrafts(previous => ({ ...previous, [draftKey]: { ...(previous[draftKey] || currentOptions), ...patch } }))
    if (selected) {
      const threadId = selected
      optionWrites.current = optionWrites.current.catch(() => {}).then(async () => { await api(`/threads/${encodeURIComponent(threadId)}/options`, patch) }).catch(error => setError(message(error)))
    }
    if (running && (patch.model !== undefined || patch.effort !== undefined)) setToast('模型设置已更新，将从下一轮生效')
  }
  function openSettings(tab: SettingsTab, focusLoading = false) { setLoadingFocus(focusLoading); setSettingsTab(tab); setSettings(true) }
  async function copyReply() {
    const text = thread?.items.filter(item => item.type === 'agentMessage' && item.text).at(-1)?.text
    if (!text) { setToast('还没有可复制的回复'); return }
    try { await navigator.clipboard.writeText(text); setToast('已复制最新回复') } catch { setError('无法访问剪贴板，请使用回复下方的复制按钮') }
  }
  async function terminalResume() {
    if (!selected) return
    try { await api(`/threads/${encodeURIComponent(selected)}/release`, {}); await navigator.clipboard.writeText(`codex resume ${selected}`); setToast('已复制终端继续命令') }
    catch (error) { setError(message(error)) }
  }
  async function selectSkills() {
    try { const result = await api<{ skills: SkillInfo[] }>(`/skills${activeWorkspace ? `?workspace=${encodeURIComponent(activeWorkspace.id)}` : ''}`); setAvailableSkills(result.skills.filter(skill => skill.enabled)); setPalette('skills') }
    catch (error) { setError(message(error)) }
  }
  function useSkill(skill: SkillInfo) {
    setSkillDrafts(previous => ({ ...previous, [draftKey]: [...(previous[draftKey] || []).filter(row => row.path !== skill.path), skill].slice(0, 10) }))
    closeDialogs(); setPalette(null); requestAnimationFrame(() => composer.current?.focus())
  }
  function toggleSkill(skill: SkillInfo) { setSkillDrafts(previous => { const rows = previous[draftKey] || []; return { ...previous, [draftKey]: rows.some(row => row.path === skill.path) ? rows.filter(row => row.path !== skill.path) : [...rows, skill].slice(0, 10) } }) }
  function toggleReference(path: string) { setReferenceDrafts(previous => { const rows = previous[draftKey] || []; return { ...previous, [draftKey]: rows.includes(path) ? rows.filter(row => row !== path) : [...rows, path].slice(0, 20) } }) }
  function runCommand(id: string) {
    setPalette(null)
    const tabs: Record<string, SettingsTab> = { '/model': 'models', '/permissions': 'models', '/skills': 'skills', '/settings': 'general', '/status': 'status', '/archives': 'archives', '/help': 'shortcuts' }
    if (tabs[id]) { openSettings(tabs[id]); return }
    if (['/plan', '/goal'].includes(id) && !activeWorkspace) { setError('请先选择一个工作区。'); return }
    if (id === '/plan') {
      if (!boot?.capabilities?.planning) { setError('当前引擎未提供规划模式；更新 cweb 或 CLI 后重试。'); return }
      const collaborationMode = currentOptions.collaborationMode === 'plan' ? 'default' : 'plan'
      changeOptions({ collaborationMode }); setToast(collaborationMode === 'plan' ? '已切换规划模式，下一轮先调查并形成方案' : '已切回执行模式'); return
    }
    if (id === '/goal') { if (!boot?.capabilities?.goals) setError('目标功能将在服务更新后可用。'); else goalPanel.current?.open(); return }
    if (id === '/panel') { openGenui(); setInspector(false) }
    else if (id === '/genui') { void api<{ skills: SkillInfo[] }>(`/skills${activeWorkspace ? `?workspace=${encodeURIComponent(activeWorkspace.id)}` : ''}`).then(value => { const skill = value.skills.find(row => row.name === 'genui' && row.enabled); if (skill) useSkill(skill); else setToast('请先在设置中启用 GenUI') }).catch(error => setError(message(error))) }
    else if (id === '/new') newThread()
    else if (id === '/resume') { newThread(null); openSidebarNavigation(); setTimeout(() => document.querySelector<HTMLInputElement>('[aria-label="搜索会话"]')?.focus(), 0) }
    else if (id === '/folder') addWorkspaceDialog()
    else if (id === '/files') setInspector(true)
    else if (id === '/copy') void copyReply()
    else if (id === '/stop') void interrupt()
    else if (id === '/archive') void archive()
    else if (id === '/compact' && selected) void api(`/threads/${encodeURIComponent(selected)}/compact`, {}).then(() => setToast('CLI 已开始压缩上下文')).catch(error => setError(message(error)))
    else if (id === '/compact') setError('请先打开一个会话')
  }
  async function addFiles(incoming: File[]) {
    const key = draftKey
    if (!activeWorkspace) { setError('请先选择工作区，再添加附件'); return }
    if (busy || uploadPending.current.has(key)) return
    const remaining = 10 - (fileDrafts[key]?.length || 0)
    if (incoming.length > remaining) { setError('每条消息最多添加 10 个附件'); return }
    uploadPending.current.add(key); setUploads(previous => ({ ...previous, [key]: incoming.length }))
    try {
      for (const file of incoming) {
        if (!file.size || file.size > 20 * 1024 * 1024) throw new Error(`${file.name}：附件必须非空，且不能超过 20 MB`)
        const attached = await upload(file)
        setFileDrafts(previous => ({ ...previous, [key]: [...(previous[key] || []), attached] }))
      }
    } catch (error) { setError(message(error)) }
    finally { uploadPending.current.delete(key); setUploads(previous => ({ ...previous, [key]: 0 })) }
  }

  function closeDialogs() { if (settings || workspaceDialog || renameDialog) dialogExit.exit() }
  function newThread(id: string | null = activeWorkspace?.id || null) {
    setWorkspaceId(id)
    setSelected(null); setSidebar(false); setError(''); follow.current = true
    try { localStorage.removeItem('cweb:thread'); localStorage.removeItem('dsh-local-thread') } catch { /* No effect on conversation history. */ }
    requestAnimationFrame(() => composer.current?.focus())
  }
  function setDraft(value: string) { setDrafts(previous => ({ ...previous, [draftKey]: value })) }
  function cancelEdit() {
    if (!editing || busy) return
    const saved = editing.saved
    setDrafts(previous => ({ ...previous, [draftKey]: saved.text })); setFileDrafts(previous => ({ ...previous, [draftKey]: saved.files })); setSkillDrafts(previous => ({ ...previous, [draftKey]: saved.skills })); setReferenceDrafts(previous => ({ ...previous, [draftKey]: saved.references }))
    setEditingMessages(previous => { const value = { ...previous }; delete value[draftKey]; return value })
    setPendingMessages(previous => previous.filter(row => row.key !== draftKey || !row.editTurnId))
    composer.current?.focus()
  }
  function recoverMessage(pending: PendingMessage) {
    if (busy) return
    const saved = pending.contents
    setDrafts(previous => ({ ...previous, [pending.key]: previous[pending.key] ? `${saved.text}\n\n${previous[pending.key]}` : saved.text }))
    setFileDrafts(previous => ({ ...previous, [pending.key]: [...new Map([...saved.files, ...(previous[pending.key] || [])].map(file => [file.id, file])).values()] }))
    setSkillDrafts(previous => ({ ...previous, [pending.key]: [...new Map([...saved.skills, ...(previous[pending.key] || [])].map(skill => [skill.path, skill])).values()] }))
    setReferenceDrafts(previous => ({ ...previous, [pending.key]: [...new Set([...saved.references, ...(previous[pending.key] || [])])] }))
    setPendingMessages(previous => previous.filter(row => row.id !== pending.id)); setError(''); composer.current?.focus()
  }
  function changeLoadingStyle(value: RunningStyle) {
    setLoadingStyle(value)
    try { localStorage.setItem('cweb:loading-style', value) } catch { setToast('本次选择已生效，浏览器未能保存设置') }
  }
  function addWorkspaceDialog() { setError(''); setDirectoryDraft(''); setNameDraft(''); setWorkspaceEditing(null); setWorkspaceDialog(true) }
  function chooseThread(id: string) { window.dispatchEvent(new CustomEvent(threadReadEvent, { detail: id })); setWorkspaceId(workspaceFor(workspaces, threads.find(row => row.id === id)?.cwd || '')?.id || null); setSelected(id); setSidebar(false); setError('') }

  async function submit(queued = false) {
    if ((!draft.trim() && !files.length && !skills.length && !references.length) || busy || sending.current || pendingMessage || !connected || !activeWorkspace || uploads[draftKey] || thread?.externalOwner) return
    let text = draft.trim()
    if (!editing && /^\/goal\s+/.test(text)) { if (boot?.capabilities?.goals) { goalPanel.current?.open(text.replace(/^\/goal\s+/, '')); setDraft('') } else setError('目标功能将在服务更新后可用。'); return }
    const planPrompt = !editing && /^\/plan\s+/.test(text)
    if (planPrompt) { if (!boot?.capabilities?.planning) { setError('当前引擎未提供规划模式。'); return } text = text.replace(/^\/plan\s+/, ''); changeOptions({ collaborationMode: 'plan' }) }
    if (!editing && /^\/[^\s]*$/.test(text)) {
      if (commands.some(command => command.id === text)) { setDraft(''); runCommand(text) }
      else setError('未识别的命令，请输入 / 查看网页支持的操作')
      return
    }
    if (!editing && /^\/panel\s+/.test(text)) { text = `请使用 GenUI 更新这个会话的交互面板：${text.slice(7).trim()}。使用 panel:true 的 dsh-ui 围栏或可用的 render_ui 工具。`; openGenui(); setInspector(false) }
    if (references.length) text += `${text ? '\n\n' : ''}引用项目文件：\n${references.map(path => '@' + JSON.stringify(path)).join('\n')}`
    const focusAtSend = document.activeElement
    sending.current = true; setBusy(true); setError('')
    let target = selected; const original = draftKey
    const optimistic: PendingMessage = { id: crypto.randomUUID(), key: original, state: 'sending', baseline: thread?.items.map(item => item.id) || [], contents: { text: draft, files, skills, references }, ...(editing ? { editTurnId: editing.turnId } : {}), item: { id: '', type: 'userMessage', text, status: 'sending', timestamp: Date.now(), timeSource: 'observed', attachments: files, skills: skills.map(({ name, path }) => ({ name, path })) } }
    optimistic.item.id = optimistic.id
    setPendingMessages(previous => [...previous, optimistic])
    setDrafts(previous => ({ ...previous, [original]: '' })); setFileDrafts(previous => ({ ...previous, [original]: [] })); setSkillDrafts(previous => ({ ...previous, [original]: [] })); setReferenceDrafts(previous => ({ ...previous, [original]: [] }))
    try {
      showLatest()
      await optionWrites.current
      if (!target) {
        const created = await api<ThreadView>('/threads', { cwd: activeCwd, model: currentOptions.model })
        const focusedInput = document.activeElement === composer.current
        const selection = composer.current ? [composer.current.selectionStart, composer.current.selectionEnd] : null
        target = created.id; updateViews(previous => mergeView(previous, created))
        if (currentDraftKey.current === original) {
          if (focusedInput && selection) restoreComposerFocus.current = { key: created.id, start: selection[0], end: selection[1] }
          setSelected(created.id)
        }
        setPendingMessages(previous => previous.map(row => row.id === optimistic.id ? { ...row, key: created.id } : row))
        setDrafts(previous => ({ ...previous, [original]: '', [created.id]: previous[original] || '' })); setFileDrafts(previous => ({ ...previous, [original]: [], [created.id]: previous[original] || [] })); setSkillDrafts(previous => ({ ...previous, [original]: [], [created.id]: previous[original] || [] }))
        setReferenceDrafts(previous => ({ ...previous, [original]: [], [created.id]: previous[original] || [] }))
        setOptionDrafts(previous => ({ ...previous, [created.id]: currentOptions }))
      }
      const isQueued = !editing && (queued || planPrompt) && running
      const payload = { text, ...currentOptions, ...(planPrompt ? { collaborationMode: 'plan' as const } : {}), attachments: files.map(file => file.id), skills: skills.map(skill => skill.path), steer: Boolean(!editing && running && !queued && !planPrompt), ...(boot?.capabilities?.clientMessageIds ? { clientMessageId: optimistic.id } : {}) }
      let result: { thread?: ThreadView }
      try { result = await api(`/threads/${encodeURIComponent(target)}/${editing ? 'edit' : isQueued ? 'queue' : 'message'}`, editing ? { itemId: editing.itemId, turnId: editing.turnId, message: payload } : payload) }
      catch (error) { if (error instanceof ApiError && error.code === 'NOT_RUNNING') result = await api(`/threads/${encodeURIComponent(target)}/message`, { ...payload, steer: false }); else throw error }
      if (result.thread) { const value = result.thread; updateViews(previous => mergeView(previous, value)) }
      setPendingMessages(previous => isQueued ? previous.filter(row => row.id !== optimistic.id) : previous.map(row => row.id === optimistic.id ? { ...row, state: 'syncing' } : row))
      if (editing) setEditingMessages(previous => { const value = { ...previous }; delete value[original]; return value })
    } catch (error) {
      if (!echoedMessage(optimistic, target ? viewsRef.current[target] : undefined)) {
        setPendingMessages(previous => previous.map(row => row.id === optimistic.id ? { ...row, state: 'failed', error: message(error) } : row))
        if (error instanceof ApiError && error.code === 'EDIT_REVERTED') setEditingMessages(previous => { const value = { ...previous }; delete value[original]; return value })
      }
    }
    finally {
      sending.current = false; setBusy(false)
      requestAnimationFrame(() => {
        // A native question or another user action may already own focus while
        // this HTTP acknowledgement is in flight. Preserve that newer intent.
        if (selectedRef.current === target && (document.activeElement === focusAtSend || document.activeElement === document.body)) composer.current?.focus()
      })
    }
  }

  async function interrupt() {
    if (!selected) return
    try { await api(`/threads/${encodeURIComponent(selected)}/interrupt`, {}) }
    catch (error) { setError(message(error)) }
  }
  async function ensureGoalThread() {
    if (selectedRef.current) return selectedRef.current
    if (!activeWorkspace || busy) throw new Error('请先选择工作区，并等待消息提交完成。')
    const created = await api<ThreadView>('/threads', { cwd: activeCwd, model: currentOptions.model })
    updateViews(previous => mergeView(previous, created)); setSelected(created.id); setOptionDrafts(previous => ({ ...previous, [created.id]: currentOptions })); return created.id
  }
  async function startGoal(id: string, objective: string) {
    await optionWrites.current
    const options = { ...currentOptions, ...(currentOptions.collaborationMode === 'plan' ? { collaborationMode: 'default' as const } : {}) }
    const snapshot = await api<ThreadView>(`/threads/${encodeURIComponent(id)}/snapshot`)
    if (snapshot.turnId) {
      // A native goal can resume before the HTTP reply. Queue only when the user
      // explicitly chose to add work behind the turn already shown as running.
      if (running) await api(`/threads/${encodeURIComponent(id)}/queue`, { text: objective, ...options })
    } else {
      try { await api(`/threads/${encodeURIComponent(id)}/message`, { text: objective, ...options }) }
      catch (error) { if (!(error instanceof ApiError && ['BUSY', 'SESSION_IN_USE'].includes(error.code))) throw error }
    }
    setOptionDrafts(previous => ({ ...previous, [id]: options })); if (selectedRef.current === id) showLatest()
  }

  async function archive() {
    if (!selected) return
    try { await api(`/threads/${encodeURIComponent(selected)}/archive`, {}); newThread() }
    catch (error) { setError(message(error)) }
  }

  async function chooseWorkspace() {
    if (workspaceSaving || (!workspaceEditing && !directoryDraft)) return
    setWorkspaceSaving(true); setError('')
    try {
      if (workspaceEditing) {
        await api(`/workspaces/${workspaceEditing}/rename`, { name: nameDraft })
        setWorkspaces(rows => rows.map(row => row.id === workspaceEditing ? { ...row, name: nameDraft.trim() } : row))
      } else {
        const result = await api<WorkspaceInfo>('/workspaces', { path: directoryDraft, ...(nameDraft.trim() ? { name: nameDraft.trim() } : {}) })
        setWorkspaces(rows => rows.some(row => row.id === result.id) ? rows : [...rows, result]); newThread(result.id)
      }
      closeDialogs()
    } catch (error) { setError(message(error)) }
    finally { setWorkspaceSaving(false) }
  }

  const pluginSend = useCallback(async (id: string, text: string) => {
    const current = genuiCurrent.current
    if (id !== current.selected || !current.connected) throw new Error('网页尚未连接，请恢复连接后重试')
    try {
      await api(`/threads/${encodeURIComponent(id)}/todo-link`, { text, ...current.currentOptions })
      setToast('关联请求已提交，将在会话就绪后执行'); follow.current = true
    } catch (error) { setError(message(error)); throw error }
  }, [])
  const referenceDraft = useRef(draftKey); referenceDraft.current = draftKey
  const referenceFile = useCallback((path: string) => {
    const key = referenceDraft.current
    setReferenceDrafts(previous => ({ ...previous, [key]: [...new Set([...(previous[key] || []), path])].slice(0, 20) }))
    requestAnimationFrame(() => composer.current?.focus())
  }, [])
  const closeInspector = inspectorExit.exit
  const closeGenui = genuiExit.exit
  function toggleInspector() { if (inspector) closeInspector(); else if (genuiOpen) genuiExit.exit(() => { setGenuiOpen(false); setInspector(true) }); else setInspector(true) }
  async function togglePlugin(enabled: boolean) {
    const previous = pluginEnabled
    setPluginEnabled(enabled); setPluginSaving(true)
    try { await api('/plugins/todo-note/settings', { enabled }); setPluginEnabled(enabled) }
    catch (error) { setPluginEnabled(previous); setError(message(error)) }
    finally { setPluginSaving(false) }
  }

  const resizeSidebar = (width: number) => setSidebarWidth(Math.max(210, Math.min(420, width)))
  function openSidebarNavigation() { setSidebarCollapsed(false); setSidebar(mobile); try { localStorage.setItem('cweb:sidebar-collapsed', 'false') } catch {} }
  function jumpToNotice(id: string) { setSearch(''); chooseThread(id); openSidebarNavigation(); setRevealThread({ id, seq: ++revealSequence.current }) }
  const toggleSidebar = () => { setSidebar(false); setSidebarCollapsed(value => { try { localStorage.setItem('cweb:sidebar-collapsed', String(!value)) } catch {} return !value }) }
  return <FilePreviewProvider workspaceId={activeWorkspace?.id} root={activeWorkspace?.path} cwd={activeCwd}><ChoiceProvider threadId={selected || ''} activeMessageId={activeChoiceMessage} message={thread?.items.find(item => item.id === activeChoiceMessage)} onAnswer={choiceAnswer}><GenuiProvider threadId={selected || ""} enabled={prefs.genui} streaming={running} onAction={genuiAction} onOpen={openGenui}><div style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties} className={`app ${sidebarResizing ? 'sidebar-resizing' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${(inspector && activeWorkspace) || genuiOpen ? '' : 'inspector-hidden'}`}>
    <Presence show={sidebar} className="sidebar-backdrop" role="button" tabIndex={0} aria-label="关闭会话列表" onClick={() => setSidebar(false)} onKeyDown={event => { if (['Enter', ' '].includes(event.key)) setSidebar(false) }}>{null}</Presence>
    <aside className={`sidebar ${sidebar ? 'shown' : ''}`} aria-label="会话列表" aria-hidden={mobile ? !sidebar : sidebarCollapsed} {...((mobile ? !sidebar : sidebarCollapsed) ? { inert: '' } : {})}><div className="sidebar-content">
      <div className="brand"><BrandMark size={42} /><div><strong>cweb</strong><span>Codex 工作台</span></div></div>
      <button className="new-thread" onClick={() => newThread()} disabled={busy}><Plus size={17} /><span>新建会话</span><kbd>↵</kbd></button>
      <button className={`workspace-picker ${home ? 'active' : ''}`} disabled={busy} onClick={() => newThread(null)}><Folder size={16} /><span>所有工作区</span><span className="workspace-count">{workspaces.length}</span></button>
      <label className="search"><Search size={15} /><input aria-label="搜索会话" placeholder="搜索工作区或会话…" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="section-label">工作区与会话 <IconButton label="添加工作区" onClick={addWorkspaceDialog}><Plus size={15} /></IconButton></div>
      <WorkspaceGroups workspaceId={activeWorkspace?.id} workspaces={workspaces} threads={threads} views={views} approvals={approvals} selected={selected} reveal={revealThread} busy={busy} search={search} onChoose={chooseThread} onNew={newThread} onRename={workspace => { setWorkspaceEditing(workspace.id); setNameDraft(workspace.name); setWorkspaceDialog(true) }} />
      <div className="sidebar-bottom"><div className="local-status"><span className={`status-dot ${connected ? '' : 'offline'}`} /><span>{connected ? '本地引擎已连接' : runtime.state === 'starting' ? '正在连接本地引擎' : '本地引擎未连接'}</span><ShieldCheck size={13} /></div><div className="sidebar-actions"><UsagePopover /><div className="sidebar-utilities"><IconButton label="连接与设置" className="settings-trigger" onClick={() => openSettings('general')}><Settings size={17} /></IconButton><IconButton label={theme === 'light' ? '切换深色主题' : '切换浅色主题'} onClick={() => void updatePreferences({ theme: theme === 'light' ? 'dark' : 'light' }).catch(error => setError(message(error)))}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}</IconButton></div></div></div>
      </div><div className="sidebar-resize" role="separator" tabIndex={0} aria-label="调整侧边栏宽度" aria-orientation="vertical" aria-valuemin={210} aria-valuemax={420} aria-valuenow={sidebarWidth} onPointerDown={event => { sidebarDrag.current = true; setSidebarResizing(true); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }} onPointerMove={event => { if (sidebarDrag.current) resizeSidebar(event.clientX) }} onPointerUp={event => { sidebarDrag.current = false; setSidebarResizing(false); try { localStorage.setItem('cweb:sidebar-width', String(Math.max(210, Math.min(420, event.clientX)))) } catch {} }} onPointerCancel={() => { sidebarDrag.current = false; setSidebarResizing(false) }} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = Math.max(210, Math.min(420, sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10))); resizeSidebar(next); try { localStorage.setItem('cweb:sidebar-width', String(next)) } catch {} } }} />
    </aside>

    <main className={`main ${dropping ? 'dragging-files' : ''}`} ref={main} onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDropping(true) } }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }} onDragLeave={event => { if (event.dataTransfer.types.includes('Files') && --dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false) } }} onDrop={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current = 0; setDropping(false); void addFiles(Array.from(event.dataTransfer.files)) } }} >
      <Presence show={dropping} className="file-drop-overlay"><Upload size={32} /><strong>松开以添加附件</strong><span>图片与文件 · 每个不超过 20 MB</span></Presence><header className="topbar"><IconButton label="打开会话列表" className="mobile-menu" onClick={() => setSidebar(true)}><Menu size={18} /></IconButton><IconButton label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} className="desktop-sidebar-toggle" onClick={toggleSidebar}>{sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</IconButton><div className="breadcrumb"><Folder size={15} /><button className="breadcrumb-home" onClick={() => newThread(null)} disabled={busy}>工作区</button>{!home && <><span className="slash">/</span><span>{activeWorkspace?.name || baseName(activeCwd)}</span><span className="slash">/</span><strong>{thread?.title || '新会话'}</strong></>}</div><div className="topbar-actions">{prefs.genui && <IconButton label="GenUI 交互面板" onClick={openGenui}><Braces size={17} /></IconButton>}<IconButton label="快捷命令" onClick={() => setPalette('commands')}><Command size={16} /></IconButton>{selected && <><IconButton label="复制终端继续命令" disabled={running || busy} onClick={() => void terminalResume()}><SquareTerminal size={16} /></IconButton><IconButton label="重命名会话" onClick={() => { setNameDraft(thread?.title || ''); setRenameDialog(true) }}><Pencil size={15} /></IconButton><IconButton label="归档会话" onClick={() => void archive()} disabled={running || Boolean(thread?.externalOwner)}><Archive size={15} /></IconButton></>}<span className={`badge local-badge run-badge ${running ? 'is-running' : ''}`} role="status"><span className={`status-dot ${currentApprovals.length || thread?.choicePending ? 'waiting' : thread?.status === 'completed' ? 'complete' : ''}`} />{currentApprovals.length ? '待确认' : thread?.choicePending ? '待回复' : running ? '处理中' : thread?.status === 'completed' ? '已完成' : 'LOCAL'}</span><IconButton disabled={!activeWorkspace} label={inspector ? '隐藏工作区面板' : '显示工作区面板'} onClick={toggleInspector}><PanelRight size={17} /></IconButton></div></header>
      <div className="conversation-stage"><div className="conversation" ref={transcript} tabIndex={0} aria-label="会话内容"><div ref={transcriptContent} className="conversation-content">
        {home ? !boot ? <div className="workspace-home workspace-loading" role="status" aria-label="正在加载工作区"><BrandMark size={26} /><p>正在载入工作台…</p><div className="conversation-skeleton" aria-hidden="true"><i /><i /><i /></div></div> : <WorkspaceHome workspaces={workspaces} threads={threads} onOpen={newThread} onAdd={addWorkspaceDialog} onThread={chooseThread} /> : !selected ? pendingMessage ? <div className="transcript"><TranscriptItem item={pendingMessage.item} /></div> : <div className="welcome"><div className="welcome-eyebrow"><span />你的代码，你的工作区</div><h1>让想法，<br /><span>在这里开始。</span></h1><p>与 Codex 一起理解、构建和打磨项目。<br />每一次执行，都在你的本机。</p><div className="starter-grid">{starters.map(starter => <button key={starter.title} className="starter" onClick={() => { setDraft(starter.prompt); requestAnimationFrame(() => composer.current?.focus()) }}><div className="starter-icon">{starter.icon}<ArrowRight size={14} /></div><strong>{starter.title}</strong><span>{starter.detail}</span></button>)}</div><div className="welcome-note"><ShieldCheck size={14} />执行前可审批，过程可查看，随时可停止</div></div>
          : <Transcript key={selected} thread={displayedThread} loading={loadingThread} approvals={currentApprovals.length} expanded={prefs.showActivityDetails} collapseTiming={prefs.activityCollapseTiming || 'next-input'} jumpTo={jumpTarget} follow={follow} paused={awayFromBottom || historyNavigation} onEdit={editMessage} editDisabled={busy || Boolean(pendingMessage)} />}
      </div></div><div className="composer-dock" ref={composerDock}><div className={`composer-region ${home ? 'home-notices' : ''}`}>
        {!home && boot?.capabilities?.goals && <GoalPanel ref={goalPanel} threadId={selected} update={goalUpdate} running={running} latestTaskAt={thread?.items.findLast(item => item.type === 'userMessage')?.timestamp || thread?.runs?.at(-1)?.startedAt} ensureThread={ensureGoalThread} onStart={startGoal} />}
        {!home && currentOptions.collaborationMode === 'plan' && <div className="plan-mode-banner"><GitBranch size={15} /><span>规划模式 · 先调查并形成方案</span><button type="button" onClick={() => changeOptions({ collaborationMode: 'default' })}>切回执行</button></div>}
        {(awayFromBottom || historyNavigation) && !home && <button type="button" className="scroll-to-bottom" onClick={showLatest}><ArrowDown size={15} />回到底部</button>}
        {error && <Notice text={error} onClose={() => setError('')} />}
        {runtime.state === 'failed' && <div className="connection-notice"><span>{runtime.error || '无法连接 Codex CLI'}</span><button onClick={() => setReload(reload + 1)}>重新连接</button><button onClick={() => openSettings('general')}>设置</button></div>}
        {runtime.state === 'ready' && !streamConnected && <div className="connection-notice"><span>事件连接中断，正在重新连接。恢复后可继续操作</span><button onClick={() => setReload(reload + 1)}>重新连接</button></div>}
        <Presence show={Boolean(toast)} className="toast" role="status"><Check size={14} />{toast}</Presence>
        {thread?.externalOwner && <div className="connection-notice session-notice"><span>这个会话的任务仍在另一端执行，结束后可在网页继续。</span><button disabled={handoffBusy} onClick={() => void handoff()}>{handoffBusy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}检查并在网页继续</button></div>}
        {pluginEnabled && thread?.todoTools === 'waiting' && !thread.externalOwner && <div className="connection-notice session-notice"><span>待办工具等待会话重新载入；如果另一端仍打开此会话，请先退出该会话。</span><button disabled={handoffBusy || running || !connected} onClick={() => void connectTodo()}><RefreshCw size={14} />检查待办连接</button></div>}
        <ApprovalStack approvals={currentApprovals} onError={setError} />
        <ChoiceDock />
        <RunStatus thread={thread} approvals={currentApprovals.length} />
        {pendingMessage && <div className={`message-delivery ${pendingMessage.state === 'failed' ? 'failed' : ''}`} role="status"><span>{pendingMessage.state === 'failed' ? `发送未确认：${pendingMessage.error}` : pendingMessage.state === 'syncing' ? '已提交，正在同步 CLI 记录…' : '正在发送…'}</span>{pendingMessage.state === 'failed' && <button type="button" onClick={() => recoverMessage(pendingMessage)}>恢复草稿</button>}</div>}
        <Presence show={Boolean(editing)} className="edit-message-banner"><Pencil size={15} /><div><strong>编辑历史消息</strong><span>{editing?.merged ? '本轮较早的指令已合并。' : ''}{running ? '发送时先停止当前任务，' : '发送后'}回退本轮及后续对话，项目文件不回退。</span></div><button type="button" disabled={busy} onClick={cancelEdit}>取消编辑</button></Presence>
        {!home && <Composer key={draftKey} editing={Boolean(editing)} input={composer} draft={draft} onDraft={setDraft} prefs={prefs} options={currentOptions} onOptions={changeOptions} models={boot?.models || []} loadingStyle={loadingStyle}
          files={files} onFiles={files => void addFiles(files)} onRemove={id => setFileDrafts(previous => ({ ...previous, [draftKey]: files.filter(file => file.id !== id) }))} uploading={Boolean(uploads[draftKey])}
          skills={skills} skillIndex={availableSkills} skillsLoading={skillsLoading} onRefreshSkills={() => setSkillsRevision(value => value + 1)} onToggleSkill={toggleSkill} onSkills={() => void selectSkills()} onRemoveSkill={path => setSkillDrafts(previous => ({ ...previous, [draftKey]: skills.filter(skill => skill.path !== path) }))}
          workspaceId={activeWorkspace?.id} referenceIndexReady={boot?.capabilities?.fileReferences} references={references} onToggleReference={toggleReference}
          history={history} running={running} busy={busy || pendingMessage?.state === 'syncing'} disabled={!connected || !activeWorkspace || Boolean(thread?.externalOwner) || Boolean(pendingMessage)} onSubmit={queued => void submit(queued)} onInterrupt={() => void interrupt()} onCommand={runCommand}
          queue={queue.filter(row => row.threadId === selected)} onQueue={(id, retry) => void api(`/queue/${id}/${retry ? 'retry' : 'remove'}`, {}).catch(error => setError(message(error)))} />}

      </div></div>{thread && <TurnNavigator items={thread.items} viewport={transcript} onNavigate={navigateMessage} />}<ThreadNotices notices={notices} workspaces={workspaces} onJump={jumpToNotice} onDismiss={dismissNotice} /></div>
    </main>
    {genuiOpen && <GenuiPanel panels={genuiPanels} closing={genuiExit.closing} onClose={closeGenui} />}
    {!genuiOpen && inspector && activeWorkspace && <Inspector key={activeWorkspace.id} cwd={activeCwd} root={activeWorkspace.path} workspaceId={activeWorkspace.id} thread={thread} closing={inspectorExit.closing} onReference={referenceFile} onClose={closeInspector} />}
    {pluginEnabled && selected && !loadingThread && <TodoNote sessionId={selected} send={pluginSend} linkPending={todoLinkPending} running={running && !currentApprovals.length && !thread?.choicePending} />}


    <dialog ref={dialog} data-exiting={dialogExit.closing || undefined} className={`settings-dialog ${settings ? 'categorized-settings' : ''} ${workspaceDialog && !workspaceEditing ? 'workspace-dialog' : ''}`} onCancel={event => { event.preventDefault(); closeDialogs() }} onClick={event => { if (event.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDialogs() } }}>
      <div className="dialog-header"><h2>{workspaceDialog ? workspaceEditing ? '重命名工作区' : '添加工作区' : renameDialog ? '重命名会话' : '连接与设置'}</h2><IconButton label="关闭对话框" onClick={closeDialogs}><X size={18} /></IconButton></div>
      {workspaceDialog ? <form className={workspaceEditing ? '' : 'workspace-dialog-form'} onSubmit={event => { event.preventDefault(); void chooseWorkspace() }}>
        {workspaceEditing ? <p className="muted">名称用于整理工作区，不会移动项目目录。</p> : <><p className="workspace-dialog-intro">选择一个项目文件夹，接着开始你的会话。</p><DirectoryPicker initialPath={activeWorkspace?.path || workspaces[0]?.path} workspaces={workspaces} onSelect={setDirectoryDraft} disabled={workspaceSaving} /></>}
        <div className="workspace-dialog-details"><label className="field-label">工作区名称{!workspaceEditing && '（可选）'}<input autoFocus={Boolean(workspaceEditing)} value={nameDraft} disabled={workspaceSaving} maxLength={80} onChange={event => setNameDraft(event.target.value)} placeholder="默认使用文件夹名称" /></label>{error && <Notice text={error} />}<div className="dialog-footer"><button type="button" disabled={workspaceSaving} onClick={closeDialogs}>取消</button><button className="primary" type="submit" disabled={workspaceSaving || (workspaceEditing ? !nameDraft.trim() : !directoryDraft)}>{workspaceSaving ? <><LoaderCircle size={15} className="spin" />正在打开…</> : workspaceEditing ? '保存工作区名称' : '打开工作区'}</button></div></div>
      </form>
        : renameDialog ? <form onSubmit={event => { event.preventDefault(); if (selected) void api(`/threads/${encodeURIComponent(selected)}/rename`, { title: nameDraft }).then(closeDialogs).catch(error => setError(message(error))) }}><label className="field-label">会话名称<input autoFocus value={nameDraft} maxLength={120} onChange={event => setNameDraft(event.target.value)} /></label>{error && <Notice text={error} />}<div className="dialog-footer"><button className="primary" disabled={!nameDraft.trim()}>保存名称</button></div></form>
          : settings && <SettingsPanel tab={settingsTab} onTab={tab => { setLoadingFocus(false); setSettingsTab(tab) }} boot={boot} connected={connected} preferences={prefs} onPreferences={updatePreferences} loadingStyle={loadingStyle} onLoadingStyle={changeLoadingStyle} loadingFocus={loadingFocus}
            current={selected ? { title: thread?.title || '当前会话', options: currentOptions, model: thread?.model, tokens: thread?.tokens } : undefined} onCurrent={changeOptions}
            workspaces={workspaces} workspaceId={activeWorkspace?.id} onUseSkill={useSkill} plugin={pluginEnabled} pluginSaving={pluginSaving} onPlugin={enabled => void togglePlugin(enabled)}
            onReconnect={() => { setReload(reload + 1); closeDialogs() }} onRestored={id => { closeDialogs(); chooseThread(id) }} />}

    </dialog>
    {palette && <CommandPalette title={palette === 'commands' ? '搜索命令…' : palette === 'skills' ? '选择本轮 Skill…' : '搜索输入历史…'}
      items={palette === 'commands' ? commands : palette === 'skills' ? availableSkills.map(skill => ({ id: skill.path, label: skill.name, detail: skill.description })) : history.map((text, index) => ({ id: String(index), label: text }))}
      onClose={() => { setPalette(null); requestAnimationFrame(() => composer.current?.focus()) }} onChoose={id => { if (palette === 'commands') runCommand(id); else if (palette === 'skills') { const skill = availableSkills.find(row => row.path === id); if (skill) useSkill(skill) } else { setDraft(history[Number(id)]); setPalette(null); requestAnimationFrame(() => composer.current?.focus()) } }} />}
  </div></GenuiProvider></ChoiceProvider></FilePreviewProvider>
}
