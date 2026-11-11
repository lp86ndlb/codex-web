#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { access, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = resolve(process.env.CWEB_DATA_DIR || resolve(root, 'bridge/.data'))
const stateFile = resolve(data, 'daemon.json')
const logFile = resolve(data, 'logs/server.log')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const readState = () => readFile(stateFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
async function health(state) {
  if (!state || state.app !== 'cweb' || !Number.isInteger(state.port)) return null
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/health`, { signal: AbortSignal.timeout(1200) })
    const value = await response.json()
    return value.app === 'cweb' && value.instance === state.instance && value.pid === state.pid ? value : null
  } catch { return null }
}
async function lock() {
  await mkdir(data, { recursive: true, mode: 0o700 })
  const path = resolve(data, 'launcher.lock')
  for (let attempt = 0; attempt < 120; attempt++) {
    try { await mkdir(path); await writeFile(resolve(path, 'pid'), String(process.pid), { mode: 0o600 }); return () => rm(path, { recursive: true, force: true }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const pid = Number(await readFile(resolve(path, 'pid'), 'utf8').catch(() => '0'))
      let alive = false
      if (pid > 0) { try { process.kill(pid, 0); alive = true } catch (error) { alive = error.code !== 'ESRCH' } }
      const age = Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs
      if (!alive && (pid > 0 || age > 10_000)) { await rm(path, { recursive: true, force: true }); continue }
      await delay(250)
    }
  }
  throw new Error('另一个启动器正在操作服务，请稍后重试。')
}
async function start(port) {
  const existing = await readState()
  if (await health(existing)) {
    if (port !== undefined && Number(port) !== 0 && Number(port) !== existing.port) throw new Error(`服务已运行于 ${existing.port}；使用 cweb restart --port ${port} 切换。`)
    return existing
  }
  await access(resolve(root, 'bridge/dist/index.html')).catch(() => { throw new Error('请先在项目目录运行 npm run setup 或 npm run build。') })
  await mkdir(dirname(logFile), { recursive: true, mode: 0o700 })
  const log = await open(logFile, 'a', 0o600)
  let spawnError
  const child = spawn(process.execPath, [resolve(root, 'bridge/server/main.ts'), '--port', String(port ?? 4780)], {
    cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, CWEB_DATA_DIR: data },
  })
  child.on('error', error => { spawnError = error }); child.unref(); await log.close()
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) break
    const state = await readState()
    if (state?.pid === child.pid && await health(state)) return state
    await delay(100)
  }
  const tail = (await readFile(logFile, 'utf8').catch(() => '')).split('\n').slice(-12).join('\n')
  throw new Error(`服务未能启动；未终止任何占用端口的进程。日志：${logFile}\n${tail}`)
}
async function stop(force) {
  const state = await readState()
  if (!await health(state)) { console.log('cweb 未运行。'); return }
  const response = await fetch(`http://127.0.0.1:${state.port}/api/control/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cweb-control': state.token }, body: JSON.stringify({ force }), signal: AbortSignal.timeout(5000),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message || '停止失败')
  for (let i = 0; i < 100; i++) { if (!await health(state) && (await readState())?.instance !== state.instance) { console.log('cweb 已停止。'); return } await delay(100) }
  throw new Error('服务仍在关闭中，请稍后运行 cweb status 检查。')
}
async function openBrowser(url) {
  // Fixed argv; BROWSER is an executable path, never evaluated as shell text.
  const candidates = process.env.CWEB_BROWSER ? [process.env.CWEB_BROWSER] : ['microsoft-edge', 'microsoft-edge-stable', 'xdg-open']
  for (const command of candidates) {
    const opened = await new Promise(resolve => {
      const child = spawn(command, [url], { detached: true, stdio: 'ignore' })
      child.once('error', () => resolve(false)); child.once('spawn', () => { child.unref(); resolve(true) })
    })
    if (opened) return
  }
  console.log(`浏览器未能自动打开，请访问 ${url}`)
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    port: { type: 'string' }, 'no-browser': { type: 'boolean' }, force: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } })
  const action = values.help ? 'help' : positionals[0] || 'start'
  if (positionals.length > 1) throw new Error('只接受一个操作；运行 cweb help 查看用法。')
  if (!['start', 'open', 'stop', 'restart', 'status', 'port', 'logs', 'help'].includes(action)) throw new Error(`未知操作 ${action}，运行 cweb help 查看用法。`)
  if (values.port !== undefined && (!/^\d+$/.test(values.port) || Number(values.port) > 65535)) throw new Error('端口必须为 0–65535；0 表示自动分配。')
  if (action === 'help') { console.log('cweb [start|open|stop|restart|status|port|logs]\n  默认：后台启动并在 Edge 打开网页；重复运行复用服务。\n  --port 4780   指定端口（0 自动分配）\n  --no-browser 不打开浏览器\n  --force      停止服务时中断仍在运行的任务\n  CWEB_BROWSER 可指定浏览器可执行文件。\n  工作区在网页中添加，与启动目录无关。'); return }
  if (['status', 'port'].includes(action)) {
    const state = await readState(); const status = await health(state)
    console.log(status ? action === 'port' ? state.port : `cweb 运行中 · PID ${state.pid} · http://127.0.0.1:${state.port}${status.busy ? ' · 有任务执行中' : ''}` : 'cweb 未运行。'); return
  }
  if (action === 'logs') { console.log((await readFile(logFile, 'utf8').catch(() => '暂无日志')).split('\n').slice(-80).join('\n')); return }
  const release = await lock()
  let state
  try {
    if (action === 'stop' || action === 'restart') await stop(values.force)
    if (action !== 'stop') state = await start(values.port)
  } finally { await release() }
  if (state) { const url = `http://127.0.0.1:${state.port}`; console.log(`cweb 已就绪 · ${url}\n服务在后台运行，关闭终端不影响使用。`); if (!values['no-browser']) await openBrowser(url) }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
