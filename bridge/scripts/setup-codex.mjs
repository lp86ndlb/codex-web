import { mkdir, readFile, writeFile, copyFile, chmod, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import TOML from '@iarna/toml'

// Import only connection/model settings. Never inherit global paths, hooks, plugins or permission overrides.
const allowed = ['model', 'model_provider', 'model_providers', 'model_reasoning_effort', 'model_reasoning_summary', 'service_tier', 'disable_response_storage']
const source = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'))
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../.data/codex-home')
await mkdir(target, { recursive: true, mode: 0o700 })
await chmod(target, 0o700)

async function exists(path) {
  try { await access(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

if (!(await exists(resolve(target, 'config.toml')))) {
  const original = await exists(resolve(source, 'config.toml')) ? TOML.parse(await readFile(resolve(source, 'config.toml'), 'utf8')) : {}
  const selected = Object.fromEntries(allowed.filter(key => original[key] !== undefined).map(key => [key, original[key]]))
  // Provider metadata can reference external credential helpers. Keep static provider settings only.
  if (selected.model_providers) {
    const providerFields = ['name', 'base_url', 'env_key', 'env_key_instructions', 'wire_api', 'query_params', 'http_headers', 'env_http_headers', 'requires_openai_auth', 'supports_websockets', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms']
    selected.model_providers = Object.fromEntries(Object.entries(selected.model_providers).map(([name, provider]) =>
      [name, Object.fromEntries(Object.entries(provider).filter(([key]) => providerFields.includes(key)))]))
  }
  await writeFile(resolve(target, 'config.toml'), TOML.stringify({ ...selected, cli_auth_credentials_store: 'file', analytics: { enabled: false } }), { mode: 0o600, flag: 'wx' })
  console.log('已在项目内创建独立 Codex 连接配置（不导入全局插件、路径或权限设置）')
} else console.log('独立配置已存在，保留原文件')

if (await exists(resolve(source, 'auth.json')) && !(await exists(resolve(target, 'auth.json')))) {
  await copyFile(resolve(source, 'auth.json'), resolve(target, 'auth.json'), constants.COPYFILE_EXCL)
  await chmod(resolve(target, 'auth.json'), 0o600)
  console.log('已将登录凭据复制到项目内的私有目录；源文件未修改')
} else if (!(await exists(resolve(target, 'auth.json')))) {
  console.log('没有可复制的文件登录凭据。可使用现有供应商环境变量，或在独立目录登录：')
  console.log(`CODEX_HOME='${target.replaceAll("'", "'\\''")}' codex login`)
} else console.log('独立登录凭据已存在，保留原文件')
