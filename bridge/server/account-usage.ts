import { createHash } from 'node:crypto'
import type { AccountStatus, UsageLimits, UsageWindow } from '../shared/types.ts'
import type { CodexRpc } from './rpc.ts'
import { record, string } from './errors.ts'

function window(value: unknown): UsageWindow | null {
  const row = record(value)
  if (typeof row.usedPercent !== 'number' || !Number.isFinite(row.usedPercent) || row.usedPercent < 0 || row.usedPercent > 100) return null
  return { usedPercent: row.usedPercent, ...(typeof row.windowDurationMins === 'number' && row.windowDurationMins > 0 ? { windowDurationMins: row.windowDurationMins } : {}), ...(typeof row.resetsAt === 'number' && row.resetsAt > 0 ? { resetsAt: row.resetsAt } : {}) }
}
function limits(value: unknown): UsageLimits[] {
  const raw = record(value), byId = Object.entries(record(raw.rateLimitsByLimitId))
  return (byId.length ? byId : raw.rateLimits ? [['Codex', raw.rateLimits] as [string, unknown]] : []).flatMap(([id, value]) => {
    const row = record(value), primary = window(row.primary), secondary = window(row.secondary), source = record(row.credits)
    const credits = typeof source.hasCredits === 'boolean' || typeof source.unlimited === 'boolean' || typeof source.balance === 'string'
      ? { hasCredits: source.hasCredits === true, unlimited: source.unlimited === true, ...(typeof source.balance === 'string' ? { balance: source.balance } : {}) } : null
    return primary || secondary || credits ? [{ limitName: string(row.limitName) || string(row.limitId) || id, primary, secondary, credits }] : []
  })
}
function failure(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  if (/method not found|unknown method|not supported|does not support/i.test(text)) return { retry: false, text: '当前 CLI 不支持额度查询，请升级 CLI 后重试。' }
  if (/401|unauthori[sz]ed|authentication required|not logged|token.*expired/i.test(text)) return { retry: false, text: '额度查询需要有效登录，请在 Codex CLI 检查登录状态后刷新。' }
  if (/403|permission|forbidden/i.test(text)) return { retry: false, text: '当前账户无权读取额度，请检查账户权限。' }
  if (/429|rate.?limit.*exceed|too many requests/i.test(text)) return { retry: false, text: '额度查询请求过于频繁，请稍后刷新。' }
  return { retry: true, text: /time.?out|超时/i.test(text) ? '额度查询超时，请检查连接后刷新。' : '暂时无法取得额度快照，请检查连接或稍后刷新。' }
}

/** Keep only confirmed, account-scoped snapshots in memory; never infer usage
 * from a previous conversation, and never expose identity fields to the UI. */
export class AccountUsage {
  private rpc: CodexRpc
  private clock: () => number
  private epoch = 0
  private pending?: Promise<AccountStatus>
  private cached?: { identity: string; value: AccountStatus }
  constructor(rpc: CodexRpc, clock = Date.now) {
    this.rpc = rpc; this.clock = clock
    rpc.on('disconnected', () => this.clear())
    rpc.on('notification', message => { if (['account/updated', 'account/login/completed'].includes(string(record(message).method))) this.clear() })
  }
  private clear() { this.epoch++; this.cached = undefined; this.pending = undefined }
  read(): Promise<AccountStatus> {
    if (this.pending) return this.pending
    const pending = this.load().finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending; return pending
  }
  private async load(): Promise<AccountStatus> {
    const epoch = this.epoch
    await this.rpc.start()
    const [accountResult, initial] = await Promise.allSettled([
      this.rpc.call('account/read', { refreshToken: false }),
      // Normal usage polls do not need the separate reset-credit detail API.
      this.rpc.call('account/rateLimits/read', { excludeResetCreditDetails: true }),
    ])
    if (epoch !== this.epoch) return { accountType: '', planType: '', limits: [], error: '账户或连接状态已变化，请刷新额度。' }
    const response = accountResult.status === 'fulfilled' ? record(accountResult.value) : {}, account = record(response.account)
    const accountType = string(account.type), planType = string(account.planType)
    const routing = string(record(response.workspaceRouting).chatgptAccountId)
    const known = routing || string(response.userId) || string(account.email)
    const identity = known ? createHash('sha256').update(JSON.stringify([accountType, planType, routing, response.userId, account.email])).digest('hex') : ''
    if (!identity || this.cached?.identity !== identity) this.cached = undefined
    let result = initial
    // One read-only retry for transient failures/empty snapshots. Authentication
    // and unsupported-method errors need a user action, not repeated requests.
    if (epoch === this.epoch && (result.status === 'rejected' ? failure(result.reason).retry : !limits(result.value).length)) {
      try { result = { status: 'fulfilled', value: await this.rpc.call('account/rateLimits/read', { excludeResetCreditDetails: true }) } }
      catch (reason) { result = { status: 'rejected', reason } }
    }
    if (epoch !== this.epoch) return { accountType: '', planType: '', limits: [], error: '账户或连接状态已变化，请刷新额度。' }
    const raw = result.status === 'fulfilled' ? record(result.value) : {}, rows = limits(raw)
    if (routing && string(raw.accountId) && raw.accountId !== routing) { this.cached = undefined; return { accountType, planType, limits: [], error: '额度快照与当前账户不一致，请稍后刷新。' } }
    if (rows.length && accountResult.status === 'fulfilled' && accountType) {
      const value: AccountStatus = { accountType, planType, limits: rows, updatedAt: this.clock(), stale: false }
      if (identity) this.cached = { identity, value }
      return value
    }
    const error = result.status === 'rejected' ? failure(result.reason) : accountResult.status === 'rejected' ? failure(accountResult.reason) : { retry: true, text: accountType === 'apiKey' ? 'API Key 登录未返回订阅额度窗口，请查看对应服务的用量。' : !accountType ? '尚未读取到登录账户，请检查 Codex 登录状态。' : 'Codex 暂未返回额度快照，请稍后刷新。' }
    const cached = this.cached
    if (error.retry && identity && cached?.identity === identity && this.clock() - cached.value.updatedAt! <= 15 * 60_000) return { ...cached.value, stale: true, error: error.text }
    if (!error.retry) this.cached = undefined
    return { accountType, planType, limits: [], error: error.text }
  }
}
