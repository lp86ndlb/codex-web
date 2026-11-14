import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const exec = promisify(execFile), launcher = resolve('../scripts/cweb.mjs')
async function fixture() {
  await mkdir('test-results', { recursive: true })
  const root = await mkdtemp(resolve('test-results/cli-completion-'))
  const env = { ...process.env, XDG_DATA_HOME: resolve(root, 'xdg'), BASH_COMPLETION_USER_DIR: '', CWEB_DATA_DIR: resolve(root, 'daemon') }
  const run = (...args: string[]) => exec(process.execPath, [launcher, ...args], { env, timeout: 5000 })
  const script = resolve(root, 'cweb.bash'); await writeFile(script, (await run('completion', 'bash')).stdout)
  const complete = async (...words: string[]) => {
    const result = await exec('bash', ['--noprofile', '--norc', '-c', 'source "$1"; shift; COMP_WORDS=("$@"); COMP_CWORD=$(($#-1)); _cweb_complete; if ((${#COMPREPLY[@]})); then printf "%s\\n" "${COMPREPLY[@]}"; fi', 'bash', script, ...words], { env, timeout: 5000 })
    return result.stdout.trim() ? result.stdout.trim().split('\n') : []
  }
  return { root, env, run, script, complete, target: resolve(root, 'xdg/bash-completion/completions/cweb'), close: () => rm(root, { recursive: true, force: true }) }
}

test('Bash completes only cweb subcommands and matching action options without falling back to system commands', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await f.complete('cweb', ''), ['start', 'open', 'stop', 'restart', 'status', 'port', 'logs', 'doctor', 'completion', 'help'])
    assert.deepEqual(await f.complete('./cweb', 're'), ['restart'])
    assert.deepEqual(await f.complete('cweb', 'st'), ['start', 'stop', 'status'])
    assert.deepEqual(await f.complete('cweb', 'unmatched'), [])
    assert.deepEqual(await f.complete('cweb', 'unknown', ''), [])
    assert.deepEqual(await f.complete('cweb', 'restart', ''), ['--port', '--no-browser', '--force', '--help'])
    assert.deepEqual(await f.complete('cweb', 'stop', ''), ['--force', '--help'])
    assert.deepEqual(await f.complete('cweb', 'status', ''), ['--help'])
    assert.deepEqual(await f.complete('cweb', 'restart', '--force', ''), ['--port', '--no-browser', '--help'])
    assert.deepEqual(await f.complete('cweb', 'stop', '--', ''), [])
    assert.deepEqual(await f.complete('cweb', 'restart', 'unexpected', ''), [])
    const spec = await exec('bash', ['--noprofile', '--norc', '-c', 'source "$1"; complete -p cweb', 'bash', f.script], { env: f.env })
    assert.match(spec.stdout, /-F _cweb_complete/)
    assert.doesNotMatch(spec.stdout, /-o (?:default|bashdefault)|-A command|-c /)
    await assert.rejects(readFile(resolve(f.env.CWEB_DATA_DIR, 'daemon.json')), { code: 'ENOENT' })
  } finally { await f.close() }
})

test('Bash treats ports as values and completes completion formats without offering unrelated words', async () => {
  const f = await fixture()
  try {
    for (const words of [ ['cweb', 'start', '--port', ''], ['cweb', 'start', '--port', '4'], ['cweb', 'start', '--port=4'], ['cweb', '--port', '=', '4'] ]) assert.deepEqual(await f.complete(...words), [])
    assert.deepEqual(await f.complete('cweb', '--port', '4781', 'st'), ['start', 'stop', 'status'])
    assert.deepEqual(await f.complete('cweb', '--port', '=', '4781', 'stop', ''), ['--force', '--help'])
    assert.deepEqual(await f.complete('cweb', 'completion', ''), ['bash', 'install'])
    assert.deepEqual(await f.complete('cweb', 'completion', 'i'), ['install'])
    assert.deepEqual(await f.complete('cweb', 'completion', 'bash', ''), [])
    assert.deepEqual(await f.complete('cweb', '--help', ''), [])
    assert.match((await f.run('completion', 'install', '--help')).stdout, /completion install/)
  } finally { await f.close() }
})

test('completion installation is idempotent, follows XDG and preserves custom files and symlinks', async () => {
  const f = await fixture()
  try {
    await f.run('completion', 'install')
    const first = await readFile(f.target, 'utf8'); assert.equal(first, await readFile(f.script, 'utf8'))
    await f.run('completion', 'install'); assert.equal(await readFile(f.target, 'utf8'), first)
    // Exercise managed upgrades, rather than silently leaving obsolete rules.
    await writeFile(f.target, first.split('\n')[0] + '\n# previous version\n')
    await f.run('completion', 'install'); assert.equal(await readFile(f.target, 'utf8'), first)
    await writeFile(f.target, '# my custom completion\n')
    await assert.rejects(f.run('completion', 'install'), /已有自定义补全/)
    assert.equal(await readFile(f.target, 'utf8'), '# my custom completion\n')
    await rm(f.target); const custom = resolve(f.root, 'custom.bash'); await writeFile(custom, first)
    await symlink(custom, f.target)
    await assert.rejects(f.run('completion', 'install'), /已有自定义补全/)
    assert.equal(await readFile(custom, 'utf8'), first)
    await assert.rejects(exec(process.execPath, [launcher, 'completion', 'install'], { env: { ...f.env, XDG_DATA_HOME: 'relative' } }), /必须使用绝对路径/)
  } finally { await f.close() }
})

test('a fresh Bash session discovers installed cweb rules through Ubuntu bash-completion', async t => {
  const system = '/usr/share/bash-completion/bash_completion'
  try { await readFile(system) } catch { t.skip('bash-completion is not installed'); return }
  const f = await fixture()
  try {
    await f.run('completion', 'install')
    const result = await exec('bash', ['--noprofile', '--norc', '-c', 'source "$1"; __load_completion cweb; COMP_WORDS=(cweb re); COMP_CWORD=1; _cweb_complete; printf "%s\\n" "${COMPREPLY[@]}"; complete -p cweb', 'bash', system], { env: f.env, timeout: 5000 })
    assert.equal(result.stdout.split('\n')[0], 'restart'); assert.match(result.stdout, /-F _cweb_complete/)
  } finally { await f.close() }
})
