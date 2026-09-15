import type { ProjectId, SessionId, TurnId, WorkspaceId } from './ids.js'
import type { AgentKey } from './values.js'

export const capabilityToolNames = [
  'session.info',
  'agent.list',
  'agent.send',
  'agent.inbox.list',
  'agent.inbox.read',
] as const

export type CapabilityToolName = (typeof capabilityToolNames)[number]
export type CapabilityAssetKind = 'skill' | 'prompt' | 'instruction' | 'file'

export interface CapabilityAsset {
  readonly id: string
  readonly kind: CapabilityAssetKind
  readonly name: string
  readonly version: string
  readonly content: string
  readonly checksum: string
  readonly targetPath: string | null
}

export interface CapabilitySnapshot {
  readonly id: string
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly version: number
  readonly assets: readonly CapabilityAsset[]
  readonly allowedTools: readonly CapabilityToolName[]
  readonly createdAt: string
}

export interface CapabilityGrantClaims {
  readonly id: string
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly actorAgentId: SessionId
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly allowedTools: readonly CapabilityToolName[]
  readonly issuedAt: string
  readonly expiresAt: string
}

export interface IssuedCapabilityGrant {
  readonly token: string
  readonly claims: CapabilityGrantClaims
}

export type AgentInboxMessageStatus = 'accepted' | 'delivered' | 'read'

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
  /** SHA-256 of the idempotent send payload; used to reject key reuse with changed input. */
  readonly payloadFingerprint?: string
  readonly status: AgentInboxMessageStatus
  readonly createdAt: string
  readonly readAt: string | null
}
