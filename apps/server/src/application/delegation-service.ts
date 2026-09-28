import { createHash, randomUUID } from 'node:crypto'
import type { AgentInboxMessage, CapabilityToolName, Timestamp } from '@wemux/domain'
import {
  assertDelegationTransition,
  defaultDelegationPolicy,
  narrowDelegatedAuthority,
  type AcceptDelegationCommand,
  type CompleteDelegationCommand,
  type CreateDelegationCommand,
  type DelegatedAuthority,
  type Delegation,
  type DelegationCompletionResult,
  type DelegationDispatchResult,
  type DelegationMutationResult,
  type DelegationPolicy,
  type RejectDelegationCommand,
  type StartDelegationCommand,
} from '@wemux/server-domain'
import type {
  DelegationApprovalPort,
  DelegationAuthorityResolver,
  DelegationDeliveryPort,
  DelegationJournalPort,
  DelegationRepository,
} from './ports/delegation-ports.ts'

export class DelegationError extends Error {
  readonly code: 'not_found' | 'conflict' | 'forbidden' | 'invalid_input'
  constructor(code: DelegationError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export class DelegationApplicationService {
  private readonly repository: DelegationRepository
  private readonly authorities: DelegationAuthorityResolver
  private readonly delivery: DelegationDeliveryPort
  private readonly journal: DelegationJournalPort
  private readonly approvals: DelegationApprovalPort
  private readonly now: () => Timestamp
  private readonly policy: DelegationPolicy

  constructor(
    repository: DelegationRepository,
    authorities: DelegationAuthorityResolver,
    delivery: DelegationDeliveryPort,
    journal: DelegationJournalPort,
    approvals: DelegationApprovalPort,
    now: () => Timestamp,
    policy: DelegationPolicy = defaultDelegationPolicy,
  ) {
    this.repository = repository
    this.authorities = authorities
    this.delivery = delivery
    this.journal = journal
    this.approvals = approvals
    this.now = now
    this.policy = policy
  }

  async create(command: CreateDelegationCommand): Promise<DelegationDispatchResult> {
    const fingerprint = hash({
      dispatchId: command.dispatchId,
      objective: command.objective,
      source: command.source,
      target: command.target,
      requestedAuthority: command.requestedAuthority,
      ancestorAgentIds: command.ancestorAgentIds,
      depth: command.depth,
    })
    const existing = await this.repository.findDelegationByDispatchId(command.dispatchId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new DelegationError('conflict', 'dispatchId was reused with a different delegation payload')
      return { delegation: existing, pendingApproval: existing.status === 'pending_approval', replayed: true }
    }
    if (command.source.sessionId === command.target.sessionId || command.source.agentId === command.target.agentId || command.ancestorAgentIds.includes(command.target.agentId)) {
      throw new DelegationError('invalid_input', 'delegation target already exists in the ancestor chain')
    }
    if (command.depth < 1 || command.depth > this.policy.maxDepth) throw new DelegationError('invalid_input', `delegation depth exceeds ${this.policy.maxDepth}`)
    const activeChildren = await this.repository.countActiveChildren(command.source.sessionId)
    if (activeChildren >= this.policy.maxConcurrentChildrenPerParent) throw new DelegationError('conflict', 'delegation child quota exceeded')
    if (command.source.canonicalSessionId !== command.source.sessionId) throw new DelegationError('invalid_input', 'canonical session must reuse the source agent session in D1')
    const sourceAuthority = await this.authorities.resolve(command.source.sessionId)
    const targetAuthority = await this.authorities.resolve(command.target.sessionId)
    if (command.target.workerId !== sourceAuthority.workerId || targetAuthority.workerId !== sourceAuthority.workerId) throw new DelegationError('invalid_input', 'D1 only supports delegation on the same Worker')

    const authority = this.narrowAuthority(command.requestedAuthority, sourceAuthority, targetAuthority)
    const createdAt = this.now()
    let delegation: Delegation = {
      id: randomUUID(),
      dispatchId: command.dispatchId,
      status: 'draft',
      version: 0,
      fingerprint,
      objective: requiredText(command.objective, 'objective'),
      source: command.source,
      target: command.target,
      authority,
      ancestorAgentIds: [...command.ancestorAgentIds, command.source.agentId],
      depth: command.depth,
      createdAt,
      updatedAt: createdAt,
      requestReceipts: {},
    }
    const crossProject = command.source.projectId !== command.target.projectId
    delegation = transition(delegation, crossProject ? 'pending_approval' : 'dispatched', this.now())
    delegation = remember(delegation, command.requestId, hash(command), delegation.version)
    await this.repository.saveDelegation(delegation)

    if (crossProject) {
      await this.approvals.requestCrossProjectApproval(delegation)
      return { delegation, pendingApproval: true, replayed: false }
    }
    const inboxMessage = await this.delivery.deliverRequest(delegation)
    return { delegation, inboxMessage, pendingApproval: false, replayed: false }
  }

  async accept(command: AcceptDelegationCommand): Promise<DelegationMutationResult> {
    return this.mutate(command.delegationId, command.requestId, command.expectedVersion, command, ['dispatched'], 'accepted', async current => {
      this.assertTargetActor(current, command.actorAgentId)
      await this.recheckAuthority(current)
    })
  }

  async reject(command: RejectDelegationCommand): Promise<DelegationMutationResult> {
    return this.mutate(command.delegationId, command.requestId, command.expectedVersion, command, ['dispatched'], 'rejected', current => {
      this.assertTargetActor(current, command.actorAgentId)
    }, command.reason ? { rejectionReason: requiredText(command.reason, 'reason') } : {})
  }

  async start(command: StartDelegationCommand): Promise<DelegationMutationResult> {
    return this.mutate(command.delegationId, command.requestId, command.expectedVersion, command, ['accepted'], 'running', current => this.recheckAuthority(current), { childRunId: command.childRunId })
  }

  async complete(command: CompleteDelegationCommand): Promise<DelegationCompletionResult> {
    const mutation = await this.mutate(command.delegationId, command.requestId, command.expectedVersion, command, ['running'], command.outcome, current => {
      this.assertTargetActor(current, command.actorAgentId)
    }, command.resultSummary === undefined ? {} : { resultSummary: requiredText(command.resultSummary, 'resultSummary') })
    if (mutation.replayed) return mutation
    const silent = command.resultSummary?.trim() === '[SILENT]'
    const inboxMessage = await this.delivery.deliverResult(mutation.delegation, silent)
    await this.journal.appendResult(mutation.delegation, silent)
    return { ...mutation, inboxMessage }
  }

  private async mutate(
    id: string,
    requestId: string,
    expectedVersion: number,
    input: unknown,
    allowedFrom: readonly Delegation['status'][],
    nextStatus: Delegation['status'],
    validate: (delegation: Delegation) => Promise<void> | void,
    patch: Partial<Delegation> = {},
  ): Promise<DelegationMutationResult> {
    const current = await this.repository.getDelegation(id)
    if (!current) throw new DelegationError('not_found', 'delegation not found')
    const fingerprint = hash(input)
    const replay = current.requestReceipts[requestId]
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new DelegationError('conflict', 'requestId was reused with a different delegation command')
      return { delegation: current, replayed: true }
    }
    if (current.version !== expectedVersion) throw new DelegationError('conflict', 'delegation version conflict')
    if (!allowedFrom.includes(current.status)) throw new DelegationError('conflict', `delegation cannot move from ${current.status} to ${nextStatus}`)
    await validate(current)
    let next = transition({ ...current, ...patch }, nextStatus, this.now())
    next = remember(next, requestId, fingerprint, next.version)
    await this.repository.saveDelegation(next, expectedVersion)
    return { delegation: next, replayed: false }
  }

  private assertTargetActor(delegation: Delegation, actorAgentId: string): void {
    if (delegation.target.agentId !== actorAgentId) throw new DelegationError('forbidden', 'only the delegated target agent may decide or complete this delegation')
  }

  private async recheckAuthority(delegation: Delegation): Promise<void> {
    const current = await this.resolveAuthority(delegation.source.sessionId, delegation.target.sessionId, delegation.authority)
    if (!sameAuthority(current, delegation.authority)) throw new DelegationError('forbidden', 'delegated authority narrowed after dispatch')
  }

  private async resolveAuthority(sourceSessionId: Delegation['source']['sessionId'], targetSessionId: Delegation['target']['sessionId'], requested: DelegatedAuthority): Promise<DelegatedAuthority> {
    return this.narrowAuthority(requested, await this.authorities.resolve(sourceSessionId), await this.authorities.resolve(targetSessionId))
  }

  private narrowAuthority(requested: DelegatedAuthority, source: DelegatedAuthority, target: DelegatedAuthority): DelegatedAuthority {
    const narrowed = narrowDelegatedAuthority(requested, source, target)
    if (!narrowed.capabilities.length) throw new DelegationError('forbidden', 'delegated authority has no permitted capabilities')
    return narrowed
  }
}

function transition(delegation: Delegation, status: Delegation['status'], updatedAt: Timestamp): Delegation {
  assertDelegationTransition(delegation.status, status)
  return { ...delegation, status, version: delegation.version + 1, updatedAt }
}

function remember(delegation: Delegation, requestId: string, fingerprint: string, resultingVersion: number): Delegation {
  return { ...delegation, requestReceipts: { ...delegation.requestReceipts, [requiredText(requestId, 'requestId')]: { fingerprint, resultingVersion } } }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requiredText(value: string, field: string): string {
  const text = value.trim()
  if (!text || text.includes('\0')) throw new DelegationError('invalid_input', `${field} is invalid`)
  return text
}

function sameAuthority(left: DelegatedAuthority, right: DelegatedAuthority): boolean {
  const normalize = (values: readonly string[]) => [...values].sort().join('\0')
  return normalize(left.capabilities as readonly CapabilityToolName[]) === normalize(right.capabilities as readonly CapabilityToolName[])
    && normalize(left.allowedProjectIds) === normalize(right.allowedProjectIds)
}
