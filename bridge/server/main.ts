import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { CodexRpc } from './rpc.ts'
import { Bridge } from './bridge.ts'
import { WorkspaceCatalog } from './catalog.ts'
import { createHttpServer } from './http.ts'
import { importLegacyHistory } from './history-import.ts'

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
async function main() {
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, port: { type: 'string', default: '4780' },
    codex: { type: 'string', default: process.env.CWEB_CODEX || 'codex' }, dev: { type: 'boolean', default: false },
  } })
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须为 0–65535')
  const data = resolve(process.env.CWEB_DATA_DIR || resolve(appDirectory, '.data'))
  const previous = await readFile(resolve(data, 'daemon.json'), 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (previous?.app === 'cweb') {
    const live = await fetch(`http://127.0.0.1:${previous.port}/api/health`, { signal: AbortSignal.timeout(1200) }).then(res => res.json()).catch(() => null)
    if (live?.instance === previous.instance) throw new Error(`cweb 已在端口 ${previous.port} 运行。使用 cweb restart 重启。`)
  }
  const sharedHistory = process.env.CWEB_ISOLATED !== '1'
  const codexHome = sharedHistory ? resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex')) : resolve(data, 'codex-home')
  const tmp = resolve(data, 'tmp')
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  await mkdir(tmp, { recursive: true, mode: 0o700 })
  if (sharedHistory) {
    const imported = await importLegacyHistory(resolve(data, 'codex-home'), codexHome, resolve(data, 'history-import.json'))
    if (imported) console.log(`已将 ${imported} 个原网页会话加入终端原生历史；原始副本保留。`)
  }
  const catalog = new WorkspaceCatalog(resolve(data, 'workspaces.json'))
  await catalog.initialize()
  if (values.root) await catalog.add(resolve(values.root))
  const socketPath = resolve(codexHome, 'app-server-control/app-server-control.sock')
  const sharedSocket = sharedHistory && (await stat(socketPath).catch(() => null))?.isSocket()
  const daemon = sharedSocket ? await readFile(resolve(codexHome, 'app-server-daemon/daemon.pid'), 'utf8').then(JSON.parse).catch(() => ({})) : {}
  const rpc = new CodexRpc({ ...(sharedSocket ? { socketPath, enginePid: daemon.pid, socketFallback: true } : {}), command: values.codex!, args: ['app-server', '--listen', 'stdio://',
    '-c', 'analytics.enabled=false', '-c', 'thread_unload_delay_secs=0'], cwd: data,
    env: { ...process.env, CODEX_HOME: codexHome, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      XDG_CACHE_HOME: resolve(data, 'cache'), XDG_DATA_HOME: resolve(data, 'xdg-data'), XDG_CONFIG_HOME: resolve(data, 'xdg-config') },
  })
  const bridge = new Bridge(rpc, catalog, codexHome, data, sharedHistory)
  await bridge.initialize()
  const vite = values.dev ? await (await import('vite')).createServer({ root: appDirectory, server: { middlewareMode: true }, appType: 'spa' }) : null
  const instance = randomUUID(); const token = randomBytes(32).toString('hex')
  let stopping = false
  const stateFile = resolve(data, 'daemon.json')
  const stop = async () => {
    if (stopping) return
    stopping = true
    await app.close(); await vite?.close()
    const state = await readFile(stateFile, 'utf8').then(JSON.parse).catch(() => null)
    if (state?.instance === instance) await rm(stateFile, { force: true })
  }
  const app = createHttpServer({ bridge, dist: resolve(appDirectory, 'dist'), devMiddleware: vite?.middlewares,
    control: { instance, token, stop: () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) } },
  })
  await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve) })
  const address = app.server.address(); const actualPort = typeof address === 'object' && address ? address.port : port
  const state = { app: 'cweb', instance, token, pid: process.pid, port: actualPort, startedAt: Date.now(), directory: appDirectory }
  try {
    await writeFile(`${stateFile}.${instance}.tmp`, JSON.stringify(state), { mode: 0o600 })
    await rename(`${stateFile}.${instance}.tmp`, stateFile)
  } catch (error) { await app.close(); await vite?.close(); throw error }
  console.log(`cweb · http://127.0.0.1:${actualPort}\n网页设置: ${data}\n${sharedHistory ? '共享终端会话' : '独立会话'}: ${codexHome}\n工作区在网页中添加；按项目整理会话。`)
  process.on('SIGINT', () => { void stop().catch(console.error) })
  process.on('SIGTERM', () => { void stop().catch(console.error) })
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
