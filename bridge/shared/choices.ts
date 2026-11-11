import type { Item } from './types.ts'

export interface ChoiceSpec { id: string; legacyId?: string; question: string; multiple: boolean; options: { label: string; description: string }[] }
type ChoiceMessage = Pick<Item, 'text'> & Partial<Pick<Item, 'questions'>>

/** The installed CLI's async input is an agentMessage with structured questions.
 * Preserve those titles and options instead of interpreting their prose. */
export function nativeChoices(questions: Item['questions']): ChoiceSpec[] {
  return (questions || []).map((question, index) => ({
    id: `native-${index}-${textId(question.title + '\n' + (question.options || []).join('\n'))}`,
    legacyId: textId(question.title + '\n' + (question.options || []).join('\n')),
    question: question.title, multiple: false,
    options: (question.options || []).map(label => ({ label, description: '' })),
  }))
}
export function parseChoice(raw: string): ChoiceSpec | null {
  if (raw.length > 20_000) return null
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 100 || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 2000 || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 10) return null
    const options = value.options.map((option: unknown) => typeof option === 'string' ? { label: option, description: '' } : option) as { label: string; description?: string }[]
    if (options.some(option => !option || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 300 || (option.description !== undefined && (typeof option.description !== 'string' || option.description.length > 1000)))) return null
    if (new Set(options.map(option => option.label)).size !== options.length) return null
    return { id: value.id, question: value.question, multiple: value.multiple === true, options: options.map(option => ({ label: option.label, description: option.description || '' })) }
  } catch { return null }
}

export function fencedChoices(text: string): ChoiceSpec[] {
  return [...text.matchAll(/```cweb-choice\s*\n([\s\S]*?)\n```/gi)].flatMap(match => { const spec = parseChoice(match[1]); return spec ? [spec] : [] })
}

function textId(text: string) { let hash = 2166136261; for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return `text-${(hash >>> 0).toString(36)}` }
/** Recognize a direct question followed by actual options, never invent options
 * from a progress list, quoted example, code block or rhetorical question. */
export function textChoices(text: string): ChoiceSpec[] {
  if (text.length > 32_000 || fencedChoices(text).length) return []
  const lines = text.replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, '').split('\n')
  const result: ChoiceSpec[] = []
  for (let i = 0; i < lines.length && result.length < 10; i++) {
    const raw = lines[i].trim()
    if (!raw || /^>|^\|/.test(raw) || /(?:示例|例如|example)\s*[:：]/i.test(raw)) continue
    const question = raw.replace(/^#{1,6}\s+/, '').replace(/^\*\*(.+)\*\*$/, '$1')
    if (!/(?:你|您|请|是否|吗|是什么|哪[个种些]|有没有|能否|would you|do you|can you|which|select|choose)/i.test(question)) continue
    // An actual prompt may include a short explanation after the question mark,
    // e.g. “主要原因是什么？我会按你的实际感受调整。”
    if (question.length > 2000 || !(/[?？]/.test(question) || /(?:请选择|请勾选|选择哪|choose|select|which).*[:：]\s*$/i.test(question))) continue
    let at = i + 1; while (at < lines.length && !lines[at].trim()) at++
    const options: { label: string; description: string }[] = []
    for (; at < lines.length; at++) {
      const match = /^\s{0,3}(?:[-*+•]\s+|\d{1,2}[.)、]\s+|[A-Ja-j][.)、]\s+)(?:\[ \]\s*)?(.+?)\s*$/.exec(lines[at])
      if (!match || /^\[[xX]\]/.test(match[1])) break
      const label = match[1].replace(/^\*\*(.+)\*\*$/, '$1')
      if (label.length > 300) break
      options.push({ label, description: '' })
    }
    if (options.length < 2 || options.length > 10 || new Set(options.map(row => row.label)).size !== options.length) continue
    result.push({ id: textId(question + '\n' + options.map(row => row.label).join('\n')), question, options, multiple: /多选|可选多项|选择多个|select all|one or more/i.test(question) })
    i = at - 1
  }
  return result
}
export function messageChoices(message: string | ChoiceMessage) {
  const text = typeof message === 'string' ? message : message.text
  if (typeof message !== 'string' && message.questions?.length) return nativeChoices(message.questions)
  const fenced = fencedChoices(text); return fenced.length ? fenced : textChoices(text)
}
export function pendingChoiceMessage<T extends ChoiceMessage & { type: string; status?: string }>(items: T[]) {
  const user = items.findLastIndex(item => item.type === 'userMessage')
  for (let i = items.length - 1; i > user; i--) { const item = items[i]; if (item.type === 'agentMessage' && item.status !== 'inProgress' && messageChoices(item).length) return item }
  return undefined
}
export function hasPendingChoice(items: (ChoiceMessage & { type: string; status?: string })[]) { return Boolean(pendingChoiceMessage(items)) }
