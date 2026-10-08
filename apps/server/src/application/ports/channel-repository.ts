import type { ProjectId, SessionId, Timestamp, UserId } from '@wemux/domain'
import type { Channel, ChannelBinding, ChannelBindingId, ChannelId, ConnectorCredentialId } from '@wemux/connector'
import type { InboundDelivery, OutboundDelivery } from '@wemux/server-domain'

export interface ChannelSecretRecord {
  readonly credentialId: ConnectorCredentialId
  readonly channelId: ChannelId
  readonly ciphertext: string
  readonly revision: number
  readonly expiresAt: Timestamp | null
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export interface ChannelBindingRecord {
  readonly binding: ChannelBinding
  readonly callbackUrl: string
  readonly createdBy: UserId
}

export interface ChannelRequestRecord {
  readonly projectId: ProjectId
  readonly requestId: string
  readonly fingerprint: string
  readonly operation: 'create' | 'enable' | 'disable' | 'rotate_token' | 'delete' | 'binding.create' | 'binding.enable' | 'binding.disable' | 'outbound.replay' | 'test'
  readonly result: unknown
  readonly createdAt: Timestamp
}

export interface AcceptInboundInput {
  readonly delivery: InboundDelivery
}

export type AcceptInboundResult =
  | { readonly kind: 'accepted'; readonly delivery: InboundDelivery }
  | { readonly kind: 'duplicate'; readonly delivery: InboundDelivery }
  | { readonly kind: 'conflict'; readonly delivery: InboundDelivery }

export interface ChannelRepository {
  getChannel(id: ChannelId): Promise<Channel | null>
  listChannels(projectId: ProjectId): Promise<readonly Channel[]>
  listEnabledChannels(): Promise<readonly Channel[]>
  getSecret(channelId: ChannelId): Promise<ChannelSecretRecord | null>
  getSecrets(channelId: ChannelId, at: Timestamp): Promise<readonly ChannelSecretRecord[]>
  getRequest(projectId: ProjectId, requestId: string): Promise<ChannelRequestRecord | null>
  createChannel(channel: Channel, secret: ChannelSecretRecord, callbackUrl: string | null, request: ChannelRequestRecord): Promise<void>
  updateChannel(channel: Channel, expectedRevision: number, request: ChannelRequestRecord, cancelPending?: boolean): Promise<boolean>
  rotateChannelSecret(channel: Channel, expectedRevision: number, secret: ChannelSecretRecord, previousExpiresAt: Timestamp, request: ChannelRequestRecord): Promise<boolean>
  deleteChannel(channelId: ChannelId, projectId: ProjectId, expectedRevision: number, at: Timestamp, request: ChannelRequestRecord): Promise<'deleted' | 'revision_conflict' | 'active_lease'>
  channelCallbackUrl(channelId: ChannelId): Promise<string | null>

  getBinding(id: ChannelBindingId): Promise<ChannelBindingRecord | null>
  findBinding(channelId: ChannelId, externalConversationKey: string): Promise<ChannelBindingRecord | null>
  listBindings(projectId: ProjectId, channelId?: ChannelId): Promise<readonly ChannelBindingRecord[]>
  createBinding(record: ChannelBindingRecord, request: ChannelRequestRecord): Promise<void>
  updateBinding(record: ChannelBindingRecord, expectedRevision: number, request: ChannelRequestRecord): Promise<boolean>
  updateBindingCallback(channelId: ChannelId, externalConversationKey: string, callbackUrl: string): Promise<boolean>

  acceptInbound(input: AcceptInboundInput): Promise<AcceptInboundResult>
  purgeInboundBefore(before: Timestamp): Promise<number>
  claimAcceptedInbound(limit: number): Promise<readonly InboundDelivery[]>
  updateInbound(delivery: InboundDelivery): Promise<void>
  listInbound(projectId: ProjectId, limit: number): Promise<readonly InboundDelivery[]>

  saveOutbound(delivery: OutboundDelivery): Promise<boolean>
  getOutbound(id: string): Promise<OutboundDelivery | null>
  getProjectOutbound(projectId: ProjectId, id: string): Promise<OutboundDelivery | null>
  listOutbound(projectId: ProjectId, limit: number): Promise<readonly OutboundDelivery[]>
  claimOutbound(now: Timestamp, leaseUntil: Timestamp, limit: number): Promise<readonly OutboundDelivery[]>
  updateOutbound(delivery: OutboundDelivery): Promise<void>
  cancelPendingForChannel(channelId: ChannelId, updatedAt: Timestamp): Promise<number>
  replayOutbound(id: string, now: Timestamp, request: ChannelRequestRecord): Promise<OutboundDelivery | null>

  findInboundBySessionRequest(sessionId: SessionId, requestId: string): Promise<InboundDelivery | null>
}
