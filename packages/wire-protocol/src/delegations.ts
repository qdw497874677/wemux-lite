import type {
  CapabilityToolName,
  ProjectId,
  SessionId,
  WorkerId,
} from '@wemux/domain'

export interface DelegationWireRoute {
  /** D1 requires source and target to be equal. D2 may use these fields for routing. */
  readonly sourceWorkerId: WorkerId
  readonly targetWorkerId: WorkerId
}

export interface DelegationDispatchMessage {
  readonly kind: 'delegation.dispatch'
  readonly requestId: string
  readonly delegationId: string
  readonly dispatchId: string
  readonly objective: string
  readonly sourceProjectId: ProjectId
  readonly targetProjectId: ProjectId
  readonly sourceSessionId: SessionId
  readonly targetSessionId: SessionId
  readonly canonicalSessionId: SessionId
  readonly sourceAgentId: string
  readonly targetAgentId: string
  readonly authorityCapabilities: readonly CapabilityToolName[]
  readonly ancestorAgentIds: readonly string[]
  readonly depth: number
  readonly route: DelegationWireRoute
}

export interface DelegationDecisionMessage {
  readonly kind: 'delegation.decision'
  readonly requestId: string
  readonly delegationId: string
  readonly dispatchId: string
  readonly decision: 'accepted' | 'rejected'
  readonly actorAgentId: string
  readonly reason?: string
  readonly childRunId?: string
  readonly route: DelegationWireRoute
}

export interface DelegationResultMessage {
  readonly kind: 'delegation.result'
  readonly requestId: string
  readonly delegationId: string
  readonly dispatchId: string
  readonly outcome: 'completed' | 'failed' | 'cancelled'
  readonly sourceSessionId: SessionId
  readonly canonicalSessionId: SessionId
  readonly sourceAgentId: string
  readonly targetAgentId: string
  readonly childRunId?: string
  readonly resultSummary?: string
  readonly silent: boolean
  readonly route: DelegationWireRoute
}

export type DelegationWireMessage =
  | DelegationDispatchMessage
  | DelegationDecisionMessage
  | DelegationResultMessage
