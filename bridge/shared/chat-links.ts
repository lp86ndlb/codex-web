export type ChatLink =
  | { kind: 'file'; path: string; line?: number; anchor?: string }
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'invalid' }

export interface ChatLinkScope { root: string; cwd: string; origin?: string }
const invalid: ChatLink = { kind: 'invalid' }
const controls = /[\u0000-\u001f\u007f]/

/** POSIX lexical resolution only. The authenticated server still checks real paths. */
function absolutePath(path: string, base: string): string | undefined {
  if (!base.startsWith('/')) return undefined
  const segments: string[] = []
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return '/' + segments.join('/')
}

/** Resolve Markdown destinations without treating local files as application routes. */
export function resolveChatLink(href: string, scope: ChatLinkScope): ChatLink {
  if (typeof href !== 'string' || href.length > 8192 || controls.test(href)) return invalid
  let value = href.trim()
  if (!value) return invalid
  if (/^\/api\/attachments\/[0-9a-f-]+\/content(?:[?#]|$)/i.test(value)) return { kind: 'external', href: value }
  if (/^\/\//.test(value)) {
    try { const url = new URL(value, 'https://local.invalid'); return url.hostname ? { kind: 'external', href: value } : invalid } catch { return invalid }
  }
  if (/^(?:https?:|mailto:)/i.test(value)) {
    try {
      const url = new URL(value)
      if (url.protocol === 'mailto:') return { kind: 'external', href: value }
      if (!url.hostname) return invalid
      if (!scope.origin || url.origin !== new URL(scope.origin).origin || /^\/api(?:\/|$)/.test(url.pathname)) return { kind: 'external', href: value }
      value = url.pathname + url.search + url.hash
    } catch { return invalid }
  } else if (/^file:/i.test(value)) {
    try {
      const url = new URL(value)
      if (url.hostname && url.hostname !== 'localhost' || url.username || url.password || url.port) return invalid
      value = url.pathname + url.search + url.hash
    } catch { return invalid }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    // A source location can contain a colon; an executable/custom URL cannot.
    if (/^(?:javascript|data|vbscript|vscode|command|blob|ftp|tel):/i.test(value) || !/^.+:\d+(?::\d+)?$/.test(value)) return invalid
  }

  const hash = value.indexOf('#')
  let destination = hash < 0 ? value : value.slice(0, hash)
  let fragment: string | undefined
  try {
    destination = decodeURIComponent(destination)
    fragment = hash < 0 ? undefined : decodeURIComponent(value.slice(hash + 1))
  } catch { return invalid }
  if (controls.test(destination) || fragment !== undefined && controls.test(fragment) || destination.includes('?') || destination.includes('\\')) return invalid
  if (!destination) return fragment ? { kind: 'anchor', anchor: fragment } : invalid

  let line: number | undefined
  const suffix = /:(\d+)(?::(\d+))?$/.exec(destination)
  if (suffix) {
    line = Number(suffix[1])
    if (!Number.isSafeInteger(line) || line < 1 || suffix[2] && (!Number.isSafeInteger(Number(suffix[2])) || Number(suffix[2]) < 1)) return invalid
    destination = destination.slice(0, suffix.index)
  }
  if (fragment && /^L\d/.test(fragment)) {
    const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(fragment)
    if (!match) return invalid
    line = Number(match[1])
    const end = match[2] ? Number(match[2]) : line
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end) || end < line) return invalid
    fragment = undefined
  }
  const path = absolutePath(destination, scope.cwd || scope.root)
  if (!path) return invalid
  return { kind: 'file', path, ...(line === undefined ? {} : { line }), ...(fragment ? { anchor: fragment } : {}) }
}
