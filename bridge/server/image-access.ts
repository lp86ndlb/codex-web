import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import type { Item, ThreadView } from '../shared/types.ts'
import { resolveChatLink } from '../shared/chat-links.ts'
import { BridgeError } from './errors.ts'
import { Workspace } from './workspace.ts'

const links = new WeakMap<Item, { text: string; urls: string[] }>()
function imageLinks(item: Item): string[] {
  const cached = links.get(item)
  if (cached?.text === item.text) return cached.urls
  const tree = fromMarkdown(item.text), urls: string[] = [], references: string[] = []
  const definitions = new Map<string, string>(), pending: Nodes[] = [tree]
  while (pending.length) {
    const node = pending.pop()!
    if (node.type === 'image' || node.type === 'link') urls.push(node.url)
    if (node.type === 'imageReference' || node.type === 'linkReference') references.push(node.identifier)
    if (node.type === 'definition') definitions.set(node.identifier, node.url)
    if ('children' in node) for (const child of node.children) pending.push(child)
  }
  for (const id of references) { const url = definitions.get(id); if (url) urls.push(url) }
  links.set(item, { text: item.text, urls }); return urls
}

/** Temporary artifacts are exact images linked by this conversation, not a new file-browser root. */
export function imageAccess(workspace: Workspace, path: string, thread?: ThreadView) {
  const requested = resolve(workspace.root, path)
  if (workspace.contains(requested)) return { workspace, path: requested, temporary: false }
  const temporary = [...new Set(['/tmp', '/var/tmp', tmpdir()])]
    .filter(root => root !== '/').map(root => new Workspace(root)).find(scope => scope.contains(requested))
  if (temporary && /\.(?:png|jpe?g|webp|gif|avif)$/i.test(requested) && thread && workspace.contains(thread.cwd)) {
    for (const item of thread.items) {
      if (item.type !== 'agentMessage') continue
      if (imageLinks(item).some(url => {
        const link = resolveChatLink(url, { root: workspace.root, cwd: thread.cwd })
        return link.kind === 'file' && link.path === requested
      })) return { workspace: temporary, path: requested, temporary: true }
    }
  }
  throw new BridgeError('OUTSIDE_WORKSPACE', '只能预览工作区文件，或当前对话明确引用的临时图片', 403)
}
