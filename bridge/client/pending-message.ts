import type { AttachmentInfo, Item, SkillInfo, ThreadView } from '../shared/types.ts'

export interface DraftContents { text: string; files: AttachmentInfo[]; skills: SkillInfo[]; references: string[] }
export interface PendingMessage {
  id: string; key: string; item: Item; baseline: string[]; contents: DraftContents
  state: 'sending' | 'syncing' | 'failed' | 'unknown'; error?: string; editTurnId?: string
}

/** Prefer the native client id. The content fallback also supports a bridge
 * that is still running the preceding version during a frontend hot update. */
export function echoedMessage(pending: PendingMessage, thread?: ThreadView) {
  const baseline = new Set(pending.baseline)
  return thread?.items.some(item => item.type === 'userMessage' && (item.id === pending.id || !baseline.has(item.id)
    && item.text === pending.item.text
    && JSON.stringify(item.attachments?.map(file => file.id) || []) === JSON.stringify(pending.item.attachments?.map(file => file.id) || [])
    && JSON.stringify(item.skills?.map(skill => skill.path) || []) === JSON.stringify(pending.item.skills?.map(skill => skill.path) || []))) || false
}

export function withPendingMessage(thread: ThreadView | undefined, pending?: PendingMessage): ThreadView | undefined {
  if (!pending || echoedMessage(pending, thread)) return thread
  if (!thread) return undefined
  const cut = pending.editTurnId && pending.state !== 'failed' ? thread.items.findIndex(item => item.turnId === pending.editTurnId) : -1
  const items = cut >= 0 ? thread.items.slice(0, cut) : thread.items
  return { ...thread, items: [...items, pending.item] }
}
