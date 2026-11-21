import { describeModel } from '../shared/activity.ts'
import { useEffect, useRef, useState } from 'react'
import { Check, MessageSquare, RefreshCw, Search, X } from 'lucide-react'
import { api, message } from './api.ts'
import { useExitAction } from './Motion.tsx'
import { teamPath, type TeamController } from './useTeam.ts'
import { useTeamMemberSelection } from './useTeamMemberSelection.ts'

interface TeamCandidate { threadId: string; title: string; model: string; effort: string; busy: boolean }
export function TeamImportDialog({ team, initialParent, onClose }: { team: TeamController; initialParent?: string; onClose: () => void }) {
  const state = team.state!
  const [candidates, setCandidates] = useState<TeamCandidate[]>([]), [loading, setLoading] = useState(true), [failure, setFailure] = useState(''), [retry, setRetry] = useState(0)
  const [search, setSearch] = useState(''), [selected, setSelected] = useState('')
  const { level, setLevel, parentId, setParent, groupId, setGroup, rememberSuccess, discard } = useTeamMemberSelection(state, team.workspaceId, initialParent)
  const dialog = useRef<HTMLDialogElement>(null), { closing, exit } = useExitAction(onClose, dialog)
  const cancel = () => { discard(); exit() }
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setFailure('')
    void api<TeamCandidate[]>(teamPath('/team/candidates', team.workspaceId), undefined, { signal: controller.signal }).then(rows => {
      if (!controller.signal.aborted) setCandidates(rows)
    }).catch(error => { if (!controller.signal.aborted) setFailure(message(error)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [team.workspaceId, retry])
  const available = candidates.filter(candidate => !state.members.some(member => member.threadId === candidate.threadId))
  const filtered = available.filter(candidate => `${candidate.title} ${candidate.model}`.toLowerCase().includes(search.trim().toLowerCase()))
  const candidate = available.find(candidate => candidate.threadId === selected)
  const parents = state.members.filter(m => m.level === level - 1), groups = state.groups.filter(g => g.level === level && g.parentId === parentId)
  return <dialog ref={dialog} className="team-editor-dialog team-import-dialog" data-exiting={closing || undefined} aria-label="加入已有会话" onCancel={e => { e.preventDefault(); cancel() }}>
    <header><h2>加入已有会话</h2><button className="icon-button" aria-label="关闭加入会话" onClick={cancel}><X size={16} /></button></header>
    <form onSubmit={e => { e.preventDefault(); if (!candidate) return; void team.act('/team/members/import', { threadId: candidate.threadId, level, parentId: level === 1 ? null : parentId, groupId: level === 1 ? null : groupId || null }).then(ok => { if (ok) { rememberSuccess(); exit() } }) }}>
      <p className="team-card-note">选择本工作区中的会话，保留原有历史、模型与独立对话。加入和调整关系不会调用模型。</p>
      <label className="team-candidate-search"><Search size={15} /><input aria-label="搜索可加入的会话" placeholder="搜索会话" autoFocus value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="team-candidate-list" role="group" aria-label="可加入的会话" aria-busy={loading}>
        {loading ? <p className="team-card-note" role="status">正在读取会话…</p> : failure ? <p className="team-error" role="alert">{failure}<button type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />重试</button></p> : filtered.length ? filtered.map(row => <button key={row.threadId} type="button" className="team-candidate" aria-pressed={selected === row.threadId} onClick={() => setSelected(row.threadId)}>
          <MessageSquare size={17} /><span><strong>{row.title || '未命名会话'}</strong><small>{describeModel(row.model || 'CLI 默认模型')}{row.effort ? ` · ${row.effort}` : ''}{row.busy ? ' · 正在运行' : ''}</small></span>{selected === row.threadId && <Check size={16} />}
        </button>) : <p className="team-card-note">{search ? '没有匹配的会话' : '本工作区暂无可加入的会话。可以先正常新建对话，或申请新增团队会话。'}</p>}
      </div>
      <div className="team-form-row"><label>层级<select aria-label="加入会话层级" value={level} onChange={e => setLevel(Number(e.target.value))}>{state.levels.map((label, i) => <option key={i} value={i + 1} disabled={i === 0 && state.members.length > 0 || i > 0 && !state.members.some(m => m.level === i)}>{i + 1} · {label}</option>)}</select></label>{level > 1 && <label>直属上级<select aria-label="加入会话直属上级" required value={parentId} onChange={e => setParent(e.target.value)}><option value="">选择上级</option>{parents.map(m => <option key={m.threadId} value={m.threadId}>{m.name}</option>)}</select></label>}</div>
      {level > 1 && <label>所属分组<select aria-label="加入会话分组" value={groupId} onChange={e => setGroup(e.target.value)}><option value="">上级的默认分组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
      {candidate && <p className="team-model-summary">{candidate.title} → 第 {level} 层{level > 1 && parentId ? ` · 上级：${parents.find(m => m.threadId === parentId)?.name || ''}` : ' · 最高负责人'}{candidate.busy ? '。正在进行的对话继续运行。' : ''}</p>}
      {team.error && <p className="team-error" role="alert">{team.error}</p>}
      <footer><button type="button" onClick={cancel}>取消</button><button className="team-primary" disabled={team.saving || loading || !candidate || level > 1 && !parentId}>确认加入团队</button></footer>
    </form>
  </dialog>
}
