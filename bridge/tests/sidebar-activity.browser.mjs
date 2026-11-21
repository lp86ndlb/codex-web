import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'sidebar-activity-')), cwd = resolve(root, 'workspace'); await mkdir(cwd)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json') } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [], reads = []
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => { if (/^\/api\/threads\/[^/?]+(?:\/snapshot)?$/.test(new URL(request.url()).pathname) && request.method() === 'GET') reads.push(new URL(request.url()).pathname) })
const row = id => page.locator(`[data-thread-id="${id}"]`)
const running = id => row(id).getByRole('img', { name: '正在执行', exact: true })
let stage = 'seed'; const metrics = {}
async function until(check) { const end = Date.now() + 6000; do { if (await check()) return; await page.waitForTimeout(40) } while (Date.now() < end); throw new Error(`Timed out: ${stage}`) }
try {
  await bridge.bootstrap(); await bridge.plugin.setEnabled(false)
  await bridge.updatePreferences({ theme: 'dark', showInspector: false })
  const ids = []
  for (const name of ['当前会话', '后台会话甲', '后台会话乙', '外部会话']) {
    const thread = await bridge.create(cwd); await bridge.rename(thread.id, name)
    await bridge.message(thread.id, { text: name === '外部会话' ? '完成初始化' : '等待加载状态验证', mode: 'read-only' }); ids.push(thread.id)
  }
  await new Promise(resolve => setTimeout(resolve, 1300))
  await page.addInitScript(id => localStorage.setItem('cweb:thread', id), ids[0])
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  for (const id of ids.slice(0, 3)) await running(id).waitFor()
  await page.locator('.composer textarea').waitFor(); await page.waitForTimeout(200)
  const beforeReads = reads.length

  stage = 'first background output-only patch must not hide its spinner'
  await rpc.call('test/append', { threadId: ids[1], text: '后台持续输出' }); await page.waitForTimeout(300)
  assert.equal(await running(ids[1]).count(), 1, 'The first delta omitted status; the sidebar must retain the running summary')
  for (let i = 0; i < 8; i++) await rpc.call('test/append', { threadId: ids[2], text: `后台步骤 ${i}` })
  await page.waitForTimeout(1200)
  for (const id of ids.slice(0, 3)) assert.equal(await running(id).count(), 1)
  assert.equal(reads.length, beforeReads, 'Status updates must not fetch background history')

  stage = 'hover, menu, narrow sidebar and animation retain a visible indicator'
  await row(ids[1]).hover(); await page.waitForTimeout(180)
  const indicator = await running(ids[1]).boundingBox(), menu = await page.getByRole('button', { name: '会话操作：后台会话甲', exact: true }).boundingBox()
  assert.ok(indicator.x + indicator.width <= menu.x, 'Spinner and menu button must not overlap')
  await page.getByRole('button', { name: '会话操作：后台会话甲', exact: true }).click()
  assert.equal(await running(ids[1]).count(), 1); await page.keyboard.press('Escape')
  const separator = page.getByRole('separator', { name: '调整侧边栏宽度' }); await separator.focus()
  for (let i = 0; i < 7; i++) await separator.press('ArrowLeft')
  await page.waitForTimeout(200)
  const svg = running(ids[1]).locator('svg')
  const paint = () => svg.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, opacity: getComputedStyle(node).opacity, transform: getComputedStyle(node).transform, stroke: getComputedStyle(node.querySelector('circle:last-child')).stroke }))
  const first = await paint(); await page.waitForTimeout(220); const second = await paint()
  assert.ok(first.width > 10 && first.height > 10 && Number(first.opacity) > 0 && first.stroke !== 'none')
  assert.notEqual(first.transform, second.transform)
  await page.screenshot({ path: resolve(output, 'sidebar-running.png'), fullPage: true })
  await page.emulateMedia({ reducedMotion: 'reduce' }); assert.equal(await svg.isVisible(), true)
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  stage = 'reload and switch preserve all active states'
  await row(ids[1]).click(); await row(ids[0]).click(); await page.reload()
  for (const id of ids.slice(0, 3)) await running(id).waitFor()
  await rpc.call('test/append', { threadId: ids[2], text: '重新连接后的首条增量' }); await page.waitForTimeout(300)
  assert.equal(await running(ids[2]).count(), 1)

  stage = 'a newer external summary supersedes an old cached completed view'
  await row(ids[3]).click(); await page.locator('.run-badge').filter({ hasText: '已完成' }).waitFor(); await row(ids[0]).click()
  const summaries = bridge.list(), externalAt = Date.now() / 1000 + 2
  bridge.publish({ type: 'threads', threads: summaries.map(summary => summary.id === ids[3] ? { ...summary, status: 'inProgress', updatedAt: externalAt } : summary) })
  await until(async () => await running(ids[3]).count() === 1)
  bridge.publish({ type: 'threads', threads: summaries.map(summary => summary.id === ids[3] ? { ...summary, status: 'completed', updatedAt: externalAt + 1 } : summary) })
  await until(async () => await running(ids[3]).count() === 0)

  stage = 'real completion stops loading and the next native turn starts it again'
  await rpc.call('test/finish', { threadId: ids[1] })
  await until(async () => await running(ids[1]).count() === 0)
  await row(ids[1]).getByRole('img', { name: '任务已完成', exact: true }).waitFor()
  await bridge.message(ids[1], { text: '等待下一轮', mode: 'read-only' }); await running(ids[1]).waitFor()
  await rpc.call('test/append', { threadId: ids[1], text: '请选择一种方式', questions: [{ title: '选择测试', options: ['继续', '稍后'] }] })
  await row(ids[1]).getByRole('img', { name: '等待你的选择', exact: true }).waitFor()
  await running(ids[2]).waitFor()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ firstDelta: true, backgroundReads: 0, hoverAndMenu: true, animated: true, narrowSidebar: true, reload: true, freshSummary: true, completionAndRestart: true, waiting: true, ...metrics }))
} catch (error) { console.error('Stage:', stage); await page.screenshot({ path: resolve(output, 'sidebar-activity-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
