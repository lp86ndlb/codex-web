// Run only with the user's permission to write outside this workspace.
import { mkdir, open, access, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { completionPath, installBashCompletion } from './completion.mjs'
import { installShellIntegration, shellQuote } from './shell-integration.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Agents launched by cweb inherit a private XDG directory. User shell rules
// must be discoverable by ordinary terminals, not stranded in service data.
if (process.env.XDG_DATA_HOME?.startsWith(resolve(root, 'bridge/.data') + '/')) delete process.env.XDG_DATA_HOME
const target = resolve(homedir(), '.local/bin/cweb')
const quote = shellQuote
const portable = await access(resolve(root, '.migration/manifest.json')).then(() => true, () => false)
const entry = portable ? `bash ${quote(resolve(root, 'cweb'))}` : `${quote(process.execPath)} ${quote(resolve(root, 'scripts/cweb.mjs'))}`
const script = `#!/usr/bin/env bash\n# cweb launcher for ${root.replaceAll('\n', ' ')}\nexec ${entry} "$@"\n`
if (!process.argv.includes('--install')) { console.log(`目标：${target}\nBash 补全：${completionPath()}\n内容：\n${script}\n确认允许后执行：node scripts/install-launcher.mjs --install`); process.exit(0) }
await mkdir(dirname(target), { recursive: true })
const existing = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
if (existing && existing !== script) throw new Error(`保留已有入口 ${target}，请先核对其所属安装。`)
if (!existing) { const handle = await open(target, 'wx', 0o755); try { await handle.writeFile(script) } finally { await handle.close() } }
if (portable || process.argv.includes('--workspace-cli')) {
  const codexHome = portable ? resolve(root, '.migration/codex') : resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'))
  await installShellIntegration({ root, codexHome })
  await mkdir(resolve(root, 'bridge/.data'), { recursive: true })
  await writeFile(resolve(root, 'bridge/.data/installation.json'), JSON.stringify({ version: 1, root, codexHome, launcher: target, installedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  console.log('已配置 Bash PATH 与工作区 Codex 入口；在此目录运行 codex 将与网页使用同一个会话库。')
}
console.log(`已安装 ${target}`)
console.log(`已安装 Bash 补全：${await installBashCompletion()}\n新终端自动生效；当前终端运行：source <(cweb completion bash)`)
