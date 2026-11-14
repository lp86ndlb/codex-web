import { Component, lazy, Suspense, type ComponentProps, type ComponentType, type ReactNode } from 'react'

class PanelBoundary extends Component<{ name: string; retry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? <div className="plugin-error" role="alert">{this.props.name}暂未加载，草稿已保留。<button type="button" onClick={this.props.retry}>刷新重试</button></div> : this.props.children
  }
}

/** Split optional panels without letting a failed chunk replace the whole app. */
export function deferredPanel<Props extends object>(name: string, load: () => Promise<{ default: ComponentType<Props> }>) {
  const Panel = lazy(load)
  return function DeferredPanel(props: Props) {
    // Browsers cache rejected module imports. A fresh document retries the
    // failed download; the composer's pagehide handler flushes pending drafts.
    return <PanelBoundary name={name} retry={() => window.location.reload()}><Suspense fallback={null}><Panel key={name} {...props as ComponentProps<typeof Panel>} /></Suspense></PanelBoundary>
  }
}
