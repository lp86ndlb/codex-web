import { useLayoutEffect, useState, type RefObject } from 'react'

/** Unmount expensive disclosure contents only after the closing height transition. */
export function useDisclosureContent(open: boolean, element: RefObject<HTMLElement>, pseudo?: string) {
  const [retained, setRetained] = useState(open)
  useLayoutEffect(() => {
    if (open) { setRetained(true); return }
    if (!retained) return
    const node = element.current
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const disabled = () => document.documentElement.dataset.animations === 'false' || media.matches
    const style = node && getComputedStyle(node, pseudo)
    const milliseconds = (value: string) => value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000
    const durations = style?.transitionDuration.split(',').map(milliseconds) || []
    const delays = style?.transitionDelay.split(',').map(milliseconds) || []
    const duration = Math.max(0, ...durations.map((value, index) => value + (delays[index % delays.length] || 0)))
    if (!node || disabled() || !duration) { setRetained(false); return }
    let timer: ReturnType<typeof setTimeout>
    const finish = () => { clearTimeout(timer); setRetained(false) }
    const end = (event: TransitionEvent) => {
      if (event.target === node && event.propertyName === (pseudo ? 'block-size' : 'grid-template-rows') && (!pseudo || event.pseudoElement === pseudo)) finish()
    }
    const preference = () => { if (disabled()) finish() }
    // A detached/offscreen element need not emit transitionend. Leave one frame
    // after the full CSS duration before releasing the retained content.
    timer = setTimeout(finish, duration + 40)
    node.addEventListener('transitionend', end)
    media.addEventListener('change', preference)
    const observer = new MutationObserver(preference)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-animations'] })
    return () => { clearTimeout(timer); node.removeEventListener('transitionend', end); media.removeEventListener('change', preference); observer.disconnect() }
  }, [open, retained, element, pseudo])
  return open || retained
}
