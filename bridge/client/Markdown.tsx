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
export const Markdown = memo(function Markdown({ text, streaming = false, genui = true, collapseCode = true }: { text: string; streaming?: boolean; genui?: boolean; collapseCode?: boolean }) {
  return <GenuiAllowed.Provider value={genui}><CollapseCode.Provider value={collapseCode}><div className="markdown"><ReactMarkdown skipHtml remarkPlugins={streaming ? [remarkGfm, cjk] : [remarkGfm, cjk, dshMath]} components={{
    pre: MarkdownPre,
    code: ({ className, children }) => /math-inline/.test(className || '') ? <MathText source={String(children || '')} display={false} /> : <code className={className}>{children}</code>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt, src }) => src && (/^https?:\/\//.test(src) || /^\/api\/attachments\/[0-9a-f-]+\/content$/.test(src)) ? <img src={src} alt={alt || ''} loading="lazy" /> : <span className="muted">[图片：{alt || '未加载'}]</span>,
  }}>{text || ' '}</ReactMarkdown></div></CollapseCode.Provider></GenuiAllowed.Provider>
})
