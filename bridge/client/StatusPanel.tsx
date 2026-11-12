import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { AccountStatus, UsageWindow } from '../shared/types.ts'
import { api, message } from './api.ts'

function WindowUsage({ window, name }: { window: UsageWindow; name: string }) {
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent))
  const duration = window.windowDurationMins
  const label = duration ? duration >= 1440 ? `${Math.round(duration / 1440)} 天额度` : duration >= 60 ? `${Math.round(duration / 60)} 小时额度` : `${duration} 分钟额度` : name
  return <div className="usage-window"><div><strong>{label}</strong><span>剩余 {Math.round(remaining)}%</span></div><div className="usage-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining)}><i style={{ width: `${remaining}%` }} /></div>{window.resetsAt ? <small>重置时间 · {new Date(window.resetsAt * 1000).toLocaleString('zh-CN')}</small> : null}</div>
}

export function StatusPanel({ model, tokens, compact = false }: { model?: string; tokens?: number; compact?: boolean }) {
  const [value, setValue] = useState<AccountStatus | null>(null)
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false; let pending = false
    const load = async () => {
      if (pending || document.hidden) return
      pending = true; setLoading(true)
      try { const next = await api<AccountStatus>('/account/status'); if (!cancelled) { setValue(next); setError('') } }
      catch (error) { if (!cancelled) setError(message(error)) }
      finally { pending = false; if (!cancelled) setLoading(false) }
    }
    void load(); const timer = window.setInterval(load, 60000)
    const onVisibility = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [refresh])
  return <>{!compact && <><p className="settings-description">来自当前 Codex 账户，打开时自动刷新；使用窗口由账户实际返回。</p><dl className="connection-details"><dt>登录方式</dt><dd>{value?.accountType || '未提供'}</dd><dt>账户方案</dt><dd>{value?.planType || '未提供'}</dd><dt>当前会话模型</dt><dd>{model || 'CLI 默认模型'}</dd>{Boolean(tokens) && <><dt>会话累计用量</dt><dd>{tokens!.toLocaleString()} tokens</dd></>}</dl></>}
    <div className="usage-heading"><h4>使用额度</h4><button type="button" onClick={() => setRefresh(n => n + 1)} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button></div>
    {error && <p role="alert" className="settings-footnote">{error}</p>}{value?.error && <p className="settings-footnote">{value.error}</p>}
    {value?.limits.map((limit, index) => <section key={`${limit.limitName}-${index}`} className="usage-group"><strong>{limit.limitName || 'Codex'}</strong>{limit.primary && <WindowUsage window={limit.primary} name="主要额度" />}{limit.secondary && <WindowUsage window={limit.secondary} name="次要额度" />}{limit.credits && <small>{limit.credits.unlimited ? '额度：无限' : limit.credits.balance ? `余额：${limit.credits.balance}` : limit.credits.hasCredits ? '有可用额度' : '无可用额度'}</small>}</section>)}
    {!loading && value && !value.limits.length && <p className="settings-empty">当前账户没有返回可显示的额度数据。</p>}{loading && !value && <p className="settings-empty">正在读取账户状态…</p>}
    {compact && <p className="usage-footnote">{value?.planType ? `${value.planType} · ` : ''}来自 Codex · 每分钟更新</p>}
  </>
}
