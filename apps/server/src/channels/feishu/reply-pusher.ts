import { createHash } from 'node:crypto'
import type { ChannelId } from '@wemux/connector'
import type { OutboundDelivery } from '@wemux/server-domain'
import type { ChannelPushResult } from '../channel-adapter.ts'
import { FeishuTokenProvider, type FeishuAppCredential } from './token-provider.ts'

export class FeishuReplyPusher {
  private readonly tokens: FeishuTokenProvider
  private readonly baseUrl: string
  constructor(tokens: FeishuTokenProvider, baseUrl = 'https://open.feishu.cn/open-apis') {
    this.tokens = tokens
    this.baseUrl = baseUrl
  }

  async push(delivery: OutboundDelivery, credential: FeishuAppCredential): Promise<ChannelPushResult> {
    const chunks = splitCodePoints(plainText(delivery.content), 4000)
    for (let index = 0; index < chunks.length; index++) {
      const response = await this.tokens.authorizedFetch(delivery.channelId as ChannelId, credential, `${this.baseUrl}/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-idempotency-key': idempotencyUuid(delivery.id, index) },
        body: JSON.stringify({ receive_id: delivery.callbackUrl, msg_type: 'text', content: JSON.stringify({ text: chunks[index] }), uuid: idempotencyUuid(delivery.id, index) }),
      })
      const payload = await response.clone().json().catch(() => ({})) as { code?: unknown; msg?: unknown }
      await response.body?.cancel().catch(() => undefined)
      if (response.ok && (payload.code === undefined || payload.code === 0)) continue
      const diagnostic = `飞书回复失败 HTTP ${response.status}, code ${String(payload.code ?? 'unknown')}: ${String(payload.msg ?? '')}`.slice(0, 500)
      if (response.status === 429 || response.status >= 500) return { kind: 'retry', status: response.status, diagnostic, retryAfterMs: retryAfter(response) }
      return { kind: 'dead_letter', status: response.status, diagnostic }
    }
    return { kind: 'delivered', status: 200, diagnostic: null }
  }
}

export function splitCodePoints(value: string, maximum: number): string[] {
  const points = Array.from(value)
  if (!points.length) return ['']
  const chunks: string[] = []
  for (let index = 0; index < points.length; index += maximum) chunks.push(points.slice(index, index + maximum).join(''))
  return chunks
}
export function plainText(value: string): string { return value.replace(/```[^\n]*\n?/gu, '').replace(/```/gu, '').replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/[*_~>#]/gu, '').trim() }
export function idempotencyUuid(deliveryId: string, chunk: number): string { const hex = createHash('sha256').update(`${deliveryId}:${chunk}`).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}` }
function retryAfter(response: Response): number { const value = response.headers.get('retry-after'); if (!value) return 0; const seconds = Number(value); return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - Date.now()) }
