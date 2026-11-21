import { useLayoutEffect, useRef, useState } from 'react'

const storageKey = 'cweb:inspector-width'
const minimum = 280, maximum = 640, defaultWidth = 340

function savedWidth() {
  try {
    const value = Number(localStorage.getItem(storageKey))
    if (Number.isFinite(value) && value >= minimum) return Math.min(maximum, value)
  } catch {}
  return defaultWidth
}

// Update the grid at most once per frame without rerendering the transcript,
// team graph or todo list for every pointer movement.
export function InspectorResize() {
  const handle = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null)
  const frame = useRef(0)
  const pending = useRef(defaultWidth)
  const [size, setSize] = useState(() => ({ width: savedWidth(), max: maximum }))

  function elements() {
    return { app: handle.current?.closest<HTMLElement>('.app'), panel: handle.current?.closest<HTMLElement>('.inspector') }
  }
  function limit() {
    const { app } = elements()
    if (!app || window.innerWidth <= 1180) return Math.min(maximum, window.innerWidth)
    const sidebar = app.classList.contains('sidebar-collapsed') ? 0 : parseFloat(getComputedStyle(app).getPropertyValue('--sidebar-width')) || 276
    return Math.max(minimum, Math.min(maximum, app.clientWidth - sidebar - 360))
  }
  function apply(value: number) {
    pending.current = Math.round(Math.max(minimum, Math.min(limit(), value)))
    elements().app?.style.setProperty('--inspector-preferred-width', `${pending.current}px`)
  }
  function finish(save = true) {
    if (!drag.current) return
    if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; apply(pending.current) }
    drag.current = null
    const { app } = elements()
    if (app) delete app.dataset.inspectorResizing
    if (save) try { localStorage.setItem(storageKey, String(pending.current)) } catch {}
  }
  useLayoutEffect(() => {
    const { app, panel } = elements()
    if (!app || !panel) return
    app.style.setProperty('--inspector-preferred-width', `${savedWidth()}px`)
    const measure = () => {
      const width = Math.round(panel.getBoundingClientRect().width), max = limit()
      setSize(previous => previous.width === width && previous.max === max ? previous : { width, max })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(panel); observer.observe(app)
    const main = app.querySelector('.main'); if (main) observer.observe(main)
    window.addEventListener('resize', measure)
    measure()
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); cancelAnimationFrame(frame.current); delete app.dataset.inspectorResizing }
  }, [])

  return <div ref={handle} className="inspector-resize" role="separator" tabIndex={0}
    aria-label="调整右侧栏宽度" aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={size.max} aria-valuenow={size.width}
    title="拖动调整宽度，双击恢复默认；也可使用左右方向键"
    onPointerDown={event => {
      if (event.button !== 0) return
      const { app, panel } = elements(); if (!app || !panel) return
      drag.current = { pointer: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width }
      pending.current = drag.current.width
      app.dataset.inspectorResizing = 'true'
      event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault()
    }}
    onPointerMove={event => {
      if (drag.current?.pointer !== event.pointerId) return
      pending.current = drag.current.width + drag.current.x - event.clientX
      if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; apply(pending.current) })
    }}
    onPointerUp={event => {
      if (drag.current?.pointer !== event.pointerId) return
      apply(drag.current.width + drag.current.x - event.clientX); finish()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onPointerCancel={() => finish()} onLostPointerCapture={() => finish()}
    onDoubleClick={() => { apply(defaultWidth); try { localStorage.removeItem(storageKey) } catch {} }}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const step = event.shiftKey ? 40 : 10
      const preferred = parseFloat(elements().app?.style.getPropertyValue('--inspector-preferred-width') || '') || defaultWidth
      const current = Math.min(limit(), preferred)
      apply(event.key === 'Home' ? minimum : event.key === 'End' ? limit() : current + (event.key === 'ArrowLeft' ? step : -step))
      try { localStorage.setItem(storageKey, String(pending.current)) } catch {}
    }} />
}
