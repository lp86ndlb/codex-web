import { createContext, useContext, type ReactNode } from 'react'
import { defaultUrlTransform } from 'react-markdown'
import { resolveChatLink } from '../shared/chat-links.ts'
import type { AttachmentInfo } from '../shared/types.ts'

export interface FileDestination { path: string; line?: number; anchor?: string; imageUrl?: string }
export interface FileLinkScope {
  workspaceId?: string
  threadId?: string
  imageSize?: 'comfortable' | 'compact'
  root: string
  cwd: string
  open?: (destination: FileDestination) => void
  anchor?: (anchor: string) => void
}
export const FileLinks = createContext<FileLinkScope>({ root: '', cwd: '' })

export function AttachmentLink({ file, className, children }: { file: AttachmentInfo; className: string; children: ReactNode }) {
  const scope = useContext(FileLinks)
  return <a className={className} href={file.url} target="_blank" rel="noopener noreferrer" aria-label={file.kind === 'image' ? `预览附件：${file.name}` : `打开附件：${file.name}`} onClick={event => {
    if (file.kind === 'image' && scope.open && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault(); scope.open({ path: file.name, imageUrl: file.url })
    }
  }}>{children}</a>
}

/** Keep ReactMarkdown's image policy, while permitting validated local file destinations. */
export function chatUrlTransform(url: string, key: string) {
  if (key === 'src') return resolveChatLink(url, { root: '/', cwd: '/' }).kind === 'file' ? url : defaultUrlTransform(url)
  if (key !== 'href') return defaultUrlTransform(url)
  return resolveChatLink(url, { root: '/', cwd: '/' }).kind === 'invalid' ? '' : url
}

export function ChatLink({ href = '', children }: { href?: string; children?: ReactNode }) {
  const scope = useContext(FileLinks)
  const target = resolveChatLink(href, { root: scope.root, cwd: scope.cwd, origin: window.location.origin })
  if (target.kind === 'external') return <a href={target.href} target="_blank" rel="noopener noreferrer">{children}</a>
  if (target.kind === 'anchor') return <a href={`#${encodeURIComponent(target.anchor)}`} onClick={scope.anchor ? event => { event.preventDefault(); scope.anchor!(target.anchor) } : undefined}>{children}</a>
  if (target.kind !== 'file' || !scope.open || !scope.workspaceId) return <span title={href || undefined}>{children}</span>
  return <a href={href} className="local-file-link" title={`预览 ${target.path}${target.line ? `:${target.line}` : ''}`} onClick={event => {
    event.preventDefault()
    scope.open!(target)
  }}>{children}</a>
}
