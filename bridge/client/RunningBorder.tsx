import { useLayoutEffect, useRef } from 'react'

export const runningStyles = [
  { id: 'orbit', title: '环行短线', detail: '短线沿边框行进，轮廓清楚' },
  { id: 'underline', title: '底边巡航', detail: '只在底边往返，安静而明确' },
  { id: 'breath', title: '柔和呼吸', detail: '整圈描边缓慢明暗，无光斑' },
  { id: 'dots', title: '三点律动', detail: '右上角轻巧律动，边框保持静止' },
  { id: 'none', title: '仅文字计时', detail: '关闭输入框动画，保留状态和用时' },
] as const
export type RunningStyle = typeof runningStyles[number]['id']
export const defaultRunningStyle: RunningStyle = 'underline'
export function isRunningStyle(value: unknown): value is RunningStyle { return runningStyles.some(style => style.id === value) }

/** A short, flat marker follows the outline. Its size cannot reach the opposite
 * edge of the composer. Animate transforms without per-frame JS or layout. */
function outline(width: number, height: number) {
  const inset = 2
  const radius = Math.min(16.5, (width - 4) / 2, (height - 4) / 2)
  const points = [{ x: radius + inset, y: inset, rotation: 0, distance: 0 }]
  let distance = 0
  function line(x: number, y: number, rotation: number) {
    const last = points.at(-1)!
    distance += Math.hypot(x - last.x, y - last.y)
    points.push({ x, y, rotation, distance })
  }
  function corner(x: number, y: number, start: number) {
    for (let i = 1; i <= 6; i++) {
      const angle = start + i * Math.PI / 12
      distance += radius * Math.PI / 12
      points.push({ x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle), rotation: (angle + Math.PI / 2) * 180 / Math.PI, distance })
    }
  }
  line(width - radius - inset, inset, 0); corner(width - radius - inset, radius + inset, -Math.PI / 2)
  line(width - inset, height - radius - inset, 90); corner(width - radius - inset, height - radius - inset, 0)
  line(radius + inset, height - inset, 180); corner(radius + inset, height - radius - inset, Math.PI / 2)
  line(inset, radius + inset, 270); corner(radius + inset, radius + inset, Math.PI)
  return { frames: points.map(point => ({ offset: point.distance / distance, transform: `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%) rotate(${point.rotation}deg)` })), duration: Math.max(6500, distance * 4) }
}

export function RunningBorder({ variant = defaultRunningStyle }: { variant?: RunningStyle }) {
  const root = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const host = root.current
    if (!host) return
    const node = host.querySelector<HTMLElement>('.composer-run-light')
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let animation: Animation | undefined; let duration = 0; let phase = 0; let visible = true
    function refresh() {
      if (animation && duration) phase = Number(animation.currentTime || 0) % duration / duration
      animation?.cancel(); animation = undefined
      const still = reduced.matches || document.documentElement.dataset.animations === 'false' || document.hidden || !visible
      host!.toggleAttribute('data-still', still)
      if (!node) return
      const { width, height } = host!.getBoundingClientRect()
      if (width <= 1 || height <= 1) return
      const transform = (x: number) => `translate3d(${x}px, ${height - 2}px, 0) translate(-50%, -50%)`
      const margin = 20 + node.clientWidth / 2
      const path = variant === 'underline' ? { duration: 6000, frames: [
        { offset: 0, transform: transform(margin), easing: 'cubic-bezier(.45,0,.55,1)' },
        { offset: .5, transform: transform(Math.max(margin, width - margin)), easing: 'cubic-bezier(.45,0,.55,1)' },
        { offset: 1, transform: transform(margin) },
      ] } : outline(width, height)
      duration = path.duration
      node.style.transform = variant === 'underline' && still ? transform(width / 2) : path.frames[0].transform
      if (still) return
      animation = node.animate(path.frames, { id: variant === 'underline' ? 'composer-underline' : 'composer-orbit', duration, iterations: Infinity })
      animation.currentTime = phase * duration
    }
    const size = new ResizeObserver(refresh); if (node) size.observe(host)
    const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; refresh() }); intersection.observe(host)
    const settings = new MutationObserver(refresh); settings.observe(document.documentElement, { attributes: true, attributeFilter: ['data-animations'] })
    reduced.addEventListener('change', refresh); document.addEventListener('visibilitychange', refresh); refresh()
    return () => { size.disconnect(); intersection.disconnect(); settings.disconnect(); reduced.removeEventListener('change', refresh); document.removeEventListener('visibilitychange', refresh); animation?.cancel() }
  }, [variant])
  if (variant === 'none') return null
  if (variant === 'breath') return <span ref={root} className="composer-run-breath" data-variant={variant} aria-hidden="true" />
  if (variant === 'dots') return <span ref={root} className="composer-run-dots" data-variant={variant} aria-hidden="true"><i /><i /><i /></span>
  return <span ref={root} className="composer-run-border" data-variant={variant} aria-hidden="true"><i className="composer-run-light" /></span>
}
