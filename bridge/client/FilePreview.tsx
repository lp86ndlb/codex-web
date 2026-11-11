import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Code2, Download, FileText, Folder, LoaderCircle, X } from 'lucide-react'
import { api, message } from './api.ts'
import { CopyButton, IconButton } from './components.tsx'
import { FileLinks, type FileDestination } from './FileLinks.tsx'
import { Markdown } from './Markdown.tsx'
import { useExitAction } from './Motion.tsx'
import type { FileEntry } from '../shared/types.ts'
import './file-preview.css'

type Preview = { path: string; kind: 'file' | 'directory'; text?: string; language?: string }
interface Selection extends FileDestination { workspace: string; root: string }

export function FilePreviewProvider({ workspaceId, root = '', cwd = root, children }: { workspaceId?: string; root?: string; cwd?: string; children: ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const open = useCallback((destination: FileDestination) => {
    if (workspaceId) setSelection({ ...destination, workspace: workspaceId, root })
  }, [workspaceId, root])
  const scope = useMemo(() => ({ root, cwd, open: workspaceId ? open : undefined }), [root, cwd, open, workspaceId])
  return <FileLinks.Provider value={scope}>{children}{selection && <FilePreview key={selection.workspace} selection={selection} onNavigate={setSelection} onClose={() => setSelection(null)} />}</FileLinks.Provider>
}

function FilePreview({ selection, onNavigate, onClose }: { selection: Selection; onNavigate: (selection: Selection) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), content = useRef<HTMLDivElement>(null), source = useRef<HTMLTextAreaElement>(null)
  const [preview, setPreview] = useState<Preview | null>(null), [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [sourceView, setSourceView] = useState(false)
  const [history, setHistory] = useState<Selection[]>([])
  const { closing, exit } = useExitAction(onClose, dialog)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); setPreview(null); setEntries([]); setSourceView(Boolean(selection.line))
    void api<Preview>(`/preview?workspace=${encodeURIComponent(selection.workspace)}&path=${encodeURIComponent(selection.path)}`).then(async value => {
      if (cancelled) return
      setPreview(value)
      if (value.kind === 'directory') {
        const files = await api<FileEntry[]>(`/files?workspace=${encodeURIComponent(selection.workspace)}&path=${encodeURIComponent(value.path || '.')}`)
        if (!cancelled) setEntries(files)
      }
    }).catch(reason => { if (!cancelled) setError(message(reason)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selection])
  const markdown = preview?.language === 'markdown'
  const showSource = sourceView || !markdown
  const navigate = useCallback((destination: FileDestination) => {
    setHistory(rows => [...rows, selection]); onNavigate({ ...destination, workspace: selection.workspace, root: selection.root })
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
  const directory = preview?.kind === 'directory' ? path : path.slice(0, Math.max(0, path.lastIndexOf('/')))
  const scope = useMemo(() => ({ root: selection.root, cwd: `${selection.root}/${directory}`, open: navigate, anchor }), [selection.root, directory, navigate, anchor])
  function download() {
    if (preview?.kind !== 'file') return
    const url = URL.createObjectURL(new Blob([preview.text || ''], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = preview.path.split('/').at(-1) || 'document.txt'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <dialog ref={dialog} className="file-preview-dialog" data-exiting={closing || undefined} aria-label="文件预览" onCancel={event => { event.preventDefault(); exit() }} onKeyDown={event => event.stopPropagation()} onClick={event => {
    if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) exit() }
  }}><header className="file-preview-header">{history.length > 0 && <IconButton label="返回上一个文件" onClick={() => { onNavigate(history.at(-1)!); setHistory(rows => rows.slice(0, -1)) }}><ArrowLeft size={18} /></IconButton>}{preview?.kind === 'directory' ? <Folder size={19} /> : <FileText size={19} />}<div><strong>{path.split('/').filter(Boolean).at(-1) || '工作区'}</strong><small title={path}>{path || '.'}{selection.line ? ` · 第 ${selection.line} 行` : ''}</small></div><div className="file-preview-actions">{preview?.kind === 'file' && !loading && <>{markdown && <button type="button" className="file-preview-toggle" aria-pressed={sourceView} onClick={() => setSourceView(value => !value)}>{sourceView ? <FileText size={15} /> : <Code2 size={15} />}{sourceView ? '阅读' : '源码'}</button>}<CopyButton text={preview.text || ''} /><IconButton label="下载文件" onClick={download}><Download size={17} /></IconButton></>}<IconButton label="关闭文件预览" onClick={() => exit()}><X size={19} /></IconButton></div></header>
    <div ref={content} className="file-preview-body" aria-busy={loading}>{loading ? <div className="file-preview-state" role="status"><LoaderCircle size={22} className="spin" />读取文件…</div> : error ? <div className="file-preview-state" role="alert"><FileText size={26} /><strong>无法预览这个路径</strong><p>{error}</p><code>{path}</code></div> : preview?.kind === 'directory' ? <div className="file-preview-directory">{entries.map(entry => <button type="button" key={entry.path} onClick={() => navigate({ path: `${selection.root}/${entry.path}` })}>{entry.directory ? <Folder size={17} /> : <FileText size={17} />}<span>{entry.name}</span>{entry.directory && <span className="muted">目录</span>}</button>)}{!entries.length && <p className="muted">这个目录没有可展示的文件。</p>}</div> : preview && (showSource ? <textarea ref={source} className="file-preview-source" aria-label="文件源码" spellCheck={false} readOnly value={preview.text || ''} /> : <FileLinks.Provider value={scope}><article className="file-preview-document"><Markdown text={preview.text || ''} genui={false} collapseCode={false} headingIds /></article></FileLinks.Provider>)}</div>
    <footer className="file-preview-footer"><span>只读预览 · 当前工作区</span><span>{preview?.kind === 'file' && `${(preview.text || '').split('\n').length} 行 · `}<kbd>Esc</kbd> 关闭</span></footer>
  </dialog>
}
