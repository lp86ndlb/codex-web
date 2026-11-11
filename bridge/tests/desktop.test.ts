import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openLocalPath } from '../server/desktop.ts'
import { BridgeError } from '../server/errors.ts'

function code(expected: string, status: number) {
  return (error: unknown) => error instanceof BridgeError && error.code === expected && error.status === status
}

async function fixture(script: string) {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/desktop-'))
  const bin = resolve(root, 'bin'); await mkdir(bin)
  await writeFile(resolve(bin, 'package.json'), '{"type":"commonjs"}')
  await writeFile(resolve(bin, 'xdg-open'), `#!${process.execPath}\n${script}\n`, { mode: 0o700 })
  return {
    root,
    env: { ...process.env, PATH: bin, DISPLAY: ':test', WAYLAND_DISPLAY: '', STUB_LOG: resolve(root, 'args.json'), STUB_PID: resolve(root, 'pid') },
    close: () => rm(root, { recursive: true, force: true }),
  }
}

test('default opener passes one literal absolute path to xdg-open', async () => {
  const f = await fixture(`require('node:fs').writeFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)))`)
  try {
    const path = resolve(f.root, 'report ; $(touch should-not-exist).md')
    await openLocalPath(path, { env: f.env })
    assert.deepEqual(JSON.parse(await readFile(f.env.STUB_LOG, 'utf8')), [path])
  } finally { await f.close() }
})

test('default opener refuses URLs, relative paths, and missing desktop sessions', async () => {
  for (const path of ['https://example.com/a', 'file:///tmp/readme.md', '../readme.md', '/tmp/bad\0name']) {
    await assert.rejects(openLocalPath(path), code('OPEN_PATH', 400))
  }
  await assert.rejects(openLocalPath('/tmp/readme.md', { env: { DISPLAY: '', WAYLAND_DISPLAY: '' } }), code('OPEN_UNAVAILABLE', 503))
})

test('default opener reports a missing launcher, quick nonzero exit, and signal failure', async () => {
  await assert.rejects(openLocalPath('/tmp/readme.md', { env: { PATH: '/cweb-test-missing-launcher', DISPLAY: ':test' } }), code('OPEN_UNAVAILABLE', 503))
  for (const script of ['process.exit(3)', "process.kill(process.pid, 'SIGTERM')"]) {
    const f = await fixture(script)
    try { await assert.rejects(openLocalPath('/tmp/readme.md', { env: f.env }), code('OPEN_FAILED', 502)) }
    finally { await f.close() }
  }
})

test('a Wayland application that keeps running survives the startup observation window', async () => {
  const f = await fixture(`require('node:fs').writeFileSync(process.env.STUB_PID, String(process.pid)); setInterval(() => {}, 1000)`)
  let pid: number | undefined
  try {
    await openLocalPath('/tmp/readme.md', { env: { ...f.env, DISPLAY: '', WAYLAND_DISPLAY: 'wayland-test' } })
    pid = Number(await readFile(f.env.STUB_PID, 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 0)
    assert.doesNotThrow(() => process.kill(pid!, 0))
    await delay(50)
    assert.doesNotThrow(() => process.kill(pid!, 0))
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM') } catch {} }
    await f.close()
  }
})
