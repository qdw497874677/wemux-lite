import type {
  AgentKey,
  AgentInboxMessage,
  CapabilitySnapshot,
  CapabilityToolName,
  ProjectId,
  SessionId,
  TurnId,
  WorkspaceId,
} from '@wemux/domain'

export interface CapabilityGrantPayload {
  readonly grantId: string
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly actorAgentId: SessionId
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly allowedTools: readonly CapabilityToolName[]
  readonly allowedConnectorIds: readonly string[]
  readonly issuedAt: string
  readonly expiresAt: string
}

export interface CapabilityRuntimePayload {
  readonly snapshot: CapabilitySnapshot
  readonly grant: CapabilityGrantPayload
  readonly token: string
}

export interface CapabilitySessionInfoResult {
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly agentId: SessionId
  readonly agentKey: AgentKey
  readonly capabilities: readonly CapabilityToolName[]
}

export interface CapabilityAgentSummary {
  readonly agentId: SessionId
  readonly agentKey: AgentKey
  readonly sessionId: SessionId
  readonly status: 'idle' | 'running' | 'stopped'
}

export interface CapabilityAgentListResult {
  readonly agents: readonly CapabilityAgentSummary[]
}

export interface CapabilityAgentSendInput {
  readonly toAgentId: SessionId
  readonly content: string
  readonly idempotencyKey: string
}

export interface CapabilityAgentSendResult {
  readonly message: AgentInboxMessage
}

export interface CapabilityInboxListInput {
  readonly unreadOnly?: boolean
}

export interface CapabilityInboxListResult {
  readonly messages: readonly AgentInboxMessage[]
}

export interface CapabilityInboxReadInput {
  readonly messageId: string
}

export interface CapabilityInboxReadResult {
  readonly message: AgentInboxMessage
}

export interface CapabilityDelegationAcceptInput {
  readonly delegationId: string
  readonly expectedVersion: number
  readonly requestId: string
}

export interface CapabilityDelegationRejectInput extends CapabilityDelegationAcceptInput {
  readonly reason?: string
}

export interface CapabilityDelegationCompleteInput extends CapabilityDelegationAcceptInput {
  readonly outcome: 'completed' | 'failed' | 'cancelled'
  readonly resultSummary?: string
}

export interface CapabilityDelegationActionResult {
  readonly delegationId: string
  readonly status: 'accepted' | 'rejected' | 'completed' | 'failed' | 'cancelled'
  readonly childRunId?: string
  readonly replayed: boolean
}
