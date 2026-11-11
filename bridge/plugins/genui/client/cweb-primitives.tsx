import { useState, type ReactNode } from 'react'
import { ChevronRight, Code2 } from 'lucide-react'
export async function writeClipboard(text: string): Promise<boolean> { try { await navigator.clipboard.writeText(text); return true } catch { return false } }
export function CodeBlock({ code, children, language, lang, collapsed = false }: { code?: string; children?: ReactNode; language?: string; lang?: string; collapsed?: boolean; [key: string]: unknown }) {
  const [copied, setCopied] = useState(false); const [wrap, setWrap] = useState(false)
  const content = code ?? (typeof children === 'string' ? children : '')
  const body = <><div className="code-actions"><span>{language || lang || '代码'}</span><span><button onClick={() => setWrap(value => !value)}>{wrap ? '取消换行' : '自动换行'}</button><button onClick={() => void writeClipboard(content).then(setCopied)}>{copied ? '已复制' : '复制'}</button></span></div><pre style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}><code>{content || children}</code></pre></>
  return collapsed ? <details className="genui-code markdown-code"><summary><ChevronRight size={14} className="disclosure" /><Code2 size={15} /><span>{language || lang || '代码'}</span><small>{content.split('\n').length} 行代码</small></summary>{body}</details> : <div className="genui-code">{body}</div>
}
export function DiffBlock({ diffs = [] }: { diffs?: { path: string; oldText: string | null; newText: string }[]; [key: string]: unknown }) {
  return <div className="genui-diffs">{diffs.map((row, index) => <details key={row.path + index} open><summary>{row.path}</summary><div className="genui-diff-columns"><pre className="removed">{row.oldText}</pre><pre className="added">{row.newText}</pre></div></details>)}</div>
}
function JsonNode({ value, label, depth = 0 }: { value: unknown; label: string; depth?: number }) {
  if (!value || typeof value !== 'object' || depth > 12) return <div className="genui-json-value"><strong>{label}</strong>: {JSON.stringify(value)}</div>
  const entries = Object.entries(value).slice(0, 500)
  return <details open={depth < 2}><summary>{label} <small>{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</small></summary><div className="genui-json-children">{entries.map(([key, item]) => <JsonNode key={key} label={key} value={item} depth={depth + 1} />)}</div></details>
}
export function JsonTree({ value, data, label = 'JSON' }: { value?: unknown; data?: unknown; label?: string; [key: string]: unknown }) { return <div className="genui-json"><JsonNode value={value ?? data} label={label} /></div> }
export interface DiffBlockLabels { [key: string]: string | ((value: number) => string) }
export interface JsonTreeLabels { [key: string]: string | ((value: string) => string); copyButtonTitle: (action: string) => string }
