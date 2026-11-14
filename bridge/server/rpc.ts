import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import net from 'node:net'
import WebSocket from 'ws'
import { BridgeError, errorMessage, record, string } from './errors.ts'
import type { RuntimeStatus } from '../shared/types.ts'
import { diagnosticRunner } from './diagnostics.ts'

export interface RpcOptions {
  socketPath?: string
  socketFallback?: boolean
  enginePid?: number
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** Owns one CLI process. A broken stream invalidates every pending request. */
export class CodexRpc extends EventEmitter {
  private options: RpcOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private socket: WebSocket | null = null
  private processes = new Map<ChildProcessWithoutNullStreams, Promise<void>>()
  private pending = new Map<number, {
    resolve: (value: unknown) => void; reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private nextId = 0
  private starting: Promise<void> | null = null
  private disposed = false
  status: RuntimeStatus = { state: 'stopped', error: null }

  constructor(options: RpcOptions) { super(); this.options = options }
  get pid() { return this.child?.pid }
  get sharedEngine() { return Boolean(this.options.socketPath) }
  get enginePid() { return this.options.enginePid }
  diagnosticRunner() { return diagnosticRunner(this.options.command, this.options.cwd, this.options.env) }

  private setStatus(state: RuntimeStatus['state'], error: string | null = null) {
    this.status = { ...this.status, state, error, ...(state === 'ready' ? { connectedAt: Date.now() } : {}) }
    this.emit('status', this.status)
  }

  async start(): Promise<void> {
    if (this.disposed) throw new BridgeError('CLOSED', '桥接服务已关闭', 503)
    if (this.status.state === 'ready') return
    if (this.starting) return this.starting
    this.starting = this.initialize().finally(() => { this.starting = null })
    return this.starting
  }

  private async initialize(): Promise<void> {
    this.setStatus('starting')
    if (this.options.socketPath) {
      try { return await this.initializeSocket() }
      catch (error) {
        if (!this.options.socketFallback || !['ENOENT', 'ECONNREFUSED'].includes(string(record(error).code))) throw error
        this.options.socketPath = undefined; this.options.enginePid = undefined
        return this.initialize()
      }
    }
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd, env: this.options.env, stdio: 'pipe',
      detached: process.platform !== 'win32', windowsHide: true,
    })
    this.child = child
    const closed = new Promise<void>(resolve => child.once('close', () => {
      this.processes.delete(child)
      resolve()
    }))
    this.processes.set(child, closed)
    let ended = false
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    const fail = (error: Error) => {
      if (ended) return
      ended = true
      if (this.child === child) this.child = null
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(error)
      }
      this.pending.clear()
      this.setStatus(this.disposed ? 'stopped' : 'failed', this.disposed ? null : error.message)
      this.emit('disconnected')
      this.signal(child, 'SIGTERM')
      if (this.processes.has(child)) {
        const timer = setTimeout(() => this.signal(child, 'SIGKILL'), 2_000)
        timer.unref()
        void closed.then(() => clearTimeout(timer))
      }
    }
    child.on('error', error => fail(new BridgeError('CLI_START', `无法启动 Codex CLI：${errorMessage(error)}`, 503)))
    child.stdin.on('error', error => fail(new BridgeError('CLI_PIPE', `Codex 连接中断：${errorMessage(error)}`, 503)))
    child.on('close', (code, signal) => fail(new BridgeError('CLI_EXIT', `Codex 已退出（${signal || code}），未完成的操作结果未知。可重新连接后查看会话`, 503)))
    // Drain stderr without forwarding configuration, paths or credentials into browser output.
    child.stderr.on('data', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
        fail(new BridgeError('CLI_FRAME', 'Codex 返回的数据过大，连接已关闭', 502))
        this.signal(child, 'SIGTERM')
        return
      }
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try { this.receive(record(JSON.parse(line))) }
        catch (error) {
          fail(new BridgeError('CLI_PROTOCOL', `Codex 协议异常：${errorMessage(error)}`, 502))
          this.signal(child, 'SIGTERM')
          return
        }
      }
    })
    try {
      const initialized = record(await this.call('initialize', {
        clientInfo: { name: 'cweb_local', title: 'cweb', version: '0.3.0' },
        capabilities: { experimentalApi: true },
      }))
      this.status.userAgent = string(initialized.userAgent) || undefined
      this.write({ method: 'initialized', params: {} })
      this.setStatus('ready')
    } catch (error) {
      fail(error instanceof Error ? error : new Error(errorMessage(error)))
      this.signal(child, 'SIGTERM')
      throw error
    }
  }

  /** Native WebSocket over a Unix socket: close our connection, never the daemon. */
  private async initializeSocket() {
    const socket = new WebSocket('ws://localhost/', { createConnection: () => net.createConnection(this.options.socketPath!), handshakeTimeout: 5000, maxPayload: 32 * 1024 * 1024 })
    this.socket = socket
    let ended = false
    const fail = (error: Error) => {
      if (ended) return
      ended = true
      if (this.socket === socket) this.socket = null
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
      this.pending.clear(); this.setStatus(this.disposed ? 'stopped' : 'failed', this.disposed ? null : error.message); this.emit('disconnected')
      socket.terminate()
    }
    socket.on('message', data => { try { this.receive(record(JSON.parse(data.toString()))) } catch { fail(new BridgeError('CLI_PROTOCOL', '本地 Codex 返回了无效消息', 502)) } })
    socket.on('close', () => fail(new BridgeError('CLI_EXIT', '与本地 Codex 的连接已关闭，可以重新连接', 503)))
    socket.on('error', () => fail(new BridgeError('CLI_CONNECT', '无法连接本地 Codex 服务，请检查连接状态', 503)))
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      const initialized = record(await this.call('initialize', { clientInfo: { name: 'cweb_local', title: 'cweb', version: '0.3.0' }, capabilities: { experimentalApi: true } }))
      this.status.userAgent = string(initialized.userAgent) || undefined
      this.write({ method: 'initialized', params: {} }); this.setStatus('ready')
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); throw error }
  }

  private receive(message: Record<string, unknown>) {
    if (typeof message.method === 'string') {
      this.emit(message.id !== undefined ? 'request' : 'notification', message)
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) pending.reject(new BridgeError('CLI_RPC', string(record(message.error).message) || 'Codex 拒绝了请求', 502))
    else pending.resolve(message.result)
  }

  private write(message: object) {
    if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(message)); return }
    if (!this.child?.stdin.writable) throw new BridgeError('CLI_OFFLINE', 'Codex 未连接，请重试连接', 503)
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  call(method: string, params: object = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError('CLI_TIMEOUT', `Codex 请求超时（${method}）。结果未知，请查看会话后再决定是否重试`, 504))
      }, this.options.timeoutMs ?? 30_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  respond(id: string | number, result: object) { this.write({ id, result }) }
  rejectRequest(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } })
  }

  private signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
      else if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    } catch (error) {
      if (record(error).code !== 'ESRCH') this.emit('cleanupError', error)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.socket) {
      const socket = this.socket
      await new Promise<void>(resolve => { const timer = setTimeout(() => { socket.terminate(); resolve() }, 800); socket.once('close', () => { clearTimeout(timer); resolve() }); socket.close() })
    }
    await Promise.all([...this.processes].map(async ([child, closed]) => {
      const timer = setTimeout(() => this.signal(child, 'SIGKILL'), 2_000)
      this.signal(child, 'SIGTERM')
      await closed
      clearTimeout(timer)
    }))
    this.setStatus('stopped')
  }
}
