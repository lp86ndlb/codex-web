import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, MessageCircleQuestion } from 'lucide-react'
import type { Approval } from '../shared/types.ts'
import { api, message } from './api.ts'
import { useExitAction } from './Motion.tsx'

/** Native CLI questions retain every answer while moving back and forward. */
export function Questionnaire({ approval, onError, onBack }: { approval: Approval; onError: (error: string) => void; onBack?: () => void }) {
  const [index, setIndex] = useState(0); const [answers, setAnswers] = useState<Record<string, string>>({})
  const [custom, setCustom] = useState<Record<string, boolean>>({}); const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const step = useExitAction(() => {})
  const field = useRef<HTMLFieldSetElement>(null)
  const question = approval.questions[index]; const last = index === approval.questions.length - 1
  const value = (id: string) => custom[id] ? customAnswers[id] || '' : answers[id] || ''
  useEffect(() => { const frame = requestAnimationFrame(() => (field.current?.querySelector<HTMLInputElement>('input:checked') || field.current?.querySelector<HTMLInputElement>('input'))?.focus()); return () => cancelAnimationFrame(frame) }, [index])
  function previous() { if (step.closing) return; if (index > 0) step.exit(() => setIndex(index - 1)); else onBack?.() }
  async function submit(decision: 'accept' | 'decline') {
    if (busy || (decision === 'accept' && approval.questions.some(q => !value(q.id).trim()))) return
    setBusy(true); setError('')
    try { await api('/answer', { id: approval.id, decision, answers: Object.fromEntries(approval.questions.map(q => [q.id, [value(q.id)]])) }) }
    catch (error) { const text = message(error); setError(text); onError(text) }
    finally { setBusy(false) }
  }
  function next() { if (!value(question.id).trim() || busy || step.closing) return; if (last) void submit('accept'); else step.exit(() => setIndex(index + 1)) }
  return <section className="approval-card questionnaire" aria-label="需要你的回答">
    <div className="approval-title"><MessageCircleQuestion size={18} /><span>{question.header || '需要你的选择'}</span><small className="question-position">{index + 1} / {approval.questions.length}</small></div>
    <fieldset key={question.id} ref={field} disabled={busy || step.closing} data-exiting={step.closing || undefined} onKeyDown={event => {
      if (event.nativeEvent.isComposing || busy) return
      const target = event.target as HTMLInputElement
      const editingText = target.tagName === 'INPUT' && target.type !== 'radio' && Boolean(target.value)
      if (event.shiftKey && event.key === 'ArrowLeft' && !editingText) { event.preventDefault(); event.stopPropagation(); previous(); return }
      if (target.type !== 'radio' && target.tagName === 'INPUT') { if (event.key === 'Enter') { event.preventDefault(); next() }; return }
      const option = question.options[Number(event.key) - 1]
      if (/^[1-9]$/.test(event.key) && option) { event.preventDefault(); setCustom(previous => ({ ...previous, [question.id]: false })); setAnswers(previous => ({ ...previous, [question.id]: option.label })) }
      else if (event.key === 'Enter' && target.tagName !== 'BUTTON') { event.preventDefault(); next() }
    }}>
      <legend>{question.question}</legend>
      <div className="answer-options">{question.options.map((option, optionIndex) => <label key={option.label} className={`answer-choice ${answers[question.id] === option.label && !custom[question.id] ? 'selected' : ''}`}><input type="radio" name={`${approval.id}:${question.id}`} aria-label={option.label} checked={answers[question.id] === option.label && !custom[question.id]} onChange={() => { setCustom(previous => ({ ...previous, [question.id]: false })); setAnswers(previous => ({ ...previous, [question.id]: option.label })) }} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span><kbd>{optionIndex + 1}</kbd></label>)}</div>
      {question.options.length > 0 && <button type="button" className="custom-answer-toggle" onClick={() => setCustom(previous => ({ ...previous, [question.id]: !previous[question.id] }))}>{custom[question.id] ? '返回选项' : '自定义回答'}</button>}
      {(custom[question.id] || !question.options.length) && <input autoFocus aria-label={question.question} type={question.isSecret ? 'password' : 'text'} placeholder="输入你的回答" value={customAnswers[question.id] || ''} onChange={event => { setCustom(previous => ({ ...previous, [question.id]: true })); setCustomAnswers(previous => ({ ...previous, [question.id]: event.target.value })) }} />}
    </fieldset>
    {error && <p role="alert" className="choice-error">{error}</p>}
    <div className="question-navigation"><button type="button" disabled={busy} onClick={previous}><ArrowLeft size={15} />{index > 0 ? '上一项' : '回到对话'}<kbd>Shift ←</kbd></button><button type="button" className="primary" disabled={busy || !value(question.id).trim()} onClick={next}>{busy ? '提交中…' : last ? '提交回答' : '下一项'}{!last && <ArrowRight size={15} />}</button></div>
  </section>
}
