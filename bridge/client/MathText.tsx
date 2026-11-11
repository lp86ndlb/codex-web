import { memo, useMemo } from 'react'
import { renderTexToReact } from './dsh/markdown/katex.tsx'
import 'katex/dist/katex.min.css'

export default memo(function MathText({ source, display }: { source: string; display: boolean }) {
  const content = useMemo(() => source.length <= 12000 ? renderTexToReact(source, display) : source, [source, display])
  return <span className={display ? 'math-display' : 'math-inline'}>{content}</span>
})
