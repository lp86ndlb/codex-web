import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { CodexRpc } from './rpc.ts'
import { record, string } from './errors.ts'
import { classifyFailure, type ConnectionSnapshot, type DiagnosticEvent, type DiagnosticReport } from '../shared/connection.ts'

// Diagnostic exports contain structured status, never chat text or tool output.
export function redactDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]'
  if (typeof value === 'string') return value.slice(0, 4000)
    .replaceAll(homedir(), '~').replace(/\/home\/[^/\s"']+/g, '~')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/\b((?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential|authorization|cookie))(["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1$2[redacted]')
    .replace(/\b(sk-|gh[pousr]_|github_pat_)[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/([?&](?:key|token|secret|signature|code)=)[^\s&#"']+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1[redacted]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
  if (Array.isArray(value)) return value.slice(0, 80).map(item => redactDiagnostic(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, /(^|_)(token|secret|password|credential|authorization|cookie|api_key|access_key|refresh_token|headers|env|prompt|messages|body)($|_)/i.test(key) || /apiKey|accessToken|refreshToken|clientSecret/i.test(key) ? '[redacted]' : redactDiagnostic(item, depth + 1)]))
  return value
}

export type DiagnosticRunner = (args: string[], signal: AbortSignal) => Promise<{ output: string; code: number | null }>
export function diagnosticRunner(command: string, cwd: string, env: NodeJS.ProcessEnv): DiagnosticRunner {
  return (args, signal) => new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let bytes = 0, output = '', failed = false
    const stop = () => { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref(); child.once('close', () => clearTimeout(timer)) }
    const timeout = setTimeout(() => { failed = true; stop(); reject(new Error('诊断超过 30 秒，已停止。')) }, 30_000)
    const abort = () => { failed = true; stop(); reject(new Error('诊断已取消')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const read = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) { if (!failed) { failed = true; stop(); reject(new Error('诊断输出过大，已停止。')) } } else output += chunk.toString('utf8') }
    child.stdout.on('data', read); child.stderr.on('data', read)
    child.on('error', error => { failed = true; reject(error) })
    child.on('close', code => { clearTimeout(timeout); signal.removeEventListener('abort', abort); if (!failed) accept({ output, code }) })
  })
}

export class ConnectionDiagnostics {
  private events: DiagnosticEvent[] = []
  private report: DiagnosticReport = { state: 'idle' }
  private controller?: AbortController
  private installedVersion?: string
  private versionRead?: Promise<void>
  private startedAt = Date.now()
  private build = 'unknown'
  private rpc: CodexRpc
  private run: DiagnosticRunner
  constructor(rpc: CodexRpc, run: DiagnosticRunner = rpc.diagnosticRunner()) {
    this.rpc = rpc; this.run = run
    try { this.build = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* Packaged installs need not contain .git. */ }
    rpc.on('status', runtime => this.add({ layer: 'engine', level: runtime.state === 'failed' ? 'error' : 'info', title: runtime.state === 'ready' ? 'CLI 连接已建立' : runtime.state === 'starting' ? '正在连接 CLI' : 'CLI 连接已关闭' }))
    rpc.on('notification', event => {
      const params = record(event.params), method = string(event.method)
      if (method === 'error') { const failure = classifyFailure(string(record(params.error).message)); this.add({ layer: 'model', level: 'error', title: `${failure.title}${params.willRetry === true ? ' · 原生正在重试' : ''}`, threadId: string(params.threadId), code: failure.kind }) }
      if (method === 'modelProvider/authRecoveryStarted' || method === 'modelProvider/authRecoveryCompleted') this.add({ layer: 'model', level: 'info', title: method.endsWith('Started') ? '模型认证正在恢复' : '模型认证恢复流程已结束', threadId: string(params.threadId) })
      if (method === 'mcpServer/startupStatus/updated' && /fail|error/i.test(JSON.stringify(params.status))) this.add({ layer: 'tools', level: 'error', title: 'MCP 服务启动失败', threadId: string(params.threadId) })
    })
  }
  add(event: Omit<DiagnosticEvent, 'id' | 'at'>) { this.events.push({ ...event, id: randomUUID(), at: Date.now() }); if (this.events.length > 100) this.events.shift() }
  async snapshot(): Promise<ConnectionSnapshot> {
    if (!this.versionRead) this.versionRead = this.run(['--version'], AbortSignal.timeout(3000)).then(({ output }) => { this.installedVersion = /codex(?:-cli)?\s+([^\s]+)/i.exec(output)?.[1] }).catch(() => {})
    await this.versionRead
    return { checkedAt: Date.now(), bridge: { version: '0.3.0', build: this.build, startedAt: this.startedAt, node: process.version }, engine: { state: this.rpc.status.state, shared: this.rpc.sharedEngine, userAgent: this.rpc.status.userAgent, connectedAt: this.rpc.status.connectedAt, installedVersion: this.installedVersion }, events: [...this.events].reverse(), report: structuredClone(this.report) }
  }
  start() {
    if (this.controller) return
    const controller = new AbortController(); this.controller = controller
    this.report = { state: 'running', startedAt: Date.now() }
    void this.run(['doctor', '--json', '--network-only'], controller.signal).then(({ output, code }) => {
      if (controller.signal.aborted) return
      let result: unknown
      try { result = JSON.parse(output) } catch { result = { message: 'CLI 未返回结构化诊断结果。请在本机终端运行 codex doctor 查看详细输出。' } }
      this.report = { ...this.report, state: code === 0 ? 'completed' : 'failed', completedAt: Date.now(), exitCode: code, result: redactDiagnostic(result) }
    }).catch(() => { if (!controller.signal.aborted) this.report = { ...this.report, state: 'failed', completedAt: Date.now(), message: '未能完成诊断，请检查 CLI 是否支持 doctor；任务没有被重启。' } }).finally(() => { if (this.controller === controller) this.controller = undefined })
  }
  cancel() { this.controller?.abort(); this.controller = undefined; if (this.report.state === 'running') this.report = { ...this.report, state: 'cancelled', completedAt: Date.now(), message: '诊断已取消，原任务继续运行。' } }
  dispose() { this.cancel() }
}
