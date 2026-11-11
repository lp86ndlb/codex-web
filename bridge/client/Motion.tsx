import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react'

export function exitDuration() {
  // CSS fades take 180 ms; leave a frame of commit/paint time before removal.
  return document.documentElement.dataset.animations === 'false' || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220
}

/** Edge may defer a new compositor animation. Start it on the committed
 * frame so retained controls can visibly fade before the removal timer. */
export function useExitAnimation(element: RefObject<HTMLElement> | undefined, closing: boolean) {
  useLayoutEffect(() => {
    if (!closing || !element?.current) return
    for (const animation of element.current.getAnimations()) {
      if (animation instanceof CSSAnimation && animation.animationName.includes('exit')) animation.startTime = document.timeline.currentTime
    }
  }, [closing, element])
}

/** Keep the last visible children long enough to finish an exit transition. */
export function Presence({ show, children, elementRef, ...props }: HTMLAttributes<HTMLDivElement> & { show: boolean; children: ReactNode; elementRef?: RefObject<HTMLDivElement> }) {
  const localRef = useRef<HTMLDivElement>(null); const element = elementRef || localRef
  useExitAnimation(element, !show)
  const content = useRef(children); if (show) content.current = children
  const [mounted, setMounted] = useState(show)
  useEffect(() => {
    if (show) { setMounted(true); return }
    const timer = setTimeout(() => setMounted(false), exitDuration())
    return () => clearTimeout(timer)
  }, [show])
  return show || mounted ? <div ref={element} {...props} data-exiting={!show || undefined} aria-hidden={!show || undefined} {...(!show ? { inert: '' } : {})}>{content.current}</div> : null
}

/** Dialogs remain in the top layer until their closing animation finishes. */
export function useExitAction(onExit: () => void, element?: RefObject<HTMLElement>) {
  const [closing, setClosing] = useState(false); const timer = useRef<ReturnType<typeof setTimeout>>()
  const current = useRef(onExit); current.current = onExit
  useExitAnimation(element, closing)
  useEffect(() => () => clearTimeout(timer.current), [])
  const exit = useCallback((action?: () => void) => {
    if (timer.current) return
    const callback = typeof action === 'function' ? action : () => current.current()
    const duration = exitDuration()
    if (!duration) { callback(); return }
    setClosing(true)
    timer.current = setTimeout(() => { timer.current = undefined; callback(); setClosing(false) }, duration)
  }, [])
  return { closing, exit }
}

export function useExitList<T>(items: T[], key: keyof T) {
  const [retained, setRetained] = useState(items)
  useEffect(() => {
    const present = new Set(items.map(item => item[key]))
    setRetained(previous => [...items, ...previous.filter(item => !present.has(item[key]))])
    const timer = setTimeout(() => setRetained(items), exitDuration())
    return () => clearTimeout(timer)
  }, [items, key])
  const present = new Set(items.map(item => item[key]))
  return retained.map(item => ({ item, exiting: !present.has(item[key]) }))
}
