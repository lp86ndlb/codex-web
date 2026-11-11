import { useEffect, useRef } from 'react'
import { ArrowUp, Paperclip, Plus } from 'lucide-react'
import { RunningBorder, runningStyles, type RunningStyle } from './RunningBorder.tsx'

/** The miniature and the live composer share the actual animation component. */
export function LoadingStylePicker({ value, onChange, autoFocus = false }: { value: RunningStyle; onChange: (value: RunningStyle) => void; autoFocus?: boolean }) {
  const root = useRef<HTMLFieldSetElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    const frame = requestAnimationFrame(() => { root.current?.scrollIntoView({ block: 'start' }); root.current?.querySelector<HTMLInputElement>('input:checked')?.focus({ preventScroll: true }) })
    return () => cancelAnimationFrame(frame)
  }, [autoFocus])
  return <fieldset ref={root} className="loading-style-picker"><legend>输入框运行效果</legend><p className="settings-footnote">选择即生效，可以随时切换。预览会遵循「界面动画」与系统减少动态效果设置。</p><div className="loading-style-grid">{runningStyles.map(style => <label key={style.id} className={`answer-choice loading-style-option ${value === style.id ? 'selected' : ''}`}>
    <span className="compact-composer loading-style-demo" aria-hidden="true"><span className="loading-demo-lines"><i /><i /></span><span className="loading-demo-tools"><Plus size={13} /><Paperclip size={13} /><i /><span><ArrowUp size={12} /></span></span><RunningBorder variant={style.id} /></span>
    <span className="loading-style-caption"><strong>{style.title}</strong><small>{style.detail}</small></span><input type="radio" name="cweb-loading-style" aria-label={style.title} checked={value === style.id} onChange={() => onChange(style.id)} />
  </label>)}</div></fieldset>
}
