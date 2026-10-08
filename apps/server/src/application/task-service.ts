import { isDeepStrictEqual } from 'node:util'
import { AppError } from './errors.ts'
import { canDecideHumanReview } from './human-review-authority.ts'
import { createRequest, replayCreate, recordCreate } from './create-request.ts'
import { taskFacts, reuseFacts, taskCapabilities, runCapabilities } from './action-capabilities.ts'
import { evaluateCapability, type ActionCapability } from '@wemux/web-contract/task-platform'
import type { SessionId } from '@wemux/domain'
import { createHash, randomUUID } from 'node:crypto'
import { launchFingerprintInput, type LaunchRequest, type Run } from '@wemux/web-contract/task-platform'
import { ensureRunCancel, saveRunProjection, isActiveRun } from './run-projection.ts'
import { resolveReviewRequirement } from './review-requirement.ts'
import { transitionTask, type ProjectId, type UserId } from '@wemux/domain'
import { taskStatuses, taskErrorStatus, isTeamCoordinationAnchor, latestCompletedPlan, planWindowEvents, type TaskSummary, type TaskDetail, type TaskErrorCode, type TaskActivity, type ProjectEvent, type TaskStatus, type Assignment, type TaskDetailProjection, type TaskSummaryProjection, type TaskPlanWindow, type TaskPlanProjection, type TaskQueryProjection, type TaskReviewRequirementProjection, type ReviewPolicy, type PlanJournalEvent } from '@wemux/web-contract/task-platform'
import type { Session } from '@wemux/server-domain'
import type { WorkspaceId, WorkerId } from '@wemux/domain'
import type { ServerService } from './server-service.ts'
import type { ServerStore, ServerStoreTx } from './ports/server-store.ts'

export class TaskError extends Error {
  readonly code: TaskErrorCode
  readonly status: number
  readonly details?: Record<string, unknown>
  constructor(code: TaskErrorCode, message: string, details?: Record<string, unknown>) { super(message); this.code = code; this.status = taskErrorStatus[code]; this.details = details }
}
const invalid = (message: string): never => { throw new TaskError('invalid_request', message) }
/** One bounded plan window per Task. The Task's most active Session wins, ranked by the cached contiguous
 * sequence (ties by id), so the projection is deterministic and costs one row read per Session plus one
 * window read per Task. A Session the caller cannot read is omitted later, never silently replaced. */
async function candidateSessionId(tx: ServerStoreTx, sessions: readonly Session[]): Promise<SessionId | null> {
  const ranked = await Promise.all(sessions.map(async session => ({ session, seq: Number((await tx.cache.getFreshness(session.id))?.contiguousSeq ?? 0) })))
  ranked.sort((left, right) => right.seq - left.seq || left.session.id.localeCompare(right.session.id))
  return ranked[0] ? ranked[0].session.id : null
}
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
    if ('reviewPolicyFrozen' in (metadata.values as Record<string, unknown>)) invalid('reviewPolicyFrozen is server-managed')
    const policy = (metadata.values as Record<string, unknown>).reviewPolicy
    if (policy !== undefined && (typeof policy !== 'string' || !['none', 'agent', 'human', 'multi-stage'].includes(policy))) invalid('Unknown Task review policy')
    patch.metadataJson = metadata
  }
  return patch
}
export interface TaskContext { actor: UserId; teamId?: string; requestId: string }
/** Persisted facts a query projection needs before its Journal window is read. */
interface TaskProjectionSeed { readonly sessionId: SessionId | null; readonly review: TaskReviewRequirementProjection }
/** One transaction is the authorization and write boundary. No Assignment or Run creation here. */
export class TaskService {
  private readonly store: ServerStore
  private readonly publish: (event: ProjectEvent) => void
  private readonly server?: ServerService
  constructor(store: ServerStore, publish: (event: ProjectEvent) => void = () => {}, server?: ServerService) {
    this.store = store
    this.publish = publish
    this.server = server
  }
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
    // Defense in depth (Ticket 05): even if a Project row ever matched an anchor, coordination
    // Tasks stay unaddressable through ordinary Project Task routes.
    if (task.teamCoordination || isTeamCoordinationAnchor(task.projectId)) throw new TaskError('forbidden', 'Team coordination Task is not addressable as a Project Task')
    if (write && task.deletedAt) throw new TaskError('task_deleted', 'Task is permanently deleted')
    return task
  }
  authorizeProject(projectId: string, context: TaskContext) { return this.store.transaction(tx => this.project(tx, projectId, context)) }
  private writeTask(tx: ServerStoreTx, projectId: string, id: string, context: TaskContext) { return this.task(tx, projectId, id, context, true) }
  private async requirePolicyManager(tx: ServerStoreTx, projectId: string, context: TaskContext) {
    const project = await tx.resources.getProject(projectId as ProjectId)
    if (!project || project.deletedAt) throw new TaskError('not_found', 'Project not found')
    if (project.ownerId === context.actor) return
    const records = await tx.identity.getIdentityRecords({ userId: context.actor, teamId: project.teamId, projectId: project.id })
    if (!records.membership || records.projectGrant?.role !== 'manager') throw new TaskError('forbidden', 'Only Project managers may change review policy')
  }
  private enforce(capability: ActionCapability, details?: Record<string, unknown>) {
    if (!capability.allowed) throw new TaskError(capability.reasonCode === 'invalid_metadata' ? 'invalid_transition' : capability.reasonCode === 'allowed' ? 'invalid_transition' : capability.reasonCode, capability.reason, details)
  }
  list(projectId: string, context: TaskContext): Promise<TaskSummary[]> { return this.store.transaction(async tx => {
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
  /** Query projection for the Agent API: the same Task facts plus the derived plan window and review
   * requirement. Kept beside `get`/`list` so no caller can obtain a second, divergent derivation. */
  query(projectId: string, id: string, context: TaskContext): Promise<TaskDetailProjection> { return this.queryTasks(projectId, id, context) }
  queryList(projectId: string, context: TaskContext): Promise<TaskSummaryProjection[]> { return this.queryTaskList(projectId, context) }
  private async queryTaskList(projectId: string, context: TaskContext): Promise<TaskSummaryProjection[]> {
    const views = await this.store.transaction(async tx => {
      await this.project(tx, projectId, context)
      const project = await tx.resources.getProject(projectId as ProjectId)
      const sessions = (await tx.resources.listSessions()).filter(session => session.projectId === projectId && !session.deletedAt)
      return Promise.all((await tx.tasks.list(projectId)).map(async summary => {
        const task = (await tx.tasks.get(summary.id))!
        const runs = await tx.tasks.runs(task.id)
        return { summary, capabilities: await taskCapabilities(tx, task, context.actor),
          seed: { sessionId: await candidateSessionId(tx, sessions.filter(session => session.taskId === task.id)), review: resolveReviewRequirement(task, runs, project?.reviewPolicy) } }
      }))
    })
    return Promise.all(views.map(async view => ({ ...view.summary, capabilities: view.capabilities, projection: await this.projection(view.seed, context) })))
  }
  private async queryTasks(projectId: string, id: string, context: TaskContext): Promise<TaskDetailProjection> {
    const view = await this.store.transaction(async tx => {
      const task = await this.task(tx, projectId, id, context)
      const runs = await tx.tasks.runs(id)
      const project = await tx.resources.getProject(projectId as ProjectId)
      const sessions = (await tx.resources.listSessions()).filter(session => session.taskId === id && session.projectId === projectId && !session.deletedAt)
      return { task, capabilities: await taskCapabilities(tx, task, context.actor),
        seed: { sessionId: await candidateSessionId(tx, sessions), review: resolveReviewRequirement(task, runs, project?.reviewPolicy) } }
    })
    return { ...view.task, capabilities: view.capabilities, projection: await this.projection(view.seed, context) }
  }
  /** Plan and review facts for one Task. The review requirement is re-resolved from persisted state; the
   * plan is re-derived from a bounded Journal window, so a query never returns a cached plan revision. */
  private async projection(seed: TaskProjectionSeed, context: TaskContext): Promise<TaskQueryProjection> {
    const { plan, window } = await this.planProjection(seed.sessionId, context)
    return { plan, review: seed.review, window }
  }
  /** One bounded window of the candidate Session, read through the authorized history port. A Session the
   * caller cannot read yields an omitted projection (`null`), never a leak and never a failed Task read. */
  private async planProjection(sessionId: SessionId | null, context: TaskContext): Promise<{ plan: TaskPlanProjection | null; window: TaskPlanWindow | null }> {
    const server = this.server
    if (!server || !sessionId) return { plan: null, window: null }
    let through = 0
    try {
      const head = (await server.events(sessionId, 1, 1, context.actor)).freshness
      through = head ? head.contiguousSeq ?? 0 : 0
    } catch { return { plan: null, window: null } }
    const fromSeq = Math.max(1, through - planWindowEvents + 1)
    let events: readonly PlanJournalEvent[]
    try { events = (await server.events(sessionId, fromSeq, planWindowEvents, context.actor)).events }
    catch { return { plan: null, window: null } }
    const plan = latestCompletedPlan(events)
    return { plan: plan ? { ...plan, sessionId, status: 'pending' } : null,
      window: { sessionId, fromSeq, throughSeq: events.length ? events[events.length - 1].seq : fromSeq - 1, events: events.length } }
  }
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
  /** Read a completed receipt with current review authority, not pending-cycle eligibility or CAS. */
  async authorizeReviewReplay(projectId: string, id: string, runId: string, reviewId: string, context: TaskContext): Promise<void> {
    await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      const run = await tx.tasks.run(runId)
      const review = await tx.tasks.reviewById(reviewId)
      if (!run || run.taskId !== id || run.projectId !== projectId || !review ||
        review.taskId !== id || review.projectId !== projectId || review.taskRunId !== runId) {
        throw new TaskError('not_found', 'Review not found in this Task')
      }
      // Frozen human and staged policies also govern terminal receipts; retaining
      // contributor access after losing manager authority must not expose a prior
      // decision, and earlier-stage reviewers cannot read later-stage receipts.
      const replayPolicy = task.metadataJson.values.reviewPolicy
      if (replayPolicy === 'human' || replayPolicy === 'multi-stage') {
        await this.requireHumanReviewer(tx, projectId, context.actor, review.actor)
        if (replayPolicy === 'multi-stage' && (await tx.tasks.reviews(id)).some(item => item.taskRunId === review.taskRunId && item.id !== review.id && item.reviewer === context.actor)) throw new TaskError('forbidden', 'A reviewer cannot read a later stage of the same staged review chain')
      }
    })
  }

  /** An undecided human review belongs to one exact Task, Run and review cycle.
   * Only the Project owner or a current Project manager other than the
   * submitter may decide; project contribution alone is not reviewer authority. */
  private async requireHumanReviewer(tx: ServerStoreTx, projectId: string, actor: UserId, submitter: string) {
    if (actor === submitter) throw new TaskError('forbidden', 'A review submitter cannot decide their own review')
    const project = await tx.resources.getProject(projectId as ProjectId)
    if (!project || project.deletedAt) throw new TaskError('not_found', 'Project not found')
    const records = project.ownerId === actor ? null : await tx.identity.getIdentityRecords({ userId: actor, teamId: project.teamId, projectId: project.id })
    if (!canDecideHumanReview(actor, submitter, project.ownerId, !!records?.membership, records?.projectGrant?.role)) throw new TaskError('forbidden', 'Current Project manager permission required to decide human review')
  }

  async decideHumanReview(projectId: string, id: string, input: unknown, context: TaskContext, afterCommit: (publish: () => void) => void = publish => publish()) {
    const b = object(input)
    if (Object.keys(b).some(key => !['version', 'requestId', 'reviewId', 'status', 'reason'].includes(key)) ||
      !Number.isSafeInteger(b.version) || Number(b.version) < 1 || typeof b.reviewId !== 'string' || !b.reviewId ||
      (b.status !== 'approved' && b.status !== 'changes_requested') ||
      (b.reason !== undefined && (typeof b.reason !== 'string' || Buffer.byteLength(b.reason) > 2000 || b.reason.includes('\0'))) ||
      (b.status === 'changes_requested' && (typeof b.reason !== 'string' || !b.reason.trim()))) invalid('Human decision requires Task version, review identity, status and bounded change reason')
    const request = createRequest(context.actor, 'human-review-decision', JSON.stringify([projectId, id, b.reviewId]), b.requestId, b)
    if (!request) invalid('Human decision requestId required')
    let changed = false
    const receipt = await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      const review = await tx.tasks.reviewById(b.reviewId as string)
      if (!review || review.projectId !== projectId || review.taskId !== id) throw new TaskError('not_found', 'Review not found in this Task')
      const run = await tx.tasks.run(review.taskRunId)
      if (!run || run.projectId !== projectId || run.taskId !== id) throw new TaskError('not_found', 'Review Run not found in this Task')
      await this.requireHumanReviewer(tx, projectId, context.actor, review.actor)
      const previous = await replayCreate<import('@wemux/web-contract/task-platform').HumanReviewDecisionResponse>(tx, request)
      if (previous) {
        if (previous.task?.projectId !== projectId || previous.task.id !== id || previous.review?.id !== review.id ||
          previous.review.taskRunId !== run.id || previous.review.projectId !== projectId || previous.review.taskId !== id ||
          previous.review.reviewer !== context.actor || previous.review.status !== b.status) throw new TaskError('request_id_conflict', 'Human decision receipt does not match this review')
        return previous
      }
      this.cas(task, b.version)
      if ((task.metadataJson.values.reviewPolicy !== 'human' && task.metadataJson.values.reviewPolicy !== 'multi-stage') || task.metadataJson.values.reviewPolicyFrozen !== true || task.status !== 'in_review' || task.currentReviewId !== review.id ||
        review.status !== 'requested' || review.closedAt !== null || review.decidedAt !== null || review.reviewer !== null) throw new TaskError('invalid_transition', 'Review is not the current pending human stage')
      const runs = await tx.tasks.runs(id)
      const latest = runs.reduce<Run | undefined>((last, next) => !last || next.attempt > last.attempt ? next : last, undefined)
      if (!latest || latest.id !== run.id || latest.status !== 'succeeded' || runs.some(isActiveRun)) throw new TaskError('invalid_transition', 'Review requires the latest succeeded Run without an active attempt')
      const policy = task.metadataJson.values.reviewPolicy
      if (policy !== undefined && policy !== 'human' && policy !== 'multi-stage') throw new TaskError('invalid_transition', 'Configured review policy has no authorized decision workflow yet')
      // Staged chains require an independent decider per stage: the submitter
      // and every earlier-stage reviewer of this Run are barred from deciding.
      if (policy === 'multi-stage') {
        const prior = (await tx.tasks.reviews(id)).filter(item => item.taskRunId === run.id && item.reviewer !== null && item.reviewer === context.actor)
        if (prior.length) throw new TaskError('forbidden', 'A reviewer cannot decide a later stage of the same staged review chain')
      }
      const at = new Date().toISOString(), target = b.status === 'approved' ? (policy === 'multi-stage' && (review.stageIndex ?? 1) < (review.stageCount ?? 1) ? 'in_review' : 'done') : 'in_progress'
      let next: TaskDetail
      try { next = transitionTask(task, target, false) }
      catch { throw new TaskError('invalid_transition', 'Review cannot transition this Task') }
      const decision = { ...review, status: b.status as 'approved' | 'changes_requested', reviewer: context.actor, decidedAt: at, closedAt: at }
      const advance = target === 'in_review'
      const successor: import('@wemux/web-contract/task-platform').ReviewRequest | null = advance ? { id: randomUUID(), projectId, taskId: id, taskRunId: run.id, status: 'requested', actor: review.actor, reviewer: null, requestedAt: at, decidedAt: null, closedAt: null, stageIndex: (review.stageIndex ?? 1) + 1, stageCount: review.stageCount ?? 2 } : null
      // Staged advance keeps in_review, so transitionTask returns the task unchanged;
      // the successor review is still a state change and must observe Task CAS like any decision.
      next = { ...next, ...(advance && next.version === task.version ? { version: task.version + 1 } : {}), currentReviewId: successor ? successor.id : null, updatedAt: at, lastActivityAt: at }
      await tx.tasks.saveReview(decision)
      if (successor) await tx.tasks.saveReview(successor)
      await this.record(tx, next, 'task.transitioned', { action: advance ? 'review.stage_advanced' : 'review.decided', from: task.status, to: target, runId: run.id, reviewId: review.id, reviewStatus: decision.status, stageIndex: review.stageIndex ?? null, stageCount: review.stageCount ?? null, ...(successor ? { successorReviewId: successor.id } : {}), reason: b.reason ?? null }, context)
      await tx.audit.append({ id: randomUUID() as never, actorId: context.actor, action: `review.${decision.status}`, resource: { kind: 'project', id: projectId as ProjectId }, result: 'succeeded', occurredAt: at as never, metadata: { taskId: id, runId: run.id, reviewId: review.id, requestId: b.requestId as string } })
      const result = { task: next, review: decision }
      await recordCreate(tx, request, result)
      changed = true
      return result
    })
    if (changed) afterCommit(() => this.publish({ id: `review:${receipt.review.id}:${receipt.review.status}`, projectId, taskId: id, type: 'task.transitioned' }))
    return receipt
  }

  /** Human action only. Every request, including no-ops, observes Task CAS. */
  async reviewAction(projectId: string, id: string, runId: string, input: unknown, context: TaskContext, afterCommit: (publish: () => void) => void = publish => publish()) {
    const result = await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      const run = await tx.tasks.run(runId)
      if (!run || run.taskId !== id || run.projectId !== projectId) throw new TaskError('not_found', 'Run not found in this Task')
      const b = object(input)
      if (Object.keys(b).some(key => !['version', 'status'].includes(key)) || !Number.isSafeInteger(b.version) || Number(b.version) < 1 || typeof b.status !== 'string' || !['requested', 'approved', 'changes_requested'].includes(b.status)) invalid('Review requires positive version and valid status')
      this.cas(task, b.version)
      const previous = await tx.tasks.review(runId)
      const project = await tx.resources.getProject(projectId as ProjectId)
      const policy = task.metadataJson.values.reviewPolicy ?? ((await tx.tasks.runs(id)).length > 0 ? 'human' : project?.reviewPolicy)
      // No policy mode may silently degrade to a single unassigned human vote.
      // The designated-human, Agent and staged workflows require separate
      // participant/stage enforcement before they can accept decisions.
      if (policy !== undefined && policy !== 'none') throw new TaskError('invalid_transition', 'Configured review policy has no authorized decision workflow yet')
      const facts = await taskFacts(tx, task, context.actor)
      if (b.status !== 'requested' && (facts.runs as Run[]).some(item => item.attempt > run.attempt)) throw new TaskError('invalid_transition', 'Review Run is no longer latest')
      this.enforce(evaluateCapability(b.status === 'requested' ? 'review_request' : b.status === 'approved' ? 'review_approve' : 'review_changes_requested', { ...facts, run, review: previous }))
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
    if (result.changed) afterCommit(() => this.publish({ id: `review:${result.review.id}:${result.review.status}`, projectId, taskId: id, type: 'task.transitioned' }))
    return { review: result.review, task: result.task }
  }
  async sessions(projectId: string, id: string, filter: { projectId?: string; workspaceId?: string; taskId?: string; archived?: boolean }, context: TaskContext) {
    const server = this.server
    if (!server) throw new Error('Session composition unavailable')
    const sessions = await this.store.transaction(async tx => {
      const task = await this.task(tx, projectId, id, context)
      if (task.deletedAt) throw new TaskError('task_deleted', 'Task is permanently deleted')
      const visible = []
      for (const session of await tx.resources.listSessions()) {
        if (session.deletedAt || session.taskId !== id || session.projectId !== projectId ||
          (filter.projectId !== undefined && session.projectId !== filter.projectId) ||
          (filter.workspaceId !== undefined && session.workspaceId !== filter.workspaceId) ||
          (filter.taskId !== undefined && session.taskId !== filter.taskId) ||
          (filter.archived !== undefined && Boolean(session.archivedAt) !== filter.archived)) continue
        try { visible.push(await server.requireSessionAccessInTx(tx, context.actor, session.id)) }
        catch (error) { if (!(error instanceof AppError && error.status === 404)) throw error }
      }
      return visible
    })
    return Promise.all(sessions.map(session => server.sessionView(session.id, context.actor)))
  }
  async createSession(projectId: string, id: string, input: unknown, context: TaskContext) {
    if (!this.server) throw new Error('Session composition unavailable')
    const server = this.server
    const result = await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      const b = object(input)
      if (Object.keys(b).some(key => !['requestId', 'title', 'workspaceId', 'workerId', 'agentKey', 'modelId'].includes(key)) ||
        typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200 || b.title.includes('\0') ||
        typeof b.requestId !== 'string' || !b.requestId.trim() || b.requestId.length > 200 || b.requestId.includes('\0')) invalid('Session title and requestId required; unknown fields are not allowed')
      const explicit = ['workspaceId', 'workerId', 'agentKey', 'modelId'].some(key => key in b)
      if (explicit && ['workspaceId', 'workerId', 'agentKey'].some(key => typeof b[key] !== 'string' || !(b[key] as string).trim() || (b[key] as string).includes('\0'))) invalid('Complete Workspace, Worker and Agent selection required')
      if (!explicit && !task.assignee) throw new TaskError('assignment_changed', 'Task assignment required')
      const selection = explicit ? b : task.assignee!
      await this.workspace(tx, task, selection.workspaceId)
      const created = await server.createSessionInTx(tx, { ...selection, requestId: b.requestId, title: b.title }, { taskId: id, runId: null, ownerId: context.actor, shareScope: 'project' })
      if (created.created) {
        const at = new Date().toISOString()
        await this.record(tx, { ...task, lastActivityAt: at }, 'task.updated', { action: 'session.created', sessionId: created.session.id }, { ...context, requestId: b.requestId as string })
      }
      return created
    })
    if (result.created) {
      server.notifications.commands(result.session.binding.agent.workerId)
      this.publish({ id: randomUUID(), projectId, taskId: id, type: 'task.updated' })
    }
    return result
  }
  /** Explicit, idempotent human completion; a terminal Run never completes its Task by itself. */
  async complete(projectId: string, id: string, input: unknown, context: TaskContext) {
    const b = object(input)
    if (Object.keys(b).some(key => !['version', 'requestId', 'runId', 'summary', 'evidence'].includes(key)) ||
      !Number.isSafeInteger(b.version) || Number(b.version) < 1 || typeof b.runId !== 'string' || !b.runId ||
      typeof b.summary !== 'string' || !b.summary.trim() || Buffer.byteLength(b.summary) > 16000 || b.summary.includes('\0') ||
      !Array.isArray(b.evidence) || b.evidence.length > 20 || b.evidence.some(value => typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 2000 || value.includes('\0'))) invalid('Completion requires a version, Run, bounded summary and evidence references')
    const request = createRequest(context.actor, 'task-completion', JSON.stringify([projectId, id]), b.requestId, b)
    if (!request) invalid('Completion requestId required')
    let changed = false
    const result = await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      const previous = await replayCreate<{ task: TaskDetail; runId: string }>(tx, request)
      if (previous) return previous
      this.cas(task, b.version)
      const runs = await tx.tasks.runs(id)
      const latest = runs.reduce<Run | undefined>((last, run) => !last || run.attempt > last.attempt ? run : last, undefined)
      if (runs.some(isActiveRun)) throw new TaskError('active_run', 'A Run is still active; completion is unavailable')
      if (!latest || latest.id !== b.runId || latest.status !== 'succeeded') throw new TaskError('invalid_transition', 'Completion requires the latest succeeded Run')
      if (task.status !== 'in_progress' || task.currentReviewId || (await tx.tasks.pendingReviews(projectId)).some(review => review.taskId === id)) throw new TaskError('invalid_transition', 'Task is not eligible for direct completion')
      // An unrecognised future policy must never silently fall back to no-review.
      const project = await tx.resources.getProject(projectId as ProjectId)
      const policy = task.metadataJson.values.reviewPolicy ?? (runs.length > 0 ? 'human' : project?.reviewPolicy)
      if (!project || (policy !== undefined && policy !== null && policy !== 'none')) throw new TaskError('invalid_transition', 'Configured review requires a review submission')
      const at = new Date().toISOString()
      const next = { ...transitionTask(task, 'done', false), updatedAt: at, lastActivityAt: at }
      await this.record(tx, next, 'task.transitioned', { action: 'completion.submitted', from: task.status, to: 'done', runId: latest.id, summary: b.summary, evidence: b.evidence }, context)
      await tx.audit.append({ id: randomUUID() as never, actorId: context.actor, action: 'task.complete', resource: { kind: 'project', id: projectId as ProjectId }, result: 'succeeded', occurredAt: at as never, metadata: { taskId: id, runId: latest.id, requestId: b.requestId as string } })
      const receipt = { task: next, runId: latest.id }
      await recordCreate(tx, request, receipt)
      changed = true
      return receipt
    })
    if (changed) this.publish({ id: randomUUID(), projectId, taskId: id, type: 'task.transitioned' })
    return result
  }
  /** Open a configured human review without granting its submitter decision authority. */
  async submitHumanReview(projectId: string, id: string, input: unknown, context: TaskContext) {
    const b = object(input)
    if (Object.keys(b).some(key => !['version', 'requestId', 'runId', 'summary', 'evidence'].includes(key)) ||
      !Number.isSafeInteger(b.version) || Number(b.version) < 1 || typeof b.runId !== 'string' || !b.runId ||
      typeof b.summary !== 'string' || !b.summary.trim() || Buffer.byteLength(b.summary) > 16000 || b.summary.includes('\0') ||
      !Array.isArray(b.evidence) || b.evidence.length > 20 || b.evidence.some(value => typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 2000 || value.includes('\0'))) invalid('Human review submission requires a version, Run, bounded summary and evidence references')
    const request = createRequest(context.actor, 'task-review-submission', JSON.stringify([projectId, id]), b.requestId, b)
    if (!request) invalid('Review submission requestId required')
    let changed = false
    const result = await this.store.transaction(async tx => {
      const task = await this.writeTask(tx, projectId, id, context)
      const previous = await replayCreate<import('@wemux/web-contract/task-platform').HumanReviewSubmissionResponse>(tx, request)
      if (previous && (!previous.task || previous.task.id !== id || previous.task.projectId !== projectId || previous.runId !== b.runId || previous.review?.taskRunId !== b.runId || previous.review?.taskId !== id || previous.review?.projectId !== projectId)) throw new TaskError('request_id_conflict', 'Review submission receipt does not match this Task and Run')
      if (previous) return previous
      this.cas(task, b.version)
      const runs = await tx.tasks.runs(id)
      const latest = runs.reduce<Run | undefined>((last, run) => !last || run.attempt > last.attempt ? run : last, undefined)
      if (runs.some(isActiveRun)) throw new TaskError('active_run', 'A Run is still active; review submission is unavailable')
      if (!latest || latest.id !== b.runId || latest.status !== 'succeeded') throw new TaskError('invalid_transition', 'Review submission requires the latest succeeded Run')
      if (task.status !== 'in_progress' || task.currentReviewId || (await tx.tasks.pendingReviews(projectId)).some(review => review.taskId === id)) throw new TaskError('invalid_transition', 'Task is not eligible for human review submission')
      const project = await tx.resources.getProject(projectId as ProjectId)
      const policy = task.metadataJson.values.reviewPolicy ?? (runs.length > 0 ? 'human' : project?.reviewPolicy)
      // Staged policies resolve to the only decidable participants today: a
      // frozen chain of independent authorized humans. Agent decisions need a
      // real authorized Agent runtime surface and stay blocked, never silently
      // degraded to a single unassigned human vote.
      const staged = policy === 'multi-stage'
      if (policy !== 'human' && !staged) throw new TaskError('invalid_transition', 'Only human and multi-stage review Tasks can use this submission')
      const at = new Date().toISOString()
      const review: import('@wemux/web-contract/task-platform').ReviewRequest = { id: randomUUID(), projectId, taskId: id, taskRunId: latest.id, status: 'requested', actor: context.actor, reviewer: null, requestedAt: at, decidedAt: null, closedAt: null, ...(staged ? { stageIndex: 1, stageCount: 2 } : {}) }
      const next = { ...transitionTask(task, 'in_review', false), currentReviewId: review.id, updatedAt: at, lastActivityAt: at, metadataJson: { schemaVersion: 1 as const, values: { ...task.metadataJson.values, reviewPolicy: (staged ? 'multi-stage' : 'human') as 'human' | 'multi-stage', reviewPolicyFrozen: true } } }
      await tx.tasks.saveReview(review)
      await this.record(tx, next, 'task.transitioned', { action: 'review.submitted', from: task.status, to: 'in_review', runId: latest.id, reviewId: review.id, summary: b.summary, evidence: b.evidence }, context)
      await tx.audit.append({ id: randomUUID() as never, actorId: context.actor, action: 'review.submitted', resource: { kind: 'project', id: projectId as ProjectId }, result: 'succeeded', occurredAt: at as never, metadata: { taskId: id, runId: latest.id, reviewId: review.id, requestId: b.requestId as string } })
      const receipt = { task: next, runId: latest.id, review }
      await recordCreate(tx, request, receipt)
      changed = true
      return receipt
    })
    if (changed) this.publish({ id: randomUUID(), projectId, taskId: id, type: 'task.transitioned' })
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
      this.enforce(launchCapability, launchCapability.reasonCode === 'assignment_changed' ? { assignment: task.assignee } : launchCapability.reasonCode === 'active_run' ? { runId: (facts.runs as Run[]).find(run => isActiveRun(run))?.id } : undefined)
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
      const pinPolicy = task.metadataJson.values.reviewPolicyFrozen !== true
      const binding = created.session.binding
      const run: Run = { id: runId, taskId: id, projectId, requestId: request.requestId, request, fingerprint, attempt: Math.max(0, ...(await tx.tasks.runs(id)).map(run => run.attempt)) + 1, sessionId: created.session.id, snapshot: { workspaceId: binding.workspaceId, workerId: binding.agent.workerId, agentKey: binding.agent.agentKey, modelId: binding.modelId }, status: 'pending', resultSummary: null, failure: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, cancelRequestedAt: null, createCommandId: created.commandId, enqueueCommandId: queued.commandId, messageId: null, turnId: null, cancelCommandIds: [], lastProjectedSeq: 0 }
      await saveRunProjection(tx, run, 'run.created')
      if (pinPolicy) {
        const project = await tx.resources.getProject(projectId as ProjectId)
        if (!project) throw new TaskError('not_found', 'Project not found')
        // Pin the inherited requirement in the same transaction as the first Run, through the same
        // resolution the query projection reports. This server-managed snapshot is not a user edit and
        // must not invalidate clients' Task CAS tokens or emit a separate activity for a single launch.
        const runs = await tx.tasks.runs(id)
        const reviewPolicy = resolveReviewRequirement(task, runs.filter(item => item.id !== runId), project.reviewPolicy).policy
        const projected = await tx.tasks.get(id)
        if (!projected) throw new TaskError('not_found', 'Task not found')
        await tx.tasks.save({ ...projected, metadataJson: { schemaVersion: 1, values: { ...projected.metadataJson.values, reviewPolicy, reviewPolicyFrozen: true } } })
      }
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
    if (Object.keys(b).some(key => !['name', 'workerId', 'source', 'repository', 'assignment', 'version', 'requestId'].includes(key))) invalid('Unknown workspace fields')
    const server = this.server
    if (!server) throw new Error('Workspace composition unavailable')
    const { requestId, ...inputFields } = b
    const source = b.source === undefined ? (b.repository === undefined ? 'empty' : 'git') : b.source
    const repository = b.repository === undefined ? undefined : object(b.repository)
    const normalized = { ...inputFields, source, ...(repository ? { repository: { name: repository.name ?? b.name, gitUrl: repository.gitUrl, revision: repository.revision ?? 'main' } } : {}) }
    const request = createRequest(context.actor, 'task-workspace', JSON.stringify([projectId, id]), requestId, normalized)
    let createdNow = false
    const result = await this.store.transaction(async tx => {
      let task = await this.writeTask(tx, projectId, id, context)
      const previous = await replayCreate<Awaited<ReturnType<ServerService['createWorkspaceInTx']>> & { task: TaskDetail }>(tx, request)
      if (previous) { await this.workspace(tx, task, previous.workspace.id); return previous }
      if ('assignment' in b) this.cas(task, b.version)
      const created = await server.createWorkspaceInTx(tx, { ...inputFields, projectId }, context.actor)
      task = await this.bindInTx(tx, task, created.workspace.id, context)
      if ('assignment' in b) {
        if (!created.workerId) throw new TaskError('runtime_unavailable', 'Creating an assigned Workspace requires a Worker placement')
        task = await this.assignInTx(tx, task, { ...object(b.assignment), workspaceId: created.workspace.id, workerId: created.workerId }, context)
      }
      await this.record(tx, task, 'workspace.created', { workspaceId: created.workspace.id, commandId: created.commandId }, context)
      const result = { ...created, task }
      await recordCreate(tx, request, result)
      createdNow = true
      return result
    })
    if (!createdNow) return result
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
    const request = createRequest(context.actor, 'task', projectId, b.requestId, { description: '', acceptanceCriteria: null, priority: 'none', metadataJson: { schemaVersion: 1, values: {} }, ...fields })
    let created = false
    const task = await this.store.transaction(async tx => {
      await this.project(tx, projectId, context, true)
      const previous = await replayCreate<TaskDetail>(tx, request)
      if (previous) { await this.writeTask(tx, projectId, previous.id, context); return previous }
      if (fields.metadataJson && fields.metadataJson.values.reviewPolicy !== undefined) await this.requirePolicyManager(tx, projectId, context)
      const at = new Date().toISOString()
      const task: TaskDetail = { id: randomUUID(), projectId, title: '', description: '', acceptanceCriteria: null, priority: 'none', status: 'backlog', version: 1, assignee: null, origin: 'manual', activeRun: null, currentReviewId: null, linkCount: 0, createdAt: at, updatedAt: at, lastActivityAt: at, blockedFrom: null, cancelledFrom: null, workspaces: [], links: [], metadataJson: { schemaVersion: 1, values: {} }, ...fields }
      await this.record(tx, task, 'task.created', { title: task.title }, context)
      await recordCreate(tx, request, task)
      created = true
      return task
    })
    if (created) this.notify(task, 'task.created'); return task
  }
  private keys(b: Record<string, unknown>, patch: boolean) {
    const allowed = ['title', 'description', 'acceptanceCriteria', 'priority', 'metadataJson', ...(patch ? ['status', 'version'] : ['requestId'])]
    if (!Object.keys(b).length || Object.keys(b).some(key => !allowed.includes(key))) invalid('Unknown or empty fields; assignment is available in Ticket 04')
  }
  /** Permanent tombstone, no Worker command. Session cleanup cannot currently be proven, so all Session-bearing Tasks fail closed. */
  async delete(projectId: string, id: string, input: unknown, context: TaskContext) {
    const b = object(input)
    if (Object.keys(b).some(key => !['version', 'requestId'].includes(key)) || !Number.isSafeInteger(b.version) || Number(b.version) < 1 || b.requestId === undefined) invalid('Deletion requires version and requestId')
    const request = createRequest(context.actor, 'task-delete', JSON.stringify([projectId, id]), b.requestId, { version: b.version })
    let changed = false
    const receipt = await this.store.transaction(async tx => {
      await this.project(tx, projectId, context, true)
      const task = await this.task(tx, projectId, id, context)
      const project = (await tx.resources.getProject(projectId as ProjectId))!
      if (project.ownerId !== context.actor) {
        const records = await tx.identity.getIdentityRecords({ userId: context.actor, teamId: project.teamId, projectId: project.id })
        if (!records.membership || records.projectGrant?.role !== 'manager') throw new TaskError('forbidden', 'Project owner or manager permission required to delete Task')
      }
      const replay = await replayCreate<import('@wemux/web-contract/task-platform').TaskDeleteReceipt>(tx, request)
      if (replay) return replay
      if (task.deletedAt) throw new TaskError('task_deleted', 'Task is permanently deleted')
      this.cas(task, b.version)
      if (task.origin !== 'manual') invalid('Only ordinary Project Tasks may be deleted')
      const runs = await tx.tasks.runs(id)
      if (runs.some(isActiveRun) || (task.activeRun && ['pending', 'running', 'cancelling'].includes(task.activeRun.status))) throw new TaskError('active_run', 'Task has an active or queued Run; deletion does not cancel execution')
      if (task.currentReviewId || (await tx.tasks.pendingReviews(projectId)).some(review => review.taskId === id)) throw new TaskError('task_has_review', 'Task has an open review')
      if (runs.some(run => Boolean(run.sessionId)) || (await tx.resources.listSessions()).some(session => session.taskId === id || runs.some(run => run.sessionId === session.id))) throw new TaskError('task_has_sessions', 'Task has associated Session history; safe runtime cleanup cannot yet be proven. Deletion is unavailable; do not delete Sessions to bypass this restriction.')
      const at = new Date().toISOString(), workspaceIds = task.workspaces.map(binding => binding.workspaceId)
      for (const workspaceId of workspaceIds) await tx.tasks.unbind(id, workspaceId)
      const next = { ...task, deletedAt: at, deletedBy: context.actor, assignee: null, workspaces: [], version: task.version + 1, updatedAt: at, lastActivityAt: at }
      await this.record(tx, next, 'task.deleted', { workspaceIds, retainedHistory: true }, context)
      await tx.audit.append({ id: randomUUID() as never, actorId: context.actor, action: 'task.delete', resource: { kind: 'project', id: project.id }, result: 'succeeded', occurredAt: at as never, metadata: { taskId: id, version: next.version, requestId: b.requestId as string } })
      const receipt = { taskId: id, version: next.version, deletedAt: at }
      await recordCreate(tx, request, receipt)
      changed = true
      return receipt
    })
    if (changed) this.publish({ id: randomUUID(), projectId, taskId: id, type: 'task.updated' })
    return receipt
  }
  async patch(projectId: string, id: string, input: unknown, context: TaskContext) {
    const b = object(input); this.keys(b, true)
    let fields = content(b)
    if ('status' in b && (!taskStatuses.includes(b.status as TaskStatus) || !Number.isSafeInteger(b.version) || Number(b.version) < 1)) invalid('Status and positive version required')
    if ('version' in b && (!Number.isSafeInteger(b.version) || Number(b.version) < 1)) invalid('Positive version required')
    if (!('status' in b) && !Object.keys(fields).length) invalid('Content or status required')
    let event: TaskActivity['type'] | undefined
    const result = await this.store.transaction(async tx => {
      const current = await this.writeTask(tx, projectId, id, context)
      let policyChange = fields.metadataJson && !isDeepStrictEqual(fields.metadataJson.values.reviewPolicy, current.metadataJson?.values?.reviewPolicy)
      if (fields.metadataJson && current.metadataJson?.values?.reviewPolicyFrozen === true) {
        // Replacement metadata may add other fields; only the server retains the
        // pinned policy and marker. Explicit client policy edits are forbidden.
        if ('reviewPolicy' in fields.metadataJson.values || Object.keys(fields.metadataJson.values).length === 0) throw new TaskError('invalid_transition', 'Review requirement cannot be changed after execution starts')
        fields = { ...fields, metadataJson: { ...fields.metadataJson, values: { ...fields.metadataJson.values, reviewPolicy: current.metadataJson.values.reviewPolicy, reviewPolicyFrozen: true } } }
        policyChange = false
      }
      if (policyChange) {
        await this.requirePolicyManager(tx, projectId, context)
        this.cas(current, b.version)
        // A configured review requirement is frozen once execution starts. Moving
        // through blocked/backlog must not let a manager quietly erase it.
        if (current.metadataJson?.values?.reviewPolicyFrozen === true ||
          !['backlog', 'todo'].includes(current.status) || (await tx.tasks.runs(id)).length > 0) {
          throw new TaskError('invalid_transition', 'Review requirement cannot be changed after execution starts')
        }
      }
      const project = await tx.resources.getProject(projectId as ProjectId)
      const effectiveReviewPolicy = current.metadataJson?.values?.reviewPolicy ?? ((await tx.tasks.runs(id)).length > 0 ? 'human' : project?.reviewPolicy ?? 'none')
      if ('status' in b && current.metadataJson?.values && effectiveReviewPolicy !== 'none' &&
        (b.status === 'in_review' && current.status !== 'in_review' || current.status === 'in_review' && b.status !== 'in_review')) {
        throw new TaskError('invalid_transition', 'Configured review requires an authorized review workflow')
      }
      const facts = 'status' in b ? await taskFacts(tx, current, context.actor) : null
      const runs = facts?.runs as Run[] | undefined
      const latest = runs?.reduce<Run | undefined>((last, run) => !last || run.attempt > last.attempt ? run : last, undefined)
      if ('version' in b) this.cas(current, b.version)
      let next = current
      if ('status' in b) {
        this.enforce(evaluateCapability('transition', { ...facts!, target: b.status }))
        try { next = transitionTask(current, b.status as TaskStatus, runs!.some(isActiveRun)) }
        catch (error) { throw new TaskError(error instanceof Error && error.message === 'active_run' ? 'active_run' : 'invalid_transition', 'Transition not permitted') }
      }
      next = { ...next, ...fields }
      if (isDeepStrictEqual(next, current)) return current
      // A combined status/content change advances once. Legacy content writes also invalidate CAS snapshots.
      const at = new Date().toISOString(); next = { ...next, version: current.version + 1, updatedAt: at, lastActivityAt: at }
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
