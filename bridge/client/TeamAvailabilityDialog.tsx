import { useEffect, useRef } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { useExitAction } from './Motion.tsx'
import './team.css'

export function TeamAvailabilityDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), { closing, exit } = useExitAction(onClose, dialog)
  useEffect(() => { dialog.current?.showModal() }, [])
  const trial = new URL(window.location.href); trial.port = '4791'; trial.pathname = '/'; trial.search = '?team=1'; trial.hash = ''
  return <dialog ref={dialog} className="team-editor-dialog" data-exiting={closing || undefined} aria-label="团队模式服务待更新" onCancel={e => { e.preventDefault(); exit() }}>
    <header><h2>团队模式</h2><button className="icon-button" aria-label="关闭团队模式说明" onClick={() => exit()}><X size={16} /></button></header>
    <div className="team-availability-body"><p>当前网页已提供入口，后台仍是旧版本。正式工作区的团队模式将在后台服务更新后启用。</p><p className="team-card-note">运行中的任务继续执行。现在可以打开原试验工作区查看已验收的关系图；正式模式启用后，右键工作区即可设置团队，并选择已有会话加入。</p><a className="team-primary" href={trial.href} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />打开试验工作区</a><p className="team-card-note">{trial.href}</p><footer><button onClick={() => exit()}>知道了</button></footer></div>
  </dialog>
}
