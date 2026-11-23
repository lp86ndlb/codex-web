import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, ArrowLeft, Check, ChevronRight, Cpu, Gauge, Keyboard, LoaderCircle, Monitor, Moon, Palette, Plug, Puzzle, RefreshCw, Search, Settings2, ShieldCheck, Sun, Users } from 'lucide-react'
import type { Bootstrap, ModelOption, Preferences, SessionOptions, SkillInfo, ThreadSummary, ThreadView, WorkspaceInfo } from '../shared/types.ts'
import { api, message } from './api.ts'
import { describeEffort, describeModel } from '../shared/activity.ts'
import { BrandMark } from './BrandMark.tsx'
import { Notice, TranscriptItem } from './components.tsx'
import { shortcuts } from './commands.ts'
import { GenuiProvider } from './GenuiHost.tsx'
import { Checkbox } from './dsh/Checkbox.tsx'
import { StatusPanel } from './StatusPanel.tsx'
import { LoadingStylePicker } from './LoadingStylePicker.tsx'
import type { RunningStyle } from './RunningBorder.tsx'
import { FilePreviewProvider } from './FilePreview.tsx'
import { ConnectionPanel } from './ConnectionPanel.tsx'
import type { RuntimeStatus } from '../shared/types.ts'
import type { TeamDisplay } from './team-transcript.ts'
import type { TeamController } from './useTeam.ts'
import { delegationLabels, teamPeerRules, teamPolicyLabels } from '../shared/team.ts'
import { workspaceFor } from './Workspaces.tsx'

export type SettingsTab = 'general' | 'team' | 'models' | 'skills' | 'appearance' | 'archives' | 'shortcuts' | 'connection' | 'status'
const tabs: { id: SettingsTab; title: string; icon: ReactNode }[] = [
  { id: 'general', title: '常规', icon: <Settings2 size={17} /> }, { id: 'models', title: '模型与权限', icon: <Cpu size={17} /> },
  { id: 'team', title: '团队协作', icon: <Users size={17} /> },
  { id: 'skills', title: 'Skills', icon: <Puzzle size={17} /> }, { id: 'appearance', title: '外观与布局', icon: <Palette size={17} /> },
  { id: 'archives', title: '归档会话', icon: <Archive size={17} /> }, { id: 'shortcuts', title: '快捷键', icon: <Keyboard size={17} /> },
  { id: 'status', title: '状态与额度', icon: <Gauge size={17} /> }, { id: 'connection', title: '连接与诊断', icon: <Plug size={17} /> },
]
export function Switch({ label, detail, checked, onChange, disabled = false }: { label: string; detail?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="setting-switch"><span><strong>{label}</strong>{detail && <small>{detail}</small>}</span><span className="switch-control"><input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span className="switch-track"><span /></span></span></label>
}
function OptionFields({ value, models, onChange, prefix, defaults }: { value: SessionOptions; models: ModelOption[]; onChange: (patch: Partial<SessionOptions>) => void; prefix: string; defaults?: SessionOptions }) {
  const efforts = models.find(model => model.id === (value.model || defaults?.model))?.efforts || ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  const defaultModel = defaults ? `跟随默认设置（${models.find(model => model.id === defaults.model)?.label || describeModel(defaults.model) || 'CLI 默认模型'}）` : 'CLI 默认模型'
  const defaultEffort = defaults ? `跟随默认设置（${defaults.effort ? describeEffort(defaults.effort) : '模型默认'}）` : '模型默认'
  return <div className="option-fields"><label>{prefix}模型<select aria-label={`${prefix}模型`} value={value.model} onChange={event => onChange({ model: event.target.value, effort: '' })}><option value="">{defaultModel}</option>{value.model && !models.some(model => model.id === value.model) && <option value={value.model}>{describeModel(value.model)}</option>}{models.map(model => <option value={model.id} key={model.id}>{model.label}</option>)}</select></label>
    <label>{prefix}推理强度<select aria-label={`${prefix}推理强度`} value={value.effort} onChange={event => onChange({ effort: event.target.value })}><option value="">{defaultEffort}</option>{efforts.map(effort => <option key={effort} value={effort}>{describeEffort(effort)}</option>)}</select></label>
    <label>{prefix}权限<select aria-label={`${prefix}权限`} value={value.mode} onChange={event => onChange({ mode: event.target.value as SessionOptions['mode'], ...(event.target.value === 'danger-full-access' ? { approvalPolicy: 'never' as const } : {}) })}><option value="workspace-write">工作区可写</option><option value="read-only">只读</option><option value="danger-full-access">完全权限</option></select></label>
    <label>{prefix}审批<select aria-label={`${prefix}审批`} disabled={value.mode === 'danger-full-access'} value={value.mode === 'danger-full-access' ? 'never' : value.approvalPolicy} onChange={event => onChange({ approvalPolicy: event.target.value as SessionOptions['approvalPolicy'] })}><option value="on-request">按需审批</option><option value="untrusted">不可信操作先审批</option><option value="never">不请求审批</option></select></label>
  </div>
}

function TeamSettings({ team, workspaceName, teamDisplay, onTeamDisplay }: { teamDisplay: TeamDisplay; onTeamDisplay: (value: TeamDisplay) => void; team: TeamController; workspaceName?: string }) {
  const state = team.state
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null)
  async function toggle(enabled: boolean) {
    setPendingEnabled(enabled)
    try { await team.act('/team/enabled', { enabled }) }
    finally { setPendingEnabled(null) }
  }
  if (!state) {
    if (team.error) return <><Notice text={team.error} /><button className="settings-text-button" onClick={() => void team.load()}>重新读取</button></>
    return <p className="settings-description">{!workspaceName && !team.pilot ? '选择工作区后可管理团队。' : team.scope ? '正在读取团队设置…' : '当前后台尚未启用工作区团队功能。'}</p>
  }
  return <>
    <h4>{workspaceName || '当前工作区'}</h4>
    <Switch label="团队模式" checked={pendingEnabled ?? state.enabled} disabled={team.saving || pendingEnabled !== null} onChange={enabled => void toggle(enabled)}
      detail={state.enabled ? '已开启，成员可沿关系图中的连线通信。' : '已暂停。可先设置协作规则，开启后按队列继续投递。'} />
    {team.error && <Notice text={team.error} />}
    <label className="setting-field">通信审批<select aria-label="通信审批方式" value={state.policy} disabled={team.saving} onChange={e => void team.act('/team/policy', { policy: e.target.value })}>
      {Object.entries(teamPolicyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <p className="settings-footnote">{state.policy === 'manual' ? '每条新通信先由你确认。' : state.policy === 'automatic' ? '系统按已开放的连线和协作规则审批。' : '由发件会话的直属上级判断风险，最高负责人的申请由你确认。'} 新增成员仍需你批准。</p>
    {state.peerMode && <><label className="setting-field">同级协作方式<select aria-label="同级协作方式" value={state.peerMode} disabled={team.saving} onChange={e => void team.act('/team/peer-mode', { peerMode: e.target.value })}>
      <option value="direct">直接协商，按需上报（默认）</option><option value="supervised">先由直属上级审核（旧模式）</option>
    </select></label><p className="settings-footnote">{teamPeerRules[state.peerMode]}{state.policy === 'ai' && state.peerMode === 'direct' && '同级通信由发送会话单独进行只读风险判断。'}</p></>}
    {state.delegationPreference && <><label className="setting-field">任务分工偏好<select aria-label="任务分工偏好" value={state.delegationPreference} disabled={team.saving} onChange={e => void team.act('/team/delegation', { preference: e.target.value })}>
      {Object.entries(delegationLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
    </select></label><p className="settings-footnote">会话结合队列和交接成本决定，也可以自己推进主线，把独立部分交给下级。</p></>}
    <Switch label="显示团队消息" detail="与对话顶栏同步，在此浏览器中按工作区保存。" checked={teamDisplay === 'show'} onChange={visible => onTeamDisplay(visible ? 'show' : 'hide')} />
    <p className="settings-footnote">规则按工作区保存，已提出的通信沿用原审批流程。</p>
    {(!state.peerMode || !state.delegationPreference) && <p className="settings-callout">后台更新并重启后，可在这里使用{!state.peerMode ? '同级协作方式和' : ''}任务分工偏好。</p>}
  </>
}

export function SettingsPanel(props: {
  desktopNotifications: Pick<Parameters<typeof Switch>[0], 'checked' | 'disabled' | 'onChange' | 'detail'>
  loadingStyle: RunningStyle; onLoadingStyle: (value: RunningStyle) => void; loadingFocus?: boolean
  teamDisplay: TeamDisplay; onTeamDisplay: (value: TeamDisplay) => void; team: TeamController; runtime: RuntimeStatus; online: boolean; thread?: ThreadView
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
  const navigation = useRef<HTMLElement>(null)
  useEffect(() => {
    const nav = navigation.current, active = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !active) return
    const align = () => { if (nav.scrollWidth > nav.clientWidth) {
      const offset = active.getBoundingClientRect().left - nav.getBoundingClientRect().left
      nav.scrollLeft += offset - (nav.clientWidth - active.clientWidth) / 2
    } }
    align(); const observer = new ResizeObserver(align); observer.observe(nav)
    return () => observer.disconnect()
  }, [tab])
  return <div className="settings-layout"><nav ref={navigation} className="settings-nav" aria-label="设置分类">{tabs.map(item => <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => props.onTab(item.id)}>{item.icon}<span>{item.title}</span></button>)}</nav>
    <div className="settings-page"><div className="settings-page-heading"><h3>{tabs.find(item => item.id === tab)?.title}</h3><span role="status">{tab === 'connection' ? '按需检查' : (saving || (tab === 'team' && props.team.saving)) ? <><LoaderCircle size={13} className="spin" />保存中</> : <><Check size={13} />自动保存</>}</span></div>{error && <Notice text={error} />}
      {tab === 'general' && <><p className="settings-description">把工作方式设为默认，接下来专注于项目本身。</p>
        <label className="setting-field">发送消息<select aria-label="发送消息快捷键" value={prefs.sendKey} onChange={event => change({ sendKey: event.target.value as Preferences['sendKey'] })}><option value="enter">Enter 发送 · Shift Enter 换行</option><option value="mod-enter">Ctrl / ⌘ Enter 发送 · Enter 换行</option></select></label>
        <Switch label="启用 GenUI" detail="按需加载交互图表、表单、函数图和会话面板" checked={prefs.genui} onChange={genui => change({ genui })} />
        <Switch label="会话完成桌面通知" {...props.desktopNotifications} />
        <Switch label="自动恢复失败的请求" detail="确认模型请求失败且本轮尚未执行工具时，最多自动重试一次；排队任务和已执行的命令不会重发" checked={prefs.autoRecovery ?? true} onChange={autoRecovery => change({ autoRecovery })} />
        <p className="settings-footnote">只处理从网页提交的请求；原生终端会话由 CLI 自身恢复。</p>
        <label className="setting-field">图片读取方式<select aria-label="图片读取方式" value={prefs.imageInputMode || 'on-demand'} onChange={event => change({ imageInputMode: event.target.value as Preferences['imageInputMode'] })}><option value="on-demand">按需读取原图（推荐）</option><option value="inline">随消息直接发送原图</option></select></label>
        <p className="settings-footnote">两种方式都保留原图质量。按需模式在 CLI 需要时通过看图工具读取，减少历史中长期携带的图片；只影响网页之后发送的图片。</p>
        <Switch label="默认显示工作区面板" detail="桌面端打开页面时展开右侧栏；窄屏通过顶部按钮打开" checked={prefs.showInspector} onChange={showInspector => change({ showInspector })} />
        <Switch label="默认显示处理步骤" detail="显示每一步的说明；原始命令、代码与长输出仍按需展开" checked={prefs.showActivityDetails} onChange={showActivityDetails => change({ showActivityDetails })} />
        <label className="setting-field">工作步骤收起时机<select aria-label="工作步骤收起时机" value={prefs.activityCollapseTiming || 'next-input'} onChange={event => change({ activityCollapseTiming: event.target.value as Preferences['activityCollapseTiming'] })}><option value="completion">回答结束后</option><option value="next-input">下次有新消息时</option><option value="never">不收起</option></select></label>
        <p className="settings-footnote">只自动收起处理步骤，回答内容保持可见；手动展开后可继续回看。</p>
        <Switch label="启用待办便签" detail="dsh-todo-note · 每个会话独立保存，完成后由你确认" checked={props.plugin} disabled={props.pluginSaving} onChange={props.onPlugin} />
        <label className="setting-field">待办显示位置<select aria-label="待办显示位置" value={prefs.todoPlacement || 'sidebar'} onChange={event => change({ todoPlacement: event.target.value as Preferences['todoPlacement'], showInspector: event.target.value === 'sidebar' })}><option value="sidebar">右侧栏（默认）</option><option value="floating">悬浮窗</option></select></label>
        <p className="settings-footnote">右侧栏按待办、变更、文件排列。悬浮窗保留拖动、缩放和位置记忆；切换不会改变已保存的待办。</p>
        <div className="settings-callout">旧会话可以在空闲后连接便签工具；每次会话分别保存待办。</div>
      </>}
      {tab === 'team' && <TeamSettings teamDisplay={props.teamDisplay} onTeamDisplay={props.onTeamDisplay} key={props.team.scope} team={props.team} workspaceName={props.workspaces.find(w => w.id === props.workspaceId)?.name} />}
      {tab === 'models' && <><h4>新会话默认设置</h4><p className="settings-description">默认模型与强度用于新会话和选择跟随默认的会话；单独指定的设置保留。</p><p className="settings-footnote">完全权限允许访问本机文件和网络，并关闭逐次审批。</p><OptionFields prefix="默认" value={prefs} models={props.boot?.models || []} onChange={change} />
        {props.current && <section className="settings-section"><h4>当前会话</h4><p className="settings-description">{props.current.title} · 更改从下一轮生效</p><OptionFields prefix="当前会话" value={props.current.options} models={props.boot?.models || []} onChange={props.onCurrent} defaults={prefs} /><button className="settings-text-button" onClick={() => props.onCurrent({ model: '', effort: '', mode: prefs.mode, approvalPolicy: prefs.approvalPolicy })}>将默认设置应用到此会话</button></section>}
      </>}
      {tab === 'appearance' && <><div className="theme-choices">{[{ id: 'dark', title: '深色', icon: <Moon size={22} /> }, { id: 'light', title: '浅色', icon: <Sun size={22} /> }, { id: 'system', title: '跟随系统', icon: <Monitor size={22} /> }].map(theme => <button type="button" key={theme.id} aria-pressed={prefs.theme === theme.id} className={prefs.theme === theme.id ? 'selected' : ''} onClick={() => change({ theme: theme.id as Preferences['theme'] })}>{theme.icon}<span>{theme.title}</span></button>)}</div>
        <label className="setting-range">正文字号<strong>{prefs.fontSize}px</strong><input aria-label="正文字号" type="range" min="14" max="22" value={prefs.fontSize} onChange={event => change({ fontSize: Number(event.target.value) })} /></label>
        <label className="setting-range">界面字号<strong>{prefs.uiFontSize}px</strong><input aria-label="界面字号" type="range" min="12" max="18" value={prefs.uiFontSize} onChange={event => change({ uiFontSize: Number(event.target.value) })} /></label>
        <p className="settings-footnote">正文字号用于对话、输入和题目；界面字号用于侧栏、待办、设置和菜单。布局随可用窗口高度调整。</p>
        <Switch label="界面动画" detail="柔和的展开、勾选和状态过渡；尊重系统减少动态效果设置" checked={prefs.animations} onChange={animations => change({ animations })} />
        <LoadingStylePicker value={props.loadingStyle} onChange={props.onLoadingStyle} autoFocus={props.loadingFocus} />
        <h4>文件与图片</h4>
        <label className="setting-field">文件预览位置<select aria-label="文件预览位置" value={prefs.filePreviewLayout || 'dialog'} onChange={event => change({ filePreviewLayout: event.target.value as Preferences['filePreviewLayout'] })}><option value="dialog">居中弹窗</option><option value="side">右侧抽屉</option></select></label>
        <label className="setting-field">聊天图片大小<select aria-label="聊天图片大小" value={prefs.inlineImageSize || 'comfortable'} onChange={event => change({ inlineImageSize: event.target.value as Preferences['inlineImageSize'] })}><option value="comfortable">舒适显示</option><option value="compact">紧凑缩略图</option></select></label>
        <label className="setting-field">图片打开时<select aria-label="图片打开时" value={prefs.imagePreviewZoom || 'fit'} onChange={event => change({ imagePreviewZoom: event.target.value as Preferences['imagePreviewZoom'] })}><option value="fit">适应窗口</option><option value="actual">原始大小（1:1）</option></select></label>
        <p className="settings-footnote">点击图片或文件先预览，再选择下载、打开文件或所在文件夹。默认应用在运行 cweb 的电脑上打开；显示设置不会改变发送给 Codex 的原图质量。</p>
        <Switch label="代码自动换行" checked={prefs.codeWrap} onChange={codeWrap => change({ codeWrap })} />
      </>}
      {tab === 'skills' && <><p className="settings-description">查看 CLI 在所选工作区发现的 Skills，选择本轮使用的技能，或设置网页端的启用状态。</p><div className="settings-filter"><select aria-label="Skills 工作区" value={skillWorkspace} onChange={event => setSkillWorkspace(event.target.value)}><option value="">Codex 会话目录</option>{props.workspaces.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><button aria-label="刷新 Skills" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button></div><label className="settings-search"><Search size={16} /><input aria-label="搜索 Skills" placeholder="搜索名称或说明" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" />正在读取 Skills…</div> : <div className="skills-list">{skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(search.toLowerCase())).map(skill => <article key={skill.path} className="skill-card"><div className="skill-selection"><Checkbox label={skill.name} checked={skill.enabled} disabled={saving > 0} onChange={enabled => void action(async () => { const result = await api<{ skills: SkillInfo[]; errors: string[] }>('/skills/config', { ...(skillWorkspace ? { workspace: skillWorkspace } : {}), path: skill.path, enabled }); setSkills(result.skills) })} /><p>{skill.description}</p></div><div className="skill-card-footer"><span title={skill.path}>{skill.scope} · 显式提交 {skill.uses} 次</span><button disabled={!skill.enabled || skillWorkspace !== props.workspaceId} onClick={() => props.onUseSkill(skill)}>本轮使用<ChevronRight size={14} /></button></div></article>)}{!skills.length && <p className="settings-empty">当前工作区没有可用的 Skills。</p>}</div>}
        {skillErrors.map((error, index) => <Notice key={index} text={error} />)}<p className="settings-footnote">开关仅影响网页后续轮次，不修改终端配置；已经注入历史的技能内容仍会保留。计数记录网页显式选择并提交的次数。</p>
      </>}
      {tab === 'archives' && <>{preview ? <><button className="settings-text-button" onClick={() => setPreview(null)}><ArrowLeft size={15} />返回归档列表</button><h4>{preview.title}</h4><FilePreviewProvider workspaceId={previewWorkspace?.id} root={previewWorkspace?.path} cwd={preview.cwd} threadId={preview.id} preferences={prefs}><GenuiProvider inlinePanels threadId={preview.id} enabled={prefs.genui} streaming={false} onAction={async () => { throw new Error('请先恢复这个归档会话，再提交交互') }} onOpen={() => {}}><div className="archive-preview">{preview.items.map(item => <TranscriptItem key={item.id} item={item} autoRecovery={Boolean(item.turnId && preview.runs?.some(run => run.id === item.turnId && run.recoveryOf))} />)}</div></GenuiProvider></FilePreviewProvider></> : <><p className="settings-description">归档会话仍保留内容，可以随时查看或恢复。</p><label className="settings-search"><Search size={16} /><input aria-label="搜索归档会话" placeholder="搜索标题或工作区" value={search} onChange={event => setSearch(event.target.value)} /></label>{loading ? <div className="settings-loading"><LoaderCircle className="spin" />读取归档…</div> : <div className="archive-list">{archives.filter(row => `${row.title} ${row.cwd}`.toLowerCase().includes(search.toLowerCase())).map(row => <article key={row.id}><div><strong>{row.title}</strong><small title={row.cwd}>{props.workspaces.find(w => row.cwd === w.path)?.name || row.cwd}</small></div><button disabled={saving > 0} onClick={() => void action(async () => setPreview(await api<ThreadView>(`/archives/${encodeURIComponent(row.id)}`)))}>查看</button><button disabled={saving > 0} onClick={() => void action(async () => { await api(`/threads/${encodeURIComponent(row.id)}/restore`, {}); setArchives(rows => rows.filter(value => value.id !== row.id)); props.onRestored(row.id) })}>恢复并打开</button></article>)}{!archives.length && <p className="settings-empty">还没有归档的会话</p>}</div>}</>}</>}
      {tab === 'shortcuts' && <><p className="settings-description">输入 / 打开命令菜单，输入 $ 选择 Skill。浏览器保留的快捷键继续由 Edge 处理。</p><div className="shortcut-list">{shortcuts.map(([name, key]) => <div key={name}><span>{name}</span><kbd>{key}</kbd></div>)}</div></>}
      {tab === 'status' && <StatusPanel model={props.current?.options.model || props.current?.model} tokens={props.current?.tokens} />}
      {tab === 'connection' && <ConnectionPanel boot={props.boot} connected={props.connected} online={props.online} runtime={props.runtime} thread={props.thread} onReconnect={props.onReconnect} />}
    </div>
  </div>
}
