import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

// Only test callers launch this fixture; the production launcher always starts the real CLI.
const genuiSpec = JSON.parse(readFileSync(new URL('./fixtures/genui.json', import.meta.url), 'utf8'))
const store = process.env.FAKE_STORE
const threads = store && existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {}
const requests = new Map()
const loaded = new Set()
const mcpServers = new Map()
const held = new Set()
const save = () => { if (store) writeFileSync(store, JSON.stringify(threads)) }
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = (method, params) => send({ method, params })
const finish = (thread, turn, status = 'completed') => {
  turn.completedAt = Date.now() / 1000; turn.durationMs = Math.max(0, (turn.completedAt - (turn.startedAt || turn.completedAt)) * 1000)
  thread.totalTokens = (thread.totalTokens || 0) + 120
  notify('thread/tokenUsage/updated', { threadId: thread.id, turnId: turn.id, tokenUsage: { total: { totalTokens: thread.totalTokens }, last: { totalTokens: 120 } } })
  turn.status = status; thread.updatedAt = Date.now() / 1000; save()
  notify('turn/completed', { threadId: thread.id, turn })
}
const item = (thread, turn, value) => {
  value.startedAtMs ??= Date.now(); value.completedAtMs ??= Date.now()
  turn.items.push(value); save()
  notify('item/started', { threadId: thread.id, turnId: turn.id, item: value })
  notify('item/completed', { threadId: thread.id, turnId: turn.id, item: value })
}

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(request) + '\n')
  if (request.method === undefined) {
    const pending = requests.get(request.id)
    if (!pending) return
    requests.delete(request.id)
    const { thread, turn, tool } = pending
    if (tool) {
      tool.status = request.result.decision === 'accept' ? 'completed' : 'declined'
      tool.exitCode = tool.status === 'completed' ? 0 : null
      tool.aggregatedOutput = tool.status === 'completed' ? 'fixture output\n' : ''
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item: tool })
    }
    notify('serverRequest/resolved', { threadId: thread.id, requestId: request.id })
    item(thread, turn, { id: randomUUID(), type: 'agentMessage', text: '测试回复：已收到确认。', phase: 'final_answer' })
    finish(thread, turn); return
  }
  const params = request.params || {}
  const respond = result => send({ id: request.id, result })
  const thread = threads[params.threadId]
  if (request.method === 'initialize') respond({ userAgent: 'fake-codex-test-only' })
  else if (request.method === 'initialized') return
  else if (request.method === 'model/list') respond({ data: [{ id: 'fixture', model: 'fixture', displayName: '测试模型', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }, { id: 'fixture-next', model: 'fixture-next', displayName: '测试备用模型', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null })
  else if (request.method === 'collaborationMode/list') respond({ data: [{ name: 'Default', mode: 'default', model: 'fixture', reasoning_effort: null }, { name: 'Plan', mode: 'plan', model: 'fixture', reasoning_effort: 'medium' }] })
  else if (request.method === 'thread/goal/get') respond({ goal: thread.goal || null })
  else if (request.method === 'thread/goal/set') {
    if (params.origin !== 'user') { send({ id: request.id, error: { code: -32602, message: 'Explicit user provenance required' } }); return }
    const now = Date.now() / 1000; const changed = params.objective && params.objective !== thread.goal?.objective
    thread.goal = { ...(changed || !thread.goal ? { threadId: thread.id, objective: params.objective, status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: now } : thread.goal), ...params, updatedAt: now }; delete thread.goal.origin
    save(); respond({ goal: thread.goal }); notify('thread/goal/updated', { threadId: thread.id, goal: thread.goal })
  }
  else if (request.method === 'thread/goal/clear') { delete thread.goal; save(); respond({}); notify('thread/goal/cleared', { threadId: thread.id }) }
  else if (request.method === 'test/complete-goal') { thread.goal.status = 'complete'; thread.goal.updatedAt = Date.now() / 1000; save(); respond({}); notify('thread/goal/updated', { threadId: thread.id, goal: thread.goal }) }
  else if (request.method === 'account/read') respond({ account: { type: 'test-fixture', planType: 'test-plan' } })
  else if (request.method === 'account/rateLimits/read') respond({ rateLimits: { limitId: 'codex', primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1800500000 } } })
  else if (request.method === 'thread/list') respond({ data: Object.values(threads).filter(thread => Boolean(thread.archived) === Boolean(params.archived)).map(thread => ({ ...thread, turns: [] })), nextCursor: null })
  else if (request.method === 'thread/fork') {
    const id = randomUUID(), copy = structuredClone(thread)
    const boundary = params.beforeTurnId ? copy.turns.findIndex(turn => turn.id === params.beforeTurnId) : copy.turns.length
    if (boundary < 0) { send({ id: request.id, error: { code: -32602, message: 'Invalid boundary' } }); return }
    threads[id] = { ...copy, id, forkedFromId: thread.id, turns: copy.turns.slice(0, boundary), updatedAt: Date.now() / 1000 }
    loaded.add(id); save(); respond({ thread: { ...threads[id], ...(params.excludeTurns ? { turns: [] } : {}) }, model: 'fixture' })
  }
  else if (request.method === 'review/start') {
    const turn = { id: randomUUID(), status: 'inProgress', items: [], startedAt: Date.now() / 1000 }
    thread.turns.push(turn); save()
    notify('turn/started', { threadId: thread.id, turn }); respond({ reviewThreadId: thread.id, turn })
    item(thread, turn, { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: '原生审查测试：已检查指定范围。' }); finish(thread, turn)
  }
  else if (request.method === 'test/elicitation') {
    const turn = thread.turns.at(-1), id = params.id || 9010
    requests.set(id, { thread, turn })
    respond({}); send({ id, method: 'mcpServer/elicitation/request', params: { threadId: thread.id, turnId: turn.id, serverName: 'fixture-mcp', ...params.request } })
  }
  else if (request.method === 'thread/start') {
    if (params.dynamicTools?.some(tool => !['function', 'namespace'].includes(tool.type))) { send({ id: request.id, error: { code: -32602, message: 'dynamic tool format invalid' } }); return }
    const id = randomUUID()
    threads[id] = { id, name: null, preview: '', cwd: params.cwd, model: params.model || 'fixture', updatedAt: Date.now() / 1000, turns: [], historyMode: params.historyMode || 'paginated' }
    loaded.add(id)
    save(); respond({ thread: threads[id], model: threads[id].model })
  } else if (request.method === 'thread/resume') {
    if (!loaded.has(params.threadId)) {
      const key = Object.keys(params.config || {}).find(key => key.startsWith('mcp_servers.cweb_note_'))
      if (key) mcpServers.set(params.threadId, key.slice('mcp_servers.'.length))
    }
    loaded.add(params.threadId); respond({ thread: { ...thread, ...(params.excludeTurns ? { turns: [] } : {}), status: { type: 'idle' } }, model: 'fixture' })
  }
  else if (request.method === 'thread/read') respond({ thread: { ...thread, ...(params.includeTurns === false ? { turns: [] } : {}), status: { type: loaded.has(params.threadId) ? thread.turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' : 'notLoaded' } }, model: 'fixture' })
  else if (request.method === 'thread/turns/list') {
    const all = params.sortDirection === 'asc' ? thread.turns : [...thread.turns].reverse()
    const start = Number(params.cursor || 0), limit = params.limit || 50
    respond({ data: all.slice(start, start + limit), nextCursor: start + limit < all.length ? String(start + limit) : null, backwardsCursor: null })
  }
  else if (request.method === 'thread/revert') {
    const index = thread.turns.findIndex(turn => turn.id === params.beforeTurnId)
    if (index < 0 || thread.historyMode === 'legacy' || thread.turns.some(turn => turn.status === 'inProgress')) { send({ id: request.id, error: { code: -32602, message: 'Cannot revert missing, legacy or active history' } }); return }
    thread.turns = thread.turns.slice(0, index); save()
    respond({ thread: { ...thread, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null })
    notify('thread/reverted', { threadId: thread.id })
  }
  else if (request.method === 'mcpServerStatus/list') {
    const name = mcpServers.get(params.threadId)
    respond({ data: name ? [{ name, serverInfo: { name: 'cweb-todo-note' }, tools: { todo_note_read: {}, todo_note_update: {}, todo_note_complete: {} } }] : [], nextCursor: null })
  }
  else if (request.method === 'skills/list') respond({ data: params.cwds.map(cwd => ({ cwd, skills: [{ name: 'fixture-skill', description: '测试技能，用于验证原生调用', path: cwd + '/SKILL.md', scope: 'repo', enabled: true }], errors: [] })) })
  else if (request.method === 'thread/unarchive') { thread.archived = false; save(); respond({ thread }) }
  else if (request.method === 'thread/unsubscribe') { if (!held.has(params.threadId)) { loaded.delete(params.threadId); mcpServers.delete(params.threadId) } respond({ status: 'unsubscribed' }) }
  else if (request.method === 'thread/compact/start') respond({})
  else if (request.method === 'test/finish') { respond({}); finish(thread, thread.turns.at(-1)) }
  else if (request.method === 'test/append') { item(thread, thread.turns.at(-1), { id: randomUUID(), type: 'agentMessage', text: params.text, phase: params.phase || 'commentary', ...(params.questions ? {questions:params.questions,delivery:'async'} : {}) }); respond({}) }
  else if (request.method === 'test/finish') { finish(thread, thread.turns.at(-1)); respond({}) }
  else if (request.method === 'thread/inject_items') respond({})
  else if (request.method === 'thread/name/set') { thread.name = params.name; save(); respond({}) }
  else if (request.method === 'thread/archive') { thread.archived = true; save(); respond({}) }
  else if (request.method === 'turn/start') {
    const turn = { id: randomUUID(), items: [], status: 'inProgress', error: null, startedAt: (Date.now() - Number(process.env.FAKE_STARTED_OFFSET_MS || 0)) / 1000 }
    thread.turns.push(turn)
    const text = params.input[0].text
    if (!thread.preview) thread.preview = text
    notify('turn/started', { threadId: thread.id, turn })
    item(thread, turn, { id: params.clientUserMessageId || randomUUID(), type: 'userMessage', content: params.input })
    respond({ turn })
    if (text === '规划测试') {
      item(thread, turn, { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: params.collaborationMode?.mode === 'plan' ? '## 规划方案\n\n1. 只读调查\n2. 给出实现路径\n3. 等待确认后执行' : '已处于执行模式' }); finish(thread, turn); return
    }
    if (text === '选择框测试') {
      item(thread, turn, { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: '请选择下一步。\n\n```cweb-choice\n' + JSON.stringify({ id: 'fixture-choice', question: '下一步先做什么？', options: [{ label: '先修复', description: '先处理问题' }, { label: '先解释', description: '先说明原理' }] }) + '\n```' })
      finish(thread, turn); return
    }
    if (text === '排版测试') {
      item(thread, turn, { id: randomUUID(), type: 'reasoning', summary: [], content: ['test-hidden-details'] })
      item(thread, turn, { id: randomUUID(), type: 'commandExecution', command: 'cat README.md', commandActions: [{ type: 'read', name: 'README.md', path: thread.cwd + '/README.md' }], status: 'completed', aggregatedOutput: '项目说明已读取', exitCode: 0 })
      item(thread, turn, { id: randomUUID(), type: 'commandExecution', command: 'npm run check', status: 'completed', aggregatedOutput: '类型检查通过', exitCode: 0 })
      const markdown = ['# 排版渲染验证', '', '中文 **重点**、*强调*、~~删除线~~ 和 `literal $code$`。', '', '行内公式 $E = mc^2$，兼容公式 \\(a^2+b^2=c^2\\)。', '', '$$', '\\frac{1}{2} \\sum_{i=1}^{n} i^2', '$$', '', '\\[', '\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}', '\\]', '', '| 项目 | 数值 |', '| --- | --- |', '| 渲染 | $\\alpha + 1$ |', '', '- [x] 已验证', '- [ ] 待确认', '', '> 引用也应当清晰。', '', '```js', 'const formula = "$literal$"', '```'].join('\n')
      item(thread, turn, { id: randomUUID(), type: 'agentMessage', text: markdown, phase: 'final_answer' })
      finish(thread, turn); return
    }
    if (text === 'GenUI 测试') {
      item(thread, turn, { id: randomUUID(), type: 'agentMessage', text: '这是一个可操作的项目面板。\n\n```dsh-ui\n' + JSON.stringify(genuiSpec) + '\n```', phase: 'final_answer' })
      finish(thread, turn); return
    }
    if (text === 'GenUI 面板') {
      requests.set(9004, { thread, turn })
      send({ id: 9004, method: 'item/tool/call', params: { threadId: thread.id, turnId: turn.id, callId: 'genui-call', tool: 'render_ui', arguments: { spec: { ...genuiSpec, panel: true } } } })
      return
    }
    if (text.includes('等待')) { save(); return }
    if (text.includes('审批')) {
      const tool = { id: randomUUID(), type: 'commandExecution', command: 'printf "fixture output\\n"', cwd: thread.cwd, status: 'inProgress', aggregatedOutput: '', exitCode: null }
      turn.items.push(tool)
      notify('item/started', { threadId: thread.id, turnId: turn.id, item: tool })
      const id = 9001
      requests.set(id, { thread, turn, tool })
      send({ id, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: turn.id, itemId: tool.id, command: tool.command, cwd: thread.cwd, reason: '测试：请确认此命令' } })
      return
    }
    if (text.includes('待办工具') || text.startsWith('待办完成:') || text.startsWith('请关联本会话的待办便签：')) {
      const complete = text.startsWith('待办完成:')
      const link = text.startsWith('请关联本会话的待办便签：')
      requests.set(9003, { thread, turn })
      send({ id: 9003, method: 'item/tool/call', params: { threadId: thread.id, turnId: turn.id, callId: 'note-call', namespace: null,
        tool: complete ? 'todo_note_complete' : 'todo_note_update', arguments: complete ? { id: text.slice(5), note: '测试替身已复核工具行为与便签状态，并根据未通过反馈重新提交验证结果。' } : { focus: { current: '验证插件' }, add_tasks: [{ title: link ? '已关联测试任务' : '通过 Codex 工具添加的任务' }] } } })
      return
    }
    if (text.includes('提问')) {
      requests.set(9002, { thread, turn })
      const questions = [{ id: 'language', header: '语言', question: '选择输出语言', isOther: true, options: [{ label: '中文', description: '中文输出' }, { label: 'English', description: 'English output' }] }]
      if (text.includes('多步')) questions.push({ id: 'detail', header: '细节', question: '选择结果详细程度', isOther: true, options: [{ label: '简洁结果', description: '只显示结论' }, { label: '完整说明', description: '显示过程与结论' }] })
      send({ id: 9002, method: 'item/tool/requestUserInput', params: { threadId: thread.id, turnId: turn.id, itemId: 'question', questions } })
      return
    }
    const answer = { id: randomUUID(), type: 'agentMessage', text: '', phase: 'final_answer' }
    notify('item/started', { threadId: thread.id, turnId: turn.id, item: answer })
    const delta = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId: answer.id, delta: '测试消息：你好，世界。' } }) + '\n')
    const split = delta.indexOf(Buffer.from('你')) + 1
    process.stdout.write(delta.subarray(0, split)); process.stdout.write(delta.subarray(split))
    answer.text = '测试消息：你好，世界。'
    turn.items.push(answer)
    notify('item/completed', { threadId: thread.id, turnId: turn.id, item: answer })
    notify('turn/plan/updated', { threadId: thread.id, turnId: turn.id, plan: [{ step: '测试计划', status: 'completed' }] })
    notify('turn/diff/updated', { threadId: thread.id, turnId: turn.id, diff: '--- a/a.ts\n+++ b/a.ts\n-old\n+new' })
    finish(thread, turn)
  } else if (request.method === 'turn/interrupt') {
    const turn = thread.turns.find(turn => turn.id === params.turnId)
    respond({}); finish(thread, turn, 'interrupted')
  } else if (request.method === 'turn/steer') {
    const turn = thread.turns.find(turn => turn.id === params.expectedTurnId)
    item(thread, turn, { id: params.clientUserMessageId || randomUUID(), type: 'userMessage', content: params.input })
    respond({ turnId: turn.id })
  } else if (request.method === 'test/hold') {
    if (params.hold) held.add(params.threadId)
    else { held.delete(params.threadId); loaded.delete(params.threadId); mcpServers.delete(params.threadId) }
    respond({})
  } else if (request.method === 'test/linger') {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.send("ready"); setInterval(()=>{},1000)'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child.once('message', () => respond({ pid: child.pid }))
  } else if (request.method === 'test/crash') process.exit(9)
  else if (request.method === 'test/timeout') return
  else send({ id: request.id, error: { code: -32601, message: 'Unknown test method' } })
})
