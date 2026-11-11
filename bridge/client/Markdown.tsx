import { createContext, isValidElement, lazy, memo, Suspense, useContext, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { math } from 'micromark-extension-math'
import { mathFromMarkdown } from 'mdast-util-math'
import type { Processor } from 'unified'
import { mathCompatibility } from './dsh/markdown/mathCompatibility.ts'
import { cjkFriendlyStrong } from './dsh/markdown/cjkFriendlyStrong.ts'
import { GenuiFence, GenuiMessage } from './GenuiHost.tsx'
import { CodeBlock } from '../plugins/genui/client/cweb-primitives.tsx'
import { ChoiceFence } from './ChoiceHost.tsx'
import { ChatLink, chatUrlTransform } from './FileLinks.tsx'
import { LocalImage } from './LocalImage.tsx'
const MathRenderer = lazy(() => import('./MathText.tsx'))

/** The DSH grammar preserves code and adds Chinese emphasis + TeX delimiters. */
type MarkdownData = { micromarkExtensions?: ReturnType<typeof math>[]; fromMarkdownExtensions?: ReturnType<typeof mathFromMarkdown>[] }
function cjk(this: Processor) {
  const data = this.data() as MarkdownData; (data.micromarkExtensions ||= []).push(cjkFriendlyStrong())
}
function dshMath(this: Processor) {
  const data = this.data() as MarkdownData
  ;(data.micromarkExtensions ||= []).push(mathCompatibility(), math())
  ;(data.fromMarkdownExtensions ||= []).push(mathFromMarkdown())
}
function MathText({ source, display }: { source: string; display: boolean }) { return <Suspense fallback={<span className="math-loading">{source}</span>}><MathRenderer source={source} display={display} /></Suspense> }
const GenuiAllowed = createContext(true)
const CollapseCode = createContext(true)
const ImagesStreaming = createContext(false)
function MarkdownImage({ alt, src }: { alt?: string; src?: string }) {
  const streaming = useContext(ImagesStreaming)
  if (!src) return <span className="muted">[图片：{alt || '未加载'}]</span>
  if (/^https?:\/\//.test(src) || /^\/api\/attachments\/[0-9a-f-]+\/content$/.test(src)) return <img src={src} alt={alt || ''} loading="lazy" />
  return <LocalImage path={src} alt={alt} streaming={streaming} />
}
function MarkdownPre({ children }: { children?: ReactNode }) {
  const slot = useContext(GenuiMessage)
  const allowGenui = useContext(GenuiAllowed)
  const collapsed = useContext(CollapseCode)
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>
  const className = children.props.className || ''; const source = String(children.props.children || '').replace(/\n$/, '')
  if (allowGenui && /language-dsh-ui[>，,。.:;：；]?$/i.test(className)) return <GenuiFence raw={source} slot={slot.id} streaming={slot.streaming} />
  if (allowGenui && /language-cweb-choice$/i.test(className)) return <ChoiceFence raw={source} slot={slot.id} streaming={slot.streaming} />
  if (/math-display|language-(?:math|latex|tex)\b/.test(className)) return <div className="math-block"><MathText source={source} display /></div>
  return <CodeBlock code={source} language={className.replace(/^language-/, '')} collapsed={collapsed} />
}
function plainText(node: ReactNode): string { return Array.isArray(node) ? node.map(plainText).join('') : isValidElement<{ children?: ReactNode }>(node) ? plainText(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '' }
export const Markdown = memo(function Markdown({ text, streaming = false, genui = true, collapseCode = true, headingIds = false }: { text: string; streaming?: boolean; genui?: boolean; collapseCode?: boolean; headingIds?: boolean }) {
  const headings = new Map<string, number>()
  const heading = (tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => ({ children }: { children?: ReactNode }) => {
    const base = plainText(children).toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').replace(/\s/g, '-')
    const count = headings.get(base) || 0; headings.set(base, count + 1)
    const Tag = tag
    return <Tag id={count ? `${base}-${count}` : base}>{children}</Tag>
  }
  return <GenuiAllowed.Provider value={genui}><CollapseCode.Provider value={collapseCode}><ImagesStreaming.Provider value={streaming}><div className="markdown"><ReactMarkdown skipHtml urlTransform={chatUrlTransform} remarkPlugins={streaming ? [remarkGfm, cjk] : [remarkGfm, cjk, dshMath]} components={{
    ...(headingIds ? { h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6') } : {}),
    pre: MarkdownPre,
    code: ({ className, children }) => /math-inline/.test(className || '') ? <MathText source={String(children || '')} display={false} /> : <code className={className}>{children}</code>,
    a: ChatLink,
    img: MarkdownImage,
  }}>{text || ' '}</ReactMarkdown></div></ImagesStreaming.Provider></CollapseCode.Provider></GenuiAllowed.Provider>
})
