import { z } from 'zod'
import { teamTaskApprovalLimit, type TeamSnapshot } from '../shared/team.ts'
import { validateTeamGraph } from '../shared/team-topology.ts'
export const teamId = z.string().min(1).max(160)
const name = z.string().trim().min(1).max(100)
export const memberSchema = z.object({ threadId: teamId, name, role: z.enum(['lead', 'manager', 'worker']), cwd: z.string().min(1).max(4096), level: z.number().int().min(1).max(10), parentId: teamId.nullable(), groupId: teamId.nullable(), order: z.number().finite().default(0), useDefaults: z.boolean().default(true), model: z.string().max(200).default(''), effort: z.string().max(64).default('') }).strict()
export const groupSchema = z.object({ id: teamId, name, level: z.number().int().min(2).max(10), parentId: teamId, order: z.number().finite().default(0) }).strict()
export const edgeSchema = z.object({ id: teamId, source: teamId, target: teamId, direction: z.enum(['forward', 'backward', 'both', 'none']) }).strict()
export const teamProposalSchema = z.object({ to: teamId, kind: z.enum(['task', 'question', 'result']), title: z.string().trim().min(1).max(150), body: z.string().trim().min(1).max(8000), requestKey: z.string().min(1).max(120), replyTo: z.string().uuid().optional() }).strict()
export const teamDecisionSchema = z.object({ version: z.number().int().positive(), decision: z.enum(['approve', 'reject', 'cancel']), body: z.string().trim().min(1).max(8000).optional(), note: z.string().trim().max(500).optional() }).strict()
export const teamTaskApprovalSchema = z.object({
  tasks: z.array(z.object({ id: z.string().uuid(), version: z.number().int().positive() }).strict()).min(2).max(teamTaskApprovalLimit)
    .refine(tasks => new Set(tasks.map(task => task.id)).size === tasks.length, '同一任务只能选一次'),
}).strict()
const policy = z.enum(['manual', 'automatic', 'ai'])
const reviewSchema = z.object({ id: z.string().uuid(), reviewerId: teamId, kind: z.enum(['supervisor', 'risk', 'both']), state: z.enum(['pending', 'sending', 'sent', 'approved', 'rejected', 'uncertain', 'needs-user']), deliveryId: z.string().uuid(), batchId: z.string().uuid().optional(), digest: z.string(), reason: z.string().optional() }).strict()
const messageSchema = teamProposalSchema.extend({ id: z.string().uuid(), from: teamId, version: z.number().int().positive(), digest: z.string(), deliveryId: z.string().uuid(), batchId: z.string().uuid().optional(), batchRequested: z.boolean().optional(), state: z.enum(['pending', 'reviewing', 'rejected', 'approved', 'waiting', 'sending', 'delivered', 'uncertain', 'cancelled']), createdAt: z.number(), updatedAt: z.number(), reason: z.string().optional(), approvedDigest: z.string().optional(), approvedAt: z.number().optional(), policy: policy.default('manual'), graphVersion: z.number().int().default(1), reviews: z.array(reviewSchema).default([]), audit: z.array(z.object({ at: z.number(), action: z.string(), actor: z.enum(['user', 'agent', 'system']), note: z.string().optional() })) }).strict()
export const memberRequestSchema = z.object({ name, reason: z.string().trim().max(2000).default(''), level: z.number().int().min(1).max(10), parentId: teamId.nullable(), groupId: teamId.nullable(), useDefaults: z.boolean().default(true), model: z.string().max(200).default(''), effort: z.string().max(64).default(''), requestKey: z.string().min(1).max(120) }).strict()
const storedMemberRequest = memberRequestSchema.extend({ id: z.string().uuid(), from: teamId, state: z.enum(['pending', 'creating', 'created', 'rejected', 'uncertain']), version: z.number().int().positive(), createdAt: z.number(), threadId: teamId.optional(), error: z.string().optional() }).strict()
export const topologySchema = z.object({ graphVersion: z.number().int().positive(), members: z.array(memberSchema).max(80), groups: z.array(groupSchema).max(80), edges: z.array(edgeSchema).max(500), levels: z.array(name).min(3).max(10) }).strict()
const schema = z.object({ revision: z.number().int(), enabled: z.boolean(), workspace: z.string(), members: z.array(memberSchema).max(80), messages: z.array(messageSchema).max(1000), graphVersion: z.number().int().positive().default(1), levels: z.array(name).min(3).max(10), groups: z.array(groupSchema).max(80), edges: z.array(edgeSchema).max(500), policy: policy.default('manual'), memberRequests: z.array(storedMemberRequest).max(200).default([]) }).strict()
export function emptyTeam(): TeamSnapshot { return { revision: 0, enabled: false, workspace: '', members: [], messages: [], graphVersion: 1, levels: ['负责人', '主管', '执行成员'], groups: [], edges: [], policy: 'manual', memberRequests: [] } }
export function parseTeam(raw: unknown): TeamSnapshot {
  const value = structuredClone(raw) as Record<string, any>
  if (!value.levels) {
    Object.assign(value, { levels: ['负责人', '主管', '执行成员'], graphVersion: 1, policy: 'manual', groups: [], edges: [], memberRequests: [] })
    for (const member of value.members) {
      member.level = member.role === 'lead' ? 1 : member.role === 'manager' ? 2 : 3
      const parent = value.members.find((m: any) => m.role === (member.role === 'manager' ? 'lead' : 'manager'))
      member.parentId = member.level === 1 ? null : parent?.threadId || null
      member.groupId = member.parentId ? `group-${member.parentId}` : null
      member.order = 0; member.useDefaults = true; member.model = ''; member.effort = ''
      if (member.parentId) {
        if (!value.groups.some((g: any) => g.id === member.groupId)) value.groups.push({ id: member.groupId, name: `${parent.name}组`, parentId: parent.threadId, level: member.level, order: 0 })
        value.edges.push({ id: `edge-${member.threadId}`, source: parent.threadId, target: member.threadId, direction: 'both' })
      }
    }
  }
  const parsed = schema.parse(value)
  const error = validateTeamGraph(parsed.members, parsed.groups, parsed.edges, parsed.levels)
  if (error) throw new Error(error)
  return parsed
}
