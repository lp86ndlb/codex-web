import { useEffect, useRef } from 'react'
import { saveComposerCache, type ComposerCache } from './composer-cache.ts'

/** Write only changed conversations, coalesce typing, flush before leaving. */
export function useComposerCache(value: ComposerCache, onError: (message: string) => void) {
  const current = useRef(value); current.current = value
  const saved = useRef(value)
  const flush = useRef(() => {})
  flush.current = () => {
    try { saveComposerCache(localStorage, current.current, saved.current); saved.current = current.current; onError('') }
    catch { onError('浏览器未能保存草稿，请在关闭页面前复制重要内容。') }
  }
  useEffect(() => { const timer = setTimeout(() => flush.current(), 250); return () => clearTimeout(timer) }, [value.drafts, value.fileDrafts, value.skillDrafts, value.referenceDrafts])
  useEffect(() => { flush.current() }, [value.pendingMessages, value.editingMessages])
  useEffect(() => {
    const leave = () => flush.current(), visibility = () => { if (document.hidden) leave() }
    addEventListener('pagehide', leave); document.addEventListener('visibilitychange', visibility)
    return () => { leave(); removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', visibility) }
  }, [])
}
