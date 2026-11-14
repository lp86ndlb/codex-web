import { useId, useState } from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import type { Approval } from '../shared/types.ts'
import { validateElicitation } from '../shared/elicitation.ts'
import { api, message } from './api.ts'
import './elicitation.css'

export function ElicitationCard({ approval, onError }: { approval: Approval; onError: (error: string) => void }) {
  const request = approval.elicitation!, prefix = useId()
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(request.fields.filter(field => field.initial !== undefined && field.initial !== null).map(field => [field.id, field.initial])))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  function change(id: string, value: unknown) { setValues(before => ({ ...before, [id]: value })); setError('') }
  async function answer(decision: 'accept' | 'decline' | 'cancel') {
    if (busy) return
    try {
      const content = decision === 'accept' ? validateElicitation(request, values) : undefined
      setBusy(true); setError('')
      await api('/answer', { id: approval.id, decision, ...(content ? { content } : {}) })
    } catch (error) { setError(message(error)); onError(message(error)) } finally { setBusy(false) }
  }
  return <form className="elicitation-card" aria-label="MCP 交互请求" onSubmit={event => { event.preventDefault(); void answer('accept') }}>
    <header className="elicitation-heading"><div className="elicitation-source">工具服务 · {request.server || 'MCP'}</div><p className="elicitation-message">{request.message}</p></header>
    {request.error && <p role="alert">{request.error}</p>}
    {request.mode === 'url' && <a className="elicitation-link" href={request.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />打开确认页面<span>{new URL(request.url!).host}</span></a>}
    {request.fields.map(field => <div key={field.id} className="elicitation-field"><label htmlFor={prefix + field.id}>{field.title}{field.required && <span aria-label="必填"> *</span>}</label>{field.description && <small>{field.description}</small>}
      {field.type === 'array' ? <fieldset aria-label={field.title}>{field.options?.map(option => <label key={option.value}><input type="checkbox" checked={Array.isArray(values[field.id]) && (values[field.id] as string[]).includes(option.value)} disabled={busy} onChange={event => { const before = Array.isArray(values[field.id]) ? values[field.id] as string[] : []; change(field.id, event.target.checked ? [...before, option.value] : before.filter(value => value !== option.value)) }} />{option.title}</label>)}</fieldset>
      : field.options || field.type === 'boolean' ? <select id={prefix + field.id} value={values[field.id] === undefined ? '' : String(values[field.id])} disabled={busy} onChange={event => change(field.id, event.target.value === '' ? undefined : field.type === 'boolean' ? event.target.value === 'true' : event.target.value)}><option value="">请选择</option>{field.type === 'boolean' ? <><option value="true">是</option><option value="false">否</option></> : field.options?.map(option => <option key={option.value} value={option.value}>{option.title}</option>)}</select>
      : <input id={prefix + field.id} type={['number', 'integer'].includes(field.type) ? 'number' : field.format === 'email' ? 'email' : field.format === 'date' ? 'date' : 'text'} step={field.type === 'integer' ? 1 : 'any'} min={field.minimum} max={field.maximum} maxLength={field.maxLength ?? 20000} value={values[field.id] === undefined ? '' : String(values[field.id])} disabled={busy} onChange={event => change(field.id, field.type === 'string' ? event.target.value : event.target.value === '' ? undefined : Number(event.target.value))} />}
    </div>)}
    {error && <p className="elicitation-error" role="alert">{error}</p>}
    <div className="approval-actions"><button type="button" disabled={busy} onClick={() => void answer('cancel')}>取消</button><button type="button" disabled={busy} onClick={() => void answer('decline')}>拒绝</button><button className="primary" type="submit" disabled={busy || request.mode === 'unsupported'}>{busy ? <LoaderCircle className="spin" size={15} /> : request.mode === 'url' ? '我已完成确认' : '提交回答'}</button></div>
  </form>
}
