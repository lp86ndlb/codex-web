import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'
import { ConnectionDiagnostics } from '../server/diagnostics.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'reliability-ui-')), cwd = resolve(root, 'project'); await mkdir(cwd)
await writeFile(resolve(cwd, 'README.md'), '# 本地验收项目\n')
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'store.json'), FAKE_LOG: resolve(root, 'rpc.jsonl') } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
await bridge.plugin.setEnabled(false)
bridge.diagnostics = new ConnectionDiagnostics(rpc, async (args, signal) => {
  if (args[0] === '--version') return { output: 'codex-cli 0.169.0', code: 0 }
  await new Promise(resolve => setTimeout(resolve, 150))
  return { code: 0, output: JSON.stringify({ fixture: true, checks: { 'config.load': { status: 'ok', durationMs: 3 }, 'network.env': { status: 'ok', durationMs: 2 }, 'network.provider_reachability': { status: 'ok', durationMs: 35 }, 'network.websocket_reachability': { status: 'ok', durationMs: 48 } }, api_key: 'must-not-appear', authorization: 'Bearer must-not-appear', cancelled: signal.aborted }) }
})
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + app.server.address().port
// Edge's downloads hub is browser chrome; the pinned Playwright cannot attach
// that internal page. Keep real downloads enabled while hiding only the hub.
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-features=msDownloadsHub,DownloadBubble,DownloadBubbleV2'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' }), page = await context.newPage(), errors = []
page.on('pageerror', error => errors.push(error.message))
const input = page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true })
const results = {}
async function until(check, label = 'UI did not settle') { for (let i = 0; i < 200; i++) { if (await check()) return; await page.waitForTimeout(25) } assert.fail(label) }
async function connected() { await page.getByText('本地引擎已连接', { exact: true }).waitFor() }
const calls = async method => (await readFile(resolve(root, 'rpc.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.method === method)
try {
  const one = await bridge.create(cwd); await bridge.rename(one.id, '验收 · 源话题')
  const two = await bridge.create(cwd); await bridge.rename(two.id, '验收 · 并行话题')
  await bridge.message(one.id, { text: '介绍示例项目', mode: 'read-only' })
  await until(() => bridge.threads.get(one.id)?.status === 'completed')
  await page.addInitScript(id => {
    if (!localStorage.getItem('cweb:thread')) localStorage.setItem('cweb:thread', id)
    const NativeSource = window.EventSource; window.__testSources = []
    window.EventSource = class extends NativeSource { constructor(...args) { super(...args); window.__testSources.push(this) } }
  }, one.id)
  await page.goto(base); await connected()
  await input.fill('刷新后继续写这条草稿')
  await page.getByLabel('选择附件', { exact: true }).setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('附件保留验证') })
  await page.getByRole('button', { name: '移除附件 draft.txt', exact: true }).waitFor()
  await page.reload(); await connected()
  await until(async () => await input.inputValue() === '刷新后继续写这条草稿', 'Text draft did not survive reload')
  await page.getByRole('button', { name: '移除附件 draft.txt', exact: true }).waitFor()
  await page.locator('.thread-link').filter({ hasText: '验收 · 并行话题' }).click()
  await input.fill('另一话题的独立草稿'); await page.waitForTimeout(300)
  await page.locator('.thread-link').filter({ hasText: '验收 · 源话题' }).click()
  assert.equal(await input.inputValue(), '刷新后继续写这条草稿')
  results.draftsAndAttachmentsSurviveReload = true; results.threadDraftsIndependent = true

  const before = await page.locator('.conversation').textContent()
  await context.setOffline(true)
  await page.getByText('浏览器已离线，草稿保存在本机。网络恢复后自动同步。', { exact: true }).waitFor()
  await input.fill('断网时也能继续写')
  assert.equal(await page.locator('.conversation').textContent(), before)
  await page.screenshot({ path: resolve(output, 'reliability-offline.png'), fullPage: true })
  await context.setOffline(false); await connected()
  assert.equal(await input.inputValue(), '断网时也能继续写')
  assert.equal(await page.locator('.conversation').textContent(), before)
  results.offlinePreservesTranscriptAndDraft = true
  await page.getByRole('button', { name: '移除附件 draft.txt', exact: true }).click()

  let delay = true
  await page.route('**/api/threads/*/message', async route => { if (delay) { delay = false; await new Promise(resolve => setTimeout(resolve, 900)) } await route.continue() })
  await input.fill('检查乐观发送延迟')
  const start = Date.now(); await input.press('Enter')
  await page.locator('.user-bubble').filter({ hasText: '检查乐观发送延迟' }).waitFor()
  results.optimisticVisibleMs = Date.now() - start
  assert.ok(results.optimisticVisibleMs < 700, 'User message waited for the delayed HTTP response')
  await until(async () => (await calls('turn/start')).some(row => row.params.input.some(item => item.text === '检查乐观发送延迟')))
  await until(() => bridge.threads.get(one.id)?.status === 'completed')
  await until(async () => await page.locator('.message-delivery').count() === 0)
  // Wait for the browser's final status too, before intentionally closing SSE.
  // Otherwise the next payload can legitimately be a stale turn/steer request
  // rejected with NOT_RUNNING, which is a different fault from a lost receipt.
  await page.locator('.composer[data-running]').waitFor({ state: 'hidden' })
  await page.unroute('**/api/threads/*/message')

  await page.evaluate(() => window.__testSources.forEach(source => source.close()))
  let acceptedStatus
  await page.route('**/api/threads/*/message', async route => { acceptedStatus = (await route.fetch()).status(); await route.abort('failed') })
  await input.fill('回执丢失仍只执行一次'); await input.press('Enter')
  await page.getByText(/提交结果待核对/).waitFor()
  assert.equal(acceptedStatus, 200, 'This scenario must lose an accepted submission acknowledgement')
  const writes = (await calls('turn/start')).length
  await page.screenshot({ path: resolve(output, 'reliability-unknown-result.png'), fullPage: true })
  await page.unroute('**/api/threads/*/message')
  await page.reload(); await connected()
  await until(async () => await page.locator('.user-bubble').filter({ hasText: '回执丢失仍只执行一次' }).count() === 1)
  await until(async () => await page.locator('.message-delivery').count() === 0)
  assert.equal((await calls('turn/start')).length, writes)
  results.lostAcknowledgementNoReplay = true

  await bridge.message(one.id, { text: '等待表单回复', mode: 'read-only' })
  await bridge.message(two.id, { text: '等待并行任务', mode: 'read-only' })
  await rpc.call('test/elicitation', { threadId: one.id, request: { mode: 'form', message: '选择本轮验收参数', requestedSchema: { type: 'object', required: ['mode', 'count', 'confirm'], properties: {
    mode: { type: 'string', title: '验证方式', oneOf: [{ const: 'browser', title: '浏览器实际操作' }, { const: 'unit', title: '单元测试' }] },
    count: { type: 'integer', title: '重复次数', minimum: 1, maximum: 3 }, confirm: { type: 'boolean', title: '保留原话题' },
    checks: { type: 'array', title: '检查项目', items: { enum: ['滚动', '草稿', '通知'] } },
  } } } })
  const form = page.getByRole('form', { name: 'MCP 交互请求' })
  await form.waitFor(); await form.getByLabel('验证方式').selectOption('browser')
  await form.getByLabel('重复次数').fill('2'); await form.getByLabel('保留原话题').selectOption('true')
  await form.getByLabel('草稿', { exact: true }).check()
  await page.screenshot({ path: resolve(output, 'reliability-mcp-form.png'), fullPage: true })
  await form.getByRole('button', { name: '提交回答', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  assert.equal(bridge.threads.get(two.id).status, 'inProgress', 'Answering one topic stopped another')
  await rpc.call('test/finish', { threadId: two.id })
  results.mcpFormAndConcurrentTopics = true

  await page.getByRole('button', { name: '分支与原生审查', exact: true }).click()
  await page.getByLabel('分支位置', { exact: true }).selectOption({ index: 2 })
  await page.getByRole('button', { name: '创建分支', exact: true }).click()
  await page.getByRole('button', { name: '查看来源话题', exact: true }).waitFor()
  assert.ok(bridge.threads.get(one.id).items.some(item => item.text === '回执丢失仍只执行一次'))
  const fork = [...bridge.threads.values()].find(row => row.forkedFromId === one.id)
  assert.ok(fork); assert.ok(!fork.items.some(item => item.text === '回执丢失仍只执行一次'))
  await page.getByRole('button', { name: '分支与原生审查', exact: true }).click()
  await page.getByRole('button', { name: '原生审查', exact: true }).click()
  await page.getByRole('button', { name: '开始审查', exact: true }).click()
  await page.getByText('原生审查测试：已检查指定范围。', { exact: true }).waitFor()
  results.nativeForkAndReview = true

  await page.getByRole('button', { name: '查看连接与诊断', exact: true }).click()
  await page.getByRole('button', { name: '运行网络诊断', exact: true }).click()
  await page.getByText('网络诊断已完成', { exact: true }).waitFor()
  await page.getByText('查看脱敏诊断详情', { exact: true }).click()
  assert.ok(!(await page.locator('.diagnostic-report').textContent()).includes('must-not-appear'))
  await page.locator('.settings-page').evaluate(node => node.scrollTop = 0)
  await page.screenshot({ path: resolve(output, 'reliability-diagnostics-desktop.png'), fullPage: true })
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出脱敏报告', exact: true }).click()
  const file = await (await download).path(), report = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(report.engine.installedVersion, '0.169.0')
  assert.ok(!JSON.stringify(report).includes('must-not-appear'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.settings-page').evaluate(node => node.scrollTop = 0)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: resolve(output, 'reliability-diagnostics-mobile.png'), fullPage: true })
  results.diagnosticsAndRedactedExport = true; results.mobileWithoutOverflow = true
  assert.deepEqual(errors, [])
  await writeFile(resolve(output, 'reliability-results.json'), JSON.stringify({ ...results, pageErrors: errors, fixture: true }, null, 2))
  console.log(JSON.stringify(results))
} catch (error) {
  await page.screenshot({ path: resolve(output, 'reliability-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally { await page.goto('about:blank').catch(() => {}); await context.close(); await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
