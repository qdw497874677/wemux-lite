import type { ProjectId, SessionId, TurnId, UserId, WorkerId, WorkspaceId } from './ids.js'
import type { AgentKey } from './values.js'

export const capabilityToolNames = [
  'session.info',
  'project.list',
  'project.get',
  'project.resources',
  'task.list',
  'task.get',
  'task.create',
  'task.sessions',
  'session.get',
  'session.events',
  'agent.list',
  'agent.send',
  'agent.inbox.list',
  'agent.inbox.read',
  'delegation.accept',
  'delegation.reject',
  'delegation.complete',
  'mcp.list_tools',
  'mcp.call',
  'http.call',
] as const

export type CapabilityToolName = (typeof capabilityToolNames)[number]
export type CapabilityAssetKind = 'skill' | 'prompt' | 'instruction' | 'file'

/** Non-secret Connector definition pinned to one Turn. */
export interface CapabilityConnectorSnapshot {
  readonly id: string
  readonly projectId: ProjectId
  readonly kind: 'mcp' | 'http'
  readonly name: string
  readonly revision: number
  readonly enabled: boolean
  readonly allowedWorkerIds: readonly string[]
  readonly credentialRef: string | null
  readonly credentialAvailability: 'not_required' | 'unconfigured' | 'available' | 'unavailable' | 'invalid'
  readonly riskDefaults: { readonly requireApprovalForRead: boolean; readonly allowMcpReadOnlyHint: boolean }
  readonly config: unknown
}

export interface CapabilityAsset {
  readonly id: string
  readonly kind: CapabilityAssetKind
  readonly name: string
  readonly version: string
  readonly content: string
  readonly checksum: string
  readonly targetPath: string | null
}

export interface CollaborationRosterEntry {
  readonly agentId: SessionId
  readonly agentKey: AgentKey
  readonly sessionId: SessionId
  readonly workerId: WorkerId
  readonly projectId: ProjectId
  readonly status: 'idle' | 'running' | 'stopped'
}

export interface CollaborationProtocolSnapshot {
  readonly version: number
  readonly canonicalSessionId: SessionId
  readonly roster: readonly CollaborationRosterEntry[]
  readonly instructions: string
}

export interface CapabilitySnapshot {
  readonly id: string
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly version: number
  readonly assets: readonly CapabilityAsset[]
  readonly allowedTools: readonly CapabilityToolName[]
  readonly allowedConnectorIds: readonly string[]
  /** Immutable, non-secret Connector definitions visible to this Turn. */
  readonly connectors?: readonly CapabilityConnectorSnapshot[]
  /** Versioned Agent collaboration contract and same-Worker delegation roster. */
  readonly collaboration?: CollaborationProtocolSnapshot
  readonly createdAt: string
}

export interface CapabilityGrantClaims {
  readonly id: string
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly actorAgentId: SessionId
  /** Issued from the authenticated enqueue boundary, never from a tool argument. */
  readonly actorUserId?: UserId
  /** Account authorization generation captured at issuance; account restore never revives old grants. */
  readonly actorAuthVersion?: number
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly allowedTools: readonly CapabilityToolName[]
  readonly allowedConnectorIds: readonly string[]
  readonly issuedAt: string
  readonly expiresAt: string
}

export interface IssuedCapabilityGrant {
  readonly token: string
  readonly claims: CapabilityGrantClaims
}

export type AgentInboxMessageStatus = 'accepted' | 'delivered' | 'read'
export type AgentInboxMessageType = 'agent_message' | 'delegation_request' | 'delegation_result'

export interface DelegationRequestMessagePayload {
  readonly delegationId: string
  readonly dispatchId: string
  readonly objective: string
  readonly sourceAgentId: string
  readonly targetAgentId: string
  readonly targetWorkerId: WorkerId
  readonly ancestorAgentIds: readonly string[]
  readonly depth: number
  readonly authorityCapabilities: readonly CapabilityToolName[]
  readonly canonicalSessionId: SessionId
}

export interface DelegationResultMessagePayload {
  readonly delegationId: string
  readonly dispatchId: string
  readonly sourceAgentId: string
  readonly targetAgentId: string
  readonly outcome: 'completed' | 'failed' | 'cancelled'
  readonly childRunId?: string
  readonly resultSummary?: string
  readonly silent: boolean
}

export type AgentInboxMessagePayload = DelegationRequestMessagePayload | DelegationResultMessagePayload

export interface AgentInboxMessage {
  readonly id: string
  readonly projectId: ProjectId
  readonly fromSessionId: SessionId
  readonly toSessionId: SessionId
  readonly fromAgentId: SessionId
  readonly toAgentId: SessionId
  readonly fromAgentKey: AgentKey
  readonly toAgentKey: AgentKey
  readonly content: string
  readonly type?: AgentInboxMessageType
  readonly payload?: AgentInboxMessagePayload
  /** SHA-256 of the idempotent send payload; used to reject key reuse with changed input. */
  readonly payloadFingerprint?: string
  readonly status: AgentInboxMessageStatus
  readonly createdAt: string
  readonly readAt: string | null
}
