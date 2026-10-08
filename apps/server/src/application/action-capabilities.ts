import { AppError } from './errors.ts'
import { assertSessionTaskMutable } from './task-lifecycle.ts'
import { evaluateCapability, taskStatuses, type TaskDetail, type Run, type CapabilityFacts, type TaskCapabilities, type RunCapabilities, type ActionCapability } from '@wemux/web-contract/task-platform'
import type { SessionId, WorkerId, WorkspaceId, ProjectId } from '@wemux/domain'
import type { ServerStoreTx } from './ports/server-store.ts'
import { sessionIdleReason } from './session-idle.ts'
import { resolveReviewRequirement } from './review-requirement.ts'

export async function taskFacts(tx: ServerStoreTx, task: TaskDetail, actor: string): Promise<CapabilityFacts> {
  const a = task.assignee
  const workspace = a && typeof a.workspaceId === 'string' ? await tx.resources.getWorkspace(a.workspaceId as WorkspaceId) : null
  const worker = a && typeof a.workerId === 'string' ? await tx.resources.getWorker(a.workerId as WorkerId) : null
  const project = await tx.resources.getProject(task.projectId as ProjectId)
  const runs = await tx.tasks.runs(task.id)
  // An executed record predating review snapshots cannot prove which Project
  // default applied at its first Run. Never interpret an absent snapshot as
  // today's (possibly lowered) default when advertising permissions.
  const inheritedPolicy = resolveReviewRequirement(task, runs, project?.reviewPolicy).policy
  const values = task.metadataJson?.values
  const effectiveTask = values && typeof values === 'object' && !Array.isArray(values) && values.reviewPolicy === undefined
    ? { ...task, metadataJson: { ...task.metadataJson, values: { ...values, reviewPolicy: inheritedPolicy } } } : task
  const run = runs.reduce<Run | undefined>((last, value) => !last || value.attempt > last.attempt ? value : last, undefined)
  return { task: effectiveTask, actor, runs, run, review: task.currentReviewId ? await tx.tasks.reviewById(task.currentReviewId) : run ? await tx.tasks.review(run.id) : null, workspace, worker, teamId: project?.teamId,
    binding: workspace ? await tx.tasks.binding(workspace.id) : null }
}
export async function reuseFacts(tx: ServerStoreTx, facts: CapabilityFacts, sessionId: string): Promise<CapabilityFacts> {
  const session = await tx.resources.getSession(sessionId as SessionId)
  // Do not dereference corrupt binding metadata in the Journal adapter.
  const binding = session?.binding
  const validBinding = binding && binding.agent && typeof binding.agent.workerId === 'string'
  return { ...facts, session, idleReason: validBinding ? await sessionIdleReason(tx, sessionId as SessionId) : 'Session binding metadata is incomplete' }
}
export async function taskCapabilities(tx: ServerStoreTx, task: TaskDetail, actor: string): Promise<TaskCapabilities> {
  const facts = await taskFacts(tx, task, actor)
  const transitions = Object.fromEntries(taskStatuses.map(target => [target, evaluateCapability('transition', { ...facts, target })])) as TaskCapabilities['transitions']
  const reuse: Record<string, ActionCapability> = {}
  const sessions = await tx.resources.listSessions()
  const runs = facts.runs as Run[]
  for (const session of sessions) if (session.projectId === task.projectId && session.taskId === task.id && runs.some(run => run.taskId === task.id && run.sessionId === session.id)) {
    reuse[session.id] = evaluateCapability('launch_reuse', await reuseFacts(tx, facts, session.id))
  }
  return { transitions, launchNew: evaluateCapability('launch_new', facts), reuse }
}
export async function runCapabilities(tx: ServerStoreTx, task: TaskDetail, run: Run, actor: string): Promise<RunCapabilities> {
  const facts = { ...await taskFacts(tx, task, actor), run, review: await tx.tasks.review(run.id) }
  return { cancel: evaluateCapability('cancel', facts), reviewRequest: evaluateCapability('review_request', facts), reviewApprove: evaluateCapability('review_approve', facts), reviewChangesRequested: evaluateCapability('review_changes_requested', facts) }
}
export async function sendCapability(tx: ServerStoreTx, session: import('@wemux/server-domain').Session): Promise<ActionCapability> {
  const workspace = typeof session.workspaceId === 'string' ? await tx.resources.getWorkspace(session.workspaceId) : null
  const workerId = session.binding?.agent?.workerId
  const worker = typeof workerId === 'string' ? await tx.resources.getWorker(workerId) : null
  const project = await tx.resources.getProject(session.projectId)
  try { await assertSessionTaskMutable(tx, session) } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'task_deleted') throw error
    return { allowed: false, reasonCode: 'task_deleted', reason: error.message }
  }
  return evaluateCapability('send', { session, workspace, worker, teamId: project?.teamId })
}
