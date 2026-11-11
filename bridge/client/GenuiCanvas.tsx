import { Component, useMemo, type ReactNode } from 'react'
import { GenuiBlock } from '../plugins/genui/client/GenuiBlock.tsx'
import { GenuiActionContext } from '../plugins/genui/client/action-context.ts'
import { setGenuiAssetBase } from '../plugins/genui/client/asset-loader.ts'
import { resolveFence } from '../plugins/genui/shared/fence-resolve.ts'
import 'katex/dist/katex.min.css'
setGenuiAssetBase('/genui/')
function fingerprint(text: string) { let value = 2166136261; for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619); return (value >>> 0).toString(36) }
class Boundary extends Component<{ children: ReactNode; raw: string }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  render() { return this.state.error ? <details className="genui-source" open><summary>交互组件暂时无法显示 · 查看源数据</summary><pre>{this.props.raw}</pre></details> : this.props.children }
}
export default function GenuiCanvas({ raw, slot, streaming, inlinePanel = false, onAction, onOpen }: { raw: string; slot: string; streaming: boolean; inlinePanel?: boolean; onAction: (action: string, payload: Record<string, unknown>) => void; onOpen: () => void }) {
  const resolved = useMemo(() => raw.length <= 200_000 ? resolveFence(raw, { settled: !streaming }) : null, [raw, streaming])
  const key = useMemo(() => `${slot}:${fingerprint(raw)}`, [raw, slot])
  if (!resolved?.spec) return <details className="genui-source" open={!streaming}><summary>{streaming ? '正在生成界面…' : '界面规格不完整 · 查看源数据'}</summary><pre>{raw}</pre></details>
  if (resolved.spec.panel && !inlinePanel && !slot.includes(':panel:')) return <button className="genui-open-panel" onClick={onOpen}>打开交互面板 · {resolved.spec.title || 'GenUI'}</button>
  return <Boundary raw={raw}><GenuiActionContext.Provider value={onAction}><GenuiBlock spec={resolved.spec} stateKey={streaming ? undefined : key} animateEntrance={false} /></GenuiActionContext.Provider></Boundary>
}
