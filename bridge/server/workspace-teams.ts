import { resolve } from 'node:path'
import { WorkspaceCatalog } from './catalog.ts'
import { TeamService, type TeamAdapter } from './team.ts'
import { BridgeError } from './errors.ts'
import { teamOutstanding } from '../shared/team.ts'

/** Each workspace owns its ledger, credentials and delivery queues. Reads never enable a team. */
export class WorkspaceTeams {
  private services = new Map<string, TeamService>()
  private directory: string
  private catalog: WorkspaceCatalog
  private adapter: (id: string) => TeamAdapter
  constructor(directory: string, catalog: WorkspaceCatalog, adapter: (id: string) => TeamAdapter) {
    this.directory = directory; this.catalog = catalog; this.adapter = adapter
  }
  async initialize() { await Promise.all(this.catalog.list().map(row => this.get(row.id))) }
  async get(id: string) {
    const workspace = this.catalog.get(id)
    let team = this.services.get(id)
    if (!team) {
      team = new TeamService(resolve(this.directory, id, 'team.json'), this.adapter(id), { workspace: workspace.root })
      this.services.set(id, team)
    }
    await team.initialize()
    return team
  }
  async forThread(threadId: string) {
    for (const team of this.services.values()) if ((await team.snapshot()).members.some(row => row.threadId === threadId)) return team
    return undefined
  }
  async index() {
    return { workspaces: await Promise.all(this.catalog.list().map(async row => {
      const state = await (await this.get(row.id)).snapshot()
      const unread = state.completions?.filter(report => !report.readAt).map(({ id, sender, title, threadId, createdAt }) => ({ id, sender, title, threadId, createdAt }))
      return { ...(unread?.length ? { unread } : {}), id: row.id, enabled: state.enabled, members: state.members.length,
        pending: state.messages.filter(message => teamOutstanding.has(message.state)).length + state.memberRequests.filter(request => ['pending', 'uncertain'].includes(request.state)).length }
    })) }
  }
  async agentTool(token: string, name: string, args: unknown, workspaceId?: string) {
    // A URL scope can only narrow the credential's authority; it never grants it.
    const teams = workspaceId ? [await this.get(workspaceId)] : [...this.services.values()]
    for (const team of teams) {
      try { return await team.agentTool(token, name, args) }
      catch (error) { if (!(error instanceof BridgeError) || error.code !== 'TEAM_TOKEN') throw error }
    }
    throw new BridgeError('TEAM_TOKEN', '团队工具身份无效', 403)
  }
  async close() { await Promise.all([...this.services.values()].map(team => team.close())) }
}
