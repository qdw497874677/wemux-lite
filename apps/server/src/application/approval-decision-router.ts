import { createHash } from 'node:crypto'
import type { ApprovalDecisionInput, ApprovalDecisionPort, ApprovalDecisionResult, ApprovalView } from '@wemux/server-domain'
import type { ApprovalId, SessionId, UserId } from '@wemux/domain'
import type { ProjectionService } from './projection-service.ts'
import type { TaskService, TaskContext } from './task-service.ts'
import type { ServerService } from './server-service.ts'
import type { ApprovalDecisionRepository } from './ports/approval-decision-repository.ts'
import { AppError } from './errors.ts'

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

function keyParts(projectionKey: string): readonly string[] {
  try { return projectionKey.split(':').map(decodeURIComponent) }
  catch { throw new AppError(404, 'Approval not found', 'approval_not_found') }
}
function stableFingerprint(value: Omit<ApprovalDecisionInput, 'fingerprint'>): string {
  const canonical = JSON.stringify({ decision: value.decision, note: value.note ?? null, requestId: value.requestId, sourceRevision: value.sourceRevision })
  return createHash('sha256').update(canonical).digest('hex')
}
function validate(input: ApprovalDecisionInput): void {
  if (!input.requestId || input.requestId.length > 200 || input.requestId.includes('\0')) throw new AppError(400, 'Invalid requestId', 'invalid_request')
  if (!/^[a-f0-9]{64}$/.test(input.fingerprint) || input.fingerprint !== stableFingerprint(input)) throw new AppError(400, 'Invalid fingerprint', 'invalid_fingerprint')
  if (!input.sourceRevision || input.sourceRevision.length > 200 || input.sourceRevision.includes('\0')) throw new AppError(400, 'Invalid sourceRevision', 'invalid_request')
  if (input.note !== undefined && (input.note.length > 2000 || input.note.includes('\0'))) throw new AppError(400, 'Invalid note', 'invalid_request')
}

function validReceiptApproval(approval: ApprovalView): boolean {
  const source = approval.source
  if (!source || typeof approval.projectId !== 'string' || !approval.projectId || typeof approval.projectionKey !== 'string') return false
  const identities = source.kind === 'task_review' ? [source.taskId, source.runId, source.reviewId]
    : source.kind === 'session_tool' ? [source.sessionId, source.turnId, source.approvalId] : []
  if (identities.length !== 3 || identities.some(id => typeof id !== 'string' || !id || id.includes('\0'))) return false
  if ([source.kind, ...identities].map(encodeURIComponent).join(':') !== approval.projectionKey) return false
  return ['approved', 'denied', 'changes_requested'].includes(approval.status) && typeof approval.title === 'string' &&
    (approval.reason === null || typeof approval.reason === 'string') && !!approval.requestedBy &&
    ['user', 'agent', 'channel', 'system'].includes(approval.requestedBy.kind) &&
    (approval.requestedBy.id === null || typeof approval.requestedBy.id === 'string') &&
    typeof approval.requestedAt === 'string' && Number.isFinite(Date.parse(approval.requestedAt)) &&
    typeof approval.decidedAt === 'string' && Number.isFinite(Date.parse(approval.decidedAt)) &&
    typeof approval.sourceRevision === 'string' && !!approval.sourceRevision &&
    Array.isArray(approval.decisionCapabilities) && approval.decisionCapabilities.length === 0 &&
    !!approval.freshness && ['current', 'syncing', 'offline', 'stale', 'unavailable'].includes(approval.freshness.status) &&
    typeof approval.freshness.observedAt === 'string' && Number.isFinite(Date.parse(approval.freshness.observedAt))
}

export class ApprovalDecisionRouter implements ApprovalDecisionPort {
  private readonly projections: ProjectionService
  private readonly tasks: TaskService
  private readonly sessions: ServerService
  private readonly repository: ApprovalDecisionRepository
  private readonly clock: () => Date
  constructor(projections: ProjectionService, tasks: TaskService, sessions: ServerService, repository: ApprovalDecisionRepository, clock: () => Date = () => new Date()) {
    this.projections = projections
    this.tasks = tasks
    this.sessions = sessions
    this.repository = repository
    this.clock = clock
  }

  async decide(actorId: UserId, projectionKey: string, input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    validate(input)
    if (keyParts(projectionKey)[0] !== 'task_review') return this.decideAndSave(actorId, projectionKey, input)
    // The repository and TaskService store share one database/FIFO. Store calls
    // join this transaction sequentially without nesting store transaction leases.
    const publications: (() => void)[] = []
    const result = await this.repository.transaction(() => this.decideAndSave(actorId, projectionKey, input, publish => { publications.push(publish) }))
    for (const publish of publications) publish()
    return result
  }

  private async decideAndSave(actorId: UserId, projectionKey: string, input: ApprovalDecisionInput, afterCommit: (publish: () => void) => void = publish => publish()): Promise<ApprovalDecisionResult> {
    const at = this.clock()
    const now = at.toISOString() as never
    const previous = await this.repository.getReceipt(actorId, input.requestId, now)
    if (previous) {
      // The client fingerprint intentionally excludes the resource. The durable result
      // supplies that binding; a receipt is never a substitute for current authority.
      const approval = previous.result?.approval
      if (previous.actorId !== actorId || previous.requestId !== input.requestId || previous.fingerprint !== input.fingerprint ||
        !approval || approval.projectionKey !== projectionKey || !validReceiptApproval(approval) ||
        approval.sourceRevision !== input.sourceRevision || approval.status !== (input.decision === 'approve' ? 'approved' : input.decision === 'deny' ? 'denied' : 'changes_requested')) {
        throw new AppError(409, 'requestId fingerprint conflict', 'idempotency_conflict')
      }
      await this.projections.requireApprovalProject(actorId, approval.projectId)
      if (approval.source.kind === 'task_review') {
        await this.tasks.authorizeReviewReplay(approval.projectId, approval.source.taskId, approval.source.runId, approval.source.reviewId, { actor: actorId, requestId: input.requestId })
      } else if (approval.source.kind === 'session_tool') {
        await this.sessions.authorizeRuntimeApprovalReplay(approval.source.sessionId, approval.projectId, actorId)
      } else {
        throw new AppError(409, 'Approval receipt cannot be replayed', 'idempotency_conflict')
      }
      return { ...previous.result, replayed: true }
    }
    const current = await this.projections.approval(actorId, projectionKey)
    if (!current) throw new AppError(404, 'Approval not found', 'approval_not_found')
    if (current.sourceRevision !== input.sourceRevision) throw new AppError(409, 'Approval source revision changed', 'source_revision_conflict')
    if (current.status !== 'pending' || !current.decisionCapabilities.includes(input.decision)) throw new AppError(409, 'Approval is no longer actionable', 'approval_stale')
    const parts = keyParts(projectionKey)
    if (current.source.kind === 'task_review') await this.taskDecision(actorId, input, current, parts, afterCommit)
    else if (current.source.kind === 'session_tool') await this.sessionDecision(actorId, input, current)
    else throw new AppError(409, 'Connector or Channel approval authority is unavailable', 'approval_authority_unavailable')
    const refreshed = this.optimisticTerminal(current, input)
    const result = { approval: refreshed, replayed: false }
    await this.repository.save({ actorId, requestId: input.requestId, fingerprint: input.fingerprint, result, createdAt: now }, refreshed, new Date(at.getTime() + IDEMPOTENCY_WINDOW_MS).toISOString() as never)
    return result
  }

  private async taskDecision(actorId: UserId, input: ApprovalDecisionInput, approval: ApprovalView, parts: readonly string[], afterCommit: (publish: () => void) => void): Promise<void> {
    if (approval.source.kind !== 'task_review' || parts.length !== 4) throw new AppError(404, 'Approval not found', 'approval_not_found')
    const version = Number(input.sourceRevision.split(':')[0])
    const context: TaskContext = { actor: actorId, requestId: input.requestId }
    const task = await this.tasks.get(approval.projectId, approval.source.taskId, context)
    if (task.metadataJson.values.reviewPolicy === 'human') {
      if (input.decision === 'deny') throw new AppError(400, 'Human review does not support deny', 'invalid_request')
      await this.tasks.decideHumanReview(approval.projectId, approval.source.taskId, {
        version, reviewId: approval.source.reviewId, requestId: input.requestId,
        status: input.decision === 'approve' ? 'approved' : 'changes_requested', reason: input.note,
      }, context, afterCommit)
      return
    }
    await this.tasks.reviewAction(approval.projectId, approval.source.taskId, approval.source.runId, { version, status: input.decision === 'approve' ? 'approved' : 'changes_requested' }, context, afterCommit)
  }

  private async sessionDecision(actorId: UserId, input: ApprovalDecisionInput, approval: ApprovalView): Promise<void> {
    if (approval.source.kind !== 'session_tool') throw new AppError(404, 'Approval not found', 'approval_not_found')
    if (approval.freshness.status !== 'current' && approval.freshness.status !== 'syncing') throw new AppError(409, 'Worker approval is stale', 'approval_stale')
    await this.sessions.resolveRuntimeApproval(approval.source.sessionId as SessionId, approval.source.approvalId as ApprovalId, { commandId: input.requestId, decision: input.decision, turnId: approval.source.turnId }, actorId)
  }

  private optimisticTerminal(current: ApprovalView, input: ApprovalDecisionInput): ApprovalView {
    return { ...current, status: input.decision === 'approve' ? 'approved' : input.decision === 'deny' ? 'denied' : 'changes_requested', decidedAt: this.clock().toISOString() as never, decisionCapabilities: [] }
  }
}
