import type { Channel, ChannelId } from '@wemux/connector'
import type { OutboundDelivery } from '@wemux/server-domain'
import type { AcceptInboundResult } from '../application/ports/channel-repository.ts'

export interface ChannelInboundRequest {
  readonly channelId: ChannelId
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: Buffer
  readonly receivedAt?: Date
}

export interface ChannelInboundResponse {
  readonly status: number
  readonly body: unknown
  readonly accepted: AcceptInboundResult | null
  /** Optional work that must run only after the HTTP ACK has been written. */
  readonly afterAck?: () => Promise<void>
}

export interface ChannelPushResult {
  readonly kind: 'delivered' | 'retry' | 'dead_letter'
  readonly status: number | null
  readonly diagnostic: string | null
  readonly retryAfterMs?: number
}

/** Small internal seam shared by concrete H4 channel implementations. */
export interface ChannelAdapter {
  readonly kind: Channel['kind']
  verify(request: ChannelInboundRequest): Promise<void>
  handleInbound(request: ChannelInboundRequest): Promise<ChannelInboundResponse>
  pushReply(delivery: OutboundDelivery): Promise<ChannelPushResult>
  enable(channelId: ChannelId): Promise<void>
  disable(channelId: ChannelId): Promise<void>
}

/** Adapters with a self-initiated inbound source, such as DingTalk Stream WebSocket, implement this. */
export interface ActiveInboundAdapter extends ChannelAdapter {
  start(channelId: ChannelId): Promise<void>
  stop(channelId: ChannelId): Promise<void>
}

export function isActiveInboundAdapter(adapter: ChannelAdapter): adapter is ActiveInboundAdapter {
  const candidate = adapter as Partial<ActiveInboundAdapter>
  return typeof candidate.start === 'function' && typeof candidate.stop === 'function'
}
