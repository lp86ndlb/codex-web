import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveChatLink } from '../shared/chat-links.ts'

const scope = { root: '/projects/cweb', cwd: '/projects/cweb/bridge', origin: 'http://127.0.0.1:4780' }

test('chat links resolve workspace paths, Unicode and common source locations', () => {
  assert.deepEqual(resolveChatLink('../README.md', scope), { kind: 'file', path: '/projects/cweb/README.md' })
  assert.deepEqual(resolveChatLink('./client/../main.ts:12:3', scope), { kind: 'file', path: '/projects/cweb/bridge/main.ts', line: 12 })
  assert.deepEqual(resolveChatLink('main.ts:24', scope), { kind: 'file', path: '/projects/cweb/bridge/main.ts', line: 24 })
  assert.deepEqual(resolveChatLink('/projects/cweb/.cache/review.md', scope), { kind: 'file', path: '/projects/cweb/.cache/review.md' })
  assert.deepEqual(resolveChatLink('docs/%E9%83%A8%E7%BD%B2%20%E8%AF%B4%E6%98%8E.md#L2-L10', scope), { kind: 'file', path: '/projects/cweb/bridge/docs/部署 说明.md', line: 2 })
  assert.deepEqual(resolveChatLink('file://localhost/projects/cweb/README.md#%E5%AE%89%E8%A3%85', scope), { kind: 'file', path: '/projects/cweb/README.md', anchor: '安装' })
  assert.deepEqual(resolveChatLink('file:///projects/cweb/README.md', scope), { kind: 'file', path: '/projects/cweb/README.md' })
  assert.deepEqual(resolveChatLink('#安装', scope), { kind: 'anchor', anchor: '安装' })
  assert.deepEqual(resolveChatLink('README.md#quick-start', scope), { kind: 'file', path: '/projects/cweb/bridge/README.md', anchor: 'quick-start' })
  assert.deepEqual(resolveChatLink('README.md', { ...scope, cwd: '' }), { kind: 'file', path: '/projects/cweb/README.md' })
})

test('web links remain external while erroneous same-origin filesystem routes are previewed', () => {
  for (const href of ['https://github.com/lp86ndlb/codex-web', 'mailto:contact@example.com', '//example.com/project', 'http://127.0.0.1:4780/api/attachments/123/content', '/api/attachments/00000000-0000-4000-8000-000000000001/content']) {
    assert.deepEqual(resolveChatLink(href, scope), { kind: 'external', href })
  }
  assert.deepEqual(resolveChatLink('http://127.0.0.1:4780/projects/cweb/README.md#L8', scope), { kind: 'file', path: '/projects/cweb/README.md', line: 8 })
  assert.deepEqual(resolveChatLink('http://127.0.0.1:4781/projects/cweb/README.md', scope), { kind: 'external', href: 'http://127.0.0.1:4781/projects/cweb/README.md' })
})

test('chat links reject executable schemes, malformed encodings and remote files', () => {
  for (const href of ['javascript:alert(1)', 'javascript:12', 'data:text/html,hi', 'vscode://file/project', 'custom:thing', 'file://elsewhere/project.md', 'README.md?download=1', '%zz.md', 'README.md#%ff', 'README.md\0', 'README.md#L0', 'README.md#L12-L2', 'README.md:0', 'README.md:12:0', 'README.md:9999999999999999999999999', 'README.md#L999999999999999999999999', 'client\\main.ts', '']) {
    assert.deepEqual(resolveChatLink(href, scope), { kind: 'invalid' }, href)
  }
})
