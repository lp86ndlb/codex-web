import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type Check = { label: string; status: 'ok' | 'warn' | 'error'; detail: string }
const { runDoctor, workspaceCliCheck } = await import(pathToFileURL(resolve('../scripts/doctor.mjs')).href) as {
  runDoctor: (options: { root: string; data: string; write?: (text: string) => void }) => Promise<{ ok: boolean; checks: Check[] }>
  workspaceCliCheck: (root: string, home: string, options: { proc: string; home: string }) => Promise<Check | null>
}

async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/doctor-'))
  const data = resolve(root, 'state')
  await mkdir(resolve(root, 'bridge/dist'), { recursive: true })
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ engines: { node: '>=24.9.0' } }))
  await writeFile(resolve(root, 'bridge/dist/index.html'), '<!doctype html>')
  const command = resolve(root, 'codex with spaces.cjs')
  const args = resolve(root, 'version-args.json')
  await writeFile(command, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2))); console.log('codex-cli 9.8.7-PRIVATE_VERSION_SUFFIX\\nPRIVATE_STDOUT'); console.error('PRIVATE_STDERR');\n`)
  await chmod(command, 0o700)
  return { root, data, command, args }
}

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}

async function close(server: Server) {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
}

async function withCodex<T>(command: string, task: () => Promise<T>) {
  const previous = process.env.CWEB_CODEX
  process.env.CWEB_CODEX = command
  try { return await task() }
  finally { if (previous === undefined) delete process.env.CWEB_CODEX; else process.env.CWEB_CODEX = previous }
}

test('doctor checks only local health and Codex version without revealing or changing state', async () => {
  const value = await fixture()
  const requests: { method: string; url: string; control: string | string[] | undefined }[] = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method || '', url: req.url || '', control: req.headers['x-cweb-control'] })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ app: 'cweb', instance: 'test-instance', pid: process.pid, busy: true }))
  })
  try {
    const port = await listen(server)
    await mkdir(value.data)
    const state = JSON.stringify({ app: 'cweb', instance: 'test-instance', pid: process.pid, port, token: 'PRIVATE_CONTROL_TOKEN' })
    const path = resolve(value.data, 'daemon.json')
    await writeFile(path, state)
    const before = await stat(path)
    const lines: string[] = []
    const result = await withCodex(value.command, () => runDoctor({ ...value, write: text => lines.push(text) }))
    assert.equal(result.ok, true)
    assert.equal(result.checks.every(check => check.status === 'ok'), true)
    assert.match(lines.join('\n'), /Codex CLI：9\.8\.7/)
    assert.match(lines.join('\n'), /有任务执行中/)
    assert.doesNotMatch(lines.join('\n') + JSON.stringify(result), /PRIVATE_/)
    assert.deepEqual(JSON.parse(await readFile(value.args, 'utf8')), ['--version'])
    assert.deepEqual(requests, [{ method: 'GET', url: '/api/health', control: undefined }])
    assert.equal(await readFile(path, 'utf8'), state)
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs)
  } finally {
    await close(server)
    await rm(value.root, { recursive: true, force: true })
  }
})

test('doctor leaves a stopped service untouched and does not evaluate CWEB_CODEX as shell text', async () => {
  const value = await fixture()
  try {
    await rm(resolve(value.root, 'bridge/dist'), { recursive: true })
    const marker = resolve(value.root, 'shell-was-run')
    const command = `missing-codex; touch ${marker}`
    const result = await withCodex(command, () => runDoctor({ ...value, write: () => {} }))
    assert.equal(result.ok, false)
    assert.equal(result.checks.find(check => check.label === '网页构建')?.status, 'error')
    assert.equal(result.checks.find(check => check.label === 'Codex CLI')?.status, 'error')
    assert.match(result.checks.find(check => check.label === '网页服务')?.detail || '', /未运行/)
    await assert.rejects(stat(value.data), { code: 'ENOENT' })
    await assert.rejects(stat(marker), { code: 'ENOENT' })
  } finally { await rm(value.root, { recursive: true, force: true }) }
})

test('doctor treats missing, malformed and foreign daemon records as warnings without exposing their contents', async () => {
  const value = await fixture()
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url || '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ app: 'foreign', instance: 'foreign', pid: process.pid }))
  })
  try {
    await withCodex(value.command, async () => {
      const run = () => runDoctor({ ...value, write: () => {} })
      assert.equal((await run()).ok, true)
      await mkdir(value.data)
      const path = resolve(value.data, 'daemon.json')
      await writeFile(path, '{"token":"PRIVATE_BROKEN_JSON"')
      const malformed = await run()
      assert.equal(malformed.ok, true)
      assert.equal(malformed.checks.find(check => check.label === '网页服务')?.status, 'warn')
      assert.doesNotMatch(JSON.stringify(malformed), /PRIVATE_|SyntaxError/)
      const port = await listen(server)
      const state = JSON.stringify({ app: 'cweb', instance: 'test-instance', pid: process.pid, port, token: 'PRIVATE_TOKEN' })
      await writeFile(path, state)
      const foreign = await run()
      assert.equal(foreign.ok, true)
      assert.match(foreign.checks.find(check => check.label === '网页服务')?.detail || '', /不符/)
      assert.deepEqual(requests, ['/api/health'])
      assert.equal(await readFile(path, 'utf8'), state)
    })
  } finally {
    await close(server)
    await rm(value.root, { recursive: true, force: true })
  }
})

test('doctor distinguishes a configured workspace from a live terminal still using the old library', async () => {
  const value = await fixture(), proc = resolve(value.root, 'proc'), library = resolve(value.root, '.migration/codex')
  const options = { proc, home: value.root }
  const client = async (pid: number, env: string, cwd = value.root, tty = 34817, command = 'codex\0resume\0') => {
    const path = resolve(proc, String(pid)); await mkdir(path, { recursive: true })
    await writeFile(resolve(path, 'comm'), 'codex\n')
    await writeFile(resolve(path, 'stat'), `${pid} (codex) S 1 1 1 ${tty} 0 0\n`)
    await writeFile(resolve(path, 'cmdline'), command)
    await writeFile(resolve(path, 'environ'), `HOME=${value.root}\0PRIVATE_TOKEN=never-show\0${env}`)
    await symlink(cwd, resolve(path, 'cwd'))
  }
  try {
    await mkdir(library, { recursive: true }); await mkdir(proc)
    assert.equal(await workspaceCliCheck(value.root, library, options), null)
    await client(100, '')
    const warning = await workspaceCliCheck(value.root, library, options)
    assert.equal(warning?.status, 'warn'); assert.match(warning?.detail || '', /PID 100/)
    assert.match(warning?.detail || '', /bash codex-portable resume/)
    assert.doesNotMatch(JSON.stringify(warning), /PRIVATE_TOKEN|never-show/)
    await writeFile(resolve(proc, '100/environ'), `CODEX_HOME=${library}\0`)
    assert.equal((await workspaceCliCheck(value.root, library, options))?.status, 'ok')
    // Other workspaces and background app servers do not imply a broken terminal.
    const elsewhere = resolve(value.root, 'other'); await mkdir(elsewhere)
    await client(200, '', elsewhere, 0)
    await client(201, '', value.root, 34817, 'codex\0app-server\0')
    await client(202, '', resolve(value.root, '..'))
    assert.equal((await workspaceCliCheck(value.root, library, options))?.status, 'ok')
    // A live CLI remains tied to its original home even after shell files change.
    await writeFile(resolve(proc, '100/environ'), `CODEX_HOME=${resolve(value.root, '.codex')}\0`)
    assert.equal((await workspaceCliCheck(value.root, library, options))?.status, 'warn')
  } finally { await rm(value.root, { recursive: true, force: true }) }
})
