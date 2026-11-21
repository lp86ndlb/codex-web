import React, { Component, memo, useEffect, useMemo, useRef, type ComponentType, type ReactNode } from 'react'
import createPlugin from '../plugins/todo-note/client.js'
import { todoCount, todoCountEvent, type TodoCountSource } from '../shared/todo-count.ts'
import { api } from './api.ts'

class PluginBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  render() { return this.state.error ? <div className="plugin-error">便签界面加载失败，请刷新页面；已保存的待办仍保留。</div> : this.props.children }
}
/** Narrow DSH host facade: only this plugin's declared services are implemented. */
type PanelProps = { linkPending?: boolean; running?: boolean; docked?: boolean }
export const TodoNote = memo(function TodoNote({ sessionId, send, linkPending, running, layout = 'floating' }: { sessionId: string; send: (id: string, text: string) => Promise<void>; linkPending: boolean; running: boolean; layout?: 'sidebar' | 'floating' }) {
  const current = useRef({ sessionId, send }); current.current = { sessionId, send }
  const adapter = useMemo(() => {
    const listeners = new Set<() => void>()
    const effects: (() => (() => void) | void)[] = []
    let Panel: ComponentType<PanelProps> = () => null
    const services: Record<string, unknown> = {
      locale: { getLocale: () => ({ id: 'zh' }) },
      sidebarRight: { mounted: { getSnapshot: () => current.current.sessionId, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } } },
      sessions: { scope: (id: string) => ({ get: () => ({ send: (text: string) => current.current.send(id, text) }) }) },
      slots: { inject: (_slot: string, register: () => void) => register(), register: (_meta: unknown, panel: ComponentType<PanelProps>) => { Panel = panel } },
    }
    const plugin = createPlugin(name => { if (name === 'react') return React; throw new Error(`Unsupported plugin import: ${name}`) }, async (path, body) => {
      const action = path.endsWith('/act') ? 'act' : 'get'
      const response = await api<{ value: { note?: TodoCountSource } }>(`/plugins/todo-note/${action}`, body)
      if (response.value.note) window.dispatchEvent(new CustomEvent(todoCountEvent, { detail: todoCount(body.sessionId, response.value.note) }))
      return response.value
    })
    plugin.apply({ get: (name: string) => services[name], effect: (mount: () => (() => void) | void) => effects.push(mount) })
    return { Panel, effects, listeners }
  }, [])
  useEffect(() => { const cleanup = adapter.effects.map(mount => mount()); return () => { cleanup.forEach(dispose => dispose?.()) } }, [adapter])
  useEffect(() => { adapter.listeners.forEach(listener => listener()) }, [sessionId, adapter])
  return <PluginBoundary><adapter.Panel linkPending={linkPending} running={running} docked={layout === 'sidebar'} /></PluginBoundary>
})
