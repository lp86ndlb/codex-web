import { memo, useEffect, useRef, useState } from 'react'
import { ChevronRight, File, FilePlus2, Folder, GitBranch, RefreshCw, X, ArrowUpLeft, FileDiff, ListChecks } from 'lucide-react'
import type { Change, FileEntry, ThreadView } from '../shared/types.ts'
import { api, message } from './api.ts'
import { Diff, IconButton, Notice } from './components.tsx'

export const Inspector = memo(function Inspector({ cwd, root, workspaceId, thread, closing = false, onReference, onClose }: {
  cwd: string; root: string; workspaceId: string; thread?: ThreadView; closing?: boolean; onReference: (path: string) => void; onClose: () => void
}) {
  const [tab, setTab] = useState<'changes' | 'files'>('changes')
  const [changes, setChanges] = useState<Change[]>([])
  const [branch, setBranch] = useState('')
  const [isGit, setIsGit] = useState(false)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [directory, setDirectory] = useState(cwd)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ path: string; text: string; diff: boolean } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewRequest = useRef(0)
  useEffect(() => { setDirectory(cwd); setPreview(null) }, [cwd])
  useEffect(() => {
    previewRequest.current++; setPreview(null); setPreviewing(false)
    return () => { previewRequest.current++ }
  }, [cwd, directory, tab])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    const request = tab === 'changes'
      ? api<{ changes: Change[]; branch: string; git: boolean }>(`/changes?workspace=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(cwd)}`).then(value => { if (!cancelled) { setChanges(value.changes); setBranch(value.branch); setIsGit(value.git) } })
      : api<FileEntry[]>(`/files?workspace=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(directory)}`).then(value => { if (!cancelled) setFiles(value) })
    request.catch(error => { if (!cancelled) setError(message(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tab, cwd, workspaceId, directory, revision, thread?.status])

  async function open(path: string, diff: boolean) {
    const request = ++previewRequest.current
    setError(''); setPreviewing(true)
    try {
      const result = await api<{ text: string }>(diff ? `/diff?workspace=${encodeURIComponent(workspaceId)}&cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}` : `/file?workspace=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`)
      if (request === previewRequest.current) setPreview({ path, text: result.text, diff })
    } catch (error) { if (request === previewRequest.current) setError(message(error)) }
    finally { if (request === previewRequest.current) setPreviewing(false) }
  }

  return <aside className="inspector" data-exiting={closing || undefined} aria-label="工作区面板">
    <div className="inspector-header"><div className="tabs"><button className={tab === 'changes' ? 'active' : ''} onClick={() => { setTab('changes'); setPreview(null) }}>变更 <span>{changes.length}</span></button><button className={tab === 'files' ? 'active' : ''} onClick={() => { setTab('files'); setPreview(null) }}>文件</button></div><IconButton label="刷新文件" onClick={() => setRevision(revision + 1)} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /></IconButton><IconButton label="关闭工作区面板" onClick={onClose}><X size={15} /></IconButton></div>
    <div className="inspector-body">
      {error && <Notice text={error} onClose={() => setError('')} />}
      {tab === 'changes' ? <>
        <div className="workspace-meta"><GitBranch size={14} /><span>{branch || (isGit ? '当前分支' : '工作区')}</span><span className="muted">未提交</span></div>
        {loading ? <div className="skeleton-list"><i /><i /><i /></div> : changes.length ? <div className="file-list">{changes.map(change => <button key={change.path} disabled={previewing} onClick={() => void open(change.path, true)}><FileDiff size={15} /><span title={change.path}>{change.path}</span><b className={change.status === 'D' ? 'deleted' : ''}>{change.status === '??' ? 'U' : change.status}</b></button>)}</div> : <div className="panel-empty"><div className="empty-icon"><FileDiff size={22} /></div><p>{isGit ? '工作区很干净' : '这里还没有 Git 仓库'}</p><span>{isGit ? '文件改动会显示在这里' : '仍可浏览文件并与 Codex 协作'}</span></div>}
        {thread?.plan.length ? <section className="plan-panel"><h3><ListChecks size={15} />执行计划</h3>{thread.plan.map((row, index) => <div key={index} className={`plan-row ${row.status}`}><span>{row.status === 'completed' ? '✓' : index + 1}</span><p>{row.step}</p></div>)}</section> : null}
        {thread?.diff && <button className="turn-diff-button" onClick={() => setPreview({ path: '本轮累计改动', text: thread.diff, diff: true })}><FileDiff size={15} />查看本轮差异<ChevronRight size={14} /></button>}
      </> : <>
        <div className="file-breadcrumb"><button disabled={directory === root || directory === '.'} onClick={() => setDirectory(directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) || root : root)}><ArrowUpLeft size={14} />上一级</button><span title={directory}>{directory === root ? '/' : directory.replace(root, '')}</span></div>
        {loading ? <div className="skeleton-list"><i /><i /><i /></div> : <div className="file-list">{files.map(file => <div className="file-row" key={file.path}><button disabled={previewing} onClick={() => file.directory ? setDirectory(file.path) : void open(file.path, false)}>{file.directory ? <Folder size={15} /> : <File size={15} />}<span>{file.name}</span>{file.directory && <ChevronRight size={12} />}</button>{!file.directory && <button className="reference-button" title="引用此文件" aria-label={`引用 ${file.name}`} onClick={() => onReference(file.path)}><FilePlus2 size={15} /></button>}</div>)}{!files.length && <p className="panel-hint">这个目录没有可显示的文件</p>}</div>}
      </>}
      {preview && <section className="file-preview"><div className="preview-title"><span title={preview.path}>{preview.path}</span><IconButton label="关闭预览" onClick={() => setPreview(null)}><X size={14} /></IconButton></div>{preview.diff ? <Diff text={preview.text || '没有文本差异'} /> : <pre className="source-code">{preview.text}</pre>}</section>}
    </div>
    <div className="inspector-footer"><span className="status-dot" />文件保存在本机工作区</div>
  </aside>
}, (a, b) => a.closing === b.closing && a.cwd === b.cwd && a.root === b.root && a.workspaceId === b.workspaceId && a.onReference === b.onReference && a.onClose === b.onClose && a.thread?.id === b.thread?.id && a.thread?.status === b.thread?.status && a.thread?.plan === b.thread?.plan && a.thread?.diff === b.thread?.diff)
