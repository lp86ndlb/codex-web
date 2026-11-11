import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, MessageCircleQuestion } from 'lucide-react'
import { messageChoices, parseChoice, textChoices, type ChoiceSpec } from '../shared/choices.ts'
import type { Item } from '../shared/types.ts'
import { Checkbox } from './dsh/Checkbox.tsx'
import { Presence, useExitAction } from './Motion.tsx'

export interface ChoiceAnswer { question: string; answers: string[] }
type Panel = { specs: ChoiceSpec[]; threadId: string; slot: string; key: string; saved: Record<string, string>; active: boolean; automatic: boolean; reveal?: number }
type Host = { threadId: string; activeMessageId: string; panel: Panel | null; answers: Record<string, string>; show: (specs: ChoiceSpec[], slot: string) => void; close: () => void; submit: (panel: Panel, answers: Record<string, string[]>) => Promise<void> }
const context = createContext<Host | null>(null)
function storageKey(threadId: string, slot: string, id: string) { return `cweb:answer:${threadId}:${slot}:${id}` }
function saved(key: string) { try { return localStorage.getItem(key) || '' } catch { return '' } }
function recordedAnswer(threadId: string, slot: string, spec: ChoiceSpec, answers: Record<string, string>) {
  for (const id of [spec.id, ...(spec.legacyId ? [spec.legacyId] : [])]) {
    const key = storageKey(threadId, slot, id); const value = answers[key] || saved(key)
    if (value) return value
  }
  return ''
}
const answered = (panel: Panel) => panel.specs.every(spec => Boolean(panel.saved[spec.id]))
const draftKey = (panel: Panel) => `cweb:choice-draft:${panel.key}`
type Draft = { index: number; selected: Record<string, string[]>; custom: Record<string, boolean>; texts: Record<string, string> }
function readDraft(panel: Panel): Draft {
  const empty = { index: 0, selected: {}, custom: {}, texts: {} }
  try {
    const raw = sessionStorage.getItem(draftKey(panel)); if (!raw || raw.length > 128_000) return empty
    const value = JSON.parse(raw)
    if (!Number.isInteger(value.index) || value.index < 0 || value.index >= panel.specs.length || !value.selected || !value.custom || !value.texts) return empty
    if (!Object.values(value.selected).every(row => Array.isArray(row) && row.every(text => typeof text === 'string')) || !Object.values(value.custom).every(value => typeof value === 'boolean') || !Object.values(value.texts).every(value => typeof value === 'string')) return empty
    return value
  } catch { return empty }
}

export function ChoiceProvider({ threadId, activeMessageId, message, onAnswer, children }: { threadId: string; activeMessageId: string; message?: Item; onAnswer: (answers: ChoiceAnswer[]) => Promise<void>; children: ReactNode }) {
  const [requested, setRequested] = useState<Panel | null>(null); const [answers, setAnswers] = useState<Record<string, string>>({})
  const reveals = useRef(0)
  const specs = useMemo(() => message && message.id === activeMessageId && message.status !== 'inProgress' ? messageChoices(message) : [], [message?.text, message?.questions, message?.status, activeMessageId])
  const makePanel = useCallback((specs: ChoiceSpec[], slot: string): Panel => ({ specs, threadId, slot, key: `${threadId}:${slot}:${specs.map(spec => spec.id).join(':')}`, saved: Object.fromEntries(specs.map(spec => [spec.id, recordedAnswer(threadId, slot, spec, answers)])), active: slot === activeMessageId, automatic: true }), [threadId, activeMessageId, answers])
  const active = useMemo(() => specs.length ? makePanel(specs, activeMessageId) : null, [specs, makePanel, activeMessageId])
  // Automatic questions are derived from the current messages. Explicitly
  // reopened records have their own state, so late replies cannot erase them.
  const close = useCallback(() => setRequested(null), [])
  const submit = useCallback(async (current: Panel, selected: Record<string, string[]>) => {
    if (!current.active || current.threadId !== threadId || answered(current) || current.specs.some(spec => !selected[spec.id]?.some(value => value.trim()))) return
    await onAnswer(current.specs.map(spec => ({ question: spec.question, answers: selected[spec.id] })))
    try { sessionStorage.removeItem(draftKey(current)) } catch {}
    const recorded = Object.fromEntries(current.specs.map(spec => [storageKey(threadId, current.slot, spec.id), selected[spec.id].join('、')]))
    try { for (const [key, value] of Object.entries(recorded)) localStorage.setItem(key, value) } catch {}
    setAnswers(previous => ({ ...previous, ...recorded }))
    setRequested(previous => previous?.key === current.key && previous.reveal === current.reveal ? null : previous)
  }, [onAnswer, threadId])
  const visible = useMemo(() => requested?.threadId === threadId ? { ...makePanel(requested.specs, requested.slot), automatic: false, reveal: requested.reveal } : active && !answered(active) ? active : null, [requested, threadId, active, makePanel])
  const value = useMemo(() => ({ threadId, activeMessageId, panel: visible, answers, show: (specs: ChoiceSpec[], slot: string) => setRequested({ ...makePanel(specs, slot), automatic: false, reveal: ++reveals.current }), close, submit }), [threadId, activeMessageId, visible, answers, makePanel, close, submit])
  return <context.Provider value={value}>{children}</context.Provider>
}

function ChoiceSummary({ specs, slot, streaming }: { specs: ChoiceSpec[]; slot: string; streaming: boolean }) {
  const host = useContext(context)
  const pointerOpened = useRef(false)
  if (!host || !specs.length) return null
  const answers = specs.map(spec => recordedAnswer(host.threadId, slot, spec, host.answers))
  const complete = answers.every(Boolean)
  return <div className="choice-summary"><MessageCircleQuestion size={17} /><div><strong>{specs.length > 1 ? `${specs.length} 个问题` : specs[0].question}</strong><small>{complete ? specs.length > 1 ? '已提交全部回答' : `你的选择：${answers[0]}` : host.activeMessageId === slot ? '在输入框上方作答' : '历史选项'}</small></div><button type="button" disabled={streaming} onPointerDown={event => {
    // The exiting dock can shift this transcript row between down and up.
    // Capture mouse intent now; touch still waits for a completed tap.
    pointerOpened.current = !streaming && event.button === 0 && event.pointerType !== 'touch'
    if (pointerOpened.current) { event.preventDefault(); host.show(specs, slot) }
  }} onClick={event => { if (!pointerOpened.current || event.detail === 0) host.show(specs, slot); pointerOpened.current = false }}>{complete ? <><Check size={14} />查看选择</> : host.activeMessageId === slot ? '前往作答' : '查看选项'}</button></div>
}
export function ChoiceFence({ raw, slot, streaming }: { raw: string; slot: string; streaming: boolean }) {
  const spec = useMemo(() => parseChoice(raw), [raw])
  return spec ? <ChoiceSummary specs={[spec]} slot={slot} streaming={streaming} /> : streaming ? <div className="choice-summary">正在准备选项…</div> : <pre><code>{raw}</code></pre>
}
export function TextChoiceSummary({ item, slot, streaming }: { item: Item; slot: string; streaming: boolean }) {
  const specs = useMemo(() => item.questions?.length ? messageChoices(item) : textChoices(item.text), [item.text, item.questions])
  return <ChoiceSummary specs={specs} slot={slot} streaming={streaming} />
}

function DockedChoice({ panel, host }: { panel: Panel; host: Host }) {
  const [draft] = useState(() => readDraft(panel))
  const [index, setIndex] = useState(draft.index); const spec = panel.specs[Math.min(index, panel.specs.length - 1)]
  const review = !panel.active || answered(panel); const last = index === panel.specs.length - 1
  const [expanded, setExpanded] = useState(true); const [selected, setSelected] = useState(draft.selected)
  const [custom, setCustom] = useState(draft.custom); const [texts, setTexts] = useState(draft.texts)
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const root = useRef<HTMLElement>(null); const field = useRef<HTMLFieldSetElement>(null); const step = useExitAction(() => {}, field)
  useEffect(() => {
    if (review) return
    try { sessionStorage.setItem(draftKey(panel), JSON.stringify({ index, selected, custom, texts })) } catch {}
  }, [panel.key, review, index, selected, custom, texts])
  useEffect(() => { setExpanded(true) }, [panel.reveal])
  const values = (id: string) => custom[id] || !panel.specs.find(spec => spec.id === id)?.options.length ? [texts[id]?.trim() || ''] : selected[id] || []
  const chosen = (label: string) => review ? (panel.saved[spec.id] || '').split('、').includes(label) : values(spec.id).includes(label)
  function collapse() { if (review) host.close(); else setExpanded(false); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()) }
  function previous() { if (busy || step.closing) return; if (index > 0) step.exit(() => setIndex(index - 1)); else collapse() }
  useEffect(() => { if (expanded) { const frame = requestAnimationFrame(() => (field.current?.querySelector<HTMLElement>('input:checked:not(:disabled)') || field.current?.querySelector<HTMLElement>('input:not(:disabled)') || root.current?.querySelector<HTMLElement>('.question-panel-heading button'))?.focus()); return () => cancelAnimationFrame(frame) } }, [expanded, panel.reveal, index])
  async function next() {
    if (busy || step.closing || !review && !values(spec.id).some(Boolean)) return
    if (!last) { step.exit(() => setIndex(index + 1)); return }
    if (review) { collapse(); return }
    if (panel.specs.some(spec => !values(spec.id).some(Boolean))) return
    setBusy(true); setError('')
    try { await host.submit(panel, Object.fromEntries(panel.specs.map(spec => [spec.id, values(spec.id)]))) }
    catch (error) { setError(error instanceof Error ? error.message : '选择发送失败，请重试') }
    finally { setBusy(false) }
  }
  return <section ref={root} className="question-panel" role="region" aria-label="Codex 需要你的选择" onKeyDown={event => {
    if (event.nativeEvent.isComposing || busy) return
    const input = event.target instanceof HTMLInputElement ? event.target : null; const editing = input && !['checkbox', 'radio'].includes(input.type)
    if (event.shiftKey && event.key === 'ArrowLeft' && !(editing && input.value)) { event.preventDefault(); event.stopPropagation(); if (custom[spec.id] && !review) setCustom(previous => ({ ...previous, [spec.id]: false })); else previous(); return }
    if (editing) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void next() }; return }
    if (review) return
    const option = spec.options[Number(event.key) - 1]
    if (/^[1-9]$/.test(event.key) && option) { event.preventDefault(); setCustom(previous => ({ ...previous, [spec.id]: false })); setSelected(previous => ({ ...previous, [spec.id]: spec.multiple ? previous[spec.id]?.includes(option.label) ? previous[spec.id].filter(row => row !== option.label) : [...previous[spec.id] || [], option.label] : [option.label] })) }
    else if (event.key === 'Enter' && input) { event.preventDefault(); void next() }
  }}>
    <header className="question-panel-heading"><MessageCircleQuestion size={16} /><strong>{review ? '查看历史选择' : '等待你的回答'}</strong>{panel.specs.length > 1 && <small>{index + 1} / {panel.specs.length}</small>}<button type="button" aria-label={expanded ? '收起问题' : '展开问题'} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</button></header>
    <div className="question-panel-body" data-open={expanded || undefined} {...(!expanded ? { inert: '' } : {})}><div><div className="question-panel-scroll">
      <section className="approval-card"><fieldset className="choice-step" key={spec.id} ref={field} disabled={busy || step.closing} data-exiting={step.closing || undefined}><legend className="choice-question">{spec.question}</legend><div className="answer-options">{spec.options.map((option, optionIndex) => spec.multiple ? <div className="answer-choice multiple-choice" key={option.label}><Checkbox checked={chosen(option.label)} disabled={review || busy} label={option.label} onChange={checked => setSelected(previous => ({ ...previous, [spec.id]: checked ? [...previous[spec.id] || [], option.label] : (previous[spec.id] || []).filter(row => row !== option.label) }))} />{option.description && <small>{option.description}</small>}</div> : <label className={`answer-choice ${chosen(option.label) && !custom[spec.id] ? 'selected' : ''}`} key={option.label}><input type="radio" aria-label={option.label} name={`choice:${panel.key}:${spec.id}`} disabled={review || busy} checked={chosen(option.label) && !custom[spec.id]} onChange={() => { setCustom(previous => ({ ...previous, [spec.id]: false })); setSelected(previous => ({ ...previous, [spec.id]: [option.label] })) }} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span><kbd>{optionIndex + 1}</kbd></label>)}</div>
      {!review && spec.options.length > 0 && <button type="button" className="custom-answer-toggle" onClick={() => setCustom(previous => ({ ...previous, [spec.id]: !previous[spec.id] }))}>{custom[spec.id] ? '返回选项' : '自定义回答'}</button>}{!review && (custom[spec.id] || !spec.options.length) && <input autoFocus aria-label="自定义回答" placeholder="输入你的回答…" value={texts[spec.id] || ''} onChange={event => setTexts(previous => ({ ...previous, [spec.id]: event.target.value }))} />}
      {review && <p className="choice-record">已提交：{panel.saved[spec.id] || '未通过选择卡片提交，回复以会话记录为准。'}</p>}</fieldset>{error && <p role="alert" className="choice-error">{error}</p>}
      <div className="question-navigation">{(panel.specs.length > 1 || !review) && <button type="button" disabled={busy} onClick={previous}><ArrowLeft size={15} />{index > 0 ? '上一项' : '回到对话'}<kbd>Shift ←</kbd></button>}<button type="button" className={review ? '' : 'primary'} disabled={busy || step.closing || !review && !values(spec.id).some(Boolean)} onClick={() => void next()}>{busy ? '提交中…' : !last ? '下一项' : review ? '关闭记录' : '提交回答'}{!last && <ArrowRight size={15} />}</button></div></section>
    </div></div></div>
  </section>
}
export function ChoiceDock() {
  const host = useContext(context)
  return host ? <Presence show={Boolean(host.panel)} className="choice-dock">{host.panel && <DockedChoice key={host.panel.key} panel={host.panel} host={host} />}</Presence> : null
}
