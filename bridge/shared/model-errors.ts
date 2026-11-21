/** Inspect explicit upstream error text, never task bodies or technical terms.
 * Keep the original error intact: this classifies a reported restriction, not
 * whether the request was unsafe or which message/tool result triggered it. */
export function contentRestriction(error?: string | null): { title: string; message: string } | undefined {
  if (!error) return
  const flaggedRisk = /\b(?:flagged|blocked|rejected|refused)\b[\s\S]{0,160}\b(?:cyber[\s-]?security\s+risk|content\s+(?:safety|policy)|safety\s+(?:policy|risk))\b/i
  const explicitPolicy = /\b(?:content[_\s-]?filter(?:ed)?|content[_\s-]?policy[_\s-]?(?:violation|rejection)|safety[_\s-]?violation|policy[_\s-]?violation)\b|(?:内容|安全策略).{0,16}(?:拦截|拒绝|阻止)|(?:拦截|拒绝|阻止).{0,16}(?:内容安全|安全策略)/i
  if (!flaggedRisk.test(error) && !explicitPolicy.test(error)) return
  return { title: '模型内容安全拦截', message: '上游模型报告内容安全拦截。请核对本轮已执行步骤与原始错误；仅凭该错误无法确定触发内容，也不适合自动重试。' }
}
