import { memo, useContext, useEffect, useRef, useState } from 'react'
import { ExternalLink, ImageIcon, LoaderCircle, RefreshCw } from 'lucide-react'
import { resolveChatLink } from '../shared/chat-links.ts'
import { api, message } from './api.ts'
import { FileLinks } from './FileLinks.tsx'
import './local-image.css'

export interface LocalImageInfo { path: string; mime: string; size: number; version: string }
export const isRasterImagePath = (path: string) => /\.(?:png|jpe?g|webp|gif|avif)$/i.test(path)
export function imageContentUrl(workspace: string, path: string, version: string, refresh = 0) {
  return `/api/image?${new URLSearchParams({ workspace, path, v: version, refresh: String(refresh) })}`
}

/** Read the current workspace image once, then again when the answer settles or the user refreshes. */
export const LocalImage = memo(function LocalImage({ path, alt = '', streaming = false }: { path: string; alt?: string; streaming?: boolean }) {
  const scope = useContext(FileLinks)
  const resolved = resolveChatLink(path, { root: scope.root, cwd: scope.cwd, origin: window.location.origin })
  const localPath = resolved.kind === 'file' ? resolved.path : ''
  const [info, setInfo] = useState<LocalImageInfo | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    const request = ++generation.current
    setLoading(true); setError(''); setInfo(null)
    if (!scope.workspaceId || !localPath) { setError('请先打开图片所在的工作区'); setLoading(false); return }
    void api<LocalImageInfo>(`/image-info?${new URLSearchParams({ workspace: scope.workspaceId, path: localPath })}`).then(value => {
      if (!cancelled && generation.current === request) { setInfo(value); setRevision(previous => Math.max(Date.now(), previous + 1)) }
    }).catch(reason => { if (!cancelled) setError(message(reason)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [scope.workspaceId, localPath, streaming, refresh])
  const label = alt || info?.path.split('/').at(-1) || localPath.split('/').at(-1) || '本地图片'
  return <span className="local-image" data-local-image={localPath || undefined} aria-busy={loading}>
    {info && scope.workspaceId && !error ? <button type="button" className="local-image-stage" aria-label={`预览图片：${label}`} disabled={!scope.open} onClick={() => scope.open?.({ path: localPath })}><img key={revision} src={imageContentUrl(scope.workspaceId, localPath, info.version, revision)} alt={alt || label} loading="lazy" decoding="async" onError={() => setError('图片读取失败，可刷新后重试')} /></button>
      : <span className="local-image-placeholder" role={error ? 'alert' : 'status'}>{loading ? <LoaderCircle size={22} className="spin" /> : <ImageIcon size={24} />}<span>{error || '读取图片…'}</span></span>}
    <span className="local-image-caption"><span>{label}</span><span className="local-image-actions">{error && scope.open && localPath && <button type="button" aria-label={`预览图片：${label}`} onClick={() => scope.open?.({ path: localPath })}><ExternalLink size={13} /><span>打开</span></button>}<button type="button" aria-label={`刷新图片：${label}`} title="读取图片的最新版本" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} /><span>刷新</span></button></span></span>
  </span>
})
