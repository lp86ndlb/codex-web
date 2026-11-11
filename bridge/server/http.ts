import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Bridge } from './bridge.ts'
import type { StreamEvent } from '../shared/types.ts'
import { BridgeError, errorMessage } from './errors.ts'
import { browseDirectories } from './directories.ts'
import { preferencesSchema, sessionOptionsSchema } from './preferences.ts'
import { attachmentLimit } from './attachments.ts'
import { projectThread } from './projection.ts'
import { record } from './errors.ts'

const messageSchema = z.object({
  text: z.string().trim().max(100_000), model: z.string().max(200).optional(),
  effort: z.string().trim().max(64).optional(),
  collaborationMode: z.enum(['default', 'plan']).optional(),
  clientMessageId: z.string().uuid().optional(),
  mode: z.enum(['workspace-write', 'read-only', 'danger-full-access']), steer: z.boolean().optional(),
  approvalPolicy: z.enum(['on-request', 'untrusted', 'never']).optional(),
  attachments: z.array(z.string().uuid()).max(10).optional(), skills: z.array(z.string().min(1).max(4096)).max(10).optional(),
}).strict().refine(value => value.text || value.attachments?.length || value.skills?.length, '消息不能为空')

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new BridgeError('CONTENT_TYPE', '请求必须使用 JSON', 415)
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 512 * 1024) throw new BridgeError('BODY_LARGE', '请求内容过大', 413)
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new BridgeError('INVALID_JSON', '请求不是有效的 JSON') }
}

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

interface HttpOptions {
  bridge: Bridge
  dist: string
  control?: { instance: string; token: string; stop: () => void }
  devMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
}

/** Loopback-only HTTP transport with same-origin and per-process CSRF validation. */
export function createHttpServer({ bridge, dist, devMiddleware, control }: HttpOptions) {
  const token = randomBytes(32).toString('hex')
  const streams = new Set<ServerResponse>()
  const server = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    if (!devMiddleware) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    handle(req, res).catch(error => {
      if (res.headersSent) { res.end(); return }
      if (error instanceof z.ZodError) json(res, { error: { code: 'VALIDATION', message: '输入不符合要求，请检查填写内容' } }, 400)
      else if (error instanceof BridgeError) json(res, { error: { code: error.code, message: error.message } }, error.status)
      else json(res, { error: { code: 'INTERNAL', message: errorMessage(error) } }, 500)
    })
  })
  server.on('listening', () => {
    const address = server.address()
    if (typeof address === 'object' && address) bridge.setHttpPort(address.port)
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const host = req.headers.host || ''
    if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(host)) {
      throw new BridgeError('HOST', '仅允许通过本机地址访问', 403)
    }
    const origin = `http://${host}`
    if (req.headers.origin && req.headers.origin !== origin) throw new BridgeError('ORIGIN', '拒绝跨站请求', 403)
    const url = new URL(req.url || '/', origin)
    const path = url.pathname
    const cookieName = `cweb_${port}`
    if (path === '/api/health' && req.method === 'GET') {
      json(res, { app: 'cweb', instance: control?.instance, pid: process.pid, busy: bridge.active }); return
    }
    if (path === '/api/control/stop' && req.method === 'POST' && control) {
      const supplied = req.headers['x-cweb-control']
      if (req.headers.origin || typeof supplied !== 'string' || supplied.length !== control.token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(control.token))) {
        throw new BridgeError('CONTROL', '启动器身份校验失败', 403)
      }
      const input = z.object({ force: z.boolean().optional() }).strict().parse(await body(req))
      if (bridge.active && !input.force) throw new BridgeError('BUSY', '仍有任务正在执行，请先在网页停止任务，或使用 --force', 409)
      json(res, { ok: true }); setImmediate(control.stop); return
    }
    if (path === '/api/bootstrap' && req.method === 'GET') {
      res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`)
      try { json(res, { ...await bridge.bootstrap(), token }) }
      catch (error) { json(res, { ...await bridge.preferences.snapshot(), queue: bridge.queue(), token, root: bridge.catalog.list()[0]?.path || '', workspaces: bridge.catalog.list(), plugins: { todoNote: bridge.plugin.enabled }, codexHome: bridge.codexHome,
        runtime: { state: 'failed', error: errorMessage(error) }, models: [], account: '未连接', threads: bridge.list() }) }
      return
    }
    if (!path.startsWith('/api/')) { await serve(req, res, path); return }
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
    if (cookie !== token) throw new BridgeError('SESSION', '连接已过期，请刷新页面', 401)
    if (req.method !== 'GET') {
      const supplied = req.headers['x-bridge-token']
      if (req.headers.origin !== origin || typeof supplied !== 'string' || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        throw new BridgeError('CSRF', '请求校验失败，请刷新页面', 403)
      }
    }
    const threadMatch = /^\/api\/threads\/([^/]+)(?:\/(message|edit|interrupt|rename|archive|restore|compact|queue|options|release|handoff|todo-connect|todo-link|snapshot|goal))?$/.exec(path)
    if (path === '/api/preferences' && req.method === 'GET') { json(res, await bridge.preferences.snapshot()); return }
    if (path === '/api/preferences' && req.method === 'POST') {
      json(res, await bridge.updatePreferences(preferencesSchema.partial().parse(await body(req)))); return
    }
    if (path === '/api/account/status' && req.method === 'GET') { json(res, await bridge.accountStatus()); return }
    if (path === '/api/skills' && req.method === 'GET') { json(res, await bridge.skills(url.searchParams.get('workspace') || undefined, url.searchParams.get('refresh') === '1')); return }
    if (path === '/api/skills/config' && req.method === 'POST') {
      const input = z.object({ workspace: z.string().optional(), path: z.string().min(1).max(4096), enabled: z.boolean() }).strict().parse(await body(req))
      json(res, await bridge.setSkill(input.workspace, input.path, input.enabled)); return
    }
    const genuiMatch = /^\/api\/plugins\/genui\/([a-zA-Z0-9_-]{1,100})$/.exec(path)
    if (genuiMatch && req.method === 'GET') {
      const thread = bridge.threads.get(genuiMatch[1]) || await bridge.open(genuiMatch[1])
      let panels = await bridge.genui.get(thread.id)
      if (!panels.length) { const last = thread.items.filter(item => item.type === 'agentMessage' && item.text.includes('dsh-ui')).at(-1); if (last) panels = await bridge.genui.capture(thread.id, last.text) }
      json(res, { panels }); return
    }
    if (path === '/api/archives' && req.method === 'GET') { json(res, await bridge.archives()); return }
    const archiveMatch = /^\/api\/archives\/([^/]+)$/.exec(path)
    if (archiveMatch && req.method === 'GET') {
      const id = decodeURIComponent(archiveMatch[1])
      if (!(await bridge.archives()).some(thread => thread.id === id)) throw new BridgeError('THREAD_MISSING', '归档会话不存在', 404)
      json(res, projectThread(record(await bridge.rpc.call('thread/read', { threadId: id, includeTurns: true })).thread)); return
    }
    const queueMatch = /^\/api\/queue\/([^/]+)\/(remove|retry)$/.exec(path)
    if (queueMatch && req.method === 'POST') { bridge.changeQueue(queueMatch[1], queueMatch[2] === 'retry'); json(res, { ok: true }); return }
    if (path === '/api/attachments' && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/octet-stream') throw new BridgeError('CONTENT_TYPE', '附件需要使用二进制上传', 415)
      let name: string
      try { name = decodeURIComponent(z.string().min(1).max(2000).parse(req.headers['x-file-name'])) } catch { throw new BridgeError('ATTACHMENT_NAME', '附件名称无效') }
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > attachmentLimit) throw new BridgeError('ATTACHMENT_SIZE', '单个附件不能超过 20 MB', 413); chunks.push(Buffer.from(chunk)) }
      json(res, await bridge.attachments.save(name, Buffer.concat(chunks)), 201); return
    }
    const attachmentMatch = /^\/api\/attachments\/([^/]+)\/content$/.exec(path)
    if (attachmentMatch && req.method === 'GET') {
      const item = await bridge.attachments.get(attachmentMatch[1]); const bytes = await readFile(item.path)
      res.writeHead(200, { 'Content-Type': item.mime, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': `${item.info.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.info.name).replaceAll("'", '%27')}` })
      res.end(bytes); return
    }
    if (path === '/api/events' && req.method === 'GET') {
      const preferences = await bridge.preferences.snapshot()
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      res.write(': connected\n\n')
      streams.add(res)
      const send = (event: StreamEvent) => {
        if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); return }
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      bridge.on('event', send)
      send({ type: 'runtime', runtime: bridge.rpc.status })
      send({ type: 'threads', threads: bridge.list() })
      send({ type: 'workspaces', workspaces: bridge.catalog.list() })
      send({ type: 'plugins', plugins: { todoNote: bridge.plugin.enabled } })
      send({ type: 'preferences', ...preferences })
      send({ type: 'queue', queue: bridge.queue() })
      send({ type: 'approvals', approvals: bridge.approvals() })
      const requested = url.searchParams.get('thread')
      if (requested && bridge.threads.has(requested)) send({ type: 'thread', thread: bridge.threads.get(requested)! })
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000)
      res.on('close', () => { clearInterval(heartbeat); bridge.off('event', send); streams.delete(res) })
      return
    }
    if (path === '/api/threads' && req.method === 'GET') { json(res, await bridge.refreshList()); return }
    if (path === '/api/workspaces/browse' && req.method === 'POST') {
      const input = z.object({ path: z.string().min(1).max(4096).optional(), hidden: z.boolean().optional(),
        query: z.string().max(200).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }).strict().parse(await body(req))
      json(res, await browseDirectories(input)); return
    }
    if (path === '/api/workspaces' && req.method === 'POST') {
      const input = z.object({ path: z.string().min(1).max(4096), name: z.string().trim().min(1).max(80).optional() }).strict().parse(await body(req))
      json(res, await bridge.addWorkspace(input.path, input.name), 201); return
    }
    const workspaceMatch = /^\/api\/workspaces\/([^/]+)\/rename$/.exec(path)
    if (workspaceMatch && req.method === 'POST') {
      const input = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(await body(req))
      await bridge.renameWorkspace(workspaceMatch[1], input.name); json(res, { ok: true }); return
    }
    if (path === '/api/plugins/todo-note/settings' && req.method === 'POST') {
      const input = z.object({ enabled: z.boolean() }).strict().parse(await body(req))
      await bridge.setPlugin(input.enabled); json(res, { ok: true }); return
    }
    if (path === '/api/plugins/todo-note/tool' && req.method === 'POST') {
      const input = z.object({ sessionId: z.string().min(1).max(160), name: z.enum(['todo_note_read', 'todo_note_update', 'todo_note_complete']), arguments: z.record(z.unknown()) }).strict().parse(await body(req))
      if (!bridge.list().some(thread => thread.id === input.sessionId)) throw new BridgeError('THREAD_MISSING', '会话不存在', 404)
      json(res, { ok: true, text: await bridge.plugin.call(input.sessionId, input.name, input.arguments) }); return
    }
    if (['/api/plugins/todo-note/get', '/api/plugins/todo-note/act'].includes(path) && req.method === 'POST') {
      const input = z.object({ sessionId: z.string().min(1).max(160), since: z.number().optional(), action: z.record(z.unknown()).optional() }).strict().parse(await body(req))
      if (!bridge.list().some(thread => thread.id === input.sessionId)) throw new BridgeError('THREAD_MISSING', '会话不存在', 404)
      const acting = path.endsWith('/act')
      if (acting && !input.action) throw new BridgeError('ACTION_MISSING', '缺少便签操作')
      const note = acting ? await bridge.plugin.act(input.sessionId, [{ ...input.action, by: 'user' }]) : await bridge.plugin.get(input.sessionId)
      json(res, { ok: true, value: !acting && input.since === note.version ? { unchanged: true, version: note.version } : { note, version: note.version } }); return
    }
    if (path === '/api/threads' && req.method === 'POST') {
      const input = z.object({ cwd: z.string().max(4096), model: z.string().max(200).optional() }).strict().parse(await body(req))
      json(res, await bridge.create(input.cwd, input.model), 201); return
    }
    if (threadMatch) {
      const id = decodeURIComponent(threadMatch[1]); const action = threadMatch[2]
      if (req.method === 'GET' && action === 'snapshot') { json(res, bridge.snapshot(id) || await bridge.open(id)); return }
      if (req.method === 'GET' && action === 'goal') { json(res, await bridge.goal(id)); return }
      if (req.method === 'GET' && !action) { json(res, await bridge.open(id)); return }
      if (req.method === 'POST') {
        if (action === 'goal') {
          const input = z.object({ objective: z.string().trim().min(1).max(4000).optional(), status: z.enum(['active', 'paused']).optional(), tokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(), clear: z.boolean().optional() }).strict().refine(value => value.clear || value.objective || value.status || value.tokenBudget !== undefined, '目标更新不能为空').parse(await body(req))
          const { clear, ...patch } = input
          if (clear && Object.keys(patch).length) throw new BridgeError('GOAL_INPUT', '清除目标不能同时提交其他修改')
          json(res, await bridge.goal(id, clear ? undefined : patch, clear)); return
        }
        if (action === 'message') { await bridge.message(id, messageSchema.parse(await body(req))); json(res, { ok: true, thread: bridge.threads.get(id) }); return }
        else if (action === 'edit') {
          const input = z.object({ itemId: z.string().min(1).max(200), turnId: z.string().min(1).max(200), message: messageSchema }).strict().parse(await body(req))
          await bridge.message(id, input.message, { itemId: input.itemId, turnId: input.turnId })
          json(res, { ok: true, thread: bridge.threads.get(id) }); return
        }
        else if (action === 'queue') await bridge.enqueue(id, messageSchema.parse(await body(req)))
        else if (action === 'restore') await bridge.restore(id)
        else if (action === 'compact') await bridge.compact(id)
        else if (action === 'release') await bridge.release(id)
        else if (action === 'handoff') { json(res, await bridge.handoff(id)); return }
        else if (action === 'todo-connect') { json(res, await bridge.connectTodo(id)); return }
        else if (action === 'todo-link') { await bridge.requestTodoLink(id, messageSchema.parse(await body(req))); json(res, { ok: true }); return }
        else if (action === 'options') {
          const patch = sessionOptionsSchema.partial().parse(await body(req))
          await bridge.open(id)
          const snapshot = await bridge.preferences.patchOptions(id, patch)
          bridge.emit('event', { type: 'preferences', ...snapshot }); json(res, snapshot); return
        }
        else if (action === 'interrupt') await bridge.interrupt(id)
        else if (action === 'archive') await bridge.archive(id)
        else if (action === 'rename') {
          const input = z.object({ title: z.string().trim().min(1).max(120) }).strict().parse(await body(req))
          await bridge.rename(id, input.title)
        } else throw new BridgeError('NOT_FOUND', '操作不存在', 404)
        json(res, { ok: true }); return
      }
    }
    if (path === '/api/answer' && req.method === 'POST') {
      const input = z.object({ id: z.string().max(200), decision: z.enum(['accept', 'decline', 'cancel']),
        answers: z.record(z.array(z.string().max(20_000)).max(10)).optional() }).strict().parse(await body(req))
      bridge.answer(input.id, input.decision, input.answers); json(res, { ok: true }); return
    }
    if (req.method === 'GET') {
      const target = url.searchParams.get('path') || '.'
      if (['/api/files', '/api/file', '/api/preview', '/api/references', '/api/changes', '/api/diff', '/api/directory'].includes(path)) {
        const id = url.searchParams.get('workspace') || (bridge.catalog.list().length === 1 ? bridge.catalog.list()[0].id : '')
        const workspace = bridge.catalog.get(id)
        if (path === '/api/files') { json(res, await workspace.files(target)); return }
        if (path === '/api/references') { json(res, await workspace.references(url.searchParams.get('q') || '')); return }
        if (path === '/api/file') { json(res, { text: await workspace.file(target) }); return }
        if (path === '/api/preview') { json(res, await workspace.preview(target)); return }
        if (path === '/api/changes') { json(res, await workspace.changes(target)); return }
        if (path === '/api/diff') { json(res, { text: await workspace.diff(url.searchParams.get('cwd') || '.', target) }); return }
        if (path === '/api/directory') { json(res, { path: await workspace.directory(target) }); return }
      }
    }
    throw new BridgeError('NOT_FOUND', '接口不存在', 404)
  }

  async function serve(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new BridgeError('METHOD', '不支持此请求', 405)
    if (devMiddleware) { devMiddleware(req, res, () => { res.writeHead(404); res.end('Not found') }); return }
    const target = resolve(dist, path === '/' ? 'index.html' : '.' + decodeURIComponent(path))
    let canonical: string
    try { canonical = await realpath(target) } catch { throw new BridgeError('ASSET_MISSING', '页面资源不存在，请先运行 npm run build', 404) }
    if (!canonical.startsWith(resolve(dist) + sep)) throw new BridgeError('ASSET_PATH', '路径无效', 403)
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
    const data = await readFile(canonical)
    res.writeHead(200, { 'Content-Type': `${mime[extname(canonical)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': canonical.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' })
    res.end(req.method === 'HEAD' ? undefined : data)
  }

  return {
    server,
    async close() {
      for (const res of streams) res.end()
      await bridge.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
