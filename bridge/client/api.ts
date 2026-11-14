export class ApiError extends Error { code: string; status: number; constructor(code: string, message: string, status = 0) { super(message); this.code = code; this.status = status } }
let csrf = ''
export function setToken(token: string) { csrf = token }
export async function upload(file: File) {
  const response = await fetch('/api/attachments', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Bridge-Token': csrf, 'X-File-Name': encodeURIComponent(file.name) }, body: file })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message || '附件上传失败')
  return result as import('../shared/types.ts').AttachmentInfo
}

export async function api<T>(path: string, data?: object, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<T> {
  let response: Response
  try { response = await fetch(`/api${path}`, {
    method: data ? 'POST' : 'GET', credentials: 'same-origin',
    headers: data ? { 'Content-Type': 'application/json', 'X-Bridge-Token': csrf } : {},
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: options.signal || AbortSignal.timeout(options.timeout || (data ? 60_000 : 25_000)),
  }) } catch { throw new ApiError(data ? 'REQUEST_UNKNOWN' : 'NETWORK', data ? '连接中断，提交结果待核对。' : '无法连接网页服务，请检查连接。') }
  let result
  try { result = await response.json() } catch { throw new ApiError(data ? 'REQUEST_UNKNOWN' : 'INVALID_RESPONSE', '服务返回了无效响应，请核对连接与操作结果。', response.status) }
  if (!response.ok) throw new ApiError(result.error?.code || 'REQUEST_FAILED', result.error?.message || `请求失败 (${response.status})`, response.status)
  return result as T
}

export function uncertainSubmission(error: unknown) { return !(error instanceof ApiError) || ['REQUEST_UNKNOWN', 'MESSAGE_RESULT_UNKNOWN', 'CLI_TIMEOUT', 'CLI_PIPE', 'CLI_EXIT', 'CLI_PROTOCOL', 'EDIT_REVERTED', 'CLI_RPC'].includes(error.code) || error.status >= 500 }

export function message(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试' }
