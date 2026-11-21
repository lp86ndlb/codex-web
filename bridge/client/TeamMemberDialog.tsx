import { describeModel } from '../shared/activity.ts'
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ModelOption, SessionOptions } from '../shared/types.ts'
import type { TeamController } from './useTeam.ts'
import { useExitAction } from './Motion.tsx'
import { useTeamMemberSelection } from './useTeamMemberSelection.ts'
export function TeamMemberDialog({ team, models, defaults, initialParent, onClose, onRequested }: { team: TeamController; models: ModelOption[]; defaults: SessionOptions; initialParent?: string; onClose: () => void; onRequested: () => void }) {
  const state = team.state!
  const [name, setName] = useState(''), [reason, setReason] = useState('')
  const { level, setLevel, parentId, setParent, groupId, setGroup, rememberSuccess, discard } = useTeamMemberSelection(state, team.workspaceId, initialParent)
  const [useDefaults, setDefaults] = useState(true), [model, setModel] = useState(defaults.model), [effort, setEffort] = useState(defaults.effort)
  const dialog = useRef<HTMLDialogElement>(null), key = useRef(crypto.randomUUID()), { closing, exit } = useExitAction(onClose, dialog)
  const cancel = () => { discard(); exit() }
  useEffect(() => { dialog.current?.showModal() }, [])
  const candidates = state.members.filter(m => m.level === level - 1), groups = state.groups.filter(g => g.level === level && g.parentId === parentId)
  const efforts = models.find(m => m.id === model)?.efforts || ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  return <dialog ref={dialog} className="team-editor-dialog" data-exiting={closing || undefined} aria-label="申请新增团队会话" onCancel={e => { e.preventDefault(); cancel() }}><header><h2>新增团队会话</h2><button className="icon-button" aria-label="关闭新增会话" onClick={cancel}><X size={16} /></button></header><form onSubmit={e => { e.preventDefault(); void team.act('/team/members', { name, reason, level, parentId: level === 1 ? null : parentId, groupId: level === 1 ? null : groupId || null, useDefaults, model: useDefaults ? '' : model, effort: useDefaults ? '' : effort, requestKey: key.current }).then(ok => { if (ok) { rememberSuccess(); exit(() => { onClose(); onRequested() }) } }) }}>
    <label>会话名称<input aria-label="团队会话名称" required maxLength={100} value={name} onChange={e => setName(e.target.value)} autoFocus /></label>
    <div className="team-form-row"><label>层级<select aria-label="新成员层级" value={level} onChange={e => setLevel(Number(e.target.value))}>{state.levels.map((label, i) => <option key={i} value={i + 1} disabled={i === 0 && state.members.length > 0 || i > 0 && !state.members.some(m => m.level === i)}>{i + 1} · {label}</option>)}</select></label>{level > 1 && <label>直属上级<select aria-label="新成员直属上级" value={parentId} required onChange={e => setParent(e.target.value)}><option value="">选择上级</option>{candidates.map(m => <option key={m.threadId} value={m.threadId}>{m.name}</option>)}</select></label>}</div>
    {level > 1 && <label>所属分组<select aria-label="新成员分组" value={groupId} onChange={e => setGroup(e.target.value)}><option value="">上级的默认分组</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>}
    <label className="team-default-check"><input type="checkbox" checked={useDefaults} onChange={e => setDefaults(e.target.checked)} />采用设置中的默认模型与强度</label>
    {useDefaults ? <p className="team-card-note">{describeModel(defaults.model) || 'CLI 默认模型'} · {defaults.effort || '默认强度'}，以批准时的设置为准。</p> : <div className="team-form-row"><label>模型<select aria-label="新成员模型" value={model} onChange={e => { setModel(e.target.value); setEffort('') }}><option value="">CLI 默认模型</option>{models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label><label>推理强度<select aria-label="新成员推理强度" value={effort} onChange={e => setEffort(e.target.value)}><option value="">默认</option>{efforts.map(e => <option key={e} value={e}>{e === 'max' ? 'MAX' : e[0].toUpperCase() + e.slice(1)}</option>)}</select></label></div>}
    <label>职责说明<textarea aria-label="新成员职责" rows={3} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} placeholder="简要说明负责的工作与边界" /></label>
    {team.error && <p role="alert" className="team-error">{team.error}</p>}<p className="team-card-note">提交后进入右侧审批。点击「批准创建」后才建立原生会话，自动审批模式也不会跳过这一步。</p><footer><button type="button" onClick={cancel}>取消</button><button className="team-primary" disabled={team.saving || !name.trim() || level > 1 && !parentId}>提交成员申请</button></footer>
  </form></dialog>
}
