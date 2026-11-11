export type Mode = 'workspace-write' | 'read-only' | 'danger-full-access'
export type ApprovalPolicy = 'on-request' | 'untrusted' | 'never'
export interface SessionOptions { model: string; effort: string; mode: Mode; approvalPolicy: ApprovalPolicy; collaborationMode?: 'default' | 'plan' }
export interface Preferences extends SessionOptions {
  theme: 'dark' | 'light' | 'system'; fontSize: number; uiFontSize: number
  animations: boolean; sendKey: 'enter' | 'mod-enter'; codeWrap: boolean; showInspector: boolean; genui: boolean; showActivityDetails: boolean
}
export const defaultPreferences: Preferences = { model: '', effort: '', mode: 'workspace-write', approvalPolicy: 'on-request',
  theme: 'dark', fontSize: 16, uiFontSize: 14, animations: true, sendKey: 'enter', codeWrap: false, showInspector: false, genui: true, showActivityDetails: true }
export interface UsageWindow { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null }
export interface UsageLimits { limitName?: string | null; primary?: UsageWindow | null; secondary?: UsageWindow | null; credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null }
export interface AccountStatus { accountType: string; planType: string; limits: UsageLimits[]; error?: string }
export interface AttachmentInfo { id: string; name: string; size: number; kind: 'image' | 'file'; url: string }
export interface GenuiPanelInfo { id: string; title: string; spec: unknown; updatedAt: number }
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
export interface ThreadGoal { threadId: string; objective: string; status: GoalStatus; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number }
export interface RunMetrics { id: string; status: string; startedAt?: number; completedAt?: number; durationMs?: number; tokenBase?: number; tokens?: number; quota?: { windows: { name: string; change: number }[]; capturedAt: number }; observed?: boolean }
export interface SkillInfo { name: string; description: string; path: string; scope: string; enabled: boolean; uses: number; lastUsed: number }
export interface QueuedMessage { id: string; threadId: string; text: string; attachmentCount: number; kind?: 'todo-link'; error?: string }
export type RunStatus = 'idle' | 'inProgress' | 'completed' | 'interrupted' | 'failed'

export interface Item {
  id: string
  type: string
  text: string
  status: string
  phase?: string
  delivery?: 'async'
  questions?: { title: string; options: string[] | null }[]
  activity?: string
  summaryParts?: string[]
  durationMs?: number
  timestamp?: number
  timeSource?: 'native' | 'turn' | 'observed'
  turnId?: string
  command?: string
  output?: string
  exitCode?: number | null
  tool?: string
  ui?: unknown
  attachments?: AttachmentInfo[]
  skills?: { name: string; path: string }[]
  changes?: { path: string; diff: string; kind: string }[]
}

export interface Question {
  id: string
  header: string
  question: string
  isSecret: boolean
  options: { label: string; description: string }[]
}

export interface Approval {
  id: string
  method: string
  threadId: string
  turnId: string
  reason: string
  command: string
  cwd: string
  detail: string
  questions: Question[]
}

export interface ThreadView {
  historyMode?: 'legacy' | 'paginated'
  choicePending?: boolean
  externalOwner?: number | null
  todoTools?: 'native' | 'mcp' | 'waiting'
  id: string
  revision: number
  title: string
  cwd: string
  model: string
  updatedAt: number
  status: RunStatus
  turnId: string | null
  items: Item[]
  plan: { step: string; status: string }[]
  diff: string
  tokens: number
  tokenUsageKnown?: boolean
  runs?: RunMetrics[]
  error: string | null
}

export interface ThreadPatch {
  type: 'threadPatch'; id: string; baseRevision: number; revision: number
  changes: Partial<Omit<ThreadView, 'items' | 'id' | 'revision'>>; items: Item[]; order?: string[]
}

export interface ThreadSummary {
  id: string
  title: string
  cwd: string
  updatedAt: number
  status?: RunStatus
  attention?: boolean
}

export interface ModelOption {
  id: string
  label: string
  efforts: string[]
}

export interface RuntimeStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed'
  error: string | null
}

export interface Bootstrap {
  capabilities?: { fileReferences: boolean; filePreview?: boolean; planning?: boolean; goals?: boolean; turnMetrics?: boolean; nativeAsyncQuestions?: boolean; messageEditing?: boolean; clientMessageIds?: boolean }
  token: string
  root: string
  workspaces: WorkspaceInfo[]
  plugins: { todoNote: boolean }
  preferences: Preferences
  sessionOptions: Record<string, SessionOptions>
  queue: QueuedMessage[]
  codexHome: string
  sharedHistory?: boolean
  sharedEngine?: boolean
  runtime: RuntimeStatus
  models: ModelOption[]
  account: string
  threads: ThreadSummary[]
}

export type StreamEvent =
  | ThreadPatch
  | { type: 'goal'; threadId: string; goal: ThreadGoal | null }
  | { type: 'genui'; threadId: string; panels: GenuiPanelInfo[] }
  | { type: 'thread'; thread: ThreadView }
  | { type: 'approvals'; approvals: Approval[] }
  | { type: 'runtime'; runtime: RuntimeStatus }
  | { type: 'threads'; threads: ThreadSummary[] }
  | { type: 'workspaces'; workspaces: WorkspaceInfo[] }
  | { type: 'plugins'; plugins: { todoNote: boolean } }
  | { type: 'preferences'; preferences: Preferences; sessionOptions: Record<string, SessionOptions> }
  | { type: 'queue'; queue: QueuedMessage[] }

export interface WorkspaceInfo { id: string; name: string; path: string; createdAt: number }

export interface DirectoryListing {
  path: string
  parent: string | null
  home: string
  root: string
  breadcrumbs: { name: string; path: string }[]
  directories: { name: string; path: string; symlink: boolean }[]
  total: number
  offset: number
  limit: number
}

export interface FileEntry { name: string; path: string; directory: boolean }
export interface Change { path: string; status: string }
