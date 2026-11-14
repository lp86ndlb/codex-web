import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

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

/** Read-only local checks. A stopped/unreachable service is a warning, not an environment failure. */
export async function runDoctor({ root, data, write = console.log }) {
  const checks = await Promise.all([nodeCheck(root), buildCheck(root), codexCheck(root), serviceCheck(data)])
  const labels = { ok: '通过', warn: '注意', error: '失败' }
  write('cweb 本地检查')
  for (const value of checks) write(`[${labels[value.status]}] ${value.label}：${value.detail}`)
  write('未检查模型网络；连接异常可在网页的“连接与诊断”中排查。')
  return { ok: !checks.some(value => value.status === 'error'), checks }
}
