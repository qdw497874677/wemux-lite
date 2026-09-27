import type { ChannelId, FeishuChannel, SecretCodec } from '@wemux/connector'
import type { OutboundDelivery } from '@wemux/server-domain'
import { AppError } from '../../application/errors.ts'
import type { ChannelRepository } from '../../application/ports/channel-repository.ts'
import type { ChannelAdapter, ChannelInboundRequest, ChannelInboundResponse, ChannelPushResult } from '../channel-adapter.ts'
import { feishuInboundRetentionMs, persistFeishuInbound } from './inbound.ts'
import { FeishuReplyPusher } from './reply-pusher.ts'
import type { FeishuAppCredential } from './token-provider.ts'
import { FeishuTokenProvider } from './token-provider.ts'
import { feishuChallenge, verifyFeishuEnvelope, type FeishuVerificationSecrets } from './verify.ts'

export interface FeishuCredential extends FeishuVerificationSecrets, FeishuAppCredential {}

export class FeishuAdapter implements ChannelAdapter {
  readonly kind = 'feishu' as const
  private readonly pusher: FeishuReplyPusher
  private readonly repository: ChannelRepository
  private readonly codec: SecretCodec | null
  private readonly tokens: FeishuTokenProvider
  constructor(repository: ChannelRepository, codec: SecretCodec | null, tokens: FeishuTokenProvider = new FeishuTokenProvider(), apiBaseUrl = 'https://open.feishu.cn/open-apis') { this.repository = repository; this.codec = codec; this.tokens = tokens; this.pusher = new FeishuReplyPusher(tokens, apiBaseUrl) }

  async verify(request: ChannelInboundRequest): Promise<void> { const channel = await this.channel(request.channelId); verifyFeishuEnvelope(request.body, await this.credential(channel)) }

  async handleInbound(request: ChannelInboundRequest): Promise<ChannelInboundResponse> {
    const channel = await this.channel(request.channelId)
    const verified = verifyFeishuEnvelope(request.body, await this.credential(channel))
    const challenge = feishuChallenge(verified.value)
    if (challenge !== null) return { status: 200, body: { challenge }, accepted: null }
    const header = record(verified.value.header)
    if (channel.config.tenantKey && header.tenant_key !== channel.config.tenantKey) throw new AppError(401, 'Invalid Feishu tenant key', 'invalid_channel_token')
    const persisted = await persistFeishuInbound({ repository: this.repository, channel, envelope: verified.value, receivedAt: request.receivedAt })
    const receivedAt = request.receivedAt ?? new Date()
    return {
      status: 200,
      body: {},
      accepted: persisted.result,
      afterAck: persisted.result.kind === 'accepted' ? async () => { await this.repository.purgeInboundBefore(new Date(receivedAt.getTime() - feishuInboundRetentionMs).toISOString() as never) } : undefined,
    }
  }

  async pushReply(delivery: OutboundDelivery): Promise<ChannelPushResult> { const channel = await this.channel(delivery.channelId); return this.pusher.push(delivery, await this.credential(channel)) }
  async testConnection(channelId: ChannelId): Promise<{ ok: true; appIdHint: string }> { const channel = await this.channel(channelId); await this.tokens.token(channelId, await this.credential(channel), true); return { ok: true, appIdHint: channel.config.appIdHint } }
  async enable(channelId: ChannelId): Promise<void> { await this.channel(channelId) }
  async disable(_channelId: ChannelId): Promise<void> {}

  private async channel(id: ChannelId): Promise<FeishuChannel> { const channel = await this.repository.getChannel(id); if (!channel || channel.kind !== 'feishu') throw new AppError(404, 'Channel not found', 'channel_not_found'); if (!channel.enabled) throw new AppError(409, 'Channel is disabled', 'connector_unavailable'); return channel }
  private async credential(channel: FeishuChannel): Promise<FeishuCredential> {
    const secret = await this.repository.getSecret(channel.id)
    if (!secret || !this.codec?.encrypted) throw new AppError(503, 'Channel credential unavailable', 'credential_unavailable')
    try {
      const plaintext = await this.codec.decode(secret.ciphertext, { owner: { kind: 'channel', id: channel.id }, credentialId: secret.credentialId, authType: 'custom_credential', revision: secret.revision })
      const value = JSON.parse(plaintext) as FeishuCredential
      if (!value.appId || !value.appSecret || !value.verificationToken) throw new Error('missing fields')
      return { ...value, revision: secret.revision, encryptKey: value.encryptKey || null }
    } catch { throw new AppError(503, 'Channel credential unavailable', 'credential_unavailable') }
  }
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
