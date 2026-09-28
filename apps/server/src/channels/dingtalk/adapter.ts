import type { Timestamp } from '@wemux/domain'
import type { ChannelId, DingTalkChannel, SecretCodec } from '@wemux/connector'
import { stableFingerprint } from '@wemux/connector'
import type { InboundDelivery, OutboundDelivery } from '@wemux/server-domain'
import { AppError } from '../../application/errors.ts'
import type { ChannelRepository } from '../../application/ports/channel-repository.ts'
import type { ActiveInboundAdapter, ChannelInboundRequest, ChannelInboundResponse, ChannelPushResult } from '../channel-adapter.ts'
import { DingTalkInboundHandler, type DingTalkInboundAudit, type DingTalkInboundMessage } from './inbound.ts'
import { DingTalkReplyPusher } from './reply-pusher.ts'
import { DingTalkStreamClient, type DingTalkConnectionStatus, type DingTalkStreamClientOptions } from './stream-client.ts'

export interface DingTalkCredential {
  clientId: string
  clientSecret: string
  robotCode: string
  revision: number
}

export interface DingTalkAdapterOptions {
  fetch?: typeof fetch
  streamClient?: Omit<Partial<DingTalkStreamClientOptions>, 'credential' | 'onFrame'>
  onAudit?: (audit: DingTalkInboundAudit) => Promise<void> | void
}

interface ManagedConnection {
  revision: number
  client: DingTalkStreamClient
}

export const dingTalkInboundRetentionMs = 7 * 24 * 60 * 60 * 1000

export class DingTalkAdapter implements ActiveInboundAdapter {
  readonly kind = 'dingtalk' as const
  private readonly repository: ChannelRepository
  private readonly codec: SecretCodec | null
  private readonly options: DingTalkAdapterOptions
  private readonly pusher: DingTalkReplyPusher
  private readonly connections = new Map<ChannelId, ManagedConnection>()
  private readonly statuses = new Map<ChannelId, DingTalkConnectionStatus>()

  constructor(repository: ChannelRepository, codec: SecretCodec | null, options: DingTalkAdapterOptions = {}) {
    this.repository = repository
    this.codec = codec
    this.options = options
    this.pusher = new DingTalkReplyPusher({ fetch: options.fetch })
  }

  async verify(_request: ChannelInboundRequest): Promise<void> {
    throw new AppError(404, 'DingTalk Stream does not expose an HTTP inbound route', 'channel_not_found')
  }

  async handleInbound(_request: ChannelInboundRequest): Promise<ChannelInboundResponse> {
    throw new AppError(404, 'DingTalk Stream does not expose an HTTP inbound route', 'channel_not_found')
  }

  async pushReply(delivery: OutboundDelivery): Promise<ChannelPushResult> {
    await this.channel(delivery.channelId, true)
    return this.pusher.push({ sessionWebhook: delivery.callbackUrl, title: 'Wemux 回复', messageType: 'markdown' }, delivery.content, delivery.id)
  }

  async enable(channelId: ChannelId): Promise<void> {
    await this.start(channelId)
  }

  async disable(channelId: ChannelId): Promise<void> {
    await this.stop(channelId)
  }

  async start(channelId: ChannelId): Promise<void> {
    const channel = await this.channel(channelId, true)
    const credential = await this.credential(channel)
    const current = this.connections.get(channelId)
    if (current?.revision === credential.revision) return
    if (current) await this.stop(channelId)

    const handler = new DingTalkInboundHandler({
      channelId,
      robotCode: credential.robotCode,
      onMessage: async (message) => this.persistInbound(channel, message),
      onAudit: this.options.onAudit,
    })
    const streamOptions = this.options.streamClient ?? {}
    const client = new DingTalkStreamClient({
      ...streamOptions,
      credential,
      fetch: streamOptions.fetch ?? this.options.fetch,
      onFrame: async (frame, ack) => handler.handle(frame, ack),
      onStatus: (status) => {
        this.statuses.set(channelId, status)
        streamOptions.onStatus?.(status)
      },
    })
    this.connections.set(channelId, { revision: credential.revision, client })
    try {
      await client.start()
    } catch (error) {
      this.connections.delete(channelId)
      throw error
    }
  }

  async stop(channelId: ChannelId): Promise<void> {
    const current = this.connections.get(channelId)
    this.connections.delete(channelId)
    if (current) await current.client.stop()
    this.statuses.set(channelId, { state: 'offline', reconnectAttempt: 0 })
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((channelId) => this.stop(channelId)))
  }

  status(channelId: ChannelId): DingTalkConnectionStatus {
    return this.statuses.get(channelId) ?? { state: 'offline', reconnectAttempt: 0 }
  }

  async testConnection(channelId: ChannelId): Promise<{ ok: true; status: DingTalkConnectionStatus }> {
    const channel = await this.channel(channelId, false)
    const credential = await this.credential(channel)
    let online: DingTalkConnectionStatus | undefined
    const streamOptions = this.options.streamClient ?? {}
    const client = new DingTalkStreamClient({
      ...streamOptions,
      credential,
      fetch: streamOptions.fetch ?? this.options.fetch,
      onFrame: (_frame, ack) => ack(),
      onStatus: (status) => { if (status.state === 'online') online = status },
    })
    await client.start()
    const timeoutAt = Date.now() + 10_000
    while (!online && Date.now() < timeoutAt) await new Promise(resolve => setTimeout(resolve, 10))
    await client.stop()
    if (!online) throw new AppError(503, 'DingTalk Stream connection test timed out', 'connector_unavailable')
    return { ok: true, status: online }
  }

  private async persistInbound(channel: DingTalkChannel, message: DingTalkInboundMessage): Promise<void> {
    if (message.sessionWebhook) {
      await this.repository.updateBindingCallback(channel.id, message.conversationId, message.sessionWebhook)
    }
    const received = new Date()
    const at = received.toISOString() as Timestamp
    const normalized = {
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      senderId: message.senderId,
      text: message.text,
      createTime: message.createTime ?? null,
    }
    const id = `${channel.id}:${message.eventId}`
    const delivery: InboundDelivery = {
      id,
      channelId: channel.id,
      projectId: channel.projectId,
      providerEventId: message.eventId,
      identityStrength: message.eventId.startsWith('msg:') ? 'strong' : 'weak_identity',
      fingerprint: stableFingerprint(normalized),
      tokenVersion: 1,
      externalConversationKey: message.conversationId,
      senderId: message.senderId,
      content: message.text,
      status: 'accepted',
      bindingId: null,
      sessionId: null,
      sessionEnqueueRequestId: `channel-in:${id}`,
      diagnostic: null,
      receivedAt: at,
      updatedAt: at,
    }
    const result = await this.repository.acceptInbound({ delivery })
    if (result.kind === 'conflict') throw new AppError(409, 'Delivery identity fingerprint conflict', 'idempotency_conflict')
    if (result.kind === 'accepted') {
      await this.repository.purgeInboundBefore(new Date(received.getTime() - dingTalkInboundRetentionMs).toISOString() as Timestamp)
    }
  }

  private async channel(id: ChannelId, requireEnabled: boolean): Promise<DingTalkChannel> {
    const channel = await this.repository.getChannel(id)
    if (!channel || channel.kind !== 'dingtalk') throw new AppError(404, 'DingTalk Channel not found', 'channel_not_found')
    if (requireEnabled && !channel.enabled) throw new AppError(409, 'Channel is disabled', 'connector_unavailable')
    return channel
  }

  private async credential(channel: DingTalkChannel): Promise<DingTalkCredential> {
    const secret = await this.repository.getSecret(channel.id)
    if (!secret || !this.codec?.encrypted) throw new AppError(503, 'Channel credential unavailable', 'credential_unavailable')
    try {
      const plaintext = await this.codec.decode(secret.ciphertext, {
        owner: { kind: 'channel', id: channel.id },
        credentialId: secret.credentialId,
        authType: 'custom_credential',
        revision: secret.revision,
      })
      const value = JSON.parse(plaintext) as Partial<DingTalkCredential>
      if (!value.clientId || !value.clientSecret || !value.robotCode) throw new Error('missing fields')
      return { clientId: value.clientId, clientSecret: value.clientSecret, robotCode: value.robotCode, revision: secret.revision }
    } catch {
      throw new AppError(503, 'Channel credential unavailable', 'credential_unavailable')
    }
  }
}
