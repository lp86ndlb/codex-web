import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'

/** Follow only while the reader stays at the bottom; layout growth is not a user scroll. */
export function useConversationScroll(viewport: RefObject<HTMLDivElement>, content: RefObject<HTMLDivElement>, follow: MutableRefObject<boolean>, threadId: string | null, dock: RefObject<HTMLDivElement>) {
  const [away, setAway] = useState(false)
  const intention = useRef({ direction: 0, at: 0 })
  const pause = useCallback(() => { follow.current = false; intention.current.direction = 0 }, [])
  const jump = useCallback(() => { intention.current.direction = 0; follow.current = true; setAway(false); const node = viewport.current; if (node) node.scrollTop = node.scrollHeight }, [])
  useEffect(() => {
    const node = viewport.current; const body = content.current
    if (!node || !body) return
    follow.current = true; setAway(false)
    let frame = 0; let lastTop = node.scrollTop; let touchY = 0
    intention.current.direction = 0; let draggingScrollbar = false
    const gap = () => Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop)
    const update = () => {
      frame = 0
      if (follow.current) { node.scrollTop = node.scrollHeight; lastTop = node.scrollTop; setAway(false) }
      else setAway(gap() > 24)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const scroll = () => {
      const remaining = gap(); const delta = node.scrollTop - lastTop; lastTop = node.scrollTop
      if (draggingScrollbar && delta < 0) follow.current = false
      // Only an intentional downward movement can resume following. A late
      // scroll event at gap=0 must never override an upward wheel/touch gesture.
      const movingDown = delta > 0 && (draggingScrollbar || (intention.current.direction > 0 && performance.now() - intention.current.at < 1000))
      if (!follow.current && remaining <= 24 && movingDown) { follow.current = true; setAway(false) }
      schedule()
    }
    const gesture = (value: number) => { intention.current = { direction: value, at: performance.now() }; if (value < 0) follow.current = false }
    const wheel = (event: WheelEvent) => { if (event.deltaY) gesture(Math.sign(event.deltaY)) }
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY || 0 }
    const touch = (event: TouchEvent) => { const next = event.touches[0]?.clientY ?? touchY; gesture(Math.sign(touchY - next)); touchY = next }
    const pointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (dock.current?.contains(target)) return
      draggingScrollbar = event.clientX >= node.getBoundingClientRect().right - 16
      if (draggingScrollbar || target.closest('button,summary,a,input,textarea,select,[role="button"]')) { pause(); lastTop = node.scrollTop; setAway(gap() > 24) }
    }
    const release = () => { if (draggingScrollbar && gap() <= 2) { follow.current = true; setAway(false); schedule() }; draggingScrollbar = false }
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if ((node.contains(target) || target === document.body) && !dock.current?.contains(target) && !target.closest('input,textarea,select,[contenteditable="true"]')) {
        if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) gesture(-1)
        if (['PageDown', 'End', 'ArrowDown'].includes(event.key)) gesture(1)
        if (event.key === 'End') { event.preventDefault(); follow.current = true; setAway(false); schedule() }
        if (event.key === 'Home') { event.preventDefault(); node.scrollTop = 0; schedule() }
      }
    }
    let dockHeight = -1
    const resize = new ResizeObserver(() => {
      const height = dock.current?.offsetHeight || 0
      if (height !== dockHeight) {
        dockHeight = height
        node.parentElement?.style.setProperty('--composer-height', `${height}px`)
        node.style.scrollPaddingBottom = `${height + 8}px`
      }
      schedule()
    }); resize.observe(body); resize.observe(node); if (dock.current) resize.observe(dock.current)
    node.addEventListener('scroll', scroll, { passive: true }); node.addEventListener('wheel', wheel, { passive: true }); node.addEventListener('touchstart', touchStart, { passive: true }); node.addEventListener('touchmove', touch, { passive: true }); node.addEventListener('pointerdown', pointer)
    document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release)
    document.addEventListener('keydown', keyboard); schedule()
    return () => { cancelAnimationFrame(frame); resize.disconnect(); node.removeEventListener('scroll', scroll); node.removeEventListener('wheel', wheel); node.removeEventListener('touchstart', touchStart); node.removeEventListener('touchmove', touch); node.removeEventListener('pointerdown', pointer); document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', release); document.removeEventListener('keydown', keyboard) }
  }, [threadId])
  return { away, jump, pause }
}
