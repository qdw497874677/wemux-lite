import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import type { Timestamp } from '@wemux/domain'
import type { ChannelId, SecretCodec } from '@wemux/connector'
import { stableFingerprint } from '@wemux/connector'
import type { InboundDelivery, OutboundDelivery } from '@wemux/server-domain'
import { AppError } from '../application/errors.ts'
import type { AcceptInboundResult, ChannelRepository } from '../application/ports/channel-repository.ts'
import type { ChannelAdapter, ChannelInboundRequest, ChannelInboundResponse, ChannelPushResult } from './channel-adapter.ts'

export interface GenericWebhookRequest {
  readonly channelId: ChannelId
  readonly authorization: string | undefined
  readonly deliveryId: string | undefined
  readonly timestamp: string | undefined
  readonly body: Buffer
  readonly receivedAt?: Date
}

export class GenericWebhookAdapter implements ChannelAdapter {
  readonly kind = 'generic_webhook' as const
  private readonly repository: ChannelRepository
  private readonly codec: SecretCodec | null
  private readonly fetcher: typeof fetch
  constructor(repository: ChannelRepository, codec: SecretCodec | null, fetcher: typeof fetch = fetch) {
    this.repository = repository; this.codec = codec; this.fetcher = fetcher
  }

  async verify(request: ChannelInboundRequest): Promise<void> { await this.accept(this.fromInbound(request)) }
  async handleInbound(request: ChannelInboundRequest): Promise<ChannelInboundResponse> { const accepted = await this.accept(this.fromInbound(request)); return { status: 202, body: { accepted: true, duplicate: accepted.kind === 'duplicate', deliveryId: accepted.delivery.id }, accepted } }
  async pushReply(delivery: OutboundDelivery): Promise<ChannelPushResult> {
    let response: Response
    try { response = await this.fetcher(delivery.callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': providerId(delivery.id) }, body: JSON.stringify({ deliveryId: delivery.id, channelId: delivery.channelId, bindingId: delivery.bindingId, sessionId: delivery.sessionId, text: delivery.content }) }) }
    catch (error) { return { kind: 'retry', status: null, diagnostic: error instanceof Error ? error.message : '网络错误' } }
    await response.body?.cancel().catch(() => undefined)
    if (response.ok) return { kind: 'delivered', status: response.status, diagnostic: null }
    const diagnostic = response.status === 429 || response.status >= 500 ? `回调返回 HTTP ${response.status}` : `回调返回永久错误 HTTP ${response.status}`
    return { kind: response.status === 429 || response.status >= 500 ? 'retry' : 'dead_letter', status: response.status, diagnostic, retryAfterMs: retryAfter(response) }
  }
  async enable(channelId: ChannelId): Promise<void> { if (!await this.repository.getChannel(channelId)) throw new AppError(404, 'Channel not found', 'channel_not_found') }
  async disable(_channelId: ChannelId): Promise<void> {}
  private fromInbound(request: ChannelInboundRequest): GenericWebhookRequest { return { channelId: request.channelId, authorization: request.headers.authorization, deliveryId: request.headers['x-wemux-delivery-id'], timestamp: request.headers['x-wemux-timestamp'], body: request.body, receivedAt: request.receivedAt } }

  async accept(input: GenericWebhookRequest): Promise<AcceptInboundResult> {
    if (input.body.byteLength > 1024 * 1024) throw new AppError(413, 'Request too large')
    const channel = await this.repository.getChannel(input.channelId)
    if (!channel || channel.kind !== 'generic_webhook') throw new AppError(404, 'Channel not found', 'channel_not_found')
    if (!channel.enabled) throw new AppError(409, 'Channel is disabled', 'connector_unavailable')
    const token = singleBearer(input.authorization), secret = await this.repository.getSecret(channel.id)
    if (!secret || !this.codec?.encrypted) throw new AppError(503, 'Channel credential unavailable', 'credential_unavailable')
    let expected: string
    try { expected = await this.codec.decode(secret.ciphertext, { owner: { kind: 'channel', id: channel.id }, credentialId: secret.credentialId, authType: 'api_key', revision: secret.revision }) }
    catch { throw new AppError(503, 'Channel credential unavailable', 'credential_unavailable') }
    if (!equal(token, expected)) throw new AppError(401, 'Invalid Channel token', 'invalid_channel_token')
    const received = input.receivedAt ?? new Date()
    if (input.timestamp !== undefined) { const parsed = Date.parse(input.timestamp); if (!Number.isFinite(parsed) || Math.abs(received.getTime() - parsed) > channel.config.replayWindowSeconds * 1000) throw new AppError(401, 'Webhook timestamp outside replay window', 'replay_window') }
    const envelope = parse(input.body), deliveryId = input.deliveryId === undefined ? null : identity(input.deliveryId)
    const minute = Math.floor(received.getTime() / 60_000), providerEventId = deliveryId ?? createHash('sha256').update(`${channel.config.tokenVersion}:${minute}:`).update(input.body).digest('hex')
    const normalized = { conversation: envelope.conversation, sender: envelope.sender, text: envelope.text }
    const fingerprint = stableFingerprint(normalized), inboundEventId = `${channel.id}:${providerEventId}`, at = received.toISOString() as Timestamp
    const delivery: InboundDelivery = { id: inboundEventId, channelId: channel.id, projectId: channel.projectId, providerEventId, identityStrength: deliveryId ? 'strong' : 'weak_identity', fingerprint, tokenVersion: channel.config.tokenVersion, externalConversationKey: envelope.conversation, senderId: envelope.sender, content: envelope.text, status: 'accepted', bindingId: null, sessionId: null, sessionEnqueueRequestId: `channel-in:${inboundEventId}`, diagnostic: input.timestamp === undefined ? '未提供 X-Wemux-Timestamp' : null, receivedAt: at, updatedAt: at }
    const result = await this.repository.acceptInbound({ delivery })
    if (result.kind === 'conflict') throw new AppError(409, 'Delivery identity fingerprint conflict', 'idempotency_conflict')
    return result
  }
}

function singleBearer(value: string | undefined): string { if (!value || value.includes(',') || !/^Bearer [A-Za-z0-9_-]{43}$/u.test(value)) throw new AppError(401, 'Missing or invalid Channel token', 'invalid_channel_token'); return value.slice(7) }
function equal(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
function identity(value: string): string { if (value.includes('\0') || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 200) throw new AppError(400, 'Invalid X-Wemux-Delivery-Id'); return value }
function parse(body: Buffer): { conversation: string; sender: string; text: string } { let value: unknown; try { value = JSON.parse(body.toString('utf8')) } catch { throw new AppError(400, 'Invalid JSON') } if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'Invalid webhook body'); const record = value as Record<string, unknown>; if (Object.keys(record).some(key => !['conversation','sender','text'].includes(key))) throw new AppError(400, 'Unknown webhook field'); return { conversation: text(record.conversation, 'conversation', 500), sender: text(record.sender, 'sender', 200), text: text(record.text, 'text', 100000) } }
function text(value: unknown, field: string, maximum: number): string { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > maximum) throw new AppError(400, `Invalid ${field}`); return value.trim() }
function providerId(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32) }
function retryAfter(response: Response): number { const raw = response.headers.get('retry-after'); if (!raw) return 0; const seconds = Number(raw); return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(raw) - Date.now()) }
void randomUUID
