import type { AttachmentInfo, SkillInfo } from '../shared/types.ts'
import type { DraftContents, PendingMessage } from './pending-message.ts'

export interface EditingMessage { itemId: string; turnId: string; saved: DraftContents; merged: boolean }
export interface ComposerCache {
  drafts: Record<string, string>; fileDrafts: Record<string, AttachmentInfo[]>; skillDrafts: Record<string, SkillInfo[]>; referenceDrafts: Record<string, string[]>
  pendingMessages: PendingMessage[]; editingMessages: Record<string, EditingMessage>
}
const prefix = 'cweb:composer:v1:'
export const emptyComposerCache = (): ComposerCache => ({ drafts: {}, fileDrafts: {}, skillDrafts: {}, referenceDrafts: {}, pendingMessages: [], editingMessages: {} })
const strings = (value: unknown, limit: number) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, limit) : []
function contents(value: unknown): DraftContents {
  const row = value && typeof value === 'object' ? value as Partial<DraftContents> : {}
  return { text: typeof row.text === 'string' ? row.text.slice(0, 100_000) : '', references: strings(row.references, 20),
    files: Array.isArray(row.files) ? row.files.filter(file => file && typeof file.id === 'string' && typeof file.name === 'string' && ['image', 'file'].includes(file.kind) && file.url === `/api/attachments/${file.id}/content`).slice(0, 10) : [],
    skills: Array.isArray(row.skills) ? row.skills.filter(skill => skill && typeof skill.path === 'string' && typeof skill.name === 'string').slice(0, 10) : [] }
}
export function loadComposerCache(storage: Storage): ComposerCache {
  const result = emptyComposerCache()
  for (let i = 0; i < storage.length; i++) {
    const storageKey = storage.key(i)
    if (!storageKey?.startsWith(prefix)) continue
    try {
      const key = decodeURIComponent(storageKey.slice(prefix.length)), raw = storage.getItem(storageKey)
      if (!raw || raw.length > 2_000_000 || key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      const row = JSON.parse(raw), draft = contents(row)
      result.drafts[key] = draft.text; result.fileDrafts[key] = draft.files; result.skillDrafts[key] = draft.skills; result.referenceDrafts[key] = draft.references
      if (row.editing && typeof row.editing.itemId === 'string' && typeof row.editing.turnId === 'string') result.editingMessages[key] = { itemId: row.editing.itemId, turnId: row.editing.turnId, merged: row.editing.merged === true, saved: contents(row.editing.saved) }
      if (Array.isArray(row.pending)) for (const pending of row.pending.slice(0, 3)) {
        if (typeof pending.id !== 'string' || pending.key !== key || pending.item?.id !== pending.id || pending.item?.type !== 'userMessage' || typeof pending.item.text !== 'string') continue
        result.pendingMessages.push({ ...pending, baseline: strings(pending.baseline, 20_000), contents: contents(pending.contents), state: pending.state === 'failed' ? 'failed' : 'unknown', error: pending.state === 'failed' ? pending.error : '页面已恢复，正在核对之前的提交结果。' })
      }
    } catch { /* One damaged draft must not hide the other conversations. */ }
  }
  return result
}
export function saveComposerCache(storage: Storage, value: ComposerCache, previous = emptyComposerCache()) {
  const keys = new Set([...Object.keys(value.drafts), ...Object.keys(previous.drafts), ...Object.keys(value.fileDrafts), ...Object.keys(value.skillDrafts), ...Object.keys(value.referenceDrafts), ...value.pendingMessages.map(row => row.key), ...previous.pendingMessages.map(row => row.key), ...Object.keys(value.editingMessages), ...Object.keys(previous.editingMessages)])
  for (const key of keys) {
    const pending = value.pendingMessages.filter(row => row.key === key), before = previous.pendingMessages.filter(row => row.key === key)
    if (value.drafts[key] === previous.drafts[key] && value.fileDrafts[key] === previous.fileDrafts[key] && value.skillDrafts[key] === previous.skillDrafts[key] && value.referenceDrafts[key] === previous.referenceDrafts[key] && value.editingMessages[key] === previous.editingMessages[key] && pending.length === before.length && pending.every((row, i) => row === before[i])) continue
    const row = { text: value.drafts[key] || '', files: value.fileDrafts[key] || [], skills: value.skillDrafts[key] || [], references: value.referenceDrafts[key] || [], pending, editing: value.editingMessages[key] }
    const storageKey = prefix + encodeURIComponent(key)
    if (!row.text && !row.files.length && !row.skills.length && !row.references.length && !pending.length && !row.editing) storage.removeItem(storageKey)
    else storage.setItem(storageKey, JSON.stringify(row))
  }
}
