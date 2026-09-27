import type { Timestamp } from '@wemux/domain'
import type { ChannelId, FeishuChannel } from '@wemux/connector'
import { stableFingerprint } from '@wemux/connector'
import type { InboundDelivery } from '@wemux/server-domain'
import { AppError } from '../../application/errors.ts'
import type { AcceptInboundResult, ChannelRepository } from '../../application/ports/channel-repository.ts'

export interface FeishuNormalizedEvent {
  readonly eventId: string
  readonly eventType: string
  readonly chatId: string | null
  readonly chatType: string | null
  readonly senderId: string | null
  readonly messageId: string | null
  readonly text: string | null
  readonly mentionedBot: boolean
  readonly senderIsBot: boolean
}

export interface FeishuInboundResult {
  readonly kind: 'accepted' | 'ignored'
  readonly result: AcceptInboundResult
  readonly reason: string | null
}

export async function persistFeishuInbound(input: {
  readonly repository: ChannelRepository
  readonly channel: FeishuChannel
  readonly envelope: Record<string, unknown>
  readonly receivedAt?: Date
}): Promise<FeishuInboundResult> {
  const event = normalizeFeishuEvent(input.envelope)
  const received = input.receivedAt ?? new Date()
  const at = received.toISOString() as Timestamp
  const reason = ignoreReason(event)
  const normalized = { eventType: event.eventType, chatId: event.chatId, senderId: event.senderId, messageId: event.messageId, text: event.text, reason }
  const id = `${input.channel.id}:${event.eventId}`
  const delivery: InboundDelivery = {
    id,
    channelId: input.channel.id,
    projectId: input.channel.projectId,
    providerEventId: event.eventId,
    identityStrength: 'strong',
    fingerprint: stableFingerprint(normalized),
    tokenVersion: 1,
    externalConversationKey: event.chatId ?? `unsupported:${event.eventType}`,
    senderId: event.senderId ?? 'unknown',
    content: event.text ?? '',
    status: reason ? 'ignored' : 'accepted',
    bindingId: null,
    sessionId: null,
    sessionEnqueueRequestId: `channel-in:${id}`,
    diagnostic: reason,
    receivedAt: at,
    updatedAt: at,
  }
  const result = await input.repository.acceptInbound({ delivery })
  if (result.kind === 'conflict') throw new AppError(409, 'Delivery identity fingerprint conflict', 'idempotency_conflict')
  return { kind: reason ? 'ignored' : 'accepted', result, reason }
}

export function normalizeFeishuEvent(envelope: Record<string, unknown>): FeishuNormalizedEvent {
  const header = record(envelope.header, 'header')
  if (envelope.schema !== '2.0') throw new AppError(400, 'Unsupported Feishu event schema')
  const eventId = required(header.event_id, 'event_id', 200)
  const eventType = required(header.event_type, 'event_type', 200)
  const event = record(envelope.event, 'event')
  if (eventType !== 'im.message.receive_v1') return { eventId, eventType, chatId: null, chatType: null, senderId: null, messageId: null, text: null, mentionedBot: false, senderIsBot: false }
  const sender = record(event.sender, 'sender')
  const senderId = record(sender.sender_id, 'sender.sender_id')
  const message = record(event.message, 'message')
  const text = message.message_type === 'text' ? parseText(message.content) : null
  const mentions = Array.isArray(message.mentions) ? message.mentions.filter(isRecord) : []
  return {
    eventId,
    eventType,
    chatId: required(message.chat_id, 'chat_id', 500),
    chatType: required(message.chat_type, 'chat_type', 50),
    senderId: optional(senderId.open_id) ?? optional(senderId.user_id) ?? optional(senderId.union_id),
    messageId: required(message.message_id, 'message_id', 200),
    text,
    // 飞书只在当前应用机器人被 @ 时把该 mention 放进事件；不要把 @all 当作 @bot。
    mentionedBot: mentions.some(value => value.key !== '@_all' && value.id !== undefined),
    senderIsBot: sender.sender_type === 'app' || sender.sender_type === 'bot',
  }
}

function ignoreReason(event: FeishuNormalizedEvent): string | null {
  if (event.eventType !== 'im.message.receive_v1') return `忽略不支持的飞书事件 ${event.eventType}`
  if (event.senderIsBot) return '忽略机器人自身消息'
  if (!event.senderId || !event.chatId || !event.messageId) return '飞书消息身份字段不完整'
  if (event.text === null) return '忽略非文本飞书消息'
  if (event.chatType === 'group' && !event.mentionedBot) return '群聊消息未 @ 机器人'
  if (event.chatType !== 'group' && event.chatType !== 'p2p') return `忽略不支持的 chat_type ${event.chatType}`
  return null
}
function parseText(value: unknown): string | null { if (typeof value !== 'string') return null; try { const parsed = JSON.parse(value) as unknown; return isRecord(parsed) && typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text.trim() : null } catch { return null } }
function record(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value)) throw new AppError(400, `Invalid Feishu ${field}`); return value }
function required(value: unknown, field: string, maximum: number): string { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > maximum) throw new AppError(400, `Invalid Feishu ${field}`); return value.trim() }
function optional(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export const feishuInboundRetentionMs = 7 * 24 * 60 * 60 * 1000
export type { ChannelId }
