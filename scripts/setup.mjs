import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = resolve(root, '.cache/tmp')
await mkdir(tmp, { recursive: true })
if (!process.env.npm_execpath) throw new Error('请通过 npm run setup 运行此脚本')
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'ci', '--prefix', resolve(root, 'bridge'),
  '--cache', resolve(root, '.cache/npm'), '--no-audit', '--no-fund'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, NODE_COMPILE_CACHE: resolve(root, '.cache/node') },
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const build = spawnSync(process.execPath, [process.env.npm_execpath, '--prefix', resolve(root, 'bridge'), 'run', 'build'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, NODE_COMPILE_CACHE: resolve(root, '.cache/node') },
})
if (build.error) throw build.error
process.exitCode = build.status ?? 1
