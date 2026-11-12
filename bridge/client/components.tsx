import { memo, useEffect, useRef, useState, type DetailsHTMLAttributes, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp, ChevronRight, Copy, FileCode2, LoaderCircle, Pencil, RefreshCw, ShieldCheck, SquareTerminal, X } from 'lucide-react'
import type { Approval, Item } from '../shared/types.ts'
import { api, message } from './api.ts'
import { BrandMark } from './BrandMark.tsx'
import { GenuiFence, GenuiMessage } from './GenuiHost.tsx'
import { Markdown } from './Markdown.tsx'
import { TextChoiceSummary } from './ChoiceHost.tsx'
import { StateDot } from './dsh/StateDot.tsx'
import { DisclosureRow } from './dsh/DisclosureRow.tsx'
import { describeCommand, describeItemType, describeTool } from '../shared/activity.ts'
import { MessageTime } from './MessageMeta.tsx'
import { Questionnaire } from './Questionnaire.tsx'
import { useExitAnimation, useExitList } from './Motion.tsx'
import { useDisclosureContent } from './useDisclosureContent.ts'

export function IconButton({ label, children, onClick, disabled = false, className = '' }: {
  label: string; children: ReactNode; onClick: () => void; disabled?: boolean; className?: string
}) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>
}

export function Notice({ text, onClose }: { text: string; onClose?: () => void }) {
  return <div className="notice" role="alert"><span>{text}</span>{onClose && <IconButton label="关闭提示" onClick={onClose}><X size={15} /></IconButton>}</div>
}

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  return <IconButton label={state === 'copied' ? '已复制' : state === 'error' ? '复制失败，请手动选择' : '复制内容'} onClick={() => {
    navigator.clipboard.writeText(text).then(() => setState('copied')).catch(() => setState('error'))
  }}>{state === 'copied' ? <Check size={14} /> : <Copy size={14} />}</IconButton>
}

export function Diff({ text }: { text: string }) {
  return <pre className="diff-code">{text.split('\n').map((line, i) => <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : line.startsWith('@@') ? 'hunk' : ''}>{line || ' '}{'\n'}</span>)}</pre>
}

export function activityTitle(item: Item) { return item.activity || (item.type === 'commandExecution' ? describeCommand(item.command || '') : item.type === 'fileChange' ? `更新 ${item.changes?.length || 0} 个文件` : item.tool ? describeTool(item.tool) : item.type === 'plan' ? '更新执行计划' : describeItemType(item.type)) }
const ActivityGroupBody = memo(function ActivityGroupBody({ items }: { items: Item[] }) {
  return <div className="activity-group-body">{items.map(item => <TranscriptItem key={item.id} item={item} />)}</div>
})
export const ActivityGroup = memo(function ActivityGroup({ items, expanded = false, onToggle }: { items: Item[]; expanded?: boolean; onToggle: () => void }) {
  const running = items.some(item => item.status === 'inProgress'); const failed = items.some(item => item.status === 'failed')
  return <section className="activity-group" data-turn-id={items[0]?.turnId} data-activity-id={items[0]?.id}><DisclosureRow icon={<StateDot state={running ? 'ongoing' : failed ? 'error' : 'done'} />} title={running ? '正在处理' : `处理步骤 · ${items.length}`} open={expanded} expandable lazy onToggle={onToggle} running={running} expandOnRowClick collapsedContent={<span className="activity-preview">{activityTitle(items.at(-1)!)}</span>}><ActivityGroupBody items={items} /></DisclosureRow></section>
})

/** Keep native details semantics while deferring raw output, diffs and Markdown. */
function ToolDetails({ expanded = false, onExpandedToggle, summary, children, ...props }: Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'open' | 'onToggle'> & { expanded?: boolean; onExpandedToggle?: () => void; summary: ReactNode }) {
  const element = useRef<HTMLDetailsElement>(null)
  const [localOpen, setLocalOpen] = useState(expanded)
  const [previousExpanded, setPreviousExpanded] = useState(expanded)
  if (previousExpanded !== expanded) { setPreviousExpanded(expanded); setLocalOpen(expanded) }
  const open = onExpandedToggle ? expanded : localOpen
  const mounted = useDisclosureContent(open, element, '::details-content')
  const retainedChildren = useRef(children)
  if (open) retainedChildren.current = children
  const toggle = () => onExpandedToggle ? onExpandedToggle() : setLocalOpen(value => !value)
  return <details {...props} ref={element} open={open} onToggle={event => {
    // Also honor native/assistive toggles and explicit DOM open changes. React
    // controlled updates emit the same event and already match our state.
    if (event.currentTarget.open !== open) {
      if (onExpandedToggle) onExpandedToggle()
      else setLocalOpen(event.currentTarget.open)
    }
  }}><summary onClick={event => { event.preventDefault(); toggle() }}>{summary}</summary>{mounted ? retainedChildren.current : null}</details>
}

export const TranscriptItem = memo(function TranscriptItem({ item, expanded = false, onExpandedToggle, onEdit, editDisabled = false, autoRecovery = false }: { item: Item; expanded?: boolean; onExpandedToggle?: () => void; onEdit?: (item: Item) => void; editDisabled?: boolean; autoRecovery?: boolean }) {
  if (item.type === 'userMessage') return <article className="user-message" data-message-id={item.id}><div className="user-bubble"><Markdown text={item.text} genui={false} />{Boolean(item.attachments?.length) && <div className="message-attachments">{item.attachments!.map(file => <a className="message-attachment" href={file.url} key={file.id} target="_blank" rel="noopener noreferrer">{file.kind === 'image' && <img src={file.url} alt={file.name} loading="lazy" />}<span><FileCode2 size={14} />{file.name}</span></a>)}</div>}{Boolean(item.skills?.length) && <div className="message-skills">{item.skills!.map(skill => <span key={skill.path} title={skill.path}>${skill.name}</span>)}</div>}</div><div className="user-message-footer">{autoRecovery && <span className="message-recovery-tag" title="本条消息由网页自动重试发送；原始消息与执行记录均保留"><RefreshCw size={11} />自动重试</span>}<MessageTime item={item} /><div className="message-actions"><CopyButton text={item.text} />{onEdit && <IconButton label="编辑并从此处继续" disabled={editDisabled} onClick={() => onEdit(item)}><Pencil size={14} /></IconButton>}</div></div></article>
  if (item.type === 'agentMessage') return <GenuiMessage.Provider value={{ id: item.id, streaming: item.status === 'inProgress' }}><article data-message-id={item.id} className={item.phase === 'commentary' ? 'agent-message agent-commentary' : 'agent-message'}>{item.phase !== 'commentary' ? <div className="message-label"><BrandMark size={23} /> Codex<MessageTime item={item} /></div> : <MessageTime item={item} />}<Markdown text={item.text} streaming={item.status === 'inProgress'} collapseCode={item.phase === 'commentary'} /><TextChoiceSummary item={item} slot={item.id} streaming={item.status === 'inProgress'} />{item.text && item.phase !== 'commentary' && <div className="message-actions"><CopyButton text={item.text} /></div>}</article></GenuiMessage.Provider>
  if (item.type === 'commandExecution') return <ToolDetails className="tool-card" expanded={expanded} summary={<><SquareTerminal size={16} /><span className="tool-description">{activityTitle(item)}</span><span className={`tool-status ${item.status === 'failed' ? 'failed' : ''}`}>{item.status === 'inProgress' ? <StateDot state="ongoing" /> : item.exitCode === 0 ? <Check size={14} /> : item.exitCode !== null && item.exitCode !== undefined ? `退出 ${item.exitCode}` : item.status === 'declined' ? '已拒绝' : '结束'}</span><ChevronRight className="disclosure" size={14} /></>}>
    <div className="tool-output">{item.command && <div className="full-command">$ {item.command}</div>}<pre>{item.output || (item.status === 'inProgress' ? '正在执行，暂时没有输出' : '命令已结束，没有文本输出')}</pre><CopyButton text={(item.command || '') + '\n' + (item.output || '')} /></div>
  </ToolDetails>
  if (item.type === 'fileChange') return <ToolDetails className="tool-card" expanded={expanded} summary={<><FileCode2 size={16} /><span>修改 {item.changes?.length || 0} 个文件</span><span className="tool-status">{item.status === 'declined' ? '已拒绝' : item.status === 'failed' ? '失败' : item.status === 'inProgress' ? '进行中' : '已完成'}</span><ChevronRight className="disclosure" size={14} /></>}><div>{item.changes?.map((change, index) => <section className="file-change" key={index}><div className="file-caption">{change.path}</div><Diff text={change.diff} /></section>)}</div></ToolDetails>
  if (item.type === 'dynamicToolCall' && item.tool === 'render_ui' && item.ui) return <GenuiFence raw={JSON.stringify(item.ui)} slot={item.id} />
  if (['dynamicToolCall', 'mcpToolCall'].includes(item.type)) return <ToolDetails className="tool-card reasoning" expanded={expanded} summary={<><ChevronRight className="disclosure" size={14} /><span>{activityTitle(item)}</span><span className="tool-status">{item.status === 'inProgress' ? <LoaderCircle size={14} className="spin" /> : item.status === 'failed' ? '失败' : <Check size={14} />}</span></>}><pre>{item.text || (item.status === 'inProgress' ? '工具正在处理…' : '操作已结束')}</pre></ToolDetails>
  if (!item.text.trim()) return null
  return <ToolDetails className="tool-card reasoning" expanded={expanded} onExpandedToggle={onExpandedToggle} data-activity-id={item.id} data-turn-id={item.turnId} summary={<><ChevronRight className="disclosure" size={14} /><span>{describeItemType(item.type)}</span></>}><Markdown text={item.text} genui={false} /></ToolDetails>
})

export function ApprovalCard({ approval, onError, onBack }: { approval: Approval; onError: (error: string) => void; onBack?: () => void }) {
  const [busy, setBusy] = useState(false)
  async function respond(decision: 'accept' | 'decline') {
    if (busy) return
    setBusy(true)
    try { await api('/answer', { id: approval.id, decision }) }
    catch (error) { onError(message(error)) }
    finally { setBusy(false) }
  }
  if (approval.questions.length) return <Questionnaire approval={approval} onError={onError} onBack={onBack} />
  return <section className="approval-card" aria-label="等待审批">
    <div className="approval-title"><ShieldCheck size={18} /><span>这一步需要你的确认</span><span className="badge amber">等待你</span></div>
    {approval.reason && <p>{approval.reason}</p>}{approval.command && <pre className="approval-command">{approval.command}</pre>}
    {approval.cwd && <div className="muted small">目录 · {approval.cwd}</div>}{approval.detail && <pre className="approval-detail">{approval.detail}</pre>}
    <div className="approval-actions"><button disabled={busy} onClick={() => void respond('decline')}>拒绝</button><button className="primary" disabled={busy} onClick={() => void respond('accept')}>{busy ? '提交中…' : '允许这一次'}</button></div>
  </section>
}

export function QuestionPanel({ approval, onError, exiting = false }: { approval: Approval; onError: (error: string) => void; exiting?: boolean }) {
  const card = useRef<HTMLElement>(null); useExitAnimation(card, exiting)
  const [expanded, setExpanded] = useState(true)
  function collapse() { setExpanded(false); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()) }
  return <section ref={card} className="question-panel" data-exiting={exiting || undefined} aria-hidden={exiting || undefined} {...(exiting ? { inert: '' } : {})} role="region" aria-label="Codex 需要你的选择">
    <header className="question-panel-heading"><ShieldCheck size={16} /><strong>等待你的回答</strong><small>{approval.questions.length} 个问题</small><IconButton label={expanded ? '收起问题' : '展开问题'} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</IconButton></header>
    <div className="question-panel-body" data-open={expanded || undefined} {...(!expanded ? { inert: '' } : {})}><div><div className="question-panel-scroll"><ApprovalCard approval={approval} onError={onError} onBack={collapse} /></div></div></div>
  </section>
}

export function ApprovalStack({ approvals, onError }: { approvals: Approval[]; onError: (error: string) => void }) {
  const displayed = useExitList(approvals, 'id')
  const firstQuestion = approvals.find(approval => approval.questions.length)?.id
  return <div className="approval-stack">{displayed.map(({ item: approval, exiting }) => approval.questions.length ? (approval.id === firstQuestion || exiting) && <QuestionPanel key={approval.id} approval={approval} exiting={exiting} onError={onError} /> : <div key={approval.id} data-exiting={exiting || undefined}><ApprovalCard approval={approval} onError={onError} /></div>)}</div>
}
