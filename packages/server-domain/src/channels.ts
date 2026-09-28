import type { ProjectId, SessionId, Timestamp, UserId, WorkerId } from '@wemux/domain'
import type { Channel, ChannelBinding, ChannelBindingId, ChannelId } from '@wemux/connector'

export type { Channel, ChannelBinding, ChannelBindingId, ChannelId } from '@wemux/connector'

export type InboundDeliveryStatus =
  | 'accepted'
  | 'routing'
  | 'enqueued'
  | 'unbound'
  | 'ignored'
  | 'failed_closed'
  | 'identity_conflict'

export interface InboundDelivery {
  readonly id: string
  readonly channelId: ChannelId
  readonly projectId: ProjectId
  readonly providerEventId: string
  readonly identityStrength: 'strong' | 'weak_identity'
  readonly fingerprint: string
  readonly tokenVersion: number
  readonly externalConversationKey: string
  readonly senderId: string
  readonly content: string
  readonly status: InboundDeliveryStatus
  readonly bindingId: ChannelBindingId | null
  readonly sessionId: SessionId | null
  readonly sessionEnqueueRequestId: string
  readonly diagnostic: string | null
  readonly channelDeleted?: true
  readonly receivedAt: Timestamp
  readonly updatedAt: Timestamp
}

/** Frozen H4 six-state outbox. */
export type OutboundDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'retry_wait'
  | 'dead_letter'
  | 'cancelled'

export interface OutboundDelivery {
  readonly id: string
  readonly channelId: ChannelId
  readonly bindingId: ChannelBindingId
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly journalEventIdentity: string
  readonly callbackUrl: string
  readonly content: string
  readonly status: OutboundDeliveryStatus
  readonly attempt: number
  readonly nextAttemptAt: Timestamp | null
  readonly leaseExpiresAt: Timestamp | null
  readonly responseStatus: number | null
  readonly diagnostic: string | null
  readonly channelDeleted?: true
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly deliveredAt: Timestamp | null
}

export interface ChannelWriteIdentity {
  readonly requestId: string
  readonly fingerprint: string
}

export interface CreateChannelInput extends ChannelWriteIdentity {
  readonly projectId: ProjectId
  readonly name: string
  readonly callbackUrl: string | null
  readonly sourceCidrs: readonly string[]
}

export interface SetChannelEnabledInput extends ChannelWriteIdentity {
  readonly projectId: ProjectId
  readonly channelId: ChannelId
  readonly expectedRevision: number
  readonly enabled: boolean
}

export interface CreateChannelBindingInput extends ChannelWriteIdentity {
  readonly projectId: ProjectId
  readonly channelId: ChannelId
  readonly externalConversationKey: string
  readonly sessionId: SessionId
  readonly callbackUrl: string
  readonly senderAllowlist: readonly string[]
}

export interface SetChannelBindingEnabledInput extends ChannelWriteIdentity {
  readonly projectId: ProjectId
  readonly bindingId: ChannelBindingId
  readonly expectedRevision: number
  readonly enabled: boolean
}

export interface ChannelBindingView {
  readonly binding: ChannelBinding
  readonly callbackUrl: string
  readonly createdBy: UserId
}

export interface ChannelMutationResult {
  readonly channel: Channel
  readonly replayed: boolean
  /** Present only on initial creation. It must never be persisted in a response projection. */
  readonly issuedToken?: string
}

export interface ChannelBindingMutationResult {
  readonly binding: ChannelBinding
  readonly callbackUrl: string
  readonly replayed: boolean
}

export interface ChannelManagementPort {
  list(actorId: UserId, projectId: ProjectId): Promise<readonly Channel[]>
  create(actorId: UserId, input: CreateChannelInput): Promise<ChannelMutationResult>
  setEnabled(actorId: UserId, input: SetChannelEnabledInput): Promise<ChannelMutationResult>
  createBinding(actorId: UserId, input: CreateChannelBindingInput): Promise<ChannelBindingMutationResult>
  setBindingEnabled(actorId: UserId, input: SetChannelBindingEnabledInput): Promise<ChannelBindingMutationResult>
  replay(actorId: UserId, projectId: ProjectId, deliveryId: string, reason: string): Promise<OutboundDelivery>
}

export interface ChannelAuthorizationFacts {
  readonly actorId: UserId
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly workerId: WorkerId
}
