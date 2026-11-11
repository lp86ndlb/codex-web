import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
const exec = promisify(execFile)

test('launcher detaches, reuses one daemon under concurrent starts, restarts and refuses a foreign occupied port', { timeout: 30_000 }, async () => {
  await mkdir(resolve('test-results'), { recursive: true })
  const data = await mkdtemp(resolve('test-results/daemon-'))
  const run = (...args: string[]) => exec(process.execPath, [resolve('../scripts/cweb.mjs'), ...args], { cwd: resolve('..'), env: { ...process.env, CWEB_ISOLATED: '1', CWEB_DATA_DIR: data }, timeout: 15_000 })
  const foreign = createServer((req, res) => { res.writeHead(404); res.end('foreign') })
  try {
    await Promise.all([run('start', '--port', '0', '--no-browser'), run('start', '--port', '0', '--no-browser')])
    const first = JSON.parse(await readFile(resolve(data, 'daemon.json'), 'utf8'))
    assert.equal((await run('port')).stdout.trim(), String(first.port))
    assert.match((await run('status')).stdout, /运行中/)
    const opener = resolve(data, 'test-browser')
    const opened = resolve(data, 'opened-url.txt')
    await writeFile(opener, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$CWEB_TEST_OPEN_LOG"\n', { mode: 0o700 })
    await exec(process.execPath, [resolve('../scripts/cweb.mjs'), 'open'], { cwd: resolve('..'), env: { ...process.env, CWEB_ISOLATED: '1', CWEB_DATA_DIR: data, CWEB_BROWSER: opener, CWEB_TEST_OPEN_LOG: opened }, timeout: 5000 })
    let openedUrl = ''
    for (let i = 0; i < 30 && !openedUrl; i++) { openedUrl = await readFile(opened, 'utf8').catch(() => ''); if (!openedUrl) await new Promise(resolve => setTimeout(resolve, 20)) }
    assert.equal(openedUrl.trim(), `http://127.0.0.1:${first.port}`)
    await run('open', '--no-browser')
    const reused = JSON.parse(await readFile(resolve(data, 'daemon.json'), 'utf8')); assert.equal(reused.pid, first.pid)
    const base = `http://127.0.0.1:${first.port}`
    assert.equal((await fetch(base + '/api/control/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403)
    await run('restart', '--port', '0', '--no-browser')
    const restarted = JSON.parse(await readFile(resolve(data, 'daemon.json'), 'utf8')); assert.notEqual(restarted.instance, first.instance)
    await run('stop'); assert.match((await run('status')).stdout, /未运行/)
    await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve))
    const address = foreign.address(); assert.ok(address && typeof address === 'object')
    await assert.rejects(run('start', '--port', String(address.port), '--no-browser'), /未终止任何占用端口/)
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), 'foreign')
  } finally {
    await run('stop', '--force').catch(() => {})
    if (foreign.listening) await new Promise<void>(resolve => foreign.close(() => resolve()))
    await rm(data, { recursive: true, force: true })
  }
})
