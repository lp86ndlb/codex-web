#!/usr/bin/env node
// A deliberately separate installation. Never publishes UI or restarts cweb.
import { mkdir, readFile, writeFile, copyFile, chmod, realpath, lstat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string', default: '4791' } } })
const action = positionals[0] || 'start'
if (!['start', 'stop', 'status'].includes(action)) throw new Error('用法：npm run team:pilot -- [start|stop|status] [--port 4791]')
const base = resolve(root, '.cache/team-mode-pilot'), data = resolve(base, 'data'), workspace = resolve(base, 'workspace'), ui = resolve(base, 'ui')
await mkdir(base, { recursive: true, mode: 0o700 })
if ((await lstat(base)).isSymbolicLink() || await realpath(base) !== base) throw new Error('试验目录不能使用指向其他数据的符号链接')
const state = await readFile(resolve(data, 'daemon.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const health = state ? await fetch(`http://127.0.0.1:${state.port}/api/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null) : null
const alive = health?.app === 'cweb' && health.instance === state?.instance && health.pid === state?.pid
if (action === 'status') { console.log(JSON.stringify({ running: Boolean(alive), ...(alive ? { url: `http://127.0.0.1:${state.port}/?team=1`, pid: state.pid } : {}), workspace, data }, null, 2)); process.exit(0) }
if (action === 'stop') {
  if (!alive) { console.log('团队试验未运行。'); process.exit(0) }
  const response = await fetch(`http://127.0.0.1:${state.port}/api/control/stop`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cweb-control': state.token }, body: '{}' })
  if (!response.ok) throw new Error((await response.json()).error?.message || '试验服务未停止')
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 250))
    const current = await fetch(`http://127.0.0.1:${state.port}/api/health`, { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null)
    if (current?.instance !== state.instance) { console.log('已停止团队试验实例；实际 cweb 未变动。'); process.exit(0) }
  }
  throw new Error('试验实例仍在关闭中，请稍后用 status 核对；未强制终止任何进程。')
}
if (alive) { console.log(`团队试验已运行：http://127.0.0.1:${state.port}/?team=1`); process.exit(0) }
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4780) throw new Error('请选择与实际 cweb 不同的测试端口（默认 4791）')
for (const directory of [data, workspace, resolve(data, 'codex-home')]) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (await realpath(directory) !== directory) throw new Error('试验数据或工作区不可链接到外部目录')
}
const home = resolve(data, 'codex-home'), source = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'))
// Only credentials and provider routing; no sessions, databases, skills or tools.
try { await copyFile(resolve(source, 'auth.json'), resolve(home, 'auth.json'), constants.COPYFILE_EXCL); await chmod(resolve(home, 'auth.json'), 0o600) }
catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error }
const require = createRequire(resolve(root, 'bridge/package.json')), toml = require('@iarna/toml')
const original = await readFile(resolve(source, 'config.toml'), 'utf8').then(toml.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error })
const config = Object.fromEntries(['model', 'model_provider', 'model_providers'].filter(key => original[key] !== undefined).map(key => [key, original[key]]))
Object.assign(config, { approval_policy: 'on-request', sandbox_mode: 'read-only', model_reasoning_effort: 'low', analytics: { enabled: false } })
await writeFile(resolve(home, 'config.toml'), toml.stringify(config), { mode: 0o600 })
await writeFile(resolve(workspace, 'README.md'), '# 团队通信试验工作区\n\n仅用于三个会话的文本任务与逐次审批测试，不连接硬件，不修改真实项目。\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
console.log('构建隔离试验页面；实际网页仍使用原有版本。')
execFileSync('npm', ['--prefix', resolve(root, 'bridge'), 'run', 'build', '--', '--outDir', ui], { cwd: root, stdio: 'inherit' })
const log = await open(resolve(base, 'server.log'), 'a', 0o600)
const child = spawn(process.execPath, [resolve(root, 'bridge/server/main.ts'), '--root', workspace, '--port', String(port)], {
  cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env, CWEB_DATA_DIR: data, CWEB_ISOLATED: '1', CWEB_TEAM_PILOT: '1', CWEB_TEAM_PILOT_DIST: ui, CODEX_HOME: home },
})
child.unref(); await log.close()
for (let i = 0; i < 40; i++) {
  await new Promise(resolve => setTimeout(resolve, 250))
  const status = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null)
  if (status?.pid === child.pid && status.app === 'cweb') { console.log(`团队试验：http://127.0.0.1:${port}/?team=1\n测试工作区：${workspace}\n独立会话库：${home}`); process.exit(0) }
}
throw new Error(`试验未启动，请查看 ${resolve(base, 'server.log')}；未重启实际 cweb。`)
