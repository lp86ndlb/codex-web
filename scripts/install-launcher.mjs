// Run only with the user's permission to write outside this workspace.
import { mkdir, open, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { completionPath, installBashCompletion } from './completion.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(homedir(), '.local/bin/cweb')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const portable = await access(resolve(root, '.migration/manifest.json')).then(() => true, () => false)
const entry = portable ? `bash ${quote(resolve(root, 'cweb'))}` : `${quote(process.execPath)} ${quote(resolve(root, 'scripts/cweb.mjs'))}`
const script = `#!/usr/bin/env bash\n# cweb launcher for ${root.replaceAll('\n', ' ')}\nexec ${entry} "$@"\n`
if (!process.argv.includes('--install')) { console.log(`目标：${target}\nBash 补全：${completionPath()}\n内容：\n${script}\n确认允许后执行：node scripts/install-launcher.mjs --install`); process.exit(0) }
await mkdir(dirname(target), { recursive: true })
const handle = await open(target, 'wx', 0o755)
try { await handle.writeFile(script) } finally { await handle.close() }
console.log(`已安装 ${target}`)
console.log(`已安装 Bash 补全：${await installBashCompletion()}\n新终端自动生效；当前终端运行：source <(cweb completion bash)`)
