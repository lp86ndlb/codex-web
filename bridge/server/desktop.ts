import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { BridgeError } from './errors.ts'

interface DesktopOpenOptions {
  env?: NodeJS.ProcessEnv
  startupMs?: number
}

function launchError(error: unknown): BridgeError {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    return new BridgeError('OPEN_UNAVAILABLE', '未找到 xdg-open，请安装桌面默认应用支持', 503)
  }
  return new BridgeError('OPEN_FAILED', '默认应用启动失败，请检查桌面环境和文件关联', 502)
}

/** Launch only a validated local path; an app that stays alive must outlive this request. */
export async function openLocalPath(path: string, options: DesktopOpenOptions = {}): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) throw new BridgeError('OPEN_PATH', '只能打开本地文件或目录')
  const env = options.env ?? process.env
  if (!env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim()) {
    throw new BridgeError('OPEN_UNAVAILABLE', '当前服务没有可用的桌面会话，请在本机桌面环境启动 cweb', 503)
  }
  let child
  try {
    child = spawn('xdg-open', [path], { env, detached: true, stdio: 'ignore', shell: false, windowsHide: true })
  } catch (error) { throw launchError(error) }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: BridgeError) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    // Keep the error listener until process exit even after the observation window.
    child.once('error', error => finish(launchError(error)))
    child.once('exit', (code, signal) => {
      if (code === 0) finish()
      else finish(new BridgeError('OPEN_FAILED', signal
        ? '默认应用启动时意外退出，请检查桌面环境和文件关联'
        : `默认应用启动失败（退出码 ${code}），请检查文件关联`, 502))
    })
    child.once('spawn', () => {
      child.unref()
      // xdg-open may keep the selected application in its process. Never kill it on a timeout.
      timer = setTimeout(() => finish(), options.startupMs ?? 700)
    })
  })
}
