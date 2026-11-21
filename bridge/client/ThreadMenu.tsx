import { Archive, Copy, GitBranch, MessageSquare, Pencil, SquareTerminal } from 'lucide-react'
import { ContextMenu } from './ContextMenu.tsx'

export interface ThreadMenuTarget { threadId: string; x: number; y: number; trigger: HTMLElement }
export type ThreadMenuAction = 'open' | 'rename' | 'fork' | 'copy-title' | 'terminal' | 'archive'

/** A top-layer menu stays outside the sidebar's scrolling and folding clips. */
export function ThreadMenu({ target, title, busy, connected, unavailable, nativeActions, onClose, onAction }: {
  target: ThreadMenuTarget | null; title: string; busy: boolean; connected: boolean; unavailable: string; nativeActions: boolean
  onClose: (restoreFocus?: boolean) => void; onAction: (id: string, action: ThreadMenuAction) => void
}) {
  const disabled = busy || !connected
  const reason = !connected ? '连接就绪后可执行此操作' : busy ? '正在提交操作，请稍候' : unavailable
  const action = (value: ThreadMenuAction) => { if (!target) return; onClose(value === 'copy-title' || value === 'terminal'); onAction(target.threadId, value) }
  return <ContextMenu target={target} title={title} label="会话菜单" onClose={onClose}>
    <button type="button" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => action('open')}><MessageSquare size={15} /><span>打开会话</span></button>
    <button type="button" role="menuitem" tabIndex={-1} disabled={disabled} onClick={() => action('rename')}><Pencil size={15} /><span>重命名</span></button>
    {nativeActions && <button type="button" role="menuitem" tabIndex={-1} disabled={disabled} onClick={() => action('fork')}><GitBranch size={15} /><span>创建分支话题</span></button>}
    <div role="separator" />
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => action('copy-title')}><Copy size={15} /><span>复制会话名称</span></button>
    <button type="button" role="menuitem" tabIndex={-1} disabled={disabled || Boolean(unavailable)} title={reason || '复制 codex resume 命令，在终端接续'} onClick={() => action('terminal')}><SquareTerminal size={15} /><span>复制终端继续命令</span></button>
    <div role="separator" />
    <button type="button" role="menuitem" tabIndex={-1} disabled={disabled || Boolean(unavailable)} title={reason || '归档后可在设置中恢复'} onClick={() => action('archive')}><Archive size={15} /><span>归档会话</span></button>
    {reason && <p className="thread-menu-note">{reason}</p>}
  </ContextMenu>
}
