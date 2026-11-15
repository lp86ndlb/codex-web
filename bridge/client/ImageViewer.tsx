import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { IconButton } from './components.tsx'
import './image-viewer.css'

/** One viewer for generated pictures and uploaded attachments; only the open image is mounted. */
export function ImageViewer({ src, alt, initialZoom = 'fit', onError }: {
  src: string; alt: string; initialZoom?: 'fit' | 'actual'; onError: () => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 }), [bounds, setBounds] = useState({ width: 1, height: 1 })
  const [zoom, setZoom] = useState<number | null>(initialZoom === 'actual' ? 1 : null)
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number }>()
  useEffect(() => {
    const node = viewport.current!
    const observer = new ResizeObserver(() => setBounds({ width: node.clientWidth, height: node.clientHeight }))
    observer.observe(node); return () => observer.disconnect()
  }, [])
  const fit = size.width ? Math.min(1, Math.max(1, bounds.width - 32) / size.width, Math.max(1, bounds.height - 32) / size.height) : 1
  const scale = zoom ?? fit
  const previousScale = useRef(scale)
  useLayoutEffect(() => {
    const node = viewport.current!, factor = scale / previousScale.current
    node.scrollLeft = (node.scrollLeft + node.clientWidth / 2) * factor - node.clientWidth / 2
    node.scrollTop = (node.scrollTop + node.clientHeight / 2) * factor - node.clientHeight / 2
    previousScale.current = scale
  }, [scale])
  const magnify = (factor: number) => setZoom(Math.min(8, Math.max(0.05, scale * factor)))
  function reset() { setZoom(null); viewport.current?.scrollTo(0, 0) }
  return <div className="image-viewer">
    <div className="image-viewer-toolbar" role="toolbar" aria-label="图片缩放">
      <span>{size.width ? `${size.width} × ${size.height}` : '读取图片…'}</span>
      <IconButton label="缩小图片" disabled={!size.width || scale <= 0.05} onClick={() => magnify(1 / 1.25)}><ZoomOut size={16} /></IconButton>
      <output aria-label="图片缩放比例">{Math.round(scale * 100)}%</output>
      <IconButton label="放大图片" disabled={!size.width || scale >= 8} onClick={() => magnify(1.25)}><ZoomIn size={16} /></IconButton>
      <button type="button" aria-label="原始大小" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>1:1</button>
      <button type="button" aria-label="适应窗口" aria-pressed={zoom === null} onClick={reset}><Maximize size={15} /><span>适应</span></button>
    </div>
    <div ref={viewport} className="image-viewer-viewport" data-pannable={size.width * scale > bounds.width || size.height * scale > bounds.height || undefined} role="region" aria-label="图片查看器" tabIndex={0}
      onDoubleClick={() => zoom === null ? setZoom(1) : reset()}
      onKeyDown={event => {
        if (event.key === '+' || event.key === '=') { event.preventDefault(); magnify(1.25) }
        if (event.key === '-') { event.preventDefault(); magnify(1 / 1.25) }
        if (event.key === '0') { event.preventDefault(); reset() }
        if (event.key === '1') { event.preventDefault(); setZoom(1) }
      }}
      onPointerDown={event => {
        if (event.button !== 0 || event.pointerType === 'touch') return
        const node = event.currentTarget
        if (node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight) return
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop }
        node.setPointerCapture(event.pointerId); node.dataset.dragging = 'true'; event.preventDefault(); node.focus({ preventScroll: true })
      }}
      onPointerMove={event => {
        const state = drag.current
        if (state?.id === event.pointerId) { event.currentTarget.scrollLeft = state.left + state.x - event.clientX; event.currentTarget.scrollTop = state.top + state.y - event.clientY }
      }}
      onPointerUp={event => { drag.current = undefined; delete event.currentTarget.dataset.dragging }}
      onLostPointerCapture={event => { drag.current = undefined; delete event.currentTarget.dataset.dragging }}>
      <div className="image-viewer-canvas" style={{ width: Math.max(bounds.width, size.width * scale + 32), height: Math.max(bounds.height, size.height * scale + 32) }}>
        <img src={src} alt={alt} draggable={false} decoding="async" style={size.width ? { width: size.width * scale, height: size.height * scale } : { visibility: 'hidden' }}
          onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={onError} />
      </div>
    </div>
    <div className="image-viewer-hint">双击切换原始大小 · 放大后可拖动 · <kbd>+</kbd> <kbd>−</kbd> 缩放 · <kbd>0</kbd> 适应</div>
  </div>
}
