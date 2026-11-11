import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Check, LoaderCircle, Pause, Pencil, Play, Target, X } from 'lucide-react'
import type { ThreadGoal } from '../shared/types.ts'
import { api, message } from './api.ts'
import { Checkbox } from './dsh/Checkbox.tsx'
import { formatDuration } from './MessageMeta.tsx'
import { useExitAction } from './Motion.tsx'

export interface GoalPanelHandle { open: (objective?: string) => void }
const labels: Record<ThreadGoal['status'], string> = { active: '进行中', paused: '已暂停', blocked: '等待处理', usageLimited: '额度受限', budgetLimited: '预算已达上限', complete: '目标已完成' }

export const GoalPanel = forwardRef<GoalPanelHandle, { threadId: string | null; update?: { threadId: string; goal: ThreadGoal | null }; running: boolean; latestTaskAt?: number; ensureThread: () => Promise<string>; onStart: (id: string, objective: string) => Promise<void> }>(function GoalPanel({ threadId, update, running, latestTaskAt, ensureThread, onStart }, ref) {
  const [goal, setGoal] = useState<ThreadGoal | null>(null); const [error, setError] = useState(''); const [open, setOpen] = useState(false)
  const [objective, setObjective] = useState(''); const [budget, setBudget] = useState(''); const [start, setStart] = useState(true); const [saving, setSaving] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null); const selected = useRef(threadId); selected.current = threadId; const request = useRef(0)
  const { closing, exit } = useExitAction(() => setOpen(false), dialog)
  const load = useCallback(async () => {
    if (!threadId) { setGoal(null); return null }
    const ticket = ++request.current
    try { const result = await api<{ goal: ThreadGoal | null }>(`/threads/${encodeURIComponent(threadId)}/goal`); if (selected.current === threadId && ticket === request.current) { setGoal(result.goal); setError('') }; return result.goal }
    catch (error) { if (selected.current === threadId && ticket === request.current) setError(message(error)) }
  }, [threadId])
  useEffect(() => { setGoal(null); if (!saving && open) exit(); setError(''); void load() }, [threadId])
  useEffect(() => { if (update?.threadId === threadId) { request.current++; setGoal(update.goal) } }, [update, threadId])
  useEffect(() => {
    if (!threadId || !goal || goal.status !== 'active') return
    const timer = setInterval(() => { if (!document.hidden) void load() }, 30_000)
    return () => clearInterval(timer)
  }, [threadId, goal?.status, load])
  async function edit(text?: string) {
    const id = threadId; const value = id ? await load() : null
    if (selected.current !== id) return
    const current = value === undefined ? goal : value
    setObjective(text ?? current?.objective ?? ''); setBudget(current?.tokenBudget?.toString() || ''); setStart(!current && !running); if (value !== undefined) setError(''); setOpen(true)
  }
  useImperativeHandle(ref, () => ({ open: edit }))
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
  async function save() {
    if (!objective.trim() || saving) return
    const tokenBudget = budget.trim() ? Number(budget) : null
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) { setError('Token 预算应为正整数，或留空。'); return }
    setSaving(true); setError('')
    try {
      const id = threadId || await ensureThread()
      request.current++
      const result = await api<{ goal: ThreadGoal }>(`/threads/${encodeURIComponent(id)}/goal`, { objective: objective.trim(), tokenBudget, status: goal?.status === 'paused' && !start ? 'paused' : 'active' })
      if (selected.current === id || !threadId) { request.current++; setGoal(result.goal) }
      if (start) await onStart(id, objective.trim())
      exit()
    } catch (error) { setError(message(error)) }
    finally { setSaving(false) }
  }
  async function change(patch: object) {
    if (!threadId || saving) return
    const id = threadId; setSaving(true); setError('')
    request.current++
    try {
      const result = await api<{ goal: ThreadGoal | null }>(`/threads/${encodeURIComponent(id)}/goal`, patch)
      if (selected.current === id) {
        request.current++; setGoal(result.goal); if ('clear' in patch) exit()
        if ('status' in patch && patch.status === 'active' && result.goal && !running) await onStart(id, `继续推进当前目标：${result.goal.objective}\n先核对已有成果和待办反馈，避免重复已经完成的步骤。`)
      }
    }
    catch (error) { if (selected.current === id) setError(message(error)) }
    finally { setSaving(false) }
  }
  const showGoal = goal && !(goal.status === 'complete' && latestTaskAt && latestTaskAt > goal.updatedAt * 1000)
  return <>{showGoal && <div className={`goal-bar goal-${goal.status}`}><Target size={16} /><button type="button" className="goal-title" onClick={() => edit()} title={goal.objective}><strong>{goal.objective}</strong><span>{labels[goal.status]}{goal.timeUsedSeconds > 0 && ` · ${formatDuration(goal.timeUsedSeconds * 1000)}`}{goal.tokensUsed > 0 && ` · ${goal.tokensUsed.toLocaleString()} tokens`}</span></button><button type="button" className="icon-button" aria-label="编辑目标" onClick={() => edit()}><Pencil size={14} /></button>{goal.status !== 'complete' && <button type="button" className="icon-button" aria-label={goal.status === 'active' ? '暂停目标' : '恢复目标'} title={goal.status === 'active' ? '暂停后续推进，当前轮次继续完成' : '恢复目标'} disabled={saving} onClick={() => void change({ status: goal.status === 'active' ? 'paused' : 'active' })}>{saving ? <LoaderCircle size={15} className="spin" /> : goal.status === 'active' ? <Pause size={15} /> : <Play size={15} />}</button>}</div>}
    {error && !open && goal && <p className="goal-error" role="alert">{error}</p>}
    <dialog ref={dialog} className="goal-dialog" data-exiting={closing || undefined} aria-label="会话目标" onCancel={event => { event.preventDefault(); if (!saving) exit() }} onKeyDown={event => event.stopPropagation()}><form onSubmit={event => { event.preventDefault(); void save() }}><div className="goal-dialog-heading"><Target size={20} /><div><h3>{goal ? '管理会话目标' : '设定一个明确的终点'}</h3><p>与终端共享的 Codex 目标</p></div><button type="button" className="icon-button" aria-label="关闭目标设置" disabled={saving} onClick={() => exit()}><X size={18} /></button></div><label className="goal-field">目标与验收条件<textarea autoFocus aria-label="目标与验收条件" value={objective} maxLength={4000} rows={5} placeholder="希望达成什么结果？有哪些约束？怎样验证完成？" onChange={event => setObjective(event.target.value)} /></label><label className="goal-field">Token 预算（可选）<input type="number" aria-label="目标 Token 预算" min={1} step={1} value={budget} placeholder="留空表示不单独设置预算" onChange={event => setBudget(event.target.value)} /></label><p className="goal-hint">目标不会扩大文件权限。{goal ? '修改目标文本会重置目标用量统计；暂停只停止后续推进。' : '写清可验证的完成条件，便于在合适的地方结束任务。'}</p>{goal?.status === 'complete' && <p className="goal-hint"><Check size={14} />这个目标已经完成；保存将开始新的目标。</p>}<Checkbox checked={start} label={running ? '保存后排入下一轮执行' : '保存后开始执行'} onChange={setStart} disabled={saving} />{error && <p className="goal-error" role="alert">{error}</p>}<div className="goal-dialog-actions">{goal && <button type="button" className="goal-clear" disabled={saving} onClick={() => void change({ clear: true })}>清除目标</button>}<button type="button" disabled={saving} onClick={() => exit()}>取消</button><button className="primary" disabled={saving || !objective.trim()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Target size={15} />}保存目标</button></div></form></dialog>
  </>
})
