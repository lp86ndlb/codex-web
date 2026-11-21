import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { installShellIntegration } = await import(pathToFileURL(resolve('../scripts/shell-integration.mjs')).href)
const exec = promisify(execFile)

test('workspace CLI shares the live home without changing explicit overrides, other directories or shell customizations', async () => {
  const home = await mkdtemp(resolve('test-results/shell-'))
  const root = resolve(home, "项目 ' quoted"), library = resolve(root, '.migration/codex'), bin = resolve(home, '.local/bin')
  await mkdir(root); await mkdir(library, { recursive: true }); await mkdir(bin, { recursive: true })
  await writeFile(resolve(home, '.bashrc'), 'export KEEP_MY_SETTING=present\n')
  await writeFile(resolve(bin, 'codex'), '#!/usr/bin/env bash\nprintf "%s\\n" "${CODEX_HOME:-default}" "$@"\n', { mode: 0o700 })
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }; delete env.CODEX_HOME
  const run = (cwd: string, expression: string, more = {}) => exec('bash', ['--noprofile', '--norc', '-c', `source "$HOME/.bashrc"; ${expression}`], { cwd, env: { ...env, ...more } })
  try {
    await installShellIntegration({ root, codexHome: library, home })
    const once = await readFile(resolve(home, '.bashrc'), 'utf8')
    await installShellIntegration({ root, codexHome: library, home })
    assert.equal(await readFile(resolve(home, '.bashrc'), 'utf8'), once)
    assert.match(once, /KEEP_MY_SETTING=present/)
    assert.equal((await run(root, 'codex resume --all')).stdout, `${library}\nresume\n--all\n`)
    assert.equal((await run(home, 'codex --version')).stdout, 'default\n--version\n')
    assert.equal((await run(home, 'codex -C "$CWEB_TEST_ROOT" resume', { CWEB_TEST_ROOT: root })).stdout, `${library}\n-C\n${root}\nresume\n`)
    assert.equal((await run(root, 'codex resume', { CODEX_HOME: '/explicit-home' })).stdout, '/explicit-home\nresume\n')
    assert.equal((await run(root, 'command codex resume')).stdout, 'default\nresume\n')
    const custom = await exec('bash', ['--noprofile', '--norc', '-c', 'codex() { echo custom; }; source "$HOME/.bashrc"; codex'], { cwd: root, env })
    assert.equal(custom.stdout, 'custom\n')
    assert.equal(JSON.parse(await readFile(resolve(home, '.config/cweb/workspaces.json'), 'utf8')).length, 1)
  } finally { await rm(home, { recursive: true, force: true }) }
})
