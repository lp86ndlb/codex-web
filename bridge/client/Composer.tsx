import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ArrowUp, Code2, Command, File, GitBranch, ListPlus, LoaderCircle, Paperclip, ShieldCheck, Sparkles, Square, Target, X, Check } from 'lucide-react'
import type { AttachmentInfo, ModelOption, Preferences, QueuedMessage, SessionOptions, SkillInfo, ThreadView } from '../shared/types.ts'
import { IconButton } from './components.tsx'
import { commands } from './commands.ts'
import { describeEffort } from '../shared/activity.ts'
import { Checkbox } from './dsh/Checkbox.tsx'
import { ReferenceMenu } from './ReferenceMenu.tsx'
import { ComposerAddMenu } from './ComposerAddMenu.tsx'
import { RunningBorder, type RunningStyle } from './RunningBorder.tsx'
import { Presence } from './Motion.tsx'
import { ComposerSelect } from './ComposerSelect.tsx'
import { ContextUsagePopover } from './ContextUsagePopover.tsx'

export function Composer(p: {
  loadingStyle?: RunningStyle
  editing?: boolean
  input: RefObject<HTMLTextAreaElement>; draft: string; onDraft: (value: string) => void
  options: SessionOptions; onOptions: (patch: Partial<SessionOptions>) => void; models: ModelOption[]; prefs: Preferences
  files: AttachmentInfo[]; onFiles: (files: File[]) => void; onRemove: (id: string) => void; uploading: boolean
  skills: SkillInfo[]; skillIndex: SkillInfo[]; skillsLoading?: boolean; onRefreshSkills: () => void; onToggleSkill: (skill: SkillInfo) => void; onRemoveSkill: (path: string) => void; onSkills: () => void
  workspaceId?: string; referenceIndexReady?: boolean; references: string[]; onToggleReference: (path: string) => void
  history: string[]; running: boolean; busy: boolean; disabled: boolean; onSubmit: (queue?: boolean) => void
  onInterrupt: () => void; onCommand: (id: string) => void
  thread?: ThreadView; compactPending?: boolean; onCompact: () => Promise<void>
  queue: QueuedMessage[]; onQueue: (id: string, retry?: boolean) => void
}) {
  const picker = useRef<HTMLInputElement>(null)
  const [menuIndex, setMenuIndex] = useState(0); const [dismissed, setDismissed] = useState(false)
  const [caret, setCaret] = useState(p.draft.length); const [referenceDismissed, setReferenceDismissed] = useState(false)
  const referenceMatch = /(?:^|\s)@([^\s]*)$/.exec(p.draft.slice(0, caret))
  const reference = !referenceDismissed && referenceMatch && p.workspaceId ? { query: referenceMatch[1], start: caret - referenceMatch[1].length - 1, end: caret } : null
  const [historyIndex, setHistoryIndex] = useState(-1); const unsent = useRef('')
  const commandQuery = !p.editing && /^\/[^\s]*$/.test(p.draft) ? p.draft.toLowerCase() : null
  const query = commandQuery?.slice(1) || ''
  const commandChoices = commands.filter(row => `${row.id} ${row.label} ${row.detail}`.toLowerCase().includes(query)).map(row => ({ ...row, skill: undefined as SkillInfo | undefined }))
  const skillChoices = p.skillIndex.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.replace(/^\$/, ''))).map(skill => ({ id: `skill:${skill.path}`, label: skill.name, detail: skill.description, skill }))
  const choices = commandQuery !== null && !dismissed ? [...commandChoices, ...skillChoices].slice(0, 100) : []
  const efforts = p.models.find(model => model.id === p.options.model)?.efforts || ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  const canSend = Boolean(p.draft.trim() || p.files.length || p.skills.length || p.references.length) && !p.busy && !p.disabled && !p.uploading
  useEffect(() => { setMenuIndex(0); setDismissed(false); setReferenceDismissed(false) }, [p.draft])
  useEffect(() => { p.input.current?.closest('form')?.querySelector('[data-menu-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [menuIndex])
  function sizeInput() {
    const node = p.input.current
    if (!node) return
    node.style.height = '0px'
    const height = Math.min(node.scrollHeight, Math.min(300, window.innerHeight * .35))
    node.style.height = `${Math.max(48, height)}px`
    node.style.overflowY = node.scrollHeight > height + 1 ? 'auto' : 'hidden'
  }
  useLayoutEffect(sizeInput, [p.draft, p.prefs.fontSize])
  useEffect(() => {
    const node = p.input.current; if (!node) return
    let previous = node.clientWidth
    const observer = new ResizeObserver(() => { if (node.clientWidth !== previous) { previous = node.clientWidth; sizeInput() } })
    observer.observe(node); return () => observer.disconnect()
  }, [])
  function command(id: string) { const choice = choices.find(row => row.id === id); if (choice?.skill) { p.onToggleSkill(choice.skill); return } p.onDraft(''); setDismissed(true); p.onCommand(id) }
  function closeMenu() { p.onDraft(''); setDismissed(true); requestAnimationFrame(() => p.input.current?.focus()) }
  function closeReferences() { if (reference) p.onDraft(p.draft.slice(0, reference.start) + p.draft.slice(reference.end)); setReferenceDismissed(true); requestAnimationFrame(() => p.input.current?.focus()) }
  return <>
    {p.queue.length > 0 && <div className="message-queue" aria-label="排队消息">{p.queue.map(row => <div key={row.id}><ListPlus size={15} /><span title={row.text}>{row.error || (row.kind === 'todo-link' ? '待办关联请求，等待执行' : row.text || `${row.attachmentCount} 个附件`)}</span>{row.error && <button type="button" onClick={() => p.onQueue(row.id, true)}>重试</button>}<IconButton label="移除排队消息" onClick={() => p.onQueue(row.id)}><X size={14} /></IconButton></div>)}</div>}
    <form className="composer compact-composer" data-running={p.running || p.busy || undefined} data-sending={p.busy || undefined} onSubmit={event => { event.preventDefault(); if (reference) closeReferences(); else if (commandQuery && choices.length) { const exact = commandChoices.find(row => row.id === p.draft); if (exact) command(exact.id); else closeMenu() } else p.onSubmit() }}>
      {(p.running || p.busy) && <RunningBorder variant={p.loadingStyle} />}
      {(p.files.length > 0 || p.skills.length > 0 || p.references.length > 0 || p.uploading) && <div className="draft-attachments" aria-label="本轮附件与技能">{p.files.map(file => <div className={`attachment-chip ${file.kind}`} key={file.id}>{file.kind === 'image' ? <img src={file.url} alt={file.name} /> : <File size={19} />}<span title={file.name}>{file.name}<small>{file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}</small></span><IconButton label={`移除附件 ${file.name}`} disabled={p.busy} onClick={() => p.onRemove(file.id)}><X size={13} /></IconButton></div>)}{p.references.map(path => <div className="reference-chip skill-chip" key={path}><File size={14} /><span title={path}>{path}</span><IconButton label={`移除引用 ${path}`} onClick={() => p.onToggleReference(path)}><X size={13} /></IconButton></div>)}{p.skills.map(skill => <div className="skill-chip" key={skill.path}><span>${skill.name}</span><IconButton label={`移除 Skill ${skill.name}`} disabled={p.busy} onClick={() => p.onRemoveSkill(skill.path)}><X size={13} /></IconButton></div>)}{p.uploading && <span className="uploading"><LoaderCircle className="spin" size={16} />正在添加附件…</span>}</div>}
      <textarea ref={p.input} aria-label="发送给 Codex 的消息" placeholder={p.compactPending ? '正在压缩上下文，完成后可继续发送…' : p.busy ? '消息已提交，可以继续写下一条…' : p.running ? '补充想法，或按 Tab 排到下一轮…' : '描述任务，@ 文件 · / 命令与 Skills · 拖入附件'} value={p.draft} rows={1} onChange={event => { setCaret(event.target.selectionStart); p.onDraft(event.target.value); setHistoryIndex(-1) }} onSelect={event => setCaret(event.currentTarget.selectionStart)}
        onPaste={event => {
          const files = [...event.clipboardData.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => Boolean(file))
          if (!files.length) return
          event.preventDefault(); p.onFiles(files)
          const text = event.clipboardData.getData('text/plain'); const node = event.currentTarget
          if (text) p.onDraft(p.draft.slice(0, node.selectionStart) + text + p.draft.slice(node.selectionEnd))
        }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (reference && ['ArrowDown', 'Enter', 'Escape'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (event.key === 'ArrowDown') p.input.current?.closest('form')?.querySelector<HTMLInputElement>('.reference-menu input')?.focus(); else closeReferences(); return }
          if (choices.length && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation()
            if (event.key === 'ArrowDown') setMenuIndex(index => (index + 1) % choices.length)
            else if (event.key === 'ArrowUp') setMenuIndex(index => (index + choices.length - 1) % choices.length)
            else if (event.key === 'Escape') closeMenu()
            else if (event.key === 'Tab') { const choice = choices[menuIndex] || choices[0]; if (choice.skill) command(choice.id); else { p.onDraft(choice.id); setDismissed(true) } }
            else command((choices[menuIndex] || choices[0]).id)
            return
          }
          if (event.key === 'Escape' && p.draft) { event.stopPropagation(); return }
          if (event.key === 'Enter' && !event.shiftKey && (p.prefs.sendKey === 'enter' || event.ctrlKey || event.metaKey)) { event.preventDefault(); if (canSend) p.onSubmit(); return }
          if (event.key === 'Tab' && p.running && !p.editing && canSend) { event.preventDefault(); p.onSubmit(true); return }
          const node = event.currentTarget
          if (!event.altKey && !event.ctrlKey && !event.metaKey && !p.draft.includes('\n') && (event.key === 'ArrowUp' && node.selectionStart === 0 || event.key === 'ArrowDown' && node.selectionEnd === p.draft.length)) {
            if (event.key === 'ArrowUp' && (p.draft === '' || historyIndex >= 0) && p.history.length) {
              event.preventDefault(); if (historyIndex < 0) unsent.current = p.draft
              const index = Math.min(historyIndex + 1, p.history.length - 1); setHistoryIndex(index); p.onDraft(p.history[index])
            } else if (event.key === 'ArrowDown' && historyIndex >= 0) { event.preventDefault(); const index = historyIndex - 1; setHistoryIndex(index); p.onDraft(index < 0 ? unsent.current : p.history[index]) }
          }
          if (event.key === '$' && p.draft === '') { event.preventDefault(); p.onSkills() }
        }} />
      <Presence show={Boolean(reference)} className="reference-presence">{reference && <ReferenceMenu workspaceId={p.workspaceId!} query={reference.query} selected={p.references} onToggle={p.onToggleReference} onDone={closeReferences} indexed={p.referenceIndexReady} />}</Presence>
      <Presence show={choices.length > 0} className="slash-menu input-picker" role="region" aria-label="快捷命令与 Skills"><div className="input-picker-heading"><span>命令与技能</span><button type="button" onClick={closeMenu}><Check size={14} />完成选择</button></div><div className="input-picker-list">{choices.map((item, index) => item.skill ? <div className={`input-picker-row ${menuIndex === index ? 'active' : ''}`} data-menu-active={menuIndex === index || undefined} key={item.id} onMouseMove={() => setMenuIndex(index)}><Checkbox checked={p.skills.some(skill => skill.path === item.skill!.path)} label={item.label} onChange={() => p.onToggleSkill(item.skill!)} /><small>{item.detail}</small></div> : <button type="button" data-menu-active={menuIndex === index || undefined} className={`command-menu-row ${menuIndex === index ? 'active' : ''}`} key={item.id} onMouseMove={() => setMenuIndex(index)} onClick={() => command(item.id)}>{item.id === '/plan' ? <GitBranch size={17} /> : item.id === '/goal' ? <Target size={17} /> : item.id === '/skills' ? <Sparkles size={17} /> : <Command size={17} />}<span className="command-copy"><strong>{item.label}</strong><small>{item.detail}</small></span><code>{item.id}</code></button>)}</div><div className="input-picker-footer">技能可多选 · ↑ ↓ 选择 · Enter 确认 · Esc 完成</div></Presence>
      <div className="composer-toolbar"><div className="composer-options">
        <input ref={picker} type="file" multiple hidden aria-label="选择附件" onChange={event => { p.onFiles(Array.from(event.target.files || [])); event.target.value = '' }} />
        <ComposerAddMenu input={p.input} draft={p.draft} planning={p.options.collaborationMode === 'plan'} skills={p.skillIndex} selected={p.skills} loading={Boolean(p.skillsLoading)} disabled={p.busy} onRefresh={p.onRefreshSkills} onToggle={p.onToggleSkill} onCommand={p.onCommand} onOpen={() => { setDismissed(true); setReferenceDismissed(true); p.input.current?.closest('form')?.querySelector('details.permission-menu')?.removeAttribute('open') }} />
        <IconButton label="添加附件" disabled={p.busy || p.uploading} onClick={() => picker.current?.click()}><Paperclip size={17} /></IconButton>
        <ComposerSelect label="模型" value={p.options.model} onChange={model => p.onOptions({ model, effort: '' })} className="model-select" icon={<Code2 size={16} />} title={p.running ? '模型更改将用于下一轮' : '选择本会话下一轮使用的模型'} options={[{ value: '', label: 'CLI 默认模型' }, ...(p.options.model && !p.models.some(row => row.id === p.options.model) ? [{ value: p.options.model, label: p.options.model }] : []), ...p.models.map(option => ({ value: option.id, label: option.label }))]} />
        <ComposerSelect label="推理强度" value={p.options.effort} onChange={effort => p.onOptions({ effort })} className="effort-select" options={[{ value: '', label: '默认强度' }, ...efforts.map(value => ({ value, label: describeEffort(value) }))]} />
        <details className="permission-menu"><summary title="此会话的权限与审批"><ShieldCheck size={16} /><span>{p.options.mode === 'danger-full-access' ? '完全权限' : p.options.mode === 'read-only' ? '只读' : '可写'}</span></summary><div><strong>当前会话权限</strong><label>文件权限<select aria-label="权限模式" value={p.options.mode} onChange={event => p.onOptions({ mode: event.target.value as SessionOptions['mode'], ...(event.target.value === 'danger-full-access' ? { approvalPolicy: 'never' as const } : {}) })}><option value="workspace-write">工作区可写</option><option value="read-only">只读</option><option value="danger-full-access">完全权限</option></select></label><label>审批方式<select aria-label="审批方式" disabled={p.options.mode === 'danger-full-access'} value={p.options.mode === 'danger-full-access' ? 'never' : p.options.approvalPolicy} onChange={event => p.onOptions({ approvalPolicy: event.target.value as SessionOptions['approvalPolicy'] })}><option value="on-request">按需审批</option><option value="untrusted">不可信操作先审批</option><option value="never">不请求审批</option></select></label><button type="button" onClick={() => p.onCommand('/permissions')}>设置新会话默认值</button></div></details>
      </div><div className="send-actions"><ContextUsagePopover thread={p.thread} disabled={p.disabled || p.busy} compactPending={p.compactPending} onCompact={p.onCompact} />{p.running && !p.editing && <><IconButton label="排到下一轮" disabled={!canSend} onClick={() => p.onSubmit(true)}><ListPlus size={17} /></IconButton><IconButton label="停止执行" className="stop-button" onClick={p.onInterrupt}><Square size={13} fill="currentColor" /></IconButton></>}<button type="submit" className="send-button" aria-busy={p.busy} aria-label={p.editing ? '从编辑处继续' : p.running ? '补充指令' : '发送消息'} title={p.prefs.sendKey === 'enter' ? 'Enter 发送 · Shift Enter 换行' : 'Ctrl / ⌘ Enter 发送'} disabled={!canSend}><span className="send-glyph"><ArrowUp size={18} /></span></button></div></div>
    </form>
  </>
}
