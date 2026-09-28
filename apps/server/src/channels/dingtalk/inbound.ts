import type { ChannelId } from '@wemux/connector'

import { DINGTALK_BOT_MESSAGE_TOPIC, type DingTalkStreamFrame } from './stream-client.ts'

export interface DingTalkInboundMessage {
  channelId: ChannelId
  eventId: string
  conversationId: string
  conversationType: 'direct' | 'group'
  senderId: string
  senderName?: string
  text: string
  sessionWebhook?: string
  robotCode?: string
  createTime?: number
  raw: Record<string, unknown>
}

export interface DingTalkInboundAudit {
  channelId: ChannelId
  eventId?: string
  reason: 'unsupported_topic' | 'unsupported_message_type' | 'group_without_mention' | 'self_message' | 'invalid_message'
  detail?: string
}

export interface DingTalkInboundOptions {
  channelId: ChannelId
  robotCode?: string
  onMessage: (message: DingTalkInboundMessage) => Promise<void>
  onAudit?: (audit: DingTalkInboundAudit) => Promise<void> | void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true'
}

function parsePayload(frame: DingTalkStreamFrame): Record<string, unknown> | undefined {
  if (!frame.data) return undefined
  try {
    return record(JSON.parse(frame.data))
  } catch {
    return undefined
  }
}

export function dingTalkEventIdentity(payload: Record<string, unknown>): string | undefined {
  const msgId = stringValue(payload.msgId)
  if (msgId) return `msg:${msgId}`
  const conversationId = stringValue(payload.conversationId)
  const createTime = numberValue(payload.createAt) ?? numberValue(payload.createTime)
  return conversationId && createTime ? `conversation:${conversationId}:${createTime}` : undefined
}

export class DingTalkInboundHandler {
  private readonly options: DingTalkInboundOptions

  constructor(options: DingTalkInboundOptions) {
    this.options = options
  }

  async handle(frame: DingTalkStreamFrame, ack: (data?: unknown) => void): Promise<void> {
    // Stream callbacks must be acknowledged before downstream session work to avoid platform redelivery.
    ack()
    const topic = frame.headers?.topic
    if (frame.type !== 'CALLBACK' || topic !== DINGTALK_BOT_MESSAGE_TOPIC) {
      await this.audit('unsupported_topic', frame.headers?.messageId, topic)
      return
    }

    const payload = parsePayload(frame)
    const eventId = payload ? dingTalkEventIdentity(payload) : undefined
    if (!payload || !eventId) {
      await this.audit('invalid_message', eventId, '消息体无效或缺少 msgId/conversationId+createTime')
      return
    }
    const messageType = stringValue(payload.msgtype) ?? 'text'
    const text = stringValue(record(payload.text)?.content)
    if (messageType !== 'text' || !text) {
      await this.audit('unsupported_message_type', eventId, messageType)
      return
    }

    const conversationTypeRaw = stringValue(payload.conversationType)
    const conversationType = conversationTypeRaw === '1'
      ? 'direct'
      : conversationTypeRaw === '2'
        ? 'group'
        : undefined
    if (!conversationType) {
      await this.audit('invalid_message', eventId, `conversationType=${conversationTypeRaw ?? 'missing'}`)
      return
    }
    if (conversationType === 'group' && !booleanValue(payload.isInAtList)) {
      await this.audit('group_without_mention', eventId)
      return
    }

    const configuredRobot = this.options.robotCode
    const messageRobot = stringValue(payload.robotCode)
    const senderId = stringValue(payload.senderStaffId) ?? stringValue(payload.senderId)
    if (!senderId) {
      await this.audit('invalid_message', eventId, '缺少 senderStaffId')
      return
    }
    if ((configuredRobot && senderId === configuredRobot) || (messageRobot && senderId === messageRobot)) {
      await this.audit('self_message', eventId)
      return
    }
    const conversationId = stringValue(payload.conversationId)
    if (!conversationId) {
      await this.audit('invalid_message', eventId, '缺少 conversationId')
      return
    }

    await this.options.onMessage({
      channelId: this.options.channelId,
      eventId,
      conversationId,
      conversationType,
      senderId,
      senderName: stringValue(payload.senderNick),
      text,
      sessionWebhook: stringValue(payload.sessionWebhook),
      robotCode: messageRobot,
      createTime: numberValue(payload.createAt) ?? numberValue(payload.createTime),
      raw: payload,
    })
  }

  private async audit(reason: DingTalkInboundAudit['reason'], eventId?: string, detail?: string): Promise<void> {
    await this.options.onAudit?.({ channelId: this.options.channelId, eventId, reason, detail })
  }
}
