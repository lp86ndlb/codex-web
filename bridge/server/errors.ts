/** Expected failures expose a stable code; the HTTP handler owns user-visible reporting. */
export class BridgeError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.status = status
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export function string(value: unknown): string { return typeof value === 'string' ? value : '' }
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
