import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'model-defaults-')), cwd = resolve(root, 'project'), log = resolve(root, 'rpc.jsonl'); await mkdir(cwd)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'))
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }), errors = [], requests = []
page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()) })
const model = page.getByRole('combobox', { name: '模型', exact: true }), effort = page.getByRole('combobox', { name: '推理强度', exact: true })
const speed = page.getByRole('combobox', { name: '响应速度', exact: true })
const input = page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true })
async function until(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await page.waitForTimeout(25) } assert.fail('Defaults UI did not settle') }
async function selectDefaults() { await model.click(); await page.getByRole('option', { name: /^测试备用模型\s*默认$/ }).click(); await effort.click(); await page.getByRole('option', { name: /^Medium\s*默认$/ }).click() }
try {
  await bridge.plugin.setEnabled(false)
  await bridge.updatePreferences({ model: 'fixture', effort: 'medium', animations: false, showInspector: false })
  const thread = await bridge.create(cwd, '', ''); await bridge.rename(thread.id, '跟随设置验证')
  assert.equal((await bridge.preferences.options(thread.id)).model, '')
  await page.addInitScript(id => localStorage.setItem('cweb:thread', id), thread.id)
  await page.goto(`http://127.0.0.1:${app.server.address().port}`); await input.waitFor()
  assert.equal(await model.textContent(), '测试模型默认'); assert.equal(await effort.textContent(), 'Medium默认')
  await page.getByRole('button', { name: '连接与设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置分类', exact: true }).getByRole('button', { name: '模型与权限', exact: true }).click()
  await page.getByRole('combobox', { name: '默认模型', exact: true }).selectOption('fixture-next')
  await page.getByRole('combobox', { name: '默认推理强度', exact: true }).selectOption('medium')
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await until(async () => await model.textContent() === '测试备用模型默认')
  assert.equal(await effort.textContent(), 'Medium默认')
  assert.match(await model.getAttribute('title'), /跟随设置/)
  await page.screenshot({ path: resolve(output, 'model-default-setting-badges.png'), fullPage: true })
  await model.click(); await page.getByRole('option', { name: '测试模型', exact: true }).click()
  await effort.click(); await page.getByRole('option', { name: 'Medium', exact: true }).click()
  assert.equal(await model.locator('.composer-default-badge').count(), 0); assert.equal(await effort.locator('.composer-default-badge').count(), 0)
  await bridge.updatePreferences({ model: 'fixture-next' }); await page.waitForTimeout(100)
  assert.equal(await model.textContent(), '测试模型'); assert.equal(await effort.textContent(), 'Medium')
  await selectDefaults()
  await input.fill('验证默认设置的实际发送参数'); await input.press('Enter')
  await until(() => bridge.threads.get(thread.id)?.status === 'completed')
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const turn = calls.filter(row => row.method === 'turn/start').at(-1)
  assert.equal(turn.params.model, 'fixture-next'); assert.equal(turn.params.effort, 'medium')
  assert.equal(turn.params.serviceTierForTurn, undefined)
  const saved = await bridge.preferences.options(thread.id)
  assert.equal(saved.model, ''); assert.equal(saved.effort, '', 'The follow choice survives native submission')
  await page.reload(); await input.waitFor(); await until(async () => await model.textContent() === '测试备用模型默认')
  assert.equal(await speed.count(), 0, 'Models without an advertised tier do not show the speed control')
  await model.click(); await page.getByRole('option', { name: 'GPT-6.2-Sol', exact: true }).click()
  assert.equal(await model.textContent(), 'GPT-6.2-Sol')
  await speed.click(); await page.getByRole('option', { name: 'Fast', exact: true }).click()
  await input.fill('验证 Fast 参数'); await input.press('Enter')
  const nativeTurn = async text => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).find(row => row.method === 'turn/start' && row.params.input[0]?.text === text)
  await until(async () => Boolean(await nativeTurn('验证 Fast 参数')) && bridge.threads.get(thread.id)?.status === 'completed')
  const fast = (await nativeTurn('验证 Fast 参数')).params
  assert.equal(fast.model, 'gpt-6.2-sol')
  assert.equal(fast.serviceTierForTurn, 'priority'); assert.equal(fast.serviceTier, undefined)
  await page.reload(); await until(async () => await speed.textContent() === 'Fast')
  await speed.click(); await page.getByRole('option', { name: '标准', exact: true }).click()
  await input.fill('等待队列测试'); await input.press('Enter')
  await until(async () => Boolean(await nativeTurn('等待队列测试')) && bridge.threads.get(thread.id)?.status === 'inProgress')
  assert.equal((await nativeTurn('等待队列测试')).params.serviceTierForTurn, 'default')
  await speed.click(); await page.getByRole('option', { name: '默认速度', exact: true }).click()
  await input.fill('验证队列跟随默认速度'); await input.press('Tab')
  await until(() => bridge.queue().length === 1)
  await rpc.call('test/finish', { threadId: thread.id })
  await until(async () => Boolean(await nativeTurn('验证队列跟随默认速度')) && bridge.threads.get(thread.id)?.status === 'completed')
  assert.equal((await nativeTurn('验证队列跟随默认速度')).params.serviceTierForTurn, undefined)
  await bridge.updatePreferences({ uiFontSize: 18 }); await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(150)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await page.screenshot({ path: resolve(output, 'model-default-mobile.png'), fullPage: true })
  assert.ok(!calls.some(row => row.method === 'config/read'))
  assert.ok(!requests.some(url => url.includes('/model-defaults')))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ settingsSource: true, immediateUpdates: true, explicitOverrides: true, nativeValuesMatch: true, followPersisted: true, formattedModelLabel: true, fastAndStandard: true, queuedDefaultSpeed: true, mobile: true, noConfigRequests: true }))
} catch(error) { await page.screenshot({ path: resolve(output, 'model-default-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
