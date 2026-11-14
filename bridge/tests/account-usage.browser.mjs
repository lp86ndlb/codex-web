import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'account-usage-')), cwd = resolve(root, 'project'); await mkdir(cwd)
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'store.json') } })
const call = rpc.call.bind(rpc); let failed = false, usageReads = 0
rpc.call = async (method, params) => {
  if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'prolite' }, userId: 'user-fixture', workspaceRouting: { chatgptAccountId: 'account-fixture' } }
  if (method === 'account/rateLimits/read') { usageReads++; assert.deepEqual(params, { excludeResetCreditDetails: true }); if (failed) throw new Error('synthetic network timeout') }
  return call(method, params)
}
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data')); await bridge.plugin.setEnabled(false)
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto('http://127.0.0.1:' + app.server.address().port)
  await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  await page.getByRole('button', { name: '查看额度', exact: true }).click()
  const popup = page.getByRole('dialog', { name: '账户额度', exact: true })
  await popup.getByText('剩余 65%', { exact: true }).waitFor()
  assert.equal(await popup.getByRole('progressbar', { name: '5 小时额度', exact: true }).getAttribute('aria-valuenow'), '65')
  await page.screenshot({ path: resolve(output, 'account-usage-success.png'), fullPage: true })
  failed = true; const before = usageReads
  await popup.getByRole('button', { name: '刷新', exact: true }).click()
  await popup.getByText(/上次成功读取/).waitFor()
  await popup.getByText('剩余 65%', { exact: true }).waitFor()
  assert.equal(usageReads - before, 2)
  assert.equal(await popup.getByText(/没有返回可显示|引擎未提供/).count(), 0)
  await page.screenshot({ path: resolve(output, 'account-usage-stale.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: resolve(output, 'account-usage-mobile.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ usageVisible: true, backgroundPollParams: true, transientRetryBounded: true, sameAccountCachedUsageVisible: true, noDuplicateEmptyState: true, mobile: true, pageErrors: errors }))
} catch (error) { await page.screenshot({ path: resolve(output, 'account-usage-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
