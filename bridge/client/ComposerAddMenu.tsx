import { useEffect, useRef, useState, type RefObject } from 'react'
import { ArrowLeft, Check, GitBranch, LoaderCircle, Plus, Search, Sparkles, Target } from 'lucide-react'
import type { SkillInfo } from '../shared/types.ts'
import { Checkbox } from './dsh/Checkbox.tsx'
import { Presence } from './Motion.tsx'

export function ComposerAddMenu({ input, draft, planning, skills, selected, loading, disabled, onOpen, onCommand, onToggle, onRefresh }: {
  input: RefObject<HTMLTextAreaElement>; draft: string; planning: boolean; skills: SkillInfo[]; selected: SkillInfo[]; loading: boolean; disabled: boolean
  onOpen: () => void; onCommand: (id: string) => void; onToggle: (skill: SkillInfo) => void; onRefresh: () => void
}) {
  const root = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false); const [pane, setPane] = useState<'actions' | 'skills'>('actions'); const [query, setQuery] = useState('')
  useEffect(() => { setOpen(false) }, [draft])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(pane === 'skills' ? '.add-skill-search input' : '.add-menu-actions button')?.focus())
    return () => { document.removeEventListener('pointerdown', outside); cancelAnimationFrame(frame) }
  }, [open, pane])
  function close(focusInput = false) { setOpen(false); requestAnimationFrame(() => (focusInput ? input.current : trigger.current)?.focus()) }
  function action(id: string) { setOpen(false); onCommand(id); if (id === '/plan') requestAnimationFrame(() => input.current?.focus()) }
  const rows = skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <div className="composer-add" ref={root} onKeyDown={event => { if (open && event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close() } }}><button ref={trigger} type="button" className="icon-button composer-add-trigger" aria-label="添加功能" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => {
    if (open) { setOpen(false); return }
    onOpen(); setPane('actions'); setQuery(''); setOpen(true)
  }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); onOpen(); setPane('actions'); setOpen(true) } }}><Plus size={18} /></button>
    <Presence show={open} className="composer-add-menu input-picker" role={pane === 'actions' ? 'menu' : 'region'} aria-label={pane === 'actions' ? '添加到会话' : '选择本轮 Skills'} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.shiftKey && event.key === 'ArrowLeft' && !(event.target instanceof HTMLInputElement && !['checkbox', 'radio'].includes(event.target.type) && event.target.value)) { event.preventDefault(); event.stopPropagation(); if (pane === 'skills') setPane('actions'); else close(true); return }
      if (pane === 'skills' && event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault(); event.stopPropagation()
        if (event.target.type === 'checkbox') event.target.click(); else close(true)
        return
      }
      if (pane === 'actions' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.add-menu-actions button')]; const index = buttons.indexOf(event.target as HTMLButtonElement)
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + buttons.length + (event.key === 'ArrowDown' ? 1 : -1)) % buttons.length]?.focus()
      }
    }}>
      {pane === 'actions' ? <><div className="input-picker-heading"><span>添加到会话</span></div><div className="add-menu-actions"><button type="button" role="menuitemcheckbox" aria-checked={planning} onClick={() => action('/plan')}><GitBranch size={17} /><span><strong>Plan · 规划模式</strong><small>{planning ? '已启用，点击切回执行' : '先调查，再形成方案'}</small></span>{planning && <Check size={15} />}</button><button type="button" role="menuitem" onClick={() => action('/goal')}><Target size={17} /><span><strong>Goal · 会话目标</strong><small>设定终点、预算与验收条件</small></span></button><button type="button" role="menuitem" onClick={() => { onRefresh(); setPane('skills') }}><Sparkles size={17} /><span><strong>Skills · 本轮技能</strong><small>搜索并勾选需要的技能</small></span>{selected.length > 0 && <span className="add-count">{selected.length}</span>}</button></div></> : <>
        <div className="input-picker-heading"><button type="button" aria-label="返回添加菜单" onClick={() => setPane('actions')}><ArrowLeft size={14} />本轮 Skills</button><button type="button" onClick={() => close(true)}><Check size={14} />完成{selected.length > 0 && ` · ${selected.length}`}</button></div>
        <label className="add-skill-search"><Search size={15} /><input aria-label="搜索本轮 Skills" value={query} placeholder="搜索技能名称或用途…" onChange={event => setQuery(event.target.value)} /></label><div className="input-picker-list">{loading ? <p className="picker-hint"><LoaderCircle size={15} className="spin" />正在发现 Skills…</p> : rows.map(skill => <div className="input-picker-row" key={skill.path}><Checkbox checked={selected.some(row => row.path === skill.path)} label={skill.name} onChange={() => onToggle(skill)} /><small>{skill.description}</small></div>)}{!loading && !rows.length && <p className="picker-hint">{query ? '没有匹配的技能' : '当前工作区暂无可用 Skills'}</p>}</div><div className="input-picker-footer">可选择多个技能，保留当前输入。</div>
      </>}
    </Presence>
  </div>
}
