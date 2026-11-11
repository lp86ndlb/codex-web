import { useEffect, useState, type ReactNode } from 'react'
import { Archive, ArrowLeft, Check, ChevronRight, Cpu, Gauge, Keyboard, LoaderCircle, Monitor, Moon, Palette, Plug, Puzzle, RefreshCw, Search, Settings2, ShieldCheck, Sun } from 'lucide-react'
import type { Bootstrap, ModelOption, Preferences, SessionOptions, SkillInfo, ThreadSummary, ThreadView, WorkspaceInfo } from '../shared/types.ts'
import { api, message } from './api.ts'
import { BrandMark } from './BrandMark.tsx'
import { Notice, TranscriptItem } from './components.tsx'
import { shortcuts } from './commands.ts'
import { GenuiProvider } from './GenuiHost.tsx'
import { Checkbox } from './dsh/Checkbox.tsx'
import { StatusPanel } from './StatusPanel.tsx'
import { LoadingStylePicker } from './LoadingStylePicker.tsx'
import type { RunningStyle } from './RunningBorder.tsx'
import { FilePreviewProvider } from './FilePreview.tsx'
import { workspaceFor } from './Workspaces.tsx'

export type SettingsTab = 'general' | 'models' | 'skills' | 'appearance' | 'archives' | 'shortcuts' | 'connection' | 'status'
const tabs: { id: SettingsTab; title: string; icon: ReactNode }[] = [
  { id: 'general', title: '常规', icon: <Settings2 size={17} /> }, { id: 'models', title: '模型与权限', icon: <Cpu size={17} /> },
  { id: 'skills', title: 'Skills', icon: <Puzzle size={17} /> }, { id: 'appearance', title: '外观与布局', icon: <Palette size={17} /> },
  { id: 'archives', title: '归档会话', icon: <Archive size={17} /> }, { id: 'shortcuts', title: '快捷键', icon: <Keyboard size={17} /> },
  { id: 'status', title: '状态与额度', icon: <Gauge size={17} /> }, { id: 'connection', title: '连接', icon: <Plug size={17} /> },
]
export function Switch({ label, detail, checked, onChange, disabled = false }: { label: string; detail?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="setting-switch"><span><strong>{label}</strong>{detail && <small>{detail}</small>}</span><span className="switch-control"><input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span className="switch-track"><span /></span></span></label>
}
function OptionFields({ value, models, onChange, prefix }: { value: SessionOptions; models: ModelOption[]; onChange: (patch: Partial<SessionOptions>) => void; prefix: string }) {
  const efforts = models.find(model => model.id === value.model)?.efforts || ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  return <div className="option-fields"><label>{prefix}模型<select aria-label={`${prefix}模型`} value={value.model} onChange={event => onChange({ model: event.target.value, effort: '' })}><option value="">CLI 默认模型</option>{value.model && !models.some(model => model.id === value.model) && <option value={value.model}>{value.model}</option>}{models.map(model => <option value={model.id} key={model.id}>{model.label}</option>)}</select></label>
    <label>{prefix}推理强度<select aria-label={`${prefix}推理强度`} value={value.effort} onChange={event => onChange({ effort: event.target.value })}><option value="">模型默认</option>{efforts.map(effort => <option key={effort} value={effort}>{({ low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: 'Ultra', minimal: '最小', none: '关闭' } as Record<string, string>)[effort] || effort}</option>)}</select></label>
    <label>{prefix}权限<select aria-label={`${prefix}权限`} value={value.mode} onChange={event => onChange({ mode: event.target.value as SessionOptions['mode'], ...(event.target.value === 'danger-full-access' ? { approvalPolicy: 'never' as const } : {}) })}><option value="workspace-write">工作区可写</option><option value="read-only">只读</option><option value="danger-full-access">完全权限</option></select></label>
    <label>{prefix}审批<select aria-label={`${prefix}审批`} disabled={value.mode === 'danger-full-access'} value={value.mode === 'danger-full-access' ? 'never' : value.approvalPolicy} onChange={event => onChange({ approvalPolicy: event.target.value as SessionOptions['approvalPolicy'] })}><option value="on-request">按需审批</option><option value="untrusted">不可信操作先审批</option><option value="never">不请求审批</option></select></label>
  </div>
}

export function SettingsPanel(props: {
  loadingStyle: RunningStyle; onLoadingStyle: (value: RunningStyle) => void; loadingFocus?: boolean
  tab: SettingsTab; onTab: (tab: SettingsTab) => void; boot: Bootstrap | null; connected: boolean
  preferences: Preferences; onPreferences: (patch: Partial<Preferences>) => Promise<void>
  current?: { title: string; options: SessionOptions; model?: string; tokens?: number }; onCurrent: (patch: Partial<SessionOptions>) => void
  workspaces: WorkspaceInfo[]; workspaceId?: string; onUseSkill: (skill: SkillInfo) => void
  plugin: boolean; pluginSaving: boolean; onPlugin: (enabled: boolean) => void
  onReconnect: () => void; onRestored: (id: string) => void
}) {
  const { tab, preferences: prefs } = props
  const [error, setError] = useState(''); const [saving, setSaving] = useState(0)
  const [skillWorkspace, setSkillWorkspace] = useState(props.workspaceId || props.workspaces[0]?.id || '')
  const [skills, setSkills] = useState<SkillInfo[]>([]); const [skillErrors, setSkillErrors] = useState<string[]>([])
  const [archives, setArchives] = useState<ThreadSummary[]>([]); const [preview, setPreview] = useState<ThreadView | null>(null)
  const [loading, setLoading] = useState(false); const [search, setSearch] = useState(''); const [refresh, setRefresh] = useState(0)
  const previewWorkspace = preview ? workspaceFor(props.workspaces, preview.cwd) : undefined
  useEffect(() => { setError(''); setSearch(''); setPreview(null) }, [tab])
  useEffect(() => {
    if (tab !== 'skills' && tab !== 'archives') return
    let cancelled = false; setLoading(true); setError('')
    const request = tab === 'skills' ? api<{ skills: SkillInfo[]; errors: string[] }>(`/skills?refresh=1${skillWorkspace ? `&workspace=${encodeURIComponent(skillWorkspace)}` : ''}`).then(value => { if (!cancelled) { setSkills(value.skills); setSkillErrors(value.errors) } })
      : api<ThreadSummary[]>('/archives').then(value => { if (!cancelled) setArchives(value) })
    request.catch(error => { if (!cancelled) setError(message(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tab, skillWorkspace, refresh])
  async function action(operation: () => Promise<unknown>) {
    setError(''); setSaving(value => value + 1)
    try { await operation() } catch (error) { setError(message(error)) } finally { setSaving(value => value - 1) }
  }
  const change = (patch: Partial<Preferences>) => { void action(() => props.onPreferences(patch)) }
  return <div className="settings-layout"><nav className="settings-nav" aria-label="设置分类">{tabs.map(item => <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => props.onTab(item.id)}>{item.icon}<span>{item.title}</span></button>)}</nav>
    <div className="settings-page"><div className="settings-page-heading"><h3>{tabs.find(item => item.id === tab)?.title}</h3><span role="status">{saving ? <><LoaderCircle size={13} className="spin" />保存中</> : <><Check size={13} />自动保存</>}</span></div>{error && <Notice text={error} />}
      {tab === 'general' && <><p className="settings-description">把工作方式设为默认，接下来专注于项目本身。</p>
        <label className="setting-field">发送消息<select aria-label="发送消息快捷键" value={prefs.sendKey} onChange={event => change({ sendKey: event.target.value as Preferences['sendKey'] })}><option value="enter">Enter 发送 · Shift Enter 换行</option><option value="mod-enter">Ctrl / ⌘ Enter 发送 · Enter 换行</option></select></label>
        <Switch label="启用 GenUI" detail="按需加载交互图表、表单、函数图和会话面板" checked={prefs.genui} onChange={genui => change({ genui })} />
        <Switch label="默认显示工作区面板" detail="下次打开页面时展示文件与变更面板" checked={prefs.showInspector} onChange={showInspector => change({ showInspector })} />
        <Switch label="默认显示处理步骤" detail="显示每一步的说明；原始命令、代码与长输出仍按需展开" checked={prefs.showActivityDetails} onChange={showActivityDetails => change({ showActivityDetails })} />
        <label className="setting-field">工作步骤收起时机<select aria-label="工作步骤收起时机" value={prefs.activityCollapseTiming || 'next-input'} onChange={event => change({ activityCollapseTiming: event.target.value as Preferences['activityCollapseTiming'] })}><option value="completion">回答结束后</option><option value="next-input">下次有新消息时</option><option value="never">不收起</option></select></label>
        <p className="settings-footnote">只自动收起处理步骤，回答内容保持可见；手动展开后可继续回看。</p>
        <Switch label="启用待办便签" detail="dsh-todo-note · 每个会话独立保存，完成后由你确认" checked={props.plugin} disabled={props.pluginSaving} onChange={props.onPlugin} />
        <div className="settings-callout">旧会话可以在空闲后连接便签工具；每次会话分别保存待办。</div>
      </>}
      {tab === 'models' && <><h4>新会话默认设置</h4><p className="settings-description">默认值用于新建会话；已有会话保留自己的模型与权限。</p><p className="settings-footnote">完全权限允许访问本机文件和网络，并关闭逐次审批。</p><OptionFields prefix="默认" value={prefs} models={props.boot?.models || []} onChange={change} />
        {props.current && <section className="settings-section"><h4>当前会话</h4><p className="settings-description">{props.current.title} · 更改从下一轮生效</p><OptionFields prefix="当前会话" value={props.current.options} models={props.boot?.models || []} onChange={props.onCurrent} /><button className="settings-text-button" onClick={() => props.onCurrent({ model: prefs.model, effort: prefs.effort, mode: prefs.mode, approvalPolicy: prefs.approvalPolicy })}>将默认设置应用到此会话</button></section>}
      </>}
      {tab === 'appearance' && <><div className="theme-choices">{[{ id: 'dark', title: '深色', icon: <Moon size={22} /> }, { id: 'light', title: '浅色', icon: <Sun size={22} /> }, { id: 'system', title: '跟随系统', icon: <Monitor size={22} /> }].map(theme => <button type="button" key={theme.id} aria-pressed={prefs.theme === theme.id} className={prefs.theme === theme.id ? 'selected' : ''} onClick={() => change({ theme: theme.id as Preferences['theme'] })}>{theme.icon}<span>{theme.title}</span></button>)}</div>
        <label className="setting-range">正文字号<strong>{prefs.fontSize}px</strong><input aria-label="正文字号" type="range" min="14" max="22" value={prefs.fontSize} onChange={event => change({ fontSize: Number(event.target.value) })} /></label>
        <label className="setting-range">界面字号<strong>{prefs.uiFontSize}px</strong><input aria-label="界面字号" type="range" min="12" max="18" value={prefs.uiFontSize} onChange={event => change({ uiFontSize: Number(event.target.value) })} /></label>
        <p className="settings-footnote">聊天区使用适合阅读的固定宽度，随窗口自动适配。</p>
        <Switch label="界面动画" detail="柔和的展开、勾选和状态过渡；尊重系统减少动态效果设置" checked={prefs.animations} onChange={animations => change({ animations })} />
        <LoadingStylePicker value={props.loadingStyle} onChange={props.onLoadingStyle} autoFocus={props.loadingFocus} />
        <Switch label="代码自动换行" checked={prefs.codeWrap} onChange={codeWrap => change({ codeWrap })} />
      </>}
      {tab === 'skills' && <><p className="settings-description">查看 CLI 在所选工作区发现的 Skills，选择本轮使用的技能，或设置网页端的启用状态。</p><div className="settings-filter"><select aria-label="Skills 工作区" value={skillWorkspace} onChange={event => setSkillWorkspace(event.target.value)}><option value="">Codex 会话目录</option>{props.workspaces.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><button aria-label="刷新 Skills" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button></div><label className="settings-search"><Search size={16} /><input aria-label="搜索 Skills" placeholder="搜索名称或说明" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" />正在读取 Skills…</div> : <div className="skills-list">{skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(search.toLowerCase())).map(skill => <article key={skill.path} className="skill-card"><div className="skill-selection"><Checkbox label={skill.name} checked={skill.enabled} disabled={saving > 0} onChange={enabled => void action(async () => { const result = await api<{ skills: SkillInfo[]; errors: string[] }>('/skills/config', { ...(skillWorkspace ? { workspace: skillWorkspace } : {}), path: skill.path, enabled }); setSkills(result.skills) })} /><p>{skill.description}</p></div><div className="skill-card-footer"><span title={skill.path}>{skill.scope} · 显式提交 {skill.uses} 次</span><button disabled={!skill.enabled || skillWorkspace !== props.workspaceId} onClick={() => props.onUseSkill(skill)}>本轮使用<ChevronRight size={14} /></button></div></article>)}{!skills.length && <p className="settings-empty">当前工作区没有可用的 Skills。</p>}</div>}
        {skillErrors.map((error, index) => <Notice key={index} text={error} />)}<p className="settings-footnote">开关仅影响网页后续轮次，不修改终端配置；已经注入历史的技能内容仍会保留。计数记录网页显式选择并提交的次数。</p>
      </>}
      {tab === 'archives' && <>{preview ? <><button className="settings-text-button" onClick={() => setPreview(null)}><ArrowLeft size={15} />返回归档列表</button><h4>{preview.title}</h4><FilePreviewProvider workspaceId={previewWorkspace?.id} root={previewWorkspace?.path} cwd={preview.cwd}><GenuiProvider inlinePanels threadId={preview.id} enabled={prefs.genui} streaming={false} onAction={async () => { throw new Error('请先恢复这个归档会话，再提交交互') }} onOpen={() => {}}><div className="archive-preview">{preview.items.map(item => <TranscriptItem key={item.id} item={item} />)}</div></GenuiProvider></FilePreviewProvider></> : <><p className="settings-description">归档会话仍保留内容，可以随时查看或恢复。</p><label className="settings-search"><Search size={16} /><input aria-label="搜索归档会话" placeholder="搜索标题或工作区" value={search} onChange={event => setSearch(event.target.value)} /></label>{loading ? <div className="settings-loading"><LoaderCircle className="spin" />读取归档…</div> : <div className="archive-list">{archives.filter(row => `${row.title} ${row.cwd}`.toLowerCase().includes(search.toLowerCase())).map(row => <article key={row.id}><div><strong>{row.title}</strong><small title={row.cwd}>{props.workspaces.find(w => row.cwd === w.path)?.name || row.cwd}</small></div><button disabled={saving > 0} onClick={() => void action(async () => setPreview(await api<ThreadView>(`/archives/${encodeURIComponent(row.id)}`)))}>查看</button><button disabled={saving > 0} onClick={() => void action(async () => { await api(`/threads/${encodeURIComponent(row.id)}/restore`, {}); setArchives(rows => rows.filter(value => value.id !== row.id)); props.onRestored(row.id) })}>恢复并打开</button></article>)}{!archives.length && <p className="settings-empty">还没有归档的会话</p>}</div>}</>}</>}
      {tab === 'shortcuts' && <><p className="settings-description">输入 / 打开命令菜单，输入 $ 选择 Skill。浏览器保留的快捷键继续由 Edge 处理。</p><div className="shortcut-list">{shortcuts.map(([name, key]) => <div key={name}><span>{name}</span><kbd>{key}</kbd></div>)}</div></>}
      {tab === 'status' && <StatusPanel model={props.current?.options.model || props.current?.model} tokens={props.current?.tokens} />}
      {tab === 'connection' && <><div className="connection-brand"><BrandMark size={44} /><div><strong>cweb</strong><span>{props.connected ? 'Codex CLI 已连接' : '等待本地引擎连接'}</span></div><ShieldCheck size={20} /></div><dl className="connection-details"><dt>登录方式</dt><dd>{props.boot?.account || '未连接'}</dd><dt>运行方式</dt><dd>{props.boot?.sharedEngine ? '与终端共享原生引擎' : '独立 CLI 引擎'}</dd><dt>Codex 会话目录</dt><dd>{props.boot?.codexHome}</dd><dt>工作区</dt><dd>{props.workspaces.length} 个项目</dd></dl><div className="settings-callout">{props.boot?.sharedHistory ? <>与终端共享原生会话和归档。结束当前任务后，可复制顶部的终端继续命令。</> : <>当前使用独立会话目录。</>}<br />修改 CLI 连接配置后运行 <code>cweb restart</code>。</div><button className="primary" onClick={props.onReconnect}>重新连接</button><p className="settings-footnote">独立社区工具，不属于 OpenAI 或 DeepSeek 官方产品。</p></>}
    </div>
  </div>
}
