import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { teamOutstanding } from '../shared/team.ts'
import { graphWithoutMember, memberRemovalOptions, removalChangesRequest } from '../shared/team-member-removal.ts'
import { useExitAction } from './Motion.tsx'
import type { TeamController } from './useTeam.ts'

export function TeamRemoveMemberDialog({ team, threadId, onClose }: { team: TeamController; threadId: string; onClose: () => void }) {
  const state = team.state!, [version] = useState(state.graphVersion), [replacement, setReplacement] = useState('')
  const dialog = useRef<HTMLDialogElement>(null), { closing, exit } = useExitAction(onClose, dialog)
  useEffect(() => { dialog.current?.showModal() }, [])
  const { member, children, replacements, reason } = memberRemovalOptions(state, threadId)
  const plan = graphWithoutMember(state, threadId, replacement || undefined)
  const supported = Boolean(state.capabilities?.memberRemoval)
  const busy = state.messages.some(row => row.state === 'sending' || row.reviews.some(review => review.state === 'sending')) || state.memberRequests.some(row => row.state === 'creating')
  const affected = plan.graph ? state.messages.filter(row => removalChangesRequest(state, plan.graph!, row, threadId)) : []
  const unknown = state.messages.some(row => (affected.includes(row) || row.from === threadId || row.to === threadId || row.reviews.some(review => review.reviewerId === threadId)) && (row.state === 'uncertain' || row.reviews.some(review => review.state === 'uncertain')))
    || state.memberRequests.some(row => row.state === 'uncertain' && (row.from === threadId || row.parentId === threadId))
  const blocked = !supported ? '此功能将在 cweb 服务空闲重启后启用。' : state.graphVersion !== version ? '关系图已更新，请关闭后重新打开移出操作。' : reason || (busy ? '正在投递或创建成员，请稍后移出。' : unknown ? '相关投递或成员创建的结果待核对，请先核对回执。' : '')
  const cancelled = state.messages.filter(row => teamOutstanding.has(row.state) && (row.from === threadId || row.to === threadId)).length
  const reapproval = affected.filter(row => row.from !== threadId && row.to !== threadId).length
  const rejected = state.memberRequests.filter(row => row.state === 'pending' && (row.from === threadId || row.parentId === threadId)).length
  async function remove() {
    if (blocked || plan.error !== undefined || team.saving) return
    if (await team.act('/team/members/remove', { threadId, graphVersion: version, ...(children.length ? { reassignTo: replacement } : {}) })) exit()
  }
  return <dialog ref={dialog} className="team-editor-dialog team-remove-dialog" data-exiting={closing || undefined} aria-label="移出团队" onCancel={event => { event.preventDefault(); if (!team.saving) exit() }}>
    <header><h2>移出团队</h2><button type="button" className="icon-button" aria-label="关闭移出团队" disabled={team.saving} onClick={() => exit()}><X size={16} /></button></header>
    <form onSubmit={event => { event.preventDefault(); void remove() }}>
      <p className="team-remove-name">{member?.name || '原团队成员'}</p>
      <p className="team-card-note">移出后，原会话、历史记录和正在执行的任务会保留；以后可从「加入会话」重新加入。</p>
      {children.length > 0 && <>
        <p className="team-card-note">该会话有 {children.length} 位直属下级。选择同层级的接替上级，保留下级的层级、分组和原有通信方向。</p>
        {replacements.length > 0 && <label>接替上级<select aria-label="移出后的接替上级" value={replacement} required disabled={team.saving} onChange={event => setReplacement(event.target.value)}><option value="">请选择</option>{replacements.map(row => <option key={row.threadId} value={row.threadId}>{row.name}</option>)}</select></label>}
      </>}
      {(cancelled > 0 || reapproval > 0 || rejected > 0) && <ul className="team-remove-impact" aria-label="移出影响">
        {cancelled > 0 && <li>取消该会话尚未投递的 {cancelled} 条通信，保留请求记录。</li>}
        {reapproval > 0 && <li>另外 {reapproval} 条受关系变化影响的通信将重新等待你审批。</li>}
        {rejected > 0 && <li>关闭该会话相关的 {rejected} 条待批准成员申请。</li>}
      </ul>}
      {blocked && <p className="team-card-note team-remove-blocked" role="status">{blocked}</p>}
      {team.error && <p className="team-error" role="alert">{team.error}</p>}
      <footer><button type="button" disabled={team.saving} onClick={() => exit()}>取消</button><button className="team-remove-confirm" disabled={team.saving || Boolean(blocked) || plan.error !== undefined}>{team.saving ? '正在移出…' : '确认移出团队'}</button></footer>
    </form>
  </dialog>
}
