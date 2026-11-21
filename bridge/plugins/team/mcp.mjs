// A narrow per-session adapter for native histories whose dynamic-tool list
// cannot be changed by thread/resume. No browser/admin token is exposed.
import { createInterface } from 'node:readline'
import { teamTools } from '../../server/team.ts'
const origin = new URL(process.env.CWEB_TEAM_ORIGIN || ''), token = process.env.CWEB_TEAM_TOKEN || ''
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid team adapter configuration')
const tools = teamTools.map(({ type, ...tool }) => ({ ...tool, annotations: { readOnlyHint: ['team_members', 'team_inbox'].includes(tool.name), openWorldHint: false } }))
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  void (async () => {
    let request
    try { request = JSON.parse(line) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return }
    if (request.id === undefined) return
    let result
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'cweb-team', version: '2.0.0' } }
    else if (request.method === 'tools/list') result = { tools }
    else if (request.method === 'ping') result = {}
    else if (request.method === 'tools/call') {
      try {
        if (!tools.some(tool => tool.name === request.params?.name)) throw new Error('Unknown team tool')
        const response = await fetch(new URL('/api/team/tool', origin), { method: 'POST', headers: { 'content-type': 'application/json', 'x-cweb-team-token': token }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ name: request.params.name, arguments: request.params.arguments || {} }) })
        const value = await response.json()
        if (!response.ok) throw new Error(value.error?.message || 'Team service unavailable')
        result = { content: [{ type: 'text', text: value.text }] }
      } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] } }
    } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return }
    send({ jsonrpc: '2.0', id: request.id, result })
  })().catch(() => { /* Do not print authentication material to stdout/stderr. */ })
})
