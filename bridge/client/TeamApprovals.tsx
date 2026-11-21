import { describeModel } from '../shared/activity.ts'
import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Check, LocateFixed, MessageSquare, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { teamOutstanding, teamPolicyLabels, teamStateLabels, teamTaskApprovalLimit, type TeamMessage } from '../shared/team.ts'
import type { TeamController } from './useTeam.ts'
import type { Preferences } from '../shared/types.ts'
import { Markdown } from './Markdown.tsx'
import { FileLinks } from './FileLinks.tsx'
import { FilePreviewProvider } from './FilePreview.tsx'
import './team.css'
import './team-approvals.css'

type PreviewPreferences = Pick<Preferences, 'filePreviewLayout' | 'inlineImageSize' | 'imagePreviewZoom'>

/** Review text is passive. Local paths use the receiving member's directory,
 * while preview actions remain bound to the team's workspace provider. */
const ApprovalMarkdown = memo(function ApprovalMarkdown({ text, cwd, threadId }: { text: string; cwd?: string; threadId?: string }) {
  const files = useContext(FileLinks)
  const scope = useMemo(() => ({ ...files, cwd: cwd || files.root, threadId }), [files, cwd, threadId])
  return <FileLinks.Provider value={scope}><div className="team-review-body team-review-markdown"><Markdown text={text} genui={false} collapseCode={false} /></div></FileLinks.Provider>
})

function Communication({ row, team, selected, onLocate, onChoose, bulk }: { row: TeamMessage; team: TeamController; selected: boolean; onLocate: () => void; onChoose: (id: string) => void; bulk?: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void } }) {
  const [edit, setEdit] = useState(false), [body, setBody] = useState(row.body), [note, setNote] = useState('')
  const automaticallyOpen = row.state === 'pending' || selected
  const [expanded, setExpanded] = useState(automaticallyOpen)
  const node = useRef<HTMLElement>(null)
  useEffect(() => { setBody(row.body); setEdit(false) }, [row.version, row.body])
  useEffect(() => { setExpanded(automaticallyOpen) }, [automaticallyOpen])
  useEffect(() => { if (selected) node.current?.scrollIntoView({ block: 'nearest' }) }, [selected])
  const act = (decision: 'approve' | 'reject' | 'cancel') => void team.act(`/team/messages/${row.id}/decision`, { version: row.version, decision, ...(edit && decision === 'approve' ? { body } : {}), ...(note ? { note } : {}) })
  const title = row.kind === 'result' ? '反馈' : row.kind === 'question' ? '问题' : '任务'
  return <article ref={node} className={`team-review-card ${selected ? 'selected' : ''}`} data-message-id={row.id}>
    <div className="team-review-top"><span className={`team-status ${row.state}`}>{teamStateLabels[row.state]}</span><small>{title}</small><button className="icon-button" aria-label={`在关系图定位 ${row.title}`} onClick={onLocate}><LocateFixed size={14} /></button></div>
    <h3>{bulk && !edit && <input type="checkbox" className="team-task-select" aria-label={`选择任务 ${row.title}`} checked={bulk.checked} disabled={bulk.disabled || team.saving} onChange={event => bulk.onChange(event.target.checked)} />}{row.title}</h3>
    <p className="team-review-source">{team.state?.members.find(m => m.threadId === row.from)?.name} → {team.state?.members.find(m => m.threadId === row.to)?.name}</p>
    {edit ? <textarea aria-label="调整待发送正文" rows={5} maxLength={8000} value={body} onChange={e => setBody(e.target.value)} /> : <details className="team-body-details" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>任务详情</summary>{expanded && <ApprovalMarkdown text={row.body} cwd={team.state?.members.find(member => member.threadId === row.to)?.cwd} threadId={row.to} />}</details>}
    {row.reason && <p className="team-card-note">{row.reason}</p>}
    {!!row.reviews.length && <ul className="team-review-gates">{row.reviews.map(r => <li key={r.id}><button onClick={() => onChoose(r.reviewerId)}><ShieldCheck size={12} />{team.state?.members.find(m => m.threadId === r.reviewerId)?.name}</button><span>{r.kind === 'risk' ? '风险判断' : '上级授权'} · {r.state === 'approved' ? '已通过' : r.state === 'rejected' ? '已拒绝' : r.state === 'needs-user' ? '需继续审核' : r.state === 'uncertain' ? '需核对' : '等待审核'}</span>{r.reason && <small>{r.reason}</small>}</li>)}</ul>}
    {row.state === 'pending' && <><input className="team-approval-note" aria-label="审批备注" placeholder="审批备注（可选）" maxLength={500} value={note} onChange={e => setNote(e.target.value)} /><div className="team-card-actions"><button className="team-primary" disabled={team.saving || !body.trim()} onClick={() => act('approve')}><Check size={14} />{edit ? '修改后允许' : '允许本次'}</button><button disabled={team.saving} onClick={() => { if (edit) setBody(row.body); else bulk?.onChange(false); setEdit(value => !value) }}>{edit ? '取消修改' : '修改正文'}</button><button disabled={team.saving} onClick={() => act('reject')}>拒绝</button></div></>}
    {['approved', 'waiting', 'reviewing'].includes(row.state) && <button className="team-cancel" disabled={team.saving} onClick={() => act('cancel')}>取消未投递请求</button>}
    {(row.state === 'uncertain' || row.state === 'reviewing' && row.reviews.some(r => r.state === 'uncertain')) && <button disabled={team.saving} onClick={() => void team.act(`/team/messages/${row.id}/reconcile`, {})}><RefreshCw size={13} />核对回执</button>}
    <details className="team-audit"><summary>处理记录 · {row.audit.length}</summary>{row.audit.map((a, i) => <p key={i}>{new Date(a.at).toLocaleTimeString()} · {a.action === 'proposed' ? '提出请求' : a.action === 'edited' ? '修改正文' : a.action === 'review' ? '审核意见' : teamStateLabels[a.action as TeamMessage['state']] || a.action}{a.action !== 'proposed' && a.note ? ` · ${a.note}` : ''}</p>)}</details>
  </article>
}
export function TeamApprovals({ team, focusId, onLocate, onChoose, defaults, previewPreferences }: { team: TeamController; focusId?: string; onLocate: (id: string) => void; onChoose: (id: string) => void; defaults: { model: string; effort: string }; previewPreferences?: PreviewPreferences }) {
  const [filter, setFilter] = useState<'pending' | 'all'>('pending'), [limit, setLimit] = useState(30)
  const [selection, setSelection] = useState<Record<string, number>>({})
  useEffect(() => { if (focusId) setFilter('all') }, [focusId])
  useEffect(() => { setSelection({}) }, [team.scope, filter])
  const state = team.state
  if (!state) return <p className="panel-hint">正在读取团队记录…</p>
  const messages = state.messages.filter(r => filter === 'all' || teamOutstanding.has(r.state)).toReversed(), requests = state.memberRequests.filter(r => filter === 'all' || ['pending', 'creating', 'uncertain'].includes(r.state)).toReversed()
  const visible = messages.slice(0, limit), focused = messages.find(r => r.id === focusId)
  if (focused && !visible.includes(focused)) visible.unshift(focused)
  const selectable = state.enabled && state.capabilities?.batchApproval ? visible.filter(row => row.state === 'pending' && row.kind === 'task') : []
  const selected = selectable.filter(row => selection[row.id] === row.version)
  function renderCommunication(row: TeamMessage) {
    const checked = selection[row.id] === row.version
    const bulk = selectable.length > 1 && selectable.includes(row) ? { checked, disabled: !checked && selected.length >= teamTaskApprovalLimit, onChange: (value: boolean) => setSelection(previous => {
      const next = { ...previous }
      if (value) next[row.id] = row.version
      else delete next[row.id]
      return next
    }) } : undefined
    return <Communication key={row.id} row={row} team={team} selected={row.id === focusId} onLocate={() => onLocate(row.id)} onChoose={onChoose} bulk={bulk} />
  }
  async function approveSelected() {
    const ok = await team.act('/team/tasks/approve', { tasks: selected.map(({ id, version }) => ({ id, version })) })
    if (ok) setSelection({})
    else void team.load()
  }
  return <FilePreviewProvider workspaceId={team.workspaceId || state.workspaceId} root={state.workspace} preferences={previewPreferences}><div className="team-approvals">
    <label className="team-policy">通信审批<select aria-label="通信审批方式" value={state.policy} disabled={team.saving} onChange={e => void team.act('/team/policy', { policy: e.target.value })}>{Object.entries(teamPolicyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <details className="team-policy-hint"><summary>仅对新通信生效 · 审批规则</summary><p>同层协作需双方直属上级批准；新增成员始终由你确认。排布和规则路由不调用模型；上级审核、AI 风险判断及任务执行消耗模型用量。风险审核由发件人的直属上级执行，最高负责人自行评估。</p></details>
    {!state.enabled && <p className="team-paused">团队已关闭，未投递请求保留。</p>}
    {team.error && <div className="team-error" role="alert">{team.error}<button aria-label="清除团队错误" onClick={() => team.setError('')}><X size={13} /></button></div>}
    <div className="team-filter"><button aria-pressed={filter === 'pending'} onClick={() => { setFilter('pending'); setLimit(30) }}>待处理 {team.outstanding}</button><button aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); setLimit(30) }}>全部记录</button><button className="icon-button" aria-label="刷新团队记录" onClick={() => void team.load()}><RefreshCw size={13} /></button></div>
    {selectable.length > 1 && <div className="team-bulk-approval"><span>{selected.length ? `已选 ${selected.length} 项 · ${new Set(selected.map(row => row.to)).size} 个会话` : '勾选可同时开工的任务'}</span><button type="button" className="team-primary" disabled={team.saving || selected.length < 2} onClick={() => void approveSelected()}><Check size={14} />批准所选任务</button></div>}
    {focused && renderCommunication(focused)}
    {requests.slice(0, limit).map(r => <article key={r.id} className="team-review-card member-request" data-member-request={r.id}><div className="team-review-top"><span className="team-status pending">{r.state === 'pending' ? '需你批准' : r.state === 'created' ? '已创建' : r.state === 'creating' ? '创建中' : r.state === 'rejected' ? '已拒绝' : '需核对'}</span><small>新增会话</small></div><h3>{r.name}</h3><p className="team-card-note">第 {r.level} 层 · {r.parentId ? state.members.find(m => m.threadId === r.parentId)?.name || '上级不存在' : '最高负责人'}</p><p className="team-model-summary">{r.useDefaults ? '采用设置默认：' : '指定模型：'}{describeModel((r.useDefaults ? defaults.model : r.model) || 'CLI 默认模型')} · {(r.useDefaults ? defaults.effort : r.effort) || '默认强度'}</p>{r.reason && <ApprovalMarkdown text={r.reason} />}{r.error && <p className="team-error">{r.error}</p>}{r.state === 'pending' && <div className="team-card-actions"><button className="team-primary" disabled={team.saving} onClick={() => void team.act(`/team/members/${r.id}/decision`, { version: r.version, decision: 'approve' })}><Check size={14} />批准创建</button><button disabled={team.saving} onClick={() => void team.act(`/team/members/${r.id}/decision`, { version: r.version, decision: 'reject' })}>拒绝</button></div>}{r.threadId && <button onClick={() => onChoose(r.threadId!)}><MessageSquare size={13} />打开会话</button>}</article>)}
    {visible.filter(row => row.id !== focused?.id).map(renderCommunication)}
    {Math.max(messages.length, requests.length) > limit && <button className="team-more" onClick={() => setLimit(v => v + 30)}>再显示 30 条记录</button>}
    {!messages.length && !requests.length && <div className="panel-empty"><ShieldCheck size={24} /><p>没有待处理申请</p><span>新通信会高亮关系图中的对应箭头。</span></div>}
  </div></FilePreviewProvider>
}
