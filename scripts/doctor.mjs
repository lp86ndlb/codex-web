import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { homedir } from 'node:os'

const exec = promisify(execFile)
const check = (label, status, detail) => ({ label, status, detail })

async function nodeCheck(root) {
  const engine = await readFile(resolve(root, 'package.json'), 'utf8').then(text => JSON.parse(text).engines?.node).catch(() => '')
  const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engine || '')?.slice(1).map(Number) || [24, 9, 0]
  const current = process.versions.node.split('.').map(Number)
  const supported = current.reduce((order, part, index) => order || part - minimum[index], 0) >= 0
  return check('Node.js', supported ? 'ok' : 'error', `${process.versions.node} · 需要 >=${minimum.join('.')}${supported ? '' : '，请升级 Node.js'}`)
}

async function buildCheck(root) {
  const available = await stat(resolve(root, 'bridge/dist/index.html')).then(value => value.isFile()).catch(() => false)
  return check('网页构建', available ? 'ok' : 'error', available ? '已找到构建文件' : '缺少构建文件，请在项目目录运行 npm run build')
}

async function codexCheck(root) {
  try {
    // Use an executable and fixed argv; CWEB_CODEX is never interpreted by a shell.
    const { stdout } = await exec(process.env.CWEB_CODEX || 'codex', ['--version'], {
      cwd: root, encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true,
    })
    // Custom launchers can print diagnostics. Only report the version, never raw output.
    const version = /\bcodex(?:-cli)?\s+v?(\d+\.\d+\.\d+)/i.exec(stdout)?.[1]
      || /^\s*v?(\d+\.\d+\.\d+)\s*$/.exec(stdout)?.[1]
    return check('Codex CLI', version ? 'ok' : 'warn', version ? version : '可执行，但未返回可识别版本')
  } catch (error) {
    return check('Codex CLI', 'error', error.killed ? '版本检查超时，请检查 CWEB_CODEX 指向的程序' : '无法获取版本，请确认已安装且 CWEB_CODEX 指向可执行文件')
  }
}

async function serviceCheck(data) {
  let state
  try {
    state = JSON.parse(await readFile(resolve(data, 'daemon.json'), 'utf8'))
  } catch (error) {
    return check('网页服务', 'warn', error.code === 'ENOENT' ? '未运行（当前数据目录没有服务记录）' : '服务记录无法读取，请通过 cweb status 检查')
  }
  if (!state || state.app !== 'cweb' || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535
    || !Number.isInteger(state.pid) || state.pid < 1 || typeof state.instance !== 'string' || !state.instance) {
    return check('网页服务', 'warn', '服务记录无效，请通过 cweb status 检查')
  }
  try {
    // Health is local and unauthenticated. Never send the daemon control token.
    const response = await fetch(`http://127.0.0.1:${state.port}/api/health`, {
      signal: AbortSignal.timeout(1200), redirect: 'error',
    })
    const value = await response.json()
    if (!response.ok || value.app !== 'cweb' || value.instance !== state.instance || value.pid !== state.pid) {
      return check('网页服务', 'warn', '端口响应与服务记录不符，未操作该进程')
    }
    return check('网页服务', 'ok', `运行中 · http://127.0.0.1:${state.port}${value.busy ? ' · 有任务执行中' : ''}`)
  } catch {
    return check('网页服务', 'warn', '当前服务记录未响应，可能已停止；可运行 cweb status 检查')
  }
}

/** Inspect only this user's terminal clients. Installed shell files do not
 * prove an already-open terminal has loaded them. Never retarget a live CLI. */
export async function workspaceCliCheck(root, codexHome, { proc = '/proc', home = homedir() } = {}) {
  if (process.platform !== 'linux') return null
  const canonical = path => realpath(path).catch(() => resolve(path))
  const [workspace, expected, entries] = await Promise.all([canonical(root), canonical(codexHome), readdir(proc).catch(() => [])])
  const matched = [], different = []
  await Promise.all(entries.filter(pid => /^\d+$/.test(pid)).map(async pid => {
    try {
      const directory = resolve(proc, pid)
      if ((await stat(directory)).uid !== process.getuid?.() || (await readFile(resolve(directory, 'comm'), 'utf8')).trim() !== 'codex') return
      const state = await readFile(resolve(directory, 'stat'), 'utf8')
      if (state.slice(state.lastIndexOf(')') + 2).trim().split(/\s+/)[4] === '0') return
      const cwd = await realpath(resolve(directory, 'cwd'))
      if (cwd !== workspace && !cwd.startsWith(workspace + sep)) return
      const args = (await readFile(resolve(directory, 'cmdline'), 'utf8')).split('\0')
      if (args.includes('app-server')) return
      const values = (await readFile(resolve(directory, 'environ'), 'utf8')).split('\0')
      const value = key => values.find(entry => entry.startsWith(key + '='))?.slice(key.length + 1)
      const actual = await canonical(resolve(cwd, value('CODEX_HOME') || resolve(value('HOME') || home, '.codex')))
      ;(actual === expected ? matched : different).push(Number(pid))
    } catch { /* Process exited or cannot be inspected; never print its environment. */ }
  }))
  if (different.length) return check('正在运行的 CLI 会话库', 'warn', `同工作区的 CLI（PID ${different.sort((a, b) => a - b).join('、')}）仍使用其他会话库。退出该 CLI 后，在本工作区执行 bash codex-portable resume；已有终端也可先 source ~/.bashrc 再运行 codex。未中断或修改任何进程。`)
  return matched.length ? check('正在运行的 CLI 会话库', 'ok', `${matched.length} 个终端客户端使用网页的会话库`) : null
}

async function installationChecks(root, data) {
  const portable = await stat(resolve(root, '.migration/ready.json')).then(() => true, () => false)
  if (!portable) return []
  const launcher = await readFile(resolve(homedir(), '.local/bin/cweb'), 'utf8').catch(() => '')
  const registry = await readFile(resolve(homedir(), '.config/cweb/workspaces.json'), 'utf8').then(JSON.parse).catch(() => [])
  const linked = registry.some(entry => entry.root === root && entry.codexHome === resolve(root, '.migration/codex'))
  const installed = await readFile(resolve(data, 'installation.json'), 'utf8').then(JSON.parse).catch(() => null)
  const [defaultHome, nativeHome] = await Promise.all([realpath(resolve(homedir(), '.codex')).catch(() => ''), realpath(resolve(root, '.migration/codex')).catch(() => '')])
  const unified = Boolean(defaultHome && nativeHome && defaultHome === nativeHome)
  const running = await workspaceCliCheck(root, resolve(root, '.migration/codex'))
  return [check('终端命令入口', launcher.includes(root) ? 'ok' : 'warn', launcher.includes(root) ? '~/.local/bin/cweb 已绑定此安装' : '缺少此安装的 cweb 命令，请运行 bash scripts/migration/run.sh --install-launcher'),
    check('原生会话库统一', unified ? 'ok' : 'warn', unified ? '默认 ~/.codex 与网页指向同一目录；普通 /resume 共用原生历史' : '默认 CLI 与网页仍使用两个库；工作区路由只切换来源。统一方法见 docs/native-history.md'),
    check('工作区 CLI 配置', linked && installed?.root === root ? 'ok' : 'warn', linked && installed?.root === root ? '已安装 Bash 工作区绑定；新终端或 source ~/.bashrc 后生效，不会改变已启动的 CLI' : '普通 codex 可能仍使用其他库，请运行 bash scripts/migration/run.sh --install-launcher；旧终端需重新载入 ~/.bashrc'),
    ...(running ? [running] : [])]
}

/** Read-only local checks. A stopped/unreachable service is a warning, not an environment failure. */
export async function runDoctor({ root, data, write = console.log }) {
  const checks = [...await Promise.all([nodeCheck(root), buildCheck(root), codexCheck(root), serviceCheck(data)]), ...await installationChecks(root, data)]
  const labels = { ok: '通过', warn: '注意', error: '失败' }
  write('cweb 本地检查')
  for (const value of checks) write(`[${labels[value.status]}] ${value.label}：${value.detail}`)
  write('未检查模型网络；连接异常可在网页的“连接与诊断”中排查。')
  return { ok: !checks.some(value => value.status === 'error'), checks }
}
