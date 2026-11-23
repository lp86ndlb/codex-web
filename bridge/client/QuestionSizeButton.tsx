import { Maximize2, Minimize2 } from 'lucide-react'
import { useState } from 'react'

export function QuestionSizeButton() {
  const [large, setLarge] = useState(false)
  return <button type="button" className="question-size" aria-pressed={large} aria-label={large ? '还原答题区' : '放大答题区'} onClick={() => setLarge(value => !value)}>
    {large ? <Minimize2 size={14} /> : <Maximize2 size={14} />}{large ? '还原' : '放大'}
  </button>
}
