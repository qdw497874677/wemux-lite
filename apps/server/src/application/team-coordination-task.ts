import { createHash } from 'node:crypto'
import type { SessionRuntimeState, TeamId, UserId } from '@wemux/domain'
import { isTeamCoordinationAnchor, teamCoordinationAnchorPrefix, type TaskDetail, type TeamCoordinationIdentity } from '@wemux/web-contract/task-platform'
import type { ServerStoreTx } from './ports/server-store.ts'
import { AppError } from './errors.ts'

/** Called only after Team membership and Worker/Agent authorization in the Session
 * creation transaction. Ordinary Project Tasks never take this path; the anchor
 * `team:{teamId}` cannot collide with real Project IDs, which the server generates. */
export function coordinationAnchor(teamId: string): string { return `${teamCoordinationAnchorPrefix}${teamId}` }
export { isTeamCoordinationAnchor }

/** 协调身份 capability snapshot 的 allowedTools 固定为只读查询面；写类 operation（连接器调用、
 * 写文件、终端、外部投递）不属于协调身份，Worker/Server 侧按快照拒绝。 */
export const coordinationQueryOperations = [
  'session.info', 'project.list', 'project.get', 'project.resources',
  'task.list', 'task.get', 'task.sessions', 'session.get', 'session.events', 'agent.list',
] as const

/** Same-reuse-key concurrency resolves to one Task: the deterministic ID makes retries
 * and interleaved transactions converge on the same row without server-side locking. */
export function coordinationTaskId(identity: TeamCoordinationIdentity): string {
  const key = JSON.stringify([identity.teamId, identity.ownerId, identity.workerId, identity.agentKey])
  return `coordination:${createHash('sha256').update(key).digest('hex')}`
}

/** Team membership is checked inside the creating transaction; ownerId must be the acting member. */
export async function assertTeamCoordinationCreator(tx: ServerStoreTx, identity: TeamCoordinationIdentity): Promise<void> {
  const records = await tx.identity.getIdentityRecords({ userId: identity.ownerId as UserId, teamId: identity.teamId as TeamId })
  if (!records.membership || records.membership.userId !== identity.ownerId) throw new AppError(403, 'Team membership required for coordination Task', 'forbidden')
}

/** Idempotent coordination Task creation: same reuse key returns the same Task, identity
 * conflicts surface as 409 without echoing stored metadata, deletion as 410. */
export async function teamCoordinationTask(tx: ServerStoreTx, identity: TeamCoordinationIdentity, requestId: string): Promise<string> {
  await assertTeamCoordinationCreator(tx, identity)
  const id = coordinationTaskId(identity)
  const previous = await tx.tasks.get(id)
  if (previous) {
    const stored = previous.teamCoordination
    if (!stored || coordinationTaskId(stored) !== id) throw new AppError(409, 'Team coordination Task identity conflict', 'request_id_conflict')
    if (previous.deletedAt) throw new AppError(410, 'Team coordination Task is deleted', 'task_deleted')
    return id
  }
  const at = new Date().toISOString()
  const task: TaskDetail = {
    id, projectId: coordinationAnchor(identity.teamId), title: '团队协调',
    description: 'Team 级协调对话专用 Task，不授予任何 Project 执行权限。',
    acceptanceCriteria: null, priority: 'none', status: 'backlog', version: 1,
    assignee: null, origin: 'manual', teamCoordination: identity,
    activeRun: null, currentReviewId: null, linkCount: 0, createdAt: at, updatedAt: at,
    lastActivityAt: at, blockedFrom: null, cancelledFrom: null, workspaces: [], links: [],
    metadataJson: { schemaVersion: 1, values: {} },
  }
  await tx.tasks.save(task)
  await tx.tasks.append({ taskId: id, projectId: task.projectId, type: 'task.created', actor: identity.ownerId, requestId, occurredAt: at, payload: { action: 'coordination.created', teamId: identity.teamId } })
  return id
}

/** 协调活动投影：active/waiting 从 Session 运行态推导，绝不写入普通 Task 的状态/审查字段。 */
export function coordinationActivityState(states: readonly SessionRuntimeState[]): 'active' | 'waiting' {
  return states.some(state => state === 'queued' || state === 'running' || state === 'stopping') ? 'active' : 'waiting'
}
