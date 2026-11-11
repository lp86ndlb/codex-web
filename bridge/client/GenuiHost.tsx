import { createContext, lazy, memo, Suspense, useContext, useMemo, useState, type ReactNode } from 'react'
import { Braces, Copy, LoaderCircle, X } from 'lucide-react'
import type { GenuiPanelInfo } from '../shared/types.ts'
const Canvas = lazy(() => import('./GenuiCanvas.tsx'))
export const GenuiMessage = createContext({ id: 'message', streaming: false })
const context = createContext<{ threadId: string; enabled: boolean; streaming: boolean; inlinePanels?: boolean; onAction: (action: string, payload: Record<string, unknown>) => Promise<void>; onOpen: () => void } | null>(null)
export function GenuiProvider({ threadId, enabled, streaming, inlinePanels = false, onAction, onOpen, children }: { threadId: string; enabled: boolean; streaming: boolean; inlinePanels?: boolean; onAction: (action: string, payload: Record<string, unknown>) => Promise<void>; onOpen: () => void; children: ReactNode }) {
  const value = useMemo(() => ({ threadId, enabled, streaming, inlinePanels, onAction, onOpen }), [threadId, enabled, streaming, inlinePanels, onAction, onOpen])
  return <context.Provider value={value}>{children}</context.Provider>
}
export const GenuiFence = memo(function GenuiFence({ raw, slot, streaming = false }: { raw: string; slot: string; streaming?: boolean }) {
  const host = useContext(context); const [error, setError] = useState('')
  if (!host?.enabled) return <details className="genui-source"><summary>GenUI 已停用 · 在设置中启用后可显示交互界面</summary><pre><code>{raw}</code></pre></details>
  return <div className="cweb-genui">{error && <p className="genui-action-error" role="alert">{error}</p>}<Suspense fallback={<div className="genui-loading"><LoaderCircle size={16} className="spin" />正在加载交互组件…</div>}><Canvas raw={raw} slot={`${host.threadId}:${slot}`} streaming={streaming} inlinePanel={host.inlinePanels} onOpen={host.onOpen} onAction={(action, payload) => { setError(''); void host.onAction(action, payload).catch(error => setError(error instanceof Error ? error.message : '交互发送失败，请重试')) }} /></Suspense></div>
})
export const GenuiPanel = memo(function GenuiPanel({ panels, closing = false, onClose }: { panels: GenuiPanelInfo[]; closing?: boolean; onClose: () => void }) {
  const [selected, setSelected] = useState('')
  const [demo, setDemo] = useState(false)
  const panel = panels.find(row => row.id === selected) || panels.at(-1)
  return <aside className="genui-panel" data-exiting={closing || undefined} aria-label="GenUI 交互面板"><header><Braces size={17} /><strong>{panel?.title || 'GenUI'}</strong><button title="复制 JSON" aria-label="复制面板 JSON" disabled={!panel} onClick={() => panel && void navigator.clipboard.writeText(JSON.stringify(panel.spec, null, 2))}><Copy size={15} /></button><button aria-label="关闭交互面板" onClick={onClose}><X size={17} /></button></header>{panels.length > 1 && <nav>{panels.map(row => <button className={row.id === panel?.id ? 'active' : ''} key={row.id} onClick={() => setSelected(row.id)}>{row.title}</button>)}</nav>}{panel ? <div className="genui-panel-body"><GenuiFence raw={JSON.stringify(panel.spec)} slot={`panel:${panel.id}`} /></div> : demo ? <div className="genui-panel-body"><p className="genui-demo-note">本地组件预览 · 操作不会发送消息</p><GenuiFence raw={JSON.stringify({ title: 'GenUI 交互预览', items: [{ type: 'text', content: '图表、公式和表单可以直接出现在回答里。' }, { type: 'chart', kind: 'bars', data: [{ label: '设计', value: 8 }, { label: '实现', value: 12 }, { label: '验证', value: 6 }] }, { type: 'input', id: 'preview-name', label: '项目名称', placeholder: '试试输入一个名称' }, { type: 'checkbox', id: 'preview-check', label: '我已体验交互组件' }, { type: 'text', content: '公式也能渲染：$E = mc^2$' }] })} slot="preview" /></div> : <div className="genui-empty"><Braces size={28} /><h3>让回答成为可交互的界面</h3><p>输入 /genui 或选择 $genui，让 Codex 生成表单、图表、函数图或面板。</p><button className="primary" onClick={() => setDemo(true)}>预览交互组件</button></div>}</aside>
})
