import { useCallback, useEffect, useState } from 'react'
import { Check, Circle, Download, LoaderCircle, RefreshCw, ShieldCheck, Square, Stethoscope } from 'lucide-react'
import type { Bootstrap, RuntimeStatus, ThreadView } from '../shared/types.ts'
import { classifyFailure, type ConnectionSnapshot } from '../shared/connection.ts'
import { api, message } from './api.ts'
import { Notice } from './components.tsx'
import './connection.css'

function diagnosticChecks(result: unknown) {
  if (!result || typeof result !== 'object') return []
  const checks = (result as Record<string, unknown>).checks
  const names: Record<string, string> = { 'config.load': '配置读取', 'network.env': '网络环境', 'network.provider_reachability': '模型 HTTP 连接', 'network.websocket_reachability': 'Responses WebSocket 握手' }
  return Object.entries(checks && typeof checks === 'object' ? checks : {}).slice(0, 40).flatMap(([key, value]) => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>, id = typeof row.id === 'string' ? row.id : key
    const state = typeof row.status === 'string' ? row.status : 'unknown'
    return [{ id, name: names[id] || String(row.name || id), state, label: ['ok', 'passed', 'pass'].includes(state) ? '通过' : ['warn', 'warning'].includes(state) ? '需注意' : ['error', 'failed', 'fail'].includes(state) ? '未通过' : state === 'skipped' ? '未检查' : '待确认', duration: typeof row.durationMs === 'number' ? row.durationMs : undefined }]
  })
}

export function ConnectionPanel({ boot, connected, online, runtime, thread, onReconnect }: {
  boot: Bootstrap | null; connected: boolean; online: boolean; runtime: RuntimeStatus; thread?: ThreadView; onReconnect: () => void
}) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>()
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const supported = boot?.capabilities?.diagnostics
  const refresh = useCallback(async () => {
    if (!supported) return
    try { setSnapshot(await api<ConnectionSnapshot>('/diagnostics')); setError('') } catch (error) { setError(message(error)) }
  }, [supported])
  useEffect(() => { void refresh() }, [refresh, runtime.state])
  useEffect(() => {
    if (snapshot?.report.state !== 'running') return
    const timer = setTimeout(() => void refresh(), 1000)
    return () => clearTimeout(timer)
  }, [snapshot, refresh])
  async function diagnose(action: 'start' | 'cancel') {
    setBusy(true)
    try { setSnapshot(await api<ConnectionSnapshot>('/diagnostics', { action })); setError('') } catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  function download() {
    if (!snapshot) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'cweb-diagnostics.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const modelError = thread?.error ? classifyFailure(thread.error) : undefined
  const checks = diagnosticChecks(snapshot?.report.result)
  const model = thread?.progress?.stage === 'retrying' ? '原生正在重试' : thread?.progress?.stage === 'compacting' ? '正在压缩上下文' : modelError?.title || (thread?.status === 'inProgress' ? '任务进行中 · 未主动探测' : '未主动探测')
  const layers = [
    { name: '浏览器网络', value: online ? '浏览器报告在线' : '浏览器报告离线', ok: online },
    { name: '网页事件连接', value: connected ? '已连接并同步' : '等待重新连接', ok: connected },
    { name: 'Codex 引擎', value: runtime.state === 'ready' ? '本地连接正常' : runtime.state === 'starting' ? '正在连接' : '连接不可用', ok: runtime.state === 'ready' },
    { name: '当前模型请求', value: model, ok: !modelError && thread?.progress?.stage !== 'retrying', neutral: !thread?.progress && !modelError },
  ]
  return <section className="connection-panel" aria-label="连接与诊断">
    <p className="settings-description">分别检查网页、CLI 与模型服务。重新连接只同步已有任务；网络诊断不会重发消息或停止其他会话。</p>
    <div className="connection-layers">{layers.map(layer => <div key={layer.name} className="connection-layer" data-state={layer.neutral ? 'unknown' : layer.ok ? 'ready' : 'waiting'}><span>{layer.neutral ? <Circle size={15} /> : layer.ok ? <Check size={15} /> : <Circle size={15} />}<strong>{layer.name}</strong></span><small>{layer.value}</small></div>)}</div>
    {(runtime.error || modelError) && <div className="settings-callout">{modelError?.next || '请先重新连接本地引擎，再查看原会话的执行结果。'}{runtime.error && <details><summary>连接错误</summary><p>{runtime.error}</p></details>}</div>}
    {error && <Notice text={error} />}
    {!supported && <p className="settings-callout">诊断面板将在后端更新后启用。当前可以重新连接并查看已有会话。</p>}
    <div className="connection-actions"><button type="button" onClick={onReconnect}><RefreshCw size={15} />重新连接</button>
      {snapshot?.report.state === 'running' ? <button type="button" disabled={busy} onClick={() => void diagnose('cancel')}><Square size={14} />取消诊断</button>
        : <button type="button" disabled={!supported || !online || busy} onClick={() => void diagnose('start')}><Stethoscope size={15} />运行网络诊断</button>}
      <button type="button" disabled={!snapshot} onClick={download}><Download size={15} />导出脱敏报告</button></div>
    <details className="connection-versions"><summary>版本与运行信息</summary><dl className="connection-details"><dt>网页构建</dt><dd>{import.meta.env.VITE_CWEB_BUILD || '开发模式'}</dd><dt>桥接构建</dt><dd>{snapshot ? snapshot.bridge.version + ' · ' + snapshot.bridge.build : '等待读取'}</dd><dt>已安装 CLI</dt><dd>{snapshot?.engine.installedVersion || '未知'}</dd><dt>运行端标识</dt><dd>{snapshot?.engine.userAgent || runtime.userAgent || '未提供版本标识'}</dd><dt>运行方式</dt><dd>{boot?.sharedEngine ? '与终端共享原生引擎' : '独立 CLI 引擎'}</dd><dt>最近连接</dt><dd>{runtime.connectedAt ? new Date(runtime.connectedAt).toLocaleTimeString() : '尚未连接'}</dd></dl></details>
    {snapshot?.report.state !== 'idle' && snapshot?.report && <section className="diagnostic-report" aria-label="网络诊断结果"><h4>{snapshot.report.state === 'running' ? <><LoaderCircle size={15} className="spin" />正在检查网络</> : snapshot.report.state === 'completed' ? '网络诊断已完成' : snapshot.report.state === 'cancelled' ? '诊断已取消' : '诊断发现问题或未能完成'}</h4>
      <p className="settings-footnote">{snapshot.report.message || '检查配置、网络环境、模型 HTTP 与 WebSocket 连接；结果反映检查时刻。'}</p>{checks.length > 0 && <ul className="diagnostic-checks">{checks.map(check => <li key={check.id}><span>{check.name}</span><small>{check.duration !== undefined && `${Math.round(check.duration)} ms`}</small><strong data-ok={check.label === '通过' || undefined}>{check.label}</strong></li>)}</ul>}{snapshot.report.result !== undefined && <details open={snapshot.report.state === 'failed'}><summary>查看脱敏诊断详情</summary><pre>{JSON.stringify(snapshot.report.result, null, 2)}</pre></details>}</section>}
    <section className="connection-timeline" aria-label="连接事件"><h4>最近连接事件</h4>{snapshot?.events.length ? <ol>{snapshot.events.slice(0, 30).map(event => <li key={event.id} data-level={event.level}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.title}{event.threadId && <small>话题 {event.threadId.slice(0, 8)}</small>}</span></li>)}</ol> : <p className="settings-footnote">当前服务尚未记录异常事件。</p>}</section>
    <p className="settings-footnote"><ShieldCheck size={13} /> 诊断按需运行；导出包含版本和事件，不包含会话正文。服务完全停止时，在本机运行 <code>npm start</code> 或 <code>cweb start</code>。</p>
  </section>
}

export function ConnectionNotice({ online, connected, runtime, onReconnect, onDetails }: { online: boolean; connected: boolean; runtime: RuntimeStatus; onReconnect: () => void; onDetails: () => void }) {
  if (connected) return null
  return <div className="connection-notice" role="status"><span>{!online ? '浏览器已离线，草稿保存在本机。网络恢复后自动同步。' : runtime.state === 'ready' ? '网页连接正在恢复，已有任务不会重新发送。' : '正在核对 CLI 连接；已显示的内容与草稿会保留。'}</span><button type="button" onClick={onDetails}>诊断</button><button type="button" disabled={!online} onClick={onReconnect}><RefreshCw size={14} />重连</button></div>
}
