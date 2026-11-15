import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowUp, Code2, Download, ExternalLink, FileText, Folder, FolderOpen, ImageIcon, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { api, ApiError, message } from './api.ts'
import { CopyButton, IconButton } from './components.tsx'
import { FileLinks, type FileDestination } from './FileLinks.tsx'
import { Markdown } from './Markdown.tsx'
import { useExitAction } from './Motion.tsx'
import type { FileEntry, Preferences } from '../shared/types.ts'
import { imageContentUrl, isRasterImagePath, type LocalImageInfo } from './LocalImage.tsx'
import { ImageViewer } from './ImageViewer.tsx'
import './file-preview.css'

type Preview = { path: string; kind: 'file' | 'directory' | 'image'; text?: string; language?: string; image?: LocalImageInfo }
interface Selection extends FileDestination { workspace: string; root: string; threadId?: string }
type DisplayPreferences = Pick<Preferences, 'filePreviewLayout' | 'inlineImageSize' | 'imagePreviewZoom'>
const defaults: DisplayPreferences = { filePreviewLayout: 'dialog', inlineImageSize: 'comfortable', imagePreviewZoom: 'fit' }

export function FilePreviewProvider({ workspaceId, root = '', cwd = root, threadId, preferences = defaults, children }: {
  workspaceId?: string; root?: string; cwd?: string; threadId?: string; preferences?: DisplayPreferences; children: ReactNode
}) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const open = useCallback((destination: FileDestination) => {
    // Uploaded image previews use only the existing authenticated attachment route.
    if (destination.imageUrl && !/^\/api\/attachments\/[0-9a-f-]+\/content$/i.test(destination.imageUrl)) return
    if (workspaceId || destination.imageUrl) setSelection({ ...destination, workspace: workspaceId || '', root, threadId })
  }, [workspaceId, root, threadId])
  const scope = useMemo(() => ({ workspaceId, root, cwd, threadId, imageSize: preferences.inlineImageSize, open }), [root, cwd, open, workspaceId, threadId, preferences.inlineImageSize])
  return <FileLinks.Provider value={scope}>{children}{selection && <FilePreview key={selection.workspace} selection={selection} preferences={preferences} onNavigate={setSelection} onClose={() => setSelection(null)} />}</FileLinks.Provider>
}

function FilePreview({ selection, preferences, onNavigate, onClose }: { selection: Selection; preferences: DisplayPreferences; onNavigate: (selection: Selection) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), content = useRef<HTMLDivElement>(null), source = useRef<HTMLTextAreaElement>(null)
  const [preview, setPreview] = useState<Preview | null>(null), [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [sourceView, setSourceView] = useState(false)
  const [previewError, setPreviewError] = useState(''), [opening, setOpening] = useState<'file' | 'folder' | null>(null)
  const [openFeedback, setOpenFeedback] = useState(''), [openFailed, setOpenFailed] = useState(false)
  const openRequest = useRef(0)
  const [reload, setReload] = useState(0), [imageRevision, setImageRevision] = useState(0)
  const [history, setHistory] = useState<Selection[]>([])
  const loadedSelection = useRef<Selection>()
  const { closing, exit } = useExitAction(onClose, dialog)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    openRequest.current++; setOpening(null); setOpenFeedback(''); setOpenFailed(false); setPreviewError('')
    setLoading(true); setError('')
    if (loadedSelection.current !== selection) { setPreview(null); setEntries([]); setSourceView(Boolean(selection.line)) }
    loadedSelection.current = selection
    const query = new URLSearchParams({ workspace: selection.workspace, path: selection.path, ...(selection.threadId ? { thread: selection.threadId } : {}) })
    const options = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]) }
    const request: Promise<Preview> = selection.imageUrl ? Promise.resolve({ path: selection.path, kind: 'image' }) : isRasterImagePath(selection.path)
      ? api<LocalImageInfo>(`/image-info?${query}`, undefined, options).then(image => ({ path: image.path, kind: 'image', image }))
      : api<Preview>(`/preview?${query}`, undefined, options)
    void request.then(async value => {
      if (controller.signal.aborted) return
      setPreview(value); setImageRevision(previous => Math.max(Date.now(), previous + 1))
      if (value.kind === 'directory') {
        const files = await api<FileEntry[]>(`/files?workspace=${encodeURIComponent(selection.workspace)}&path=${encodeURIComponent(value.path || '.')}`, undefined, options)
        if (!controller.signal.aborted) setEntries(files)
      }
    }).catch(reason => { if (!controller.signal.aborted) { setError(message(reason)); setPreviewError(reason instanceof ApiError ? reason.code : '') } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); openRequest.current++ }
  }, [selection, reload])
  const markdown = preview?.language === 'markdown'
  const showSource = sourceView || !markdown
  const navigate = useCallback((destination: FileDestination) => {
    setHistory(rows => [...rows.slice(-39), selection]); onNavigate({ ...destination, workspace: selection.workspace, root: selection.root, threadId: selection.threadId })
  }, [selection, onNavigate])
  const anchor = useCallback((id: string) => {
    const target = Array.from(content.current?.querySelectorAll('[id]') || []).find(element => element.id === id)
    target?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [])
  useEffect(() => {
    if (!preview || loading || preview.kind !== 'file') return
    if (!showSource) { if (selection.anchor) anchor(selection.anchor); else if (content.current) content.current.scrollTop = 0; return }
    const input = source.current
    if (!input) return
    const lines = (preview.text || '').split('\n'), line = Math.min(selection.line || 1, lines.length)
    const offset = lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0)
    input.setSelectionRange(offset, offset + (selection.line ? lines[line - 1].length : 0))
    input.scrollTop = Math.max(0, (line - 3) * parseFloat(getComputedStyle(input).lineHeight))
    if (selection.line) input.focus({ preventScroll: true })
  }, [preview, loading, showSource, selection, anchor])
  const path = preview?.path || selection.path
  const absolutePath = path.startsWith('/') ? path : `${selection.root}/${path === '.' ? '' : path}`.replace(/\/$/, '')
  const directory = preview?.kind === 'directory' ? absolutePath : absolutePath.slice(0, absolutePath.lastIndexOf('/'))
  const parent = absolutePath.slice(0, absolutePath.lastIndexOf('/'))
  const inWorkspace = absolutePath === selection.root || absolutePath.startsWith(selection.root + '/')
  const canBrowseParent = !selection.imageUrl && !loading && Boolean(preview) && inWorkspace && absolutePath !== selection.root
  const scope = useMemo(() => ({ workspaceId: selection.workspace, root: selection.root, cwd: directory, threadId: selection.threadId, imageSize: preferences.inlineImageSize, open: navigate, anchor }), [selection.workspace, selection.root, selection.threadId, directory, preferences.inlineImageSize, navigate, anchor])
  const imageSrc = selection.imageUrl || (preview?.image ? imageContentUrl(selection.workspace, preview.path, preview.image.version, imageRevision, selection.threadId) : '')
  function download() {
    if (preview?.kind === 'image') {
      const link = document.createElement('a'); link.href = imageSrc; link.download = preview.path.split('/').at(-1) || 'image'; link.click(); return
    }
    if (preview?.kind !== 'file') return
    const url = URL.createObjectURL(new Blob([preview.text || ''], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = preview.path.split('/').at(-1) || 'document.txt'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const canOpen = !selection.imageUrl && !loading && (Boolean(preview) || ['BINARY_FILE', 'FILE_LARGE', 'IMAGE_LARGE'].includes(previewError))
  async function openDefaultApp(kind: 'file' | 'folder' = 'file') {
    if (!canOpen || opening) return
    const request = ++openRequest.current
    setOpening(kind); setOpenFeedback(''); setOpenFailed(false)
    try {
      await api('/open-file', { workspace: selection.workspace, path: preview?.path || selection.path, ...(selection.threadId ? { thread: selection.threadId } : {}), ...(kind === 'folder' ? { containingFolder: true } : {}) })
      if (request === openRequest.current) setOpenFeedback(kind === 'folder' ? '已打开所在文件夹' : '已交给默认应用')
    } catch (reason) {
      if (request === openRequest.current) { setOpenFeedback(message(reason)); setOpenFailed(true) }
    } finally { if (request === openRequest.current) setOpening(null) }
  }
  return <dialog ref={dialog} className="file-preview-dialog" data-layout={preferences.filePreviewLayout} data-exiting={closing || undefined} aria-label="文件预览"
    onCancel={event => { event.preventDefault(); exit() }} onKeyDown={event => event.stopPropagation()} onClick={event => {
      if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) exit() }
    }}>
    <header className="file-preview-header">
      {history.length > 0 && <IconButton label="返回上一个文件" onClick={() => { onNavigate(history.at(-1)!); setHistory(rows => rows.slice(0, -1)) }}><ArrowLeft size={18} /></IconButton>}
      {preview?.kind === 'directory' ? <Folder size={19} /> : preview?.kind === 'image' ? <ImageIcon size={19} /> : <FileText size={19} />}
      <div><strong>{path.split('/').filter(Boolean).at(-1) || '工作区'}</strong><small>{preview?.kind === 'directory' ? '文件夹' : preview?.kind === 'image' ? '图片预览' : markdown ? 'Markdown 文档' : '文件预览'}{selection.line ? ` · 第 ${selection.line} 行` : ''}</small></div>
      <div className="file-preview-actions">
        {preview?.kind === 'file' && !loading && <>
          {markdown && <button type="button" className="file-preview-toggle" aria-pressed={sourceView} onClick={() => setSourceView(value => !value)}>{sourceView ? <FileText size={15} /> : <Code2 size={15} />}{sourceView ? '阅读' : '源码'}</button>}
          <CopyButton key={path} text={preview.text || ''} />
        </>}
        <IconButton label={preview?.kind === 'image' ? '刷新图片' : '刷新预览'} disabled={loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={17} /></IconButton>
        {preview && preview.kind !== 'directory' && !loading && <IconButton label={preview.kind === 'image' ? '下载图片' : '下载文件'} onClick={download}><Download size={17} /></IconButton>}
        <IconButton label="关闭文件预览" onClick={() => exit()}><X size={19} /></IconButton>
      </div>
    </header>
    {!selection.imageUrl && <nav className="file-preview-location" aria-label="文件位置">
      {canBrowseParent && <button type="button" onClick={() => navigate({ path: parent })}><ArrowUp size={14} />{preview?.kind === 'directory' ? '上一级' : '所在目录'}</button>}
      <span title={absolutePath}>{absolutePath}</span><CopyButton key={absolutePath} label="复制文件路径" text={absolutePath} />
    </nav>}
    <div ref={content} className="file-preview-body" aria-busy={loading}>
      {loading && !preview ? <div className="file-preview-state" role="status"><LoaderCircle size={22} className="spin" />读取文件…</div>
        : error ? <div className="file-preview-state" role="alert"><FileText size={26} /><strong>无法预览这个路径</strong><p>{error}</p>{previewError === 'FILE_MISSING' && isRasterImagePath(selection.path) && !inWorkspace && <p>临时图片可能已被清理，可让 Codex 重新生成并保存到工作区。</p>}<code>{path}</code></div>
        : preview?.kind === 'image' ? <ImageViewer key={`${path}:${preferences.imagePreviewZoom}`} src={imageSrc} alt={path.split('/').at(-1) || '图片预览'} initialZoom={preferences.imagePreviewZoom} onError={() => setError('图片无法解码，可刷新图片或使用默认应用打开')} />
        : preview?.kind === 'directory' ? <div className="file-preview-directory">{entries.map(entry => <button type="button" key={entry.path} onClick={() => navigate({ path: `${selection.root}/${entry.path}` })}>{entry.directory ? <Folder size={17} /> : isRasterImagePath(entry.path) ? <ImageIcon size={17} /> : <FileText size={17} />}<span>{entry.name}</span>{entry.directory && <span className="muted">目录</span>}</button>)}{!entries.length && <p className="muted">这个目录没有可展示的文件。</p>}</div>
        : preview && (showSource ? <textarea ref={source} className="file-preview-source" aria-label="文件源码" spellCheck={false} readOnly value={preview.text || ''} /> : <FileLinks.Provider value={scope}><article className="file-preview-document"><Markdown text={preview.text || ''} genui={false} collapseCode={false} headingIds /></article></FileLinks.Provider>)}
    </div>
    <footer className="file-preview-footer">
      <div className="file-preview-info"><span>{selection.imageUrl ? '附件预览' : preview?.image?.temporary ? '对话中的临时图片' : '只读预览 · 当前工作区'}</span><span className="file-preview-feedback" data-error={openFailed || undefined} role={openFailed ? 'alert' : 'status'}>{openFeedback || <>{preview?.kind === 'file' ? `${(preview.text || '').split('\n').length} 行 · ` : preview?.image ? `${Math.ceil(preview.image.size / 1024)} KB · ` : ''}<kbd>Esc</kbd> 关闭</>}</span></div>
      {canOpen && <div className="file-preview-launchers">
        {preview?.kind !== 'directory' && <button type="button" className="file-preview-folder" title="在运行 cweb 的电脑上打开所在文件夹" disabled={Boolean(opening)} onClick={() => void openDefaultApp('folder')}><FolderOpen size={16} /><span>{opening === 'folder' ? '正在打开…' : '打开所在文件夹'}</span></button>}
        <button type="button" className="file-preview-open" title="使用运行 cweb 的电脑上的默认应用" disabled={Boolean(opening)} onClick={() => void openDefaultApp()}>{opening === 'file' ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />}<span>{opening === 'file' ? '正在打开…' : '使用默认应用打开'}</span></button>
      </div>}
    </footer>
  </dialog>
}
