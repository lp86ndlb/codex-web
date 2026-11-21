import { Check, FolderOpen, Network, Pencil, Plus } from 'lucide-react'
import { ContextMenu, type ContextTarget } from './ContextMenu.tsx'
export interface WorkspaceMenuTarget extends ContextTarget { workspaceId: string }
export function WorkspaceMenu({ target, name, teamAvailable, teamEnabled, teamBusy = false, onClose, onAction }: { target: WorkspaceMenuTarget | null; name: string; teamAvailable: boolean; teamEnabled?: boolean; teamBusy?: boolean; onClose: (focus?: boolean) => void; onAction: (action: 'open' | 'rename' | 'new' | 'team' | 'toggle-team') => void }) {
  const action = (value: Parameters<typeof onAction>[0]) => { onClose(); onAction(value) }
  return <ContextMenu target={target} title={name} label="工作区菜单" onClose={onClose}>
    <button role="menuitem" onClick={() => action('open')}><FolderOpen size={15} />打开工作区</button>
    <button role="menuitem" onClick={() => action('new')}><Plus size={15} />新建会话</button>
    <button role="menuitem" onClick={() => action('rename')}><Pencil size={15} />重命名工作区</button>
    <div role="separator" />{teamAvailable ? <><button role="menuitemcheckbox" aria-checked={Boolean(teamEnabled)} disabled={teamEnabled === undefined || teamBusy} onClick={() => action('toggle-team')}><Network size={15} /><span>团队模式</span>{teamEnabled && <Check size={14} />}</button><button role="menuitem" onClick={() => action('team')}><Network size={15} />打开关系图</button></> : <button role="menuitem" onClick={() => action('team')}><Network size={15} /><span>团队模式</span><small>待服务更新</small></button>}
  </ContextMenu>
}
