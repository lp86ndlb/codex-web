// Real UI/API with an isolated fake engine. Review rendering, previews and
// editing must never execute fenced UI or spend a model turn by themselves.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { CodexRpc } from '../server/rpc.ts'
import { Bridge } from '../server/bridge.ts'
import { Workspace } from '../server/workspace.ts'
import { createHttpServer } from '../server/http.ts'

const output = resolve('test-results'); await mkdir(output, { recursive: true })
const root = await mkdtemp(resolve(output, 'team-approvals-markdown-'))
const cwd = resolve(root, 'project-a'), nested = resolve(cwd, 'receiver'), other = resolve(root, 'project-b'), log = resolve(root, 'rpc.jsonl')
await mkdir(nested, { recursive: true }); await mkdir(other)
await writeFile(resolve(cwd, 'handoff.md'), '# 团队工作区文档\n\n**读取正确。**')
await writeFile(resolve(nested, 'handoff.md'), '# 接收成员目录\n\n相对路径在接收方目录内解析。')
await writeFile(resolve(other, 'handoff.md'), '# 不应读取另一个工作区')
const rpc = new CodexRpc({ command: process.execPath, args: [resolve('tests/fake-codex.mjs')], cwd, env: { ...process.env, FAKE_STORE: resolve(root, 'sessions.json'), FAKE_LOG: log } })
const bridge = new Bridge(rpc, new Workspace(cwd), resolve(root, 'home'), resolve(root, 'data'), false, { workspaceTeams: true })
const app = createHttpServer({ bridge, dist: resolve(process.env.CWEB_TEST_DIST || 'dist') })
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/microsoft-edge', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], requests = []
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => { if (request.url().includes('/api/')) requests.push({ method: request.method(), url: new URL(request.url()), body: request.postDataJSON() }) })
const base = `http://127.0.0.1:${app.server.address().port}`
const graph = page.getByRole('region', { name: '团队关系图', exact: true }), sidebar = page.locator('.team-approvals')
const preview = page.getByRole('dialog', { name: '文件预览', exact: true })
const card = id => sidebar.locator(`[data-message-id="${id}"]`)
const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const turns = async () => (await calls()).filter(row => ['turn/start', 'turn/steer'].includes(row.method))
let stage = 'setup'
async function until(fn) { const end = Date.now() + 8000; do { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 25)) } while (Date.now() < end); throw new Error(`Timed out: ${stage}`) }
async function native(name, path) { const thread = await bridge.create(path, 'fixture-next', 'medium'); await bridge.rename(thread.id, name); return thread.id }
async function showWorkspace(name) {
  await page.locator('.workspace-toggle').filter({ hasText: name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '打开关系图', exact: true }).click(); await graph.waitFor()
  await graph.getByRole('button', { name: /^审批/ }).click(); await sidebar.waitFor()
}
async function closePreview() { await preview.getByRole('button', { name: '关闭文件预览', exact: true }).click(); await preview.waitFor({ state: 'hidden' }) }
async function assertContained(prose) {
  const measurements = await prose.evaluate(element => {
    const box = element.getBoundingClientRect()
    const nodes = [...element.querySelectorAll('.genui-code, pre, table, a.local-file-link')].map(node => { const rect = node.getBoundingClientRect(); return { tag: node.tagName, left: rect.left, right: rect.right, scroll: node.scrollWidth, width: node.clientWidth } })
    return { left: box.left, right: box.right, nodes, overflow: document.documentElement.scrollWidth > innerWidth + 1 }
  })
  assert.equal(measurements.overflow, false, JSON.stringify(measurements))
  assert.ok(measurements.nodes.every(node => node.left >= measurements.left - 1 && node.right <= measurements.right + 1), JSON.stringify(measurements))
}
const choice = { id: 'approval-review-only', question: '不应弹出问答', options: [{ label: '不可点击', description: '审批正文仅供审阅' }, { label: '仍不可点击', description: '不发送选择' }] }
const genui = { title: '不应变成交互界面', items: [{ type: 'text', content: '被审阅的原始组件' }, { type: 'button', label: '不可执行的正文按钮', action: 'review-only' }] }
const body = [
  '# 核对桥接报告',
  '本次仅收集**诊断结论**，保留 `stream.h` 路径。',
  '## 核查清单',
  '1. 检查连接恢复。\n2. 记录失败次数与时间戳。',
  '- **权限边界**需要确认。\n- [x] 已有复现记录\n- [ ] 等待人工结论',
  '[交接文档](handoff.md) · [官方说明](https://example.org/docs/review?mode=team#usage)',
  '```bash\nprintf "%s\\n" "只读核对"\nprintf "%s\\n" "' + 'long_argument_'.repeat(18) + '"\n```',
  '> 执行前核对路径；原文中的代码仅供审阅。',
  '| 检查项 | 结果 |\n| --- | --- |\n| 接收会话 | 保留上下文 |',
  '### 原始问答描述',
  '```cweb-choice\n' + JSON.stringify(choice, null, 2) + '\n```',
  '```dsh-ui\n' + JSON.stringify(genui, null, 2) + '\n```',
  '<script>window.__reviewExecuted = true</script>\n[不可执行网址](javascript:alert(1))',
  '最后一行：正文完整保留。',
].join('\n\n')
try {
  const boot = await bridge.bootstrap(), workspace = boot.workspaces[0]
  await bridge.renameWorkspace(workspace.id, 'Markdown A'); await bridge.addWorkspace(other, 'Markdown B')
  await bridge.updatePreferences({ theme: 'dark', animations: false, showInspector: false, filePreviewLayout: 'side' })
  const lead = await native('团队负责人', cwd), manager = await native('项目主管', cwd), b = await native('其他工作区会话', other)
  await bridge.importTeamMember(workspace.id, { threadId: lead, level: 1, parentId: null, groupId: null })
  await bridge.importTeamMember(workspace.id, { threadId: manager, level: 2, parentId: lead, groupId: null })
  const team = await bridge.teamForWorkspace(workspace.id)
  // A read-only display fixture for a member whose cwd is a child directory;
  // this member is never dispatched to and has no native/model process.
  await team.register({ threadId: 'preview-recipient', name: '目录成员', role: 'worker', level: 3, parentId: manager, cwd: nested })
  await team.enable(true)
  const relative = await team.propose(manager, { to: 'preview-recipient', kind: 'question', title: '接收目录核对', body: '## 相对路径\n\n请查看 [成员交接文档](handoff.md)。', requestKey: 'relative-preview' })
  const proposal = await team.propose(lead, { to: manager, kind: 'task', title: '技术复核：桥接与恢复接续', body, requestKey: 'markdown-review' })
  await page.goto(base); await page.getByText('本地引擎已连接', { exact: true }).waitFor()
  await page.locator(`[data-thread-id="${b}"]`).click(); await showWorkspace('Markdown A')
  const review = card(proposal.id), prose = review.locator('.team-review-markdown')
  await review.waitFor(); await review.getByRole('button', { name: /在关系图定位/ }).click()

  stage = 'review Markdown is readable, complete and passive'
  await prose.getByRole('heading', { name: '核对桥接报告', exact: true }).waitFor()
  assert.equal(await prose.locator('h2').textContent(), '核查清单')
  assert.equal(await prose.locator('ol > li').count(), 2)
  assert.equal(await prose.locator('ul > li').count(), 3)
  assert.ok(await prose.locator('strong').filter({ hasText: '诊断结论' }).count())
  assert.equal(await prose.locator('p > code').first().textContent(), 'stream.h')
  assert.equal(await prose.locator('.genui-code').count(), 3)
  assert.equal(await prose.locator('pre').count(), 3, 'All code starts expanded')
  assert.ok((await prose.textContent()).includes('最后一行：正文完整保留。'))
  assert.equal(await prose.getByRole('button', { name: '不可执行的正文按钮', exact: true }).count(), 0)
  assert.equal(await page.locator('.question-panel, .choice-inline, .genui-host').count(), 0)
  assert.equal(await prose.locator('script, a[href^="javascript:"]').count(), 0)
  assert.equal(await page.evaluate(() => window.__reviewExecuted), undefined)
  assert.ok(await prose.locator('input[type=checkbox]').evaluateAll(inputs => inputs.length === 2 && inputs.every(input => input.disabled)))
  const external = prose.getByRole('link', { name: '官方说明', exact: true })
  assert.equal(await external.getAttribute('title'), 'https://example.org/docs/review?mode=team#usage')
  assert.equal(await external.locator('.external-link-icon').count(), 1)
  await assertContained(prose)
  await review.getByRole('heading', { name: '核对桥接报告', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(output, 'team-approvals-markdown-desktop.png'), fullPage: true })

  stage = 'local file previews use team workspace, receiver cwd and existing preferences'
  await prose.getByRole('link', { name: /交接文档/ }).click(); await preview.waitFor()
  await preview.getByRole('heading', { name: '团队工作区文档', exact: true }).waitFor()
  assert.equal(await preview.getAttribute('data-layout'), 'side')
  assert.ok(requests.some(row => row.url.pathname === '/api/preview' && row.url.searchParams.get('workspace') === workspace.id && row.url.searchParams.get('path') === resolve(cwd, 'handoff.md')))
  await closePreview()
  await card(relative.id).getByRole('link', { name: /成员交接文档/ }).click(); await preview.waitFor()
  await preview.getByRole('heading', { name: '接收成员目录', exact: true }).waitFor()
  assert.ok(requests.some(row => row.url.pathname === '/api/preview' && row.url.searchParams.get('workspace') === workspace.id && row.url.searchParams.get('path') === resolve(nested, 'handoff.md')))
  await closePreview()
  assert.equal((await turns()).length, 0, 'Reading and previewing never trigger model work')
  assert.equal(requests.filter(row => row.method === 'POST' && /genui|choice|messages\/.*\/decision|open-file/.test(row.url.pathname)).length, 0)

  stage = 'raw editor roundtrip, cancellation and source Markdown remain unchanged'
  await review.getByRole('button', { name: '修改正文', exact: true }).click()
  const editor = review.getByRole('textbox', { name: '调整待发送正文', exact: true })
  assert.equal(await editor.inputValue(), body)
  await editor.fill(''); await review.getByRole('button', { name: '取消修改', exact: true }).click()
  assert.equal(await review.getByRole('button', { name: '允许本次', exact: true }).isDisabled(), false)
  assert.equal((await team.snapshot()).messages.find(row => row.id === proposal.id).body, body)
  assert.equal((await turns()).length, 0)

  stage = 'member-request descriptions use passive Markdown without creating a session'
  const nativeStarts = (await calls()).filter(row => row.method === 'thread/start').length
  const request = await team.requestMember('user', { name: '待批准的新成员', reason: '## 新成员职责\n\n负责**接口核对**，参考 [交接文档](handoff.md)。', level: 3, parentId: manager, groupId: null, useDefaults: true, requestKey: 'markdown-member-reason' })
  const memberCard = sidebar.locator(`[data-member-request="${request.id}"]`)
  await memberCard.getByRole('heading', { name: '新成员职责', exact: true }).waitFor()
  assert.equal(await memberCard.locator('strong').textContent(), '接口核对')
  assert.equal(await memberCard.getByRole('button', { name: '批准创建', exact: true }).isVisible(), true)
  await memberCard.getByRole('link', { name: /交接文档/ }).click(); await preview.waitFor()
  await preview.getByRole('heading', { name: '团队工作区文档', exact: true }).waitFor(); await closePreview()
  assert.equal((await calls()).filter(row => row.method === 'thread/start').length, nativeStarts)
  assert.equal((await turns()).length, 0)

  stage = 'narrow and large-font sidebars keep code and links inside their container'
  await page.setViewportSize({ width: 390, height: 844 })
  await graph.getByRole('button', { name: /^审批/ }).click(); await prose.waitFor()
  await assertContained(prose)
  await review.getByRole('heading', { name: '核对桥接报告', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(output, 'team-approvals-markdown-mobile.png'), fullPage: true })
  await bridge.updatePreferences({ uiFontSize: 18, fontSize: 20 })
  await until(async () => parseFloat(await page.locator('html').evaluate(element => getComputedStyle(element).fontSize)) >= 18)
  await assertContained(prose)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await bridge.updatePreferences({ uiFontSize: 14, fontSize: 16 })

  stage = 'approval delivers original Markdown without rendered-text conversion'
  await bridge.message(manager, { text: '等待 fixture 收件人空闲', mode: 'workspace-write' })
  await review.getByRole('button', { name: '允许本次', exact: true }).click()
  await until(async () => (await team.snapshot()).messages.find(row => row.id === proposal.id).state === 'waiting')
  const decision = requests.find(row => row.url.pathname === `/api/team/messages/${proposal.id}/decision`)
  assert.equal(decision.body.decision, 'approve'); assert.equal(Object.hasOwn(decision.body, 'body'), false)
  assert.equal((await team.snapshot()).messages.find(row => row.id === proposal.id).body, body)
  await rpc.call('test/finish', { threadId: manager })
  await until(async () => (await team.snapshot()).messages.find(row => row.id === proposal.id).state === 'delivered')
  const firstDelivery = (await turns()).find(row => row.params.input?.[0]?.text?.includes(proposal.id))
  assert.ok(firstDelivery?.params.input[0].text.includes(body), 'Delivered envelope contains the exact original Markdown')

  stage = 'edited Markdown is delivered verbatim and history bodies mount only when opened'
  const edited = '# 修订结论\n\n1. **保留格式**。\n2. 等待确认。\n\n```txt\n  leading  spaces\n\nlast line\n```'
  const second = await team.propose(lead, { to: manager, kind: 'task', title: '修改后批准验证', body: '**原始正文**', requestKey: 'edited-review' })
  const secondCard = card(second.id); await secondCard.waitFor()
  await secondCard.getByRole('button', { name: '修改正文', exact: true }).click()
  await secondCard.getByRole('textbox', { name: '调整待发送正文', exact: true }).fill(edited)
  await secondCard.getByRole('button', { name: '修改后允许', exact: true }).click()
  await until(async () => (await team.snapshot()).messages.find(row => row.id === second.id).state === 'waiting')
  assert.equal(requests.find(row => row.url.pathname === `/api/team/messages/${second.id}/decision`).body.body, edited)
  await rpc.call('test/finish', { threadId: manager })
  await until(async () => (await team.snapshot()).messages.find(row => row.id === second.id).state === 'delivered')
  assert.equal((await team.snapshot()).messages.find(row => row.id === second.id).body, edited)
  const secondDelivery = (await turns()).find(row => row.params.input?.[0]?.text?.includes(second.id))
  assert.ok(secondDelivery?.params.input[0].text.includes(edited))
  await sidebar.getByRole('button', { name: '全部记录', exact: true }).click(); await secondCard.waitFor()
  assert.equal(await secondCard.locator('.team-review-markdown').count(), 0)
  await secondCard.locator('.team-body-details > summary').click()
  await secondCard.getByRole('heading', { name: '修订结论', exact: true }).waitFor()
  await secondCard.locator('.team-body-details > summary').click()
  await until(async () => await secondCard.locator('.team-review-markdown').count() === 0)
  assert.deepEqual(errors, [])
  console.log('Team approval Markdown browser passed: headings/lists/emphasis/code, passive choice/GenUI/unsafe links, workspace and receiver-scoped file previews, preview preferences, raw edit/cancel/approve/delivery preservation, member-request descriptions, mobile/large-font containment, lazy history bodies; fake engine only.')
} catch (error) { console.error('Stage:', stage); await page.screenshot({ path: resolve(output, 'team-approvals-markdown-failure.png'), fullPage: true }).catch(() => {}); throw error }
finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
