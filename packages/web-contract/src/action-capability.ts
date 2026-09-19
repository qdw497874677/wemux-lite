import { taskStatuses, workflowTargets, type TaskStatus } from '@wemux/domain'
import { runStatuses } from './task-platform.js'

export type CapabilityReasonCode = 'allowed' | 'invalid_metadata' | 'invalid_transition' | 'active_run' | 'assignment_changed' | 'workspace_not_ready' | 'runtime_unavailable' | 'reuse_ineligible' | 'not_found'
export interface ActionCapability { readonly allowed: boolean; readonly reasonCode: CapabilityReasonCode; readonly reason: string }
export type CapabilityAction = 'transition' | 'launch_new' | 'launch_reuse' | 'cancel' | 'review_request' | 'review_approve' | 'review_changes_requested' | 'send'
/** Facts, not precomputed eligibility. Unknown inputs intentionally fail closed. Authorization and CAS remain application boundaries. */
export interface CapabilityFacts {
  task?: unknown; runs?: unknown; run?: unknown; review?: unknown; target?: unknown
  assignment?: unknown; workspace?: unknown; worker?: unknown; binding?: unknown; session?: unknown
  projectId?: string; teamId?: string; actor?: string; idleReason?: string | null
}
export interface TaskCapabilities {
  transitions: Record<TaskStatus, ActionCapability>
  launchNew: ActionCapability
  reuse: Record<string, ActionCapability>
}
export interface RunCapabilities { cancel: ActionCapability; reviewRequest: ActionCapability; reviewApprove: ActionCapability; reviewChangesRequested: ActionCapability }
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const status = (value: unknown): value is TaskStatus => taskStatuses.includes(value as TaskStatus)
const assignment = (value: unknown) => { const a = record(value); return a && ['workspaceId', 'workerId', 'agentKey', 'modelId'].every(k => text(a[k])) ? a : undefined }
const same = (a: Record<string, unknown>, b: Record<string, unknown>) => ['workspaceId', 'workerId', 'agentKey', 'modelId'].every(k => a[k] === b[k])
const deny = (reasonCode: CapabilityReasonCode, reason: string): ActionCapability => ({ allowed: false, reasonCode, reason })
const timestamp = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value))
export const validReviewMetadata = (r: Record<string, unknown>) => text(r.id) && text(r.actor) && timestamp(r.requestedAt)
  && (r.closedAt === null || (timestamp(r.closedAt) && Date.parse(r.closedAt) >= Date.parse(String(r.requestedAt))))
  && (r.status === 'requested' ? r.reviewer === null && r.decidedAt === null
    : ['approved', 'changes_requested'].includes(String(r.status)) && text(r.reviewer) && timestamp(r.decidedAt)
      && Date.parse(r.decidedAt) >= Date.parse(String(r.requestedAt)) && r.closedAt === r.decidedAt)
const equalFacts = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  const left = record(a), right = record(b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equalFacts(v, b[i]))
  return !!left && !!right && Object.keys(left).filter(k => k !== 'capabilities').length === Object.keys(right).filter(k => k !== 'capabilities').length
    && Object.keys(left).filter(k => k !== 'capabilities').every(k => equalFacts(left[k], right[k]))
}
const allowed: ActionCapability = { allowed: true, reasonCode: 'allowed', reason: '' }
export const unavailableCapability: ActionCapability = deny('invalid_metadata', 'Authoritative capability data unavailable')
/** The single semantic decision source for authoritative readers, mutations and Web consumers. */
export function evaluateCapability(action: CapabilityAction, f: CapabilityFacts): ActionCapability {
  const task = record(f.task), run = record(f.run), review = record(f.review)
  const workspace = record(f.workspace), worker = record(f.worker), session = record(f.session)
  const runs = Array.isArray(f.runs) ? f.runs.map(record) : undefined
  if (action !== 'send') {
    if (!task || !text(task.id) || !text(task.projectId) || !status(task.status) || !Number.isSafeInteger(task.version) || Number(task.version) < 1 || !runs || runs.some(r => !r || r.taskId !== task.id || r.projectId !== task.projectId || !text(r.id) || !runStatuses.includes(r.status as typeof runStatuses[number]) || !assignment(r.snapshot) || !text(r.sessionId) || !Number.isSafeInteger(r.attempt) || Number(r.attempt) < 1)) return deny('invalid_metadata', 'Task or Run relationship metadata is incomplete')
    const metadata = record(task.metadataJson)
    if (!metadata || metadata.schemaVersion !== 1 || !record(metadata.values) || !('assignee' in task) || (task.assignee !== null && !assignment(task.assignee)) || !('blockedFrom' in task) || !('cancelledFrom' in task) || (task.blockedFrom !== null && !status(task.blockedFrom)) || (task.cancelledFrom !== null && !status(task.cancelledFrom))) return deny('invalid_metadata', 'Task workflow metadata is incomplete')
    if ((task.status === 'blocked' && (!status(task.blockedFrom) || task.blockedFrom === 'blocked')) || (task.status === 'cancelled' && (!status(task.cancelledFrom) || task.cancelledFrom === 'cancelled'))) return deny('invalid_metadata', 'Task restoration metadata is incomplete')
  }
  if (action !== 'send') {
    if (new Set(runs!.map(r => r!.id)).size !== runs!.length || new Set(runs!.map(r => r!.attempt)).size !== runs!.length) return deny('invalid_metadata', 'Duplicate Run history identity')
    if ((f.run != null && !run) || (f.review != null && !review)) return deny('invalid_metadata', 'Selected relationship metadata is malformed')
    if (run && !equalFacts(run, runs!.find(r => r!.id === run.id))) return deny('invalid_metadata', 'Selected Run disagrees with authoritative history')
    if (review && (!validReviewMetadata(review) || review.taskId !== task!.id || review.projectId !== task!.projectId || !runs!.some(r => r!.id === review.taskRunId))) return deny('invalid_metadata', 'Review lifecycle metadata is incomplete')
    if (task!.currentReviewId != null && (!text(task!.currentReviewId) || task!.status !== 'in_review')) return deny('invalid_metadata', 'Current review identity is invalid')
    if (action === 'transition' && task!.currentReviewId != null && (!review || review.id !== task!.currentReviewId || review.status !== 'requested' || review.closedAt !== null)) return deny('invalid_metadata', 'Current review metadata is incomplete')
  }
  const active = runs?.some(r => r && ['pending', 'running', 'cancelling'].includes(String(r.status))) ?? false
  if (action === 'transition') {
    if (!status(f.target)) return deny('invalid_transition', 'Transition not permitted')
    if (task!.status === f.target) return allowed
    if (!workflowTargets(task as { status: TaskStatus; blockedFrom: unknown; cancelledFrom: unknown }).includes(f.target)) return deny('invalid_transition', 'Transition not permitted')
    return active && ['done', 'cancelled'].includes(f.target) ? deny('active_run', 'Task has an active Run') : allowed
  }
  if (action === 'cancel' || action.startsWith('review_')) {
    if (!run || !runs?.some(r => r?.id === run.id) || run.taskId !== task!.id || run.projectId !== task!.projectId || !assignment(run.snapshot) || !text(run.sessionId) || !runStatuses.includes(run.status as typeof runStatuses[number])) return deny('not_found', 'Run not found in this Task')
    if (action === 'cancel') return allowed // Terminal cancellation is a legal no-op.
    if (review && (review.taskRunId !== run.id || review.taskId !== task!.id || review.projectId !== task!.projectId || !text(review.id) || !['requested', 'approved', 'changes_requested'].includes(String(review.status)))) return deny('invalid_metadata', 'Review relationship metadata is incomplete')
    const decision = action === 'review_request' ? 'requested' : action === 'review_approve' ? 'approved' : 'changes_requested'
    if (decision === 'requested') {
      if (review && task!.currentReviewId === review.id && review.status === 'requested' && review.closedAt === null) return allowed
      if (task!.currentReviewId != null) return deny('invalid_transition', 'Task already has a current review')
      if (runs!.some(r => Number(r!.attempt) > Number(run.attempt))) return deny('invalid_transition', 'Review must use latest Run')
    } else {
      if (!review) return deny('not_found', 'Review not requested')
      if (review.status !== 'requested' || review.closedAt !== null || task!.currentReviewId !== review.id) return deny('invalid_transition', 'Review is not the current pending cycle')
    }
    if (active) return deny('active_run', 'Review requires a terminal Run and no active Task Run')
    if (decision !== 'requested' && task!.status !== 'in_review') return deny('invalid_transition', 'Task must still be in review')
    return evaluateCapability('transition', { ...f, target: decision === 'requested' ? 'in_review' : decision === 'approved' ? 'done' : 'blocked' })
  }
  if (!['launch_new', 'launch_reuse', 'send'].includes(action)) return deny('invalid_metadata', 'Unknown capability action')
  let a = assignment(f.assignment ?? task?.assignee)
  if (action === 'send') {
    const binding = record(session?.binding), agent = record(binding?.agent)
    a = assignment({ workspaceId: binding?.workspaceId, workerId: agent?.workerId, agentKey: agent?.agentKey, modelId: binding?.modelId })
    if (!session || session.deletedAt !== null || !a || session.workspaceId !== a.workspaceId || !text(session.projectId) || !text(session.ownerId) || !text(session.id)) return deny('invalid_metadata', 'Session binding metadata is incomplete')
  } else {
    const current = assignment(task!.assignee)
    if (!a || !current || !same(a, current)) return deny('assignment_changed', 'Assignment changed; retain draft and explicitly confirm current assignment')
    if (active) return deny('active_run', 'Task already has an active Run')
    const binding = record(f.binding)
    if (!binding || binding.taskId !== task!.id || binding.projectId !== task!.projectId || binding.workspaceId !== a.workspaceId) return deny('assignment_changed', 'Assignment workspace is not bound to Task')
  }
  const placements = Array.isArray(workspace?.placements) ? workspace.placements.map(record) : undefined
  const placement = placements?.find(value => value?.workerId === a!.workerId)
  if (!workspace || workspace.id !== a!.workspaceId || workspace.projectId !== (task?.projectId ?? session?.projectId) || workspace.deletedAt !== null || !placements || !placement) return deny('invalid_metadata', 'Workspace relationship metadata is incomplete')
  if (placement.status !== 'ready') return deny('workspace_not_ready', 'Workspace is not ready on selected Worker')
  const agents = Array.isArray(worker?.capabilities) ? worker.capabilities.map(record) : []
  const agent = agents.find(value => value?.agentKey === a!.agentKey)
  if (!worker || worker.id !== a!.workerId || (f.teamId !== undefined && worker.teamId !== f.teamId) || !['online', ...(action === 'send' ? ['offline'] : [])].includes(String(worker.connectionState)) || !agent || agent.mode !== 'execution' || record(agent.availability)?.status !== 'available' || !Array.isArray(agent.models) || !agent.models.some(model => record(model)?.modelId === a!.modelId)) return deny('runtime_unavailable', action === 'send' ? 'Worker requires an available execution Agent and reported Model' : 'Worker must be online with an available execution Agent and reported Model')
  // Offline independent messages retain the existing durable delivery contract; launch requires online.
  if (action === 'launch_reuse') {
    const binding = record(session?.binding), agent = record(binding?.agent)
    const actual = assignment({ workspaceId: binding?.workspaceId, workerId: agent?.workerId, agentKey: agent?.agentKey, modelId: binding?.modelId })
    if (!session || session.deletedAt !== null || session.ownerId !== f.actor || session.projectId !== task!.projectId || !(session.taskId === task!.id || runs?.some(r => r?.sessionId === session.id)) || !actual || !same(actual, a!)) return deny('reuse_ineligible', 'Session ownership or binding mismatch; explicitly confirm a new Session')
    if (f.idleReason !== null) return deny('reuse_ineligible', `${f.idleReason ?? 'Session idleness is unknown'}; explicitly confirm a new Session`)
  }
  return allowed
}
