import { useEffect, useRef, useState } from 'react'
import { GitBranch, LoaderCircle, X } from 'lucide-react'
import type { ThreadView } from '../shared/types.ts'
import { api, message, uncertainSubmission } from './api.ts'
import { useExitAction } from './Motion.tsx'
import './native-actions.css'

export interface NativeAction { kind: 'fork' | 'review'; threadId: string; beforeTurnId?: string }
export function NativeActions({ action, thread, onClose, onComplete }: { action: NativeAction; thread: ThreadView; onClose: () => void; onComplete: (thread: ThreadView, fork: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), exit = useExitAction(onClose, dialog)
  const [kind, setKind] = useState(action.kind), [boundary, setBoundary] = useState(action.beforeTurnId || '')
  const [target, setTarget] = useState('uncommittedChanges'), [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [unknown, setUnknown] = useState(false)
  useEffect(() => { dialog.current?.showModal() }, [])
  const prompts = [...new Map(thread.items.filter(item => item.type === 'userMessage' && item.turnId).map(item => [item.turnId, item])).values()]
  async function submit() {
    if (busy || unknown) return
    setBusy(true); setError('')
    try {
      const input = kind === 'fork' ? (boundary ? { beforeTurnId: boundary } : {}) : { target: { type: target, ...(target === 'baseBranch' ? { branch: detail.trim() } : target === 'commit' ? { sha: detail.trim() } : target === 'custom' ? { instructions: detail.trim() } : {}) } }
      const result = await api<ThreadView>('/threads/' + encodeURIComponent(thread.id) + '/' + kind, input)
      onComplete(result, kind === 'fork'); exit.exit()
    } catch (error) { setError(message(error)); setUnknown(uncertainSubmission(error)) } finally { setBusy(false) }
  }
  const blocked = busy || unknown || Boolean(thread.compacting) || (kind === 'review' || !boundary) && Boolean(thread.turnId) || kind === 'review' && target !== 'uncommittedChanges' && !detail.trim()
  return <dialog ref={dialog} className="settings-dialog native-action-dialog" data-exiting={exit.closing || undefined} onCancel={event => { event.preventDefault(); if (!busy) exit.exit() }}>
    <div className="dialog-header"><h2>会话操作</h2><button type="button" className="icon-button" aria-label="关闭会话操作" disabled={busy} onClick={() => exit.exit()}><X size={18} /></button></div>
    <form onSubmit={event => { event.preventDefault(); void submit() }}><div className="native-action-tabs" role="group" aria-label="操作类型"><button type="button" aria-pressed={kind === 'fork'} disabled={busy || unknown} onClick={() => setKind('fork')}>分支话题</button><button type="button" aria-pressed={kind === 'review'} disabled={busy || unknown} onClick={() => setKind('review')}>原生审查</button></div>
      <p className="muted">{thread.title}</p>
      {kind === 'fork' ? <><p>在同一工作区创建新话题，继承指定位置之前的历史，原话题保留。项目文件仍然共享，已有目标不会因创建分支而自动启动。</p><label className="field-label">分支位置<select aria-label="分支位置" value={boundary} disabled={busy} onChange={event => setBoundary(event.target.value)}><option value="">当前历史末尾</option>{prompts.map((item, index) => <option key={item.turnId} value={item.turnId}>第 {index + 1} 条提问之前 · {item.text.slice(0, 65)}</option>)}</select></label>{boundary && <p className="settings-footnote">分支不包含所选提问及其后的回复。</p>}</>
        : <><p>调用 Codex 原生代码审查，在当前话题展示检查过程和结果。</p><label className="field-label">审查范围<select aria-label="审查范围" value={target} disabled={busy} onChange={event => { setTarget(event.target.value); setDetail('') }}><option value="uncommittedChanges">所有未提交改动</option><option value="baseBranch">与基础分支比较</option><option value="commit">指定提交</option><option value="custom">自定义审查要求</option></select></label>{target !== 'uncommittedChanges' && <label className="field-label">{target === 'baseBranch' ? '基础分支' : target === 'commit' ? '提交 SHA' : '审查要求'}<textarea aria-label="审查目标详情" value={detail} disabled={busy} onChange={event => setDetail(event.target.value)} maxLength={8000} rows={target === 'custom' ? 4 : 1} /></label>}</>}
      {thread.turnId && (kind === 'review' || !boundary) && <p className="settings-callout">当前话题仍在运行。可以选择较早的位置分支；审查需等待本轮结束。</p>}
      {error && <p className="native-action-error" role="alert">{error}</p>}{unknown && <p className="settings-footnote">结果尚未确认，请关闭此窗口并检查会话列表或运行状态；本窗口不会重复提交。</p>}
      <div className="dialog-footer"><button type="button" disabled={busy} onClick={() => exit.exit()}>取消</button><button type="submit" className="primary" disabled={blocked}>{busy ? <LoaderCircle size={15} className="spin" /> : <GitBranch size={15} />}{kind === 'fork' ? '创建分支' : '开始审查'}</button></div>
    </form>
  </dialog>
}
