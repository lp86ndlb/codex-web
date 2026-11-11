export class ApiError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code } }
let csrf = ''
export function setToken(token: string) { csrf = token }
export async function upload(file: File) {
  const response = await fetch('/api/attachments', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Bridge-Token': csrf, 'X-File-Name': encodeURIComponent(file.name) }, body: file })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message || '附件上传失败')
  return result as import('../shared/types.ts').AttachmentInfo
}

export async function api<T>(path: string, data?: object): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: data ? 'POST' : 'GET', credentials: 'same-origin',
    headers: data ? { 'Content-Type': 'application/json', 'X-Bridge-Token': csrf } : {},
    ...(data ? { body: JSON.stringify(data) } : {}),
  })
  const result = await response.json()
  if (!response.ok) throw new ApiError(result.error?.code || 'REQUEST_FAILED', result.error?.message || `请求失败 (${response.status})`)
  return result as T
}

export function message(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试' }
