import { taskFacts, reuseFacts, taskCapabilities, runCapabilities } from './action-capabilities.js'
import { evaluateCapability, type ActionCapability } from '@wemux/web-contract/task-platform'
import type { SessionId } from '@wemux/domain'
import { createHash, randomUUID } from 'node:crypto'
import { launchFingerprintInput, type LaunchRequest, type Run } from '@wemux/web-contract/task-platform'
import { ensureRunCancel, saveRunProjection, isActiveRun } from './run-projection.js'
import { transitionTask, type ProjectId, type UserId } from '@wemux/domain'
import { taskStatuses, taskErrorStatus, type TaskDetail, type TaskErrorCode, type TaskActivity, type ProjectEvent, type TaskStatus, type Assignment } from '@wemux/web-contract/task-platform'
import type { WorkspaceId, WorkerId } from '@wemux/domain'
import type { ServerService } from './server-service.js'
import type { ServerStore, ServerStoreTx } from './ports/server-store.js'

export class TaskError extends Error {
  readonly status: number
  constructor(readonly code: TaskErrorCode, message: string, readonly details?: Record<string, unknown>) { super(message); this.status = taskErrorStatus[code] }
}
const invalid = (message: string): never => { throw new TaskError('invalid_request', message) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Expected an object')
  return value as Record<string, unknown>
}
function content(input: Record<string, unknown>): Partial<TaskDetail> {
  const patch: Record<string, unknown> = {}
  for (const key of ['title', 'description', 'acceptanceCriteria']) if (key in input) {
    const value = input[key]
    if (key === 'acceptanceCriteria' && value === null) { patch[key] = null; continue }
    if (typeof value !== 'string' || value.length > (key === 'title' ? 200 : 100000) || (key === 'title' && !value.trim())) invalid(`Invalid ${key}`)
    patch[key] = value
  }
  if ('priority' in input) { if (typeof input.priority !== 'string' || !['none', 'low', 'medium', 'high'].includes(input.priority)) invalid('Invalid priority'); patch.priority = input.priority }
  if ('metadataJson' in input) {
    const metadata = object(input.metadataJson)
    if (metadata.schemaVersion !== 1 || Object.keys(metadata).some(key => !['schemaVersion', 'values'].includes(key))) invalid('metadataJson requires schemaVersion 1 and values')
    object(metadata.values)
    if (JSON.stringify(metadata).length > 16000) invalid('Metadata too large')
    patch.metadataJson = metadata
  }
  return patch
}
export interface TaskContext { actor: UserId; teamId?: string; requestId: string }
/** One transaction is the authorization and write boundary. No Assignment or Run creation here. */
export class TaskService {
  constructor(private readonly store: ServerStore, private readonly publish: (event: ProjectEvent) => void = () => {}, private readonly server?: ServerService) {}
  private async project(tx: ServerStoreTx, projectId: string, context: TaskContext, write = false) {
    const project = await tx.resources.getProject(projectId as ProjectId)
    if (!project || project.deletedAt) throw new TaskError('not_found', 'Project not found')
    if (context.teamId && context.teamId !== project.teamId) throw new TaskError('forbidden', 'Project ownership required')
    if (project.ownerId === context.actor) return
    const { membership, projectGrant } = await tx.identity.getIdentityRecords({ userId: context.actor, teamId: project.teamId, projectId: project.id })
    if (!membership || (!projectGrant && project.shareScope !== 'team')) throw new TaskError('forbidden', 'Project ownership required')
    if (write && !projectGrant) throw new TaskError('forbidden', 'Project contributor permission required')
    const role = projectGrant?.role ?? 'viewer'
    if (write && role === 'viewer') throw new TaskError('forbidden', 'Project contributor permission required')
  }
  private async task(tx: ServerStoreTx, projectId: string, id: string, context: TaskContext, write = false) {
    await this.project(tx, projectId, context, write)
    const task = await tx.tasks.get(id)
    if (!task || task.projectId !== projectId) throw new TaskError('not_found', 'Task not found in this project')
    return task
  }
  authorizeProject(projectId: string, context: TaskContext) { return this.store.transaction(tx => this.project(tx, projectId, context)) }
  private writeTask(tx: ServerStoreTx, projectId: string, id: string, context: TaskContext) { return this.task(tx, projectId, id, context, true) }
  private enforce(capability: ActionCapability, details?: Record<string, unknown>) {
    if (!capability.allowed) throw new TaskError(capability.reasonCode === 'invalid_metadata' ? 'invalid_transition' : capability.reasonCode === 'allowed' ? 'invalid_transition' : capability.reasonCode, capability.reason, details)
  }
  list(projectId: string, context: TaskContext) { return this.store.transaction(async tx => {
    await this.project(tx, projectId, context)
    return Promise.all((await tx.tasks.list(projectId)).map(async summary => {
      const task = (await tx.tasks.get(summary.id))!
      return { ...summary, capabilities: await taskCapabilities(tx, task, context.actor) }
    }))
  }) }
  get(projectId: string, id: string, context: TaskContext): Promise<TaskDetail> { return this.store.transaction(async tx => {
    const task = await this.task(tx, projectId, id, context)
    return { ...task, capabilities: await taskCapabilities(tx, task, context.actor) }
  }) }
  activity(projectId: string, id: string, after: number, context: TaskContext) {
    if (!Number.isSafeInteger(after) || after < 0) invalid('Invalid after cursor')
    return this.store.transaction(async tx => { await this.task(tx, projectId, id, context); return tx.tasks.activity(id, after) })
  }
  runs(projectId: string, id: string, context: TaskContext) {
    return this.store.transaction(async tx => {
      const task = await this.task(tx, projectId, id, context)
      return Promise.all((await tx.tasks.runs(id)).map(async run => ({ ...run, capabilities: await runCapabilities(tx, task, run, context.actor) })))
    })
  }
  run(projectId: string, id: string, runId: string, context: TaskContext) {
    return this.store.transaction(async tx => {
      const task = await this.task(tx, projectId, id, context)
      const run = await tx.tasks.run(runId)
      if (!run || run.taskId !== id || run.projectId !== projectId) throw new TaskError('not_found', 'Run not found in this Task')
      return { ...run, capabilities: await runCapabilities(tx, task, run, context.actor) }
    })
  }
  projectActivity(projectId: string, after: number, context: TaskContext) {
    return this.store.transaction(async tx => {
      await this.project(tx, projectId, context)
      if (!Number.isSafeInteger(after) || after < 0) invalid('Invalid after cursor')
      return tx.tasks.projectActivity(projectId, after)
    })
  }
  pendingReviews(projectId: string, context: TaskContext) {
    return this.store.transaction(async tx => { await this.project(tx, projectId, context); return tx.tasks.pendingReviews(projectId) })
  }
  review(projectId: string, id: string, runId: string, context: TaskContext) {
    return this.store.transaction(async tx => {
      await this.task(tx, projectId, id, context)
      const run = await tx.tasks.run(runId)
      if (!run || run.taskId !== id || run.projectId !== projectId) throw new TaskError('not_found', 'Run not found in this Task')
      return tx.tasks.review(runId)
    })
  }
  /** Human action only. Every request, including no-ops, observes Task CAS. */
  async reviewAction(projectId: string, id: string, runId: string, input: unknown, context: TaskContext) {
    const result = await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      const run = await tx.tasks.run(runId)
      if (!run || run.taskId !== id || run.projectId !== projectId) throw new TaskError('not_found', 'Run not found in this Task')
      const b = object(input)
      if (Object.keys(b).some(key => !['version', 'status'].includes(key)) || !Number.isSafeInteger(b.version) || Number(b.version) < 1 || typeof b.status !== 'string' || !['requested', 'approved', 'changes_requested'].includes(b.status)) invalid('Review requires positive version and valid status')
      this.cas(task, b.version)
      const previous = await tx.tasks.review(runId)
      this.enforce(evaluateCapability(b.status === 'requested' ? 'review_request' : b.status === 'approved' ? 'review_approve' : 'review_changes_requested', { ...await taskFacts(tx, task, context.actor), run, review: previous }))
      if (previous && task.currentReviewId === previous.id && b.status === 'requested') return { review: previous, task, changed: false }
      const target = b.status === 'requested' ? 'in_review' : b.status === 'approved' ? 'done' : 'blocked'
      let next: TaskDetail
      try { next = transitionTask(task, target, false) }
      catch { throw new TaskError('invalid_transition', 'Current Task state cannot perform this review action') }
      const at = new Date().toISOString()
      const review: import('@wemux/web-contract/task-platform').ReviewRequest = b.status !== 'requested' && previous
        ? { ...previous, status: b.status as 'approved' | 'changes_requested', reviewer: context.actor, decidedAt: at, closedAt: at }
        : { id: randomUUID(), projectId, taskId: id, taskRunId: runId, status: 'requested', actor: context.actor, reviewer: null, requestedAt: at, decidedAt: null, closedAt: null }
      await tx.tasks.saveReview(review)
      next = { ...next, currentReviewId: b.status === 'requested' ? review.id : null, updatedAt: at, lastActivityAt: at }
      await this.record(tx, next, 'task.transitioned', { from: task.status, to: target, reviewId: review.id, runId, reviewStatus: review.status }, context)
      await tx.audit.append({ id: randomUUID() as import('@wemux/domain').Id<'AuditEntryId'>, actorId: context.actor, action: `review.${review.status}`, resource: { kind: 'project', id: projectId as ProjectId }, result: 'succeeded', occurredAt: at as import('@wemux/domain').Timestamp, metadata: { taskId: id, runId, reviewId: review.id } })
      return { review, task: next, changed: true }
    })
    if (result.changed) this.publish({ id: `review:${result.review.id}:${result.review.status}`, projectId, taskId: id, type: 'task.transitioned' })
    return { review: result.review, task: result.task }
  }
  async createSession(projectId: string, id: string, input: unknown, context: TaskContext) {
    if (!this.server) throw new Error('Session composition unavailable')
    const server = this.server
    const result = await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      const b = object(input)
      if (Object.keys(b).some(key => key !== 'title') || typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) invalid('Session title required; unknown fields are not allowed')
      if (!task.assignee) throw new TaskError('assignment_changed', 'Task assignment required')
      const workspace = await this.workspace(tx, task, task.assignee.workspaceId)
      if ((await tx.tasks.binding(workspace.id))?.taskId !== id || !workspace.placements.some(placement => placement.workerId === task.assignee!.workerId && placement.status === 'ready')) throw new TaskError('assignment_changed', 'Assignment workspace placement changed')
      const created = await server.createSessionInTx(tx, { ...task.assignee, title: b.title }, { taskId: id, runId: null, ownerId: context.actor, shareScope: 'project' })
      const session = created.session
      const at = new Date().toISOString()
      await this.record(tx, { ...task, lastActivityAt: at }, 'task.updated', { action: 'session.created', sessionId: session.id }, context)
      return { ...created, session }
    })
    server.notifications.commands(result.session.binding.agent.workerId)
    this.publish({ id: randomUUID(), projectId, taskId: id, type: 'task.updated' })
    return result
  }
  async cancelRun(projectId: string, id: string, runId: string, input: unknown, context: TaskContext) {
    const result = await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      const run = await tx.tasks.run(runId)
      if (!run || run.taskId !== id || run.projectId !== projectId) throw new TaskError('not_found', 'Run not found in this Task')
      const b = object(input)
      if (Object.keys(b).some(key => !['requestId', 'runId', 'sessionId'].includes(key)) || typeof b.requestId !== 'string' || !b.requestId.trim() || b.requestId.length > 200 || b.requestId.includes('\0') || b.runId !== runId || b.sessionId !== run.sessionId) invalid('Cancel requires matching runId/sessionId and requestId')
      this.enforce(evaluateCapability('cancel', { ...await taskFacts(tx, task, context.actor), run }))
      const previous = await tx.tasks.cancelRequest(runId, b.requestId as string)
      if (!isActiveRun(run)) return { run, changed: false }
      if (run.cancelRequestedAt) {
        const reconciled = await ensureRunCancel(tx, run)
        if (reconciled !== run) {
          if (!previous) await tx.tasks.saveCancelRequest(runId, b.requestId as string, run.sessionId)
          await saveRunProjection(tx, reconciled)
          return { run: reconciled, changed: true }
        }
      }
      if (previous) return { run, changed: false }
      await tx.tasks.saveCancelRequest(runId, b.requestId as string, run.sessionId)
      if (run.cancelRequestedAt) {
        const last = run.cancelCommandIds.at(-1)
        if (!last || (await tx.commands.get(last as import('@wemux/domain').CommandId))?.status !== 'rejected') return { run, changed: false }
      }
      const next = await ensureRunCancel(tx, { ...run, failure: null, status: 'cancelling', cancelRequestedAt: run.cancelRequestedAt ?? new Date().toISOString() }, run.cancelRequestedAt ? b.requestId as string : undefined)
      await saveRunProjection(tx, next)
      await tx.audit.append({ id: randomUUID() as import('@wemux/domain').Id<'AuditEntryId'>, actorId: context.actor, action: 'run.cancel', resource: { kind: 'session', id: run.sessionId as SessionId }, result: 'succeeded', occurredAt: new Date().toISOString() as import('@wemux/domain').Timestamp, metadata: { runId, requestId: b.requestId as string } })
      return { run: next, changed: true }
    })
    if (result.changed) {
      this.server?.notifications.commands(result.run.snapshot.workerId as WorkerId)
      this.publish({ id: randomUUID(), projectId, taskId: id, runId, type: 'run.changed' })
    }
    return { run: result.run }
  }
  async launch(projectId: string, id: string, input: unknown, context: TaskContext) {
    const server = this.server
    if (!server) throw new Error('Run composition unavailable')
    const result = await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      const b = object(input), a = object(b.assignment)
      if (Object.keys(b).some(key => !['requestId', 'mode', 'prompt', 'reuseSessionId', 'assignment'].includes(key)) || typeof b.requestId !== 'string' || !b.requestId.trim() || b.requestId.length > 200 || b.requestId.includes('\0') || typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > 100000 || b.prompt.includes('\0') || Buffer.byteLength(JSON.stringify(b.prompt)) > 200000) invalid('Invalid launch request')
      if ((b.mode !== 'new' && b.mode !== 'reuse') || (b.mode === 'new' ? b.reuseSessionId !== null : typeof b.reuseSessionId !== 'string' || !b.reuseSessionId)) invalid('Invalid launch mode/session')
      if (Object.keys(a).some(key => !['workspaceId', 'workerId', 'agentKey', 'modelId'].includes(key)) || ['workspaceId', 'workerId', 'agentKey', 'modelId'].some(key => typeof a[key] !== 'string' || !(a[key] as string).trim() || (a[key] as string).length > 200)) invalid('Complete assignment required')
      await server.requireWorkerUseInTx(tx, context.actor, a.workerId as WorkerId)
      const request = structuredClone(b) as LaunchRequest
      const fingerprint = createHash('sha256').update(JSON.stringify(launchFingerprintInput(request))).digest('hex')
      const previous = await tx.tasks.runByRequest(id, request.requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new TaskError('request_id_conflict', 'requestId already belongs to a different complete request')
        return { run: previous, created: false }
      }
      const facts = { ...await taskFacts(tx, task, context.actor), assignment: request.assignment }
      const launchCapability = evaluateCapability('launch_new', facts)
      this.enforce(launchCapability, launchCapability.reasonCode === 'assignment_changed' ? { assignment: task.assignee } : launchCapability.reasonCode === 'active_run' ? { runId: task.activeRun?.id } : undefined)
      const reused = request.mode === 'reuse' ? await tx.resources.getSession(request.reuseSessionId as SessionId) : null
      if (request.mode === 'reuse') this.enforce(evaluateCapability('launch_reuse', await reuseFacts(tx, facts, request.reuseSessionId)))
      const runId = randomUUID()
      if (reused) {
        await server.requireSessionAccessInTx(tx, context.actor, reused.id, 'write')
        await server.requireWorkerUseInTx(tx, context.actor, reused.binding.agent.workerId)
      }
      const created = reused ? { session: reused, commandId: null } : await server.createSessionInTx(tx, { ...request.assignment, title: task.title }, { taskId: id, runId, ownerId: context.actor, shareScope: 'project' })
      const queued = await server.enqueueInTx(tx, created.session.id, { content: request.prompt }, context.actor)
      if (created.commandId) await tx.commands.depend(queued.commandId, created.commandId)
      const binding = created.session.binding
      const run: Run = { id: runId, taskId: id, projectId, requestId: request.requestId, request, fingerprint, attempt: Math.max(0, ...(await tx.tasks.runs(id)).map(run => run.attempt)) + 1, sessionId: created.session.id, snapshot: { workspaceId: binding.workspaceId, workerId: binding.agent.workerId, agentKey: binding.agent.agentKey, modelId: binding.modelId }, status: 'pending', resultSummary: null, failure: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, cancelRequestedAt: null, createCommandId: created.commandId, enqueueCommandId: queued.commandId, messageId: null, turnId: null, cancelCommandIds: [], lastProjectedSeq: 0 }
      await saveRunProjection(tx, run, 'run.created')
      return { run, created: true }
    })
    if (result.created) {
      server.notifications.commands(result.run.snapshot.workerId as WorkerId)
      this.publish({ id: randomUUID(), projectId, taskId: id, runId: result.run.id, type: 'run.changed' })
    }
    return { run: result.run }
  }
  private async record(tx: ServerStoreTx, task: TaskDetail, type: TaskActivity['type'], payload: Record<string, unknown>, context: TaskContext) {
    await tx.tasks.save(task)
    await tx.tasks.append({ taskId: task.id, projectId: task.projectId, type, payload, actor: context.actor, requestId: context.requestId, occurredAt: task.lastActivityAt })
  }
  private notify(task: TaskDetail, type: TaskActivity['type']) { this.publish({ id: randomUUID(), projectId: task.projectId, taskId: task.id, type: ['task.created', 'task.transitioned', 'link.changed', 'assignment.changed'].includes(type) ? type as 'task.created' | 'task.transitioned' | 'link.changed' | 'assignment.changed' : 'task.updated' }) }
  private cas(task: TaskDetail, version: unknown) {
    if (!Number.isSafeInteger(version) || Number(version) < 1) invalid('Positive version required')
    if (version !== task.version) throw new TaskError('version_conflict', 'Task changed; confirm your intent against current state', { currentVersion: task.version, status: task.status, assignment: task.assignee })
  }
  private async workspace(tx: ServerStoreTx, task: TaskDetail, workspaceId: unknown) {
    if (typeof workspaceId !== 'string' || !workspaceId) invalid('Workspace required')
    const workspace = await tx.resources.getWorkspace(workspaceId as WorkspaceId)
    if (!workspace || workspace.deletedAt) throw new TaskError('not_found', 'Workspace not found')
    if (workspace.projectId !== task.projectId) throw new TaskError('forbidden', 'Workspace belongs to another project')
    const owner = await tx.tasks.binding(workspace.id)
    if (owner && owner.taskId !== task.id) throw new TaskError('workspace_bound', 'Workspace already bound to another Task')
    return workspace
  }
  private async bindInTx(tx: ServerStoreTx, task: TaskDetail, workspaceId: string, context: TaskContext) {
    await this.workspace(tx, task, workspaceId)
    if (await tx.tasks.binding(workspaceId)) return task
    const at = new Date().toISOString()
    await tx.tasks.bind({ taskId: task.id, projectId: task.projectId, workspaceId, createdAt: at })
    const next = { ...task, lastActivityAt: at, updatedAt: at, workspaces: await tx.tasks.bindings(task.id) }
    await this.record(tx, next, 'binding.changed', { action: 'bound', workspaceId }, context)
    return next
  }
  private async assignInTx(tx: ServerStoreTx, task: TaskDetail, input: unknown, context: TaskContext) {
    let assignment: Assignment | null = null
    if (input !== null) {
      const a = object(input)
      if (Object.keys(a).some(key => !['workspaceId', 'workerId', 'agentKey', 'modelId'].includes(key)) || ['workspaceId', 'workerId', 'agentKey', 'modelId'].some(key => typeof a[key] !== 'string' || !a[key])) invalid('Complete assignment required')
      const workspace = await this.workspace(tx, task, a.workspaceId)
      if (!workspace.placements.some(placement => placement.workerId === a.workerId)) throw new TaskError('runtime_unavailable', 'Workspace is unavailable on selected Worker')
      const authorizedWorker = this.server ? await this.server.requireWorkerUseInTx(tx, context.actor, a.workerId as WorkerId) : await tx.resources.getWorker(a.workerId as WorkerId)
      const project = await tx.resources.getProject(task.projectId as ProjectId)
      const agent = authorizedWorker?.capabilities.find(value => value.agentKey === a.agentKey)
      if (!authorizedWorker || authorizedWorker.teamId !== project?.teamId || authorizedWorker.connectionState === 'revoked' || !agent || agent.mode !== 'execution' || agent.availability.status !== 'available' || !agent.models.some(model => model.modelId === a.modelId)) throw new TaskError('runtime_unavailable', 'Selected Agent or Model is unavailable')
      assignment = { workspaceId: workspace.id, workerId: authorizedWorker.id, agentKey: a.agentKey as string, modelId: a.modelId as string }
      task = await this.bindInTx(tx, task, workspace.id, context)
    }
    const current = task.assignee
    if (current === assignment || (current && assignment && Object.keys(assignment).every(key => current[key as keyof Assignment] === assignment[key as keyof Assignment]))) return task
    const at = new Date().toISOString(), next = { ...task, assignee: assignment, version: task.version + 1, updatedAt: at, lastActivityAt: at }
    await this.record(tx, next, 'assignment.changed', { from: current, to: assignment }, context)
    return next
  }
  async assignment(projectId: string, id: string, input: unknown, clear: boolean, context: TaskContext) {
    const b = object(input)
    if (Object.keys(b).some(key => !['version', ...(clear ? [] : ['assignee'])].includes(key))) invalid('Unknown assignment fields')
    let changed = false, bound: string | undefined
    const task = await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      this.cas(task, b.version)
      const next = await this.assignInTx(tx, task, clear ? null : b.assignee, context)
      changed = next.version !== task.version
      bound = next.workspaces.find(w => !task.workspaces.some(old => old.workspaceId === w.workspaceId))?.workspaceId
      return next
    })
    if (bound) this.publish({ id: randomUUID(), projectId, taskId: id, workspaceId: bound, type: 'binding.changed' })
    if (changed) this.notify(task, 'assignment.changed'); return task
  }
  async bind(projectId: string, id: string, workspaceId: string, context: TaskContext) {
    let changed = false
    const task = await this.store.transaction(async tx => {
      const current = await this.writeTask(tx, projectId, id, context)
      changed = !await tx.tasks.binding(workspaceId)
      return this.bindInTx(tx, current, workspaceId, context)
    })
    if (changed) this.publish({ id: randomUUID(), projectId, taskId: id, workspaceId, type: 'binding.changed' }); return task
  }
  async unbind(projectId: string, id: string, workspaceId: string, input: unknown, context: TaskContext) {
    const b = object(input)
    if (Object.keys(b).some(key => key !== 'version')) invalid('Unknown unbind fields')
    let changed = false, assignmentChanged = false
    const task = await this.store.transaction(async tx => {
      let task = await this.writeTask(tx, projectId, id, context)
      await this.workspace(tx, task, workspaceId)
      if (await tx.tasks.activeRunUsesWorkspace(workspaceId)) throw new TaskError('active_run', 'Workspace is used by an active Run')
      if (task.assignee?.workspaceId === workspaceId) { this.cas(task, b.version); task = await this.assignInTx(tx, task, null, context); assignmentChanged = true }
      if (!await tx.tasks.binding(workspaceId)) return task
      changed = true
      await tx.tasks.unbind(id, workspaceId)
      const at = new Date().toISOString(), next = { ...task, updatedAt: at, lastActivityAt: at, workspaces: await tx.tasks.bindings(id) }
      await this.record(tx, next, 'binding.changed', { action: 'unbound', workspaceId }, context)
      return next
    })
    if (assignmentChanged) this.notify(task, 'assignment.changed')
    if (changed) this.publish({ id: randomUUID(), projectId, taskId: id, workspaceId, type: 'binding.changed' }); return task
  }
  async retryWorkspace(projectId: string, id: string, workspaceId: string, input: unknown, context: TaskContext) {
    const b = object(input)
    if (Object.keys(b).some(key => !['requestId', 'workerId'].includes(key)) || typeof b.requestId !== 'string' || !b.requestId.trim() || b.requestId.length > 200) invalid('Retry requestId required')
    const server = this.server
    if (!server) throw new Error('Workspace composition unavailable')
    const result = await this.store.transaction(async tx => {
      let task = await this.writeTask(tx, projectId, id, context)
      await this.workspace(tx, task, workspaceId)
      if ((await tx.tasks.binding(workspaceId))?.taskId !== id) throw new TaskError('not_found', 'Workspace not bound to Task')
      const requestedWorkerId = b.workerId === undefined ? undefined : typeof b.workerId === 'string' ? b.workerId as WorkerId : invalid('Invalid workerId')
      const result = await server.reprovisionWorkspaceInTx(tx, workspaceId as WorkspaceId, b.requestId as string, requestedWorkerId, context.actor)
      if (result.created) {
        const at = new Date().toISOString(); task = { ...task, updatedAt: at, lastActivityAt: at }
        await this.record(tx, task, 'workspace.retried', { workspaceId, commandId: result.commandId }, context)
      }
      return { ...result, task }
    })
    if (result.created) {
      server.notifications.commands(result.workerId)
      this.publish({ id: randomUUID(), projectId, taskId: id, workspaceId, type: 'workspace.provisioning' })
    }
    return result
  }
  async createWorkspace(projectId: string, id: string, input: unknown, context: TaskContext) {
    const b = object(input)
    if (Object.keys(b).some(key => !['name', 'workerId', 'source', 'repository', 'assignment', 'version'].includes(key))) invalid('Unknown workspace fields')
    const server = this.server
    if (!server) throw new Error('Workspace composition unavailable')
    const result = await this.store.transaction(async tx => {
      let task = await this.writeTask(tx, projectId, id, context)
      if ('assignment' in b) this.cas(task, b.version)
      const created = await server.createWorkspaceInTx(tx, { ...b, projectId }, context.actor)
      task = await this.bindInTx(tx, task, created.workspace.id, context)
      if ('assignment' in b) {
        if (!created.workerId) throw new TaskError('runtime_unavailable', 'Creating an assigned Workspace requires a Worker placement')
        task = await this.assignInTx(tx, task, { ...object(b.assignment), workspaceId: created.workspace.id, workerId: created.workerId }, context)
      }
      await this.record(tx, task, 'workspace.created', { workspaceId: created.workspace.id, commandId: created.commandId }, context)
      return { ...created, task }
    })
    if (result.workerId) server.notifications.commands(result.workerId)
    this.publish({ id: randomUUID(), projectId, taskId: id, workspaceId: result.workspace.id, type: 'binding.changed' })
    if ('assignment' in b) this.notify(result.task, 'assignment.changed')
    this.publish({ id: randomUUID(), projectId, taskId: id, workspaceId: result.workspace.id, type: 'workspace.provisioning' }); return result
  }
  async create(projectId: string, input: unknown, context: TaskContext) {
    const b = object(input)
    this.keys(b, false)
    if (!('title' in b)) invalid('Title required')
    const fields = content(b)
    const task = await this.store.transaction(async tx => {
      await this.project(tx, projectId, context, true)
      const at = new Date().toISOString()
      const task: TaskDetail = { id: randomUUID(), projectId, title: '', description: '', acceptanceCriteria: null, priority: 'none', status: 'backlog', version: 1, assignee: null, origin: 'manual', activeRun: null, currentReviewId: null, linkCount: 0, createdAt: at, updatedAt: at, lastActivityAt: at, blockedFrom: null, cancelledFrom: null, workspaces: [], links: [], metadataJson: { schemaVersion: 1, values: {} }, ...fields }
      await this.record(tx, task, 'task.created', { title: task.title }, context)
      return task
    })
    this.notify(task, 'task.created'); return task
  }
  private keys(b: Record<string, unknown>, patch: boolean) {
    const allowed = ['title', 'description', 'acceptanceCriteria', 'priority', 'metadataJson', ...(patch ? ['status', 'version'] : [])]
    if (!Object.keys(b).length || Object.keys(b).some(key => !allowed.includes(key))) invalid('Unknown or empty fields; assignment is available in Ticket 04')
  }
  async patch(projectId: string, id: string, input: unknown, context: TaskContext) {
    const b = object(input); this.keys(b, true)
    const fields = content(b)
    if ('status' in b && (!taskStatuses.includes(b.status as TaskStatus) || !Number.isSafeInteger(b.version) || Number(b.version) < 1)) invalid('Status and positive version required')
    if ('version' in b && !('status' in b)) invalid('Version is only used with status')
    let event: TaskActivity['type'] | undefined
    const result = await this.store.transaction(async tx => {
      const current = await this.writeTask(tx, projectId, id, context)
      const facts = 'status' in b ? await taskFacts(tx, current, context.actor) : null
      const runs = facts?.runs as Run[] | undefined
      const latest = runs?.reduce<Run | undefined>((last, run) => !last || run.attempt > last.attempt ? run : last, undefined)
      if ('status' in b) this.cas(current, b.version)
      let next = current
      if ('status' in b) {
        this.enforce(evaluateCapability('transition', { ...facts!, target: b.status }))
        try { next = transitionTask(current, b.status as TaskStatus, runs!.some(isActiveRun)) }
        catch (error) { throw new TaskError(error instanceof Error && error.message === 'active_run' ? 'active_run' : 'invalid_transition', 'Transition not permitted') }
      }
      next = { ...next, ...fields }
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      const at = new Date().toISOString(); next = { ...next, updatedAt: at, lastActivityAt: at }
      event = next.status !== current.status ? 'task.transitioned' : 'task.updated'
      let reviewId: string | undefined
      if (current.status === 'in_review' && next.status !== 'in_review') {
        const review = (facts!.review ?? null) as import('@wemux/web-contract/task-platform').ReviewRequest | null
        if (current.currentReviewId && (!review || review.id !== current.currentReviewId)) throw new TaskError('invalid_transition', 'Current review is missing')
        if (review && review.id === current.currentReviewId) await tx.tasks.saveReview({ ...review, closedAt: at })
        next = { ...next, currentReviewId: null }
      }
      if (next.status === 'in_review' && current.status !== 'in_review' && latest) {
        const review = { id: randomUUID(), projectId, taskId: id, taskRunId: latest.id, status: 'requested' as const, actor: context.actor, reviewer: null, requestedAt: at, decidedAt: null, closedAt: null }
        await tx.tasks.saveReview(review)
        reviewId = review.id
        next = { ...next, currentReviewId: review.id }
      }
      await this.record(tx, next, event, { fields: Object.keys(fields), from: current.status, to: next.status, ...(reviewId ? { reviewId, runId: latest!.id, reviewStatus: 'requested' } : {}) }, context)
      if (event === 'task.transitioned') await tx.audit.append({ id: randomUUID() as import('@wemux/domain').Id<'AuditEntryId'>, actorId: context.actor, action: 'task.transitioned', resource: { kind: 'project', id: projectId as ProjectId }, result: 'succeeded', occurredAt: at as import('@wemux/domain').Timestamp, metadata: { taskId: id, from: current.status, to: next.status, ...(reviewId ? { reviewId, runId: latest!.id } : {}) } })
      return next
    })
    if (event) this.notify(result, event)
    return result
  }
  async link(projectId: string, id: string, input: unknown, removeId: string | undefined, context: TaskContext) {
    let url: URL | undefined
    if (!removeId) {
      const b = object(input)
      if (Object.keys(b).some(key => key !== 'url') || typeof b.url !== 'string') invalid('URL required')
      try { url = new URL(b.url as string) } catch { invalid('Invalid GitHub URL') }
      if (!url || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || !/^\/[\w.-]+\/[\w.-]+\/(issues|pull)\/[1-9]\d*\/?$/.test(url.pathname)) invalid('Expected a GitHub issue or pull request URL')
    }
    let changed = false
    const task = await this.store.transaction(async tx => {
      const current = await this.writeTask(tx, projectId, id, context)
      let links = [...current.links]
      if (removeId) { if (!links.some(link => link.id === removeId)) throw new TaskError('not_found', 'Link not found'); links = links.filter(link => link.id !== removeId) }
      else {
        const parts = url!.pathname.split('/'); const canonical = `https://github.com/${parts.slice(1, 5).join('/')}`
        if (links.some(link => link.url === canonical)) return current
        links.push({ id: randomUUID(), type: parts[3] === 'issues' ? 'github-issue' : 'github-pr', externalId: `${parts[1]}/${parts[2]}#${parts[4]}`, url: canonical, syncState: 'none' })
      }
      changed = true
      const at = new Date().toISOString(), next = { ...current, links, linkCount: links.length, updatedAt: at, lastActivityAt: at }
      await this.record(tx, next, 'link.changed', { action: removeId ? 'removed' : 'added', linkId: removeId ?? links.at(-1)!.id }, context)
      return next
    })
    if (changed) this.notify(task, 'link.changed'); return task
  }
}
