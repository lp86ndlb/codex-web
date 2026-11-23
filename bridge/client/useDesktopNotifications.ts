import { useCallback, useEffect, useRef, useState } from 'react'

const enabledKey = 'cweb:desktop-completion-since'
const receiptPrefix = 'cweb:desktop-completion:'
interface Completion { key: string; id: string; updatedAt: number; title: string; reportId?: string; sender?: string }

// Read and record a receipt in one transaction. localStorage can still show a
// stale value in another renderer immediately after a cross-tab lock changes hands.
let receiptDatabase: Promise<IDBDatabase> | undefined
async function showOnce(receipt: string, key: string, display: () => boolean) {
  if (!receiptDatabase) {
    receiptDatabase = new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('cweb-desktop-notifications', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('receipts')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    }).catch(error => { receiptDatabase = undefined; throw error })
  }
  const db = await receiptDatabase
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('receipts', 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    const store = transaction.objectStore('receipts'), read = store.get(receipt)
    read.onsuccess = () => {
      try {
        const legacy = read.result === undefined ? localStorage.getItem(receipt) : null
        const recent: string[] = read.result ?? (legacy === '1' ? [key] : JSON.parse(legacy || '[]'))
        if (!recent.includes(key) && display()) store.put([...recent.slice(-11), key], receipt)
      } catch (error) { transaction.abort(); reject(error) }
    }
  })
}

function enabledSince() {
  try { return Number(localStorage.getItem(enabledKey)) || 0 } catch { return 0 }
}
function permission() {
  return window.isSecureContext && typeof Notification === 'function' ? Notification.permission : 'unsupported'
}

export function useDesktopNotifications(onOpen: (notice: Completion) => void) {
  const [since, setSince] = useState(enabledSince)
  const [access, setAccess] = useState(permission)
  const [pending, setPending] = useState(false), [hint, setHint] = useState('')
  const onClick = useRef(onOpen); onClick.current = onOpen
  useEffect(() => {
    const sync = () => { setSince(enabledSince()); setAccess(permission()) }
    const storage = (event: StorageEvent) => { if (!event.key || event.key === enabledKey) sync() }
    window.addEventListener('storage', storage); window.addEventListener('focus', sync)
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('focus', sync) }
  }, [])
  async function toggle(on: boolean) {
    setHint('')
    setPending(true)
    try {
      if (on) {
        const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
        setAccess(result)
        if (result !== 'granted') {
          if (result === 'default') setHint('尚未授权，可再次点击开启。')
          return
        }
      }
      const start = on ? Date.now() : 0
      if (start) localStorage.setItem(enabledKey, String(start))
      else localStorage.removeItem(enabledKey)
      setSince(start)
    } catch { setHint('浏览器未能启用系统通知，请检查站点权限与本地存储。') }
    finally { setPending(false) }
  }

  const notify = useCallback((notice: Completion) => {
    if (!since || access !== 'granted' || notice.updatedAt < since) return
    // Keep the original report receipts. Ordinary conversations only need a
    // small recent-turn history per thread, even after years of use.
    const receipt = notice.reportId ? receiptPrefix + notice.reportId : 'cweb:desktop-turns:' + notice.id
    void showOnce(receipt, notice.key, () => {
      if (enabledSince() !== since || permission() !== 'granted') return false
      const notification = new Notification(notice.title, {
        body: notice.reportId ? '团队任务已完工 · ' + notice.sender : '本轮处理完成',
        icon: '/brand-symbol.svg', tag: notice.reportId ? receipt : notice.key,
      })
      notification.onclick = () => { window.focus(); onClick.current(notice); notification.close() }
      return true
    }).catch(() => setHint('系统通知未能发送，仍可在网页中查看。'))
  }, [since, access])

  const detail = hint || (access === 'unsupported' ? '请在支持桌面通知的浏览器中通过本机地址或 HTTPS 打开。'
    : access === 'denied' ? '浏览器已阻止通知。可在地址栏的站点权限中改为允许。'
    : '此浏览器打开 cweb 期间，任一会话每轮完成时都会显示系统横幅，点击可返回该会话。团队整体完工也会提醒。')
  return { notify, setting: { checked: since > 0 && access === 'granted', disabled: pending || access === 'unsupported' || access === 'denied', detail, onChange: toggle } }
}
