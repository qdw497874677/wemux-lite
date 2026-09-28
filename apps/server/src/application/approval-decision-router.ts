import { createHash } from 'node:crypto'
import type { ApprovalDecisionInput, ApprovalDecisionPort, ApprovalDecisionResult, ApprovalView } from '@wemux/server-domain'
import type { ApprovalId, SessionId, UserId } from '@wemux/domain'
import type { ProjectionService } from './projection-service.ts'
import type { TaskService, TaskContext } from './task-service.ts'
import type { ServerService } from './server-service.ts'
import { AppError } from './errors.ts'

interface Receipt { readonly fingerprint: string; readonly result: ApprovalDecisionResult }

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

export class ApprovalDecisionRouter implements ApprovalDecisionPort {
  private readonly receipts = new Map<string, Receipt>()
  private readonly projections: ProjectionService
  private readonly tasks: TaskService
  private readonly sessions: ServerService
  constructor(projections: ProjectionService, tasks: TaskService, sessions: ServerService) {
    this.projections = projections
    this.tasks = tasks
    this.sessions = sessions
  }

  async decide(actorId: UserId, projectionKey: string, input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    validate(input)
    const receiptKey = `${actorId}:${input.requestId}`
    const previous = this.receipts.get(receiptKey)
    if (previous) {
      if (previous.fingerprint !== input.fingerprint) throw new AppError(409, 'requestId fingerprint conflict', 'idempotency_conflict')
      return { ...previous.result, replayed: true }
    }
    const current = await this.projections.approval(actorId, projectionKey)
    if (!current) throw new AppError(404, 'Approval not found', 'approval_not_found')
    if (current.sourceRevision !== input.sourceRevision) throw new AppError(409, 'Approval source revision changed', 'source_revision_conflict')
    if (current.status !== 'pending' || !current.decisionCapabilities.includes(input.decision)) throw new AppError(409, 'Approval is no longer actionable', 'approval_stale')
    const parts = keyParts(projectionKey)
    if (current.source.kind === 'task_review') await this.taskDecision(actorId, input, current, parts)
    else if (current.source.kind === 'session_tool') await this.sessionDecision(actorId, input, current)
    else throw new AppError(409, 'Connector or Channel approval authority is unavailable', 'approval_authority_unavailable')
    const refreshed = this.optimisticTerminal(current, input)
    this.projections.rememberDecision(refreshed)
    const result = { approval: refreshed, replayed: false }
    this.receipts.set(receiptKey, { fingerprint: input.fingerprint, result })
    return result
  }

  private async taskDecision(actorId: UserId, input: ApprovalDecisionInput, approval: ApprovalView, parts: readonly string[]): Promise<void> {
    if (approval.source.kind !== 'task_review' || parts.length !== 4) throw new AppError(404, 'Approval not found', 'approval_not_found')
    const version = Number(input.sourceRevision.split(':')[0])
    const context: TaskContext = { actor: actorId, requestId: input.requestId }
    await this.tasks.reviewAction(approval.projectId, approval.source.taskId, approval.source.runId, { version, status: input.decision === 'approve' ? 'approved' : 'changes_requested' }, context)
  }

  private async sessionDecision(actorId: UserId, input: ApprovalDecisionInput, approval: ApprovalView): Promise<void> {
    if (approval.source.kind !== 'session_tool') throw new AppError(404, 'Approval not found', 'approval_not_found')
    if (approval.freshness.status !== 'current' && approval.freshness.status !== 'syncing') throw new AppError(409, 'Worker approval is stale', 'approval_stale')
    await this.sessions.resolveRuntimeApproval(approval.source.sessionId as SessionId, approval.source.approvalId as ApprovalId, { commandId: input.requestId, decision: input.decision }, actorId)
  }

  private optimisticTerminal(current: ApprovalView, input: ApprovalDecisionInput): ApprovalView {
    return { ...current, status: input.decision === 'approve' ? 'approved' : input.decision === 'deny' ? 'denied' : 'changes_requested', decidedAt: new Date().toISOString() as never, decisionCapabilities: [] }
  }
}
