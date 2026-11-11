/** Short descriptions of observable tool actions, never inferred reasoning. */
const leaf = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path
const short = (value: string, limit = 54) => value.length > limit ? `${value.slice(0, limit)}…` : value
const itemTypeLabels: Record<string, string> = {
  userMessage: '用户消息', agentMessage: '助手回复', reasoning: '任务摘要', plan: '计划',
  commandExecution: '执行本地命令', fileChange: '修改文件', mcpToolCall: '调用外部工具', dynamicToolCall: '调用工具',
  subAgentActivity: '子代理活动', collabAgentToolCall: '子代理协作', webSearch: '搜索网页',
  imageView: '查看图片', imageGeneration: '生成图片', sleep: '等待', contextCompaction: '压缩上下文',
  enteredReviewMode: '进入审查', exitedReviewMode: '结束审查', hookPrompt: '钩子提示', functionCallOutput: '工具返回结果',
}
const messageTypes = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan'])
const effortLabels: Record<string, string> = { none: '关闭', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '极致', auto: '自动' }
/** Protocol identifiers stay intact; only their visible headings are localized. */
export function describeItemType(type: string): string { return Object.hasOwn(itemTypeLabels, type) ? itemTypeLabels[type] : '其他操作' }
export function isToolActivityType(type: string): boolean { return Object.hasOwn(itemTypeLabels, type) && !messageTypes.has(type) }
export function describeEffort(effort: string): string {
  return Object.hasOwn(effortLabels, effort) ? effortLabels[effort] : effort
}
export function describeCommand(command: string, actions: { type: string; name?: string; path?: string; query?: string }[] = []): string {
  const action = actions.find(value => value.type !== 'unknown')
  if (action?.type === 'read') return `读取 ${short(action.name || leaf(action.path || '') || '项目文件')}`
  if (action?.type === 'listFiles') return '查看项目文件与目录'
  if (action?.type === 'search') return action.query ? `搜索 ${short(action.query, 40)}` : '搜索项目代码'
  if (/\b(?:npm|pnpm|yarn)\b[^\n]*(?:test|check)|\bnode\s+--test\b|\bpytest\b|\bcargo\s+test\b/.test(command)) return /\bcheck\b|tsc/.test(command) ? '检查代码类型与静态错误' : '运行测试并检查结果'
  if (/\btsc\b/.test(command)) return '检查 TypeScript 类型'
  if (/\b(?:npm|pnpm|yarn)\b[^\n]*build|\bvite\s+build\b/.test(command)) return '构建网页资源'
  if (/\bgit\b[^\n]*\bdiff\b/.test(command)) return '检查代码变更'
  if (/\bgit\b[^\n]*\bstatus\b/.test(command)) return '检查 Git 工作区状态'
  if (/\bgit\b[^\n]*\blog\b/.test(command)) return '查看提交记录'
  if (/\b(?:npm|pnpm|yarn)\b[^\n]*\b(?:install|add)\b/.test(command)) return '安装项目依赖'
  if (/CodexRpc|thread\/read|mcpServerStatus/.test(command)) return '检查会话与工具连接'
  if (/\/api\/|\bfetch\(|\bcurl\b/.test(command)) return '验证本地服务接口'
  if (/\b(?:rg|grep)\b/.test(command)) return '搜索项目文件与代码'
  if (/\b(?:cat|sed|head|tail)\b/.test(command)) return '读取文件内容'
  if (/\b(?:ls|find|pwd)\b/.test(command)) return '查看文件与目录'
  if (/\b(?:node|python3?|bash)\b/.test(command)) return /\bnode\b/.test(command) ? '运行 Node.js 脚本' : /\bpython/.test(command) ? '运行 Python 脚本' : '执行本地脚本'
  return '执行本地命令'
}
export function describeTool(tool: string): string {
  const name = tool.split('__').at(-1) || tool
  return ({ todo_note_read: '读取待办便签', todo_note_update: '更新待办便签', todo_note_complete: '提交待办，等待确认', render_ui: '生成交互界面', validate_dsh_ui: '检查交互界面规格', exec_command: '执行本地命令', apply_patch: '更新项目文件' } as Record<string, string>)[name] || `调用 ${short(name || '工具', 44)}`
}
