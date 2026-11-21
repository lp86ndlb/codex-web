export type TeamRole = 'lead' | 'manager' | 'worker'
export type TeamPolicy = 'manual' | 'automatic' | 'ai'
export type TeamDirection = 'forward' | 'backward' | 'both' | 'none'
export type TeamMessageState = 'pending' | 'reviewing' | 'rejected' | 'approved' | 'waiting' | 'sending' | 'delivered' | 'uncertain' | 'cancelled'
export interface TeamMember { threadId: string; name: string; role: TeamRole; cwd: string; level: number; parentId: string | null; groupId: string | null; order: number; useDefaults: boolean; model: string; effort: string }
export interface TeamGroup { id: string; name: string; level: number; parentId: string; order: number }
export interface TeamEdge { id: string; source: string; target: string; direction: TeamDirection }
export interface TeamReview { id: string; reviewerId: string; kind: 'supervisor' | 'risk' | 'both'; state: 'pending' | 'sending' | 'sent' | 'approved' | 'rejected' | 'uncertain' | 'needs-user'; deliveryId: string; batchId?: string; digest: string; reason?: string }
export interface TeamMemberRequest { id: string; from: string; name: string; reason: string; level: number; parentId: string | null; groupId: string | null; useDefaults: boolean; model: string; effort: string; requestKey: string; state: 'pending' | 'creating' | 'created' | 'rejected' | 'uncertain'; version: number; createdAt: number; threadId?: string; error?: string }
export interface TeamMessage {
  id: string; from: string; to: string; kind: 'task' | 'question' | 'result'; title: string; body: string
  requestKey: string; replyTo?: string; version: number; digest: string; deliveryId: string
  batchId?: string; batchRequested?: boolean
  state: TeamMessageState; createdAt: number; updatedAt: number; reason?: string
  approvedDigest?: string; approvedAt?: number
  audit: { at: number; action: string; actor: 'user' | 'agent' | 'system'; note?: string }[]
  policy: TeamPolicy; graphVersion: number; reviews: TeamReview[]
}
export interface TeamSnapshot { revision: number; enabled: boolean; workspace: string; members: TeamMember[]; messages: TeamMessage[]; graphVersion: number; levels: string[]; groups: TeamGroup[]; edges: TeamEdge[]; policy: TeamPolicy; memberRequests: TeamMemberRequest[] }
export const teamTaskApprovalLimit = 30
export interface TeamView extends TeamSnapshot { running: string[]; workspaceId?: string; pilot?: boolean; connecting?: string[]; capabilities?: { memberRemoval?: boolean; batchDelivery?: boolean; batchApproval?: boolean } }
export const teamRoleLabels: Record<TeamRole, string> = { lead: '负责人', manager: '项目主管', worker: '执行成员' }
export const teamStateLabels: Record<TeamMessageState, string> = {
  pending: '待你审批', reviewing: '等待上级审核', rejected: '已拒绝', approved: '待投递', waiting: '等待接收方', sending: '投递中', delivered: '已送达', uncertain: '需核对', cancelled: '已取消',
}
export const teamPolicyLabels: Record<TeamPolicy, string> = { manual: '手动审批', automatic: '自动审批', ai: 'AI 自主判断风险' }
export const teamOutstanding = new Set<TeamMessageState>(['pending', 'reviewing', 'approved', 'waiting', 'sending', 'uncertain'])
