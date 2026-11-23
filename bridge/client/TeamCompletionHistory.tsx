import { useEffect, useRef } from 'react'
import { CheckCircle2 } from 'lucide-react'
import type { TeamCompletion } from '../shared/team.ts'

function Report({ report }: { report: TeamCompletion }) {
  return <article data-report={report.id}>
    <small><CheckCircle2 size={14} />团队任务已完工 · {report.sender} <time dateTime={new Date(report.createdAt).toISOString()}>{new Date(report.createdAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></small>
    <strong>{report.title}</strong><p>{report.summary}</p>
  </article>
}

export function TeamCompletionHistory({ reports, target }: { reports: TeamCompletion[]; target?: string }) {
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!target) return
    const item = section.current?.querySelector<HTMLElement>(`[data-report="${CSS.escape(target)}"]`)
    if (!item) return
    const history = item.closest('details')
    if (history) history.open = true
    item.scrollIntoView({ block: 'nearest' })
  }, [target, reports.length])
  const latest = reports.at(-1)
  if (!latest) return null
  return <section ref={section} className="team-completion-history" aria-label="团队完工通知">
    <Report report={latest} />
    {reports.length > 1 && <details><summary>更早的完工通知 · {reports.length - 1}</summary>{reports.slice(0, -1).reverse().map(report => <Report key={report.id} report={report} />)}</details>}
  </section>
}
