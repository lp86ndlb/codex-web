// A session-scoped stdio adapter for older Codex threads. The web bridge owns
// the note and validates every operation; this process never writes note files.
import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { todoTools } from '../../server/todo-note.ts'

const sessionId = process.env.CWEB_TODO_SESSION_ID || ''
const origin = process.env.CWEB_TODO_ORIGIN || ''
const url = new URL(origin)
if (!/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
  throw new Error('Invalid cweb todo adapter configuration')
}
const fallbackOrigin = url.origin
const dataDirectory = process.env.CWEB_TODO_DATA_DIRECTORY || ''
const advertised = todoTools.map(({ type, ...tool }) => ({ ...tool, annotations: {
  readOnlyHint: tool.name === 'todo_note_read',
  destructiveHint: tool.name === 'todo_note_update',
  openWorldHint: false,
} }))
const send = message => process.stdout.write(JSON.stringify(message) + '\n')

async function callTool(name, args) {
  let base = fallbackOrigin
  if (isAbsolute(dataDirectory)) {
    const state = await readFile(resolve(dataDirectory, 'daemon.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (state?.app === 'cweb' && Number.isInteger(state.port) && state.port > 0 && state.port <= 65535) {
      const candidate = `http://127.0.0.1:${state.port}`
      const health = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(3000) }).then(response => response.json()).catch(() => null)
      if (health?.app !== 'cweb' || health.instance !== state.instance) throw new Error('cweb 连接尚未就绪')
      base = candidate
    }
  }
  const bootstrap = await fetch(`${base}/api/bootstrap`, { signal: AbortSignal.timeout(15000) })
  if (!bootstrap.ok) throw new Error('cweb 连接失败')
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]
  const state = await bootstrap.json()
  if (!cookie || typeof state.token !== 'string') throw new Error('cweb 连接校验失败')
  const response = await fetch(`${base}/api/plugins/todo-note/tool`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', 'x-bridge-token': state.token, cookie, origin: base },
    body: JSON.stringify({ sessionId, name, arguments: args }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message || '待办工具执行失败')
  return result.text
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  void (async () => {
    let request
    try { request = JSON.parse(line) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return }
    if (request.id === undefined) return
    let result
    if (request.method === 'initialize') {
      result = { protocolVersion: request.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'cweb-todo-note', version: '1.0.0' } }
    } else if (request.method === 'tools/list') result = { tools: advertised }
    else if (request.method === 'ping') result = {}
    else if (request.method === 'tools/call') {
      try {
        if (!advertised.some(tool => tool.name === request.params?.name)) throw new Error('未知的待办工具')
        const text = await callTool(request.params.name, request.params.arguments || {})
        result = { content: [{ type: 'text', text }] }
      } catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '待办服务不可用' }] } }
    } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return }
    send({ jsonrpc: '2.0', id: request.id, result })
  })().catch(error => { if (requestId(line) !== undefined) send({ jsonrpc: '2.0', id: requestId(line), error: { code: -32603, message: String(error) } }) })
})

function requestId(line) { try { return JSON.parse(line).id } catch { return undefined } }
