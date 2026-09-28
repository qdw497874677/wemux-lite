import { createHash } from 'node:crypto'

import type { ChannelPushResult } from '../channel-adapter.ts'

export const DINGTALK_REPLY_CHUNK_LIMIT = 20_000

export interface DingTalkReplyDestination {
  sessionWebhook?: string
  title?: string
  messageType?: 'markdown' | 'text'
}

export interface DingTalkReplyPusherOptions {
  fetch?: typeof fetch
  chunkLimit?: number
}

export function splitDingTalkReply(content: string, limit = DINGTALK_REPLY_CHUNK_LIMIT): string[] {
  const input = content.trim()
  if (!input) return ['']
  const chunks: string[] = []
  let rest = input
  while (rest.length > limit) {
    let splitAt = rest.lastIndexOf('\n', limit)
    if (splitAt < Math.floor(limit / 2)) splitAt = limit
    chunks.push(rest.slice(0, splitAt).trimEnd())
    rest = rest.slice(splitAt).trimStart()
  }
  if (rest || chunks.length === 0) chunks.push(rest)
  return chunks
}

function classify(status: number, retryAfter?: string | null): ChannelPushResult {
  if (status >= 200 && status < 300) return { kind: 'delivered', status, diagnostic: null }
  const diagnostic = `钉钉会话 Webhook 请求失败 (${status})`
  if (status === 429) {
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN
    return { kind: 'retry', status, diagnostic, retryAfterMs: Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : 60_000 }
  }
  if (status === 408 || status >= 500) return { kind: 'retry', status, diagnostic }
  return { kind: 'dead_letter', status, diagnostic }
}

function idempotencyPart(idempotencyKey: string, index: number): string {
  return createHash('sha256').update(`${idempotencyKey}:${index}`).digest('hex').slice(0, 32)
}

export class DingTalkReplyPusher {
  private readonly fetchImpl: typeof fetch
  private readonly chunkLimit: number

  constructor(options: DingTalkReplyPusherOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.chunkLimit = options.chunkLimit ?? DINGTALK_REPLY_CHUNK_LIMIT
  }

  async push(
    destination: DingTalkReplyDestination,
    content: string,
    idempotencyKey: string,
  ): Promise<ChannelPushResult> {
    if (!destination.sessionWebhook) {
      return { kind: 'dead_letter', status: null, diagnostic: '钉钉消息缺少 sessionWebhook，无法回复并进入死信' }
    }
    const chunks = splitDingTalkReply(content, this.chunkLimit)
    for (let index = 0; index < chunks.length; index += 1) {
      const clientId = idempotencyPart(idempotencyKey, index)
      const url = new URL(destination.sessionWebhook)
      url.searchParams.set('clientId', clientId)
      const messageType = destination.messageType ?? 'markdown'
      const body = messageType === 'text'
        ? { msgtype: 'text', text: { content: chunks[index] }, clientId }
        : {
            msgtype: 'markdown',
            markdown: { title: destination.title ?? 'Wemux 回复', text: chunks[index] },
            clientId,
          }
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        return { kind: 'retry', status: null, diagnostic: error instanceof Error ? error.message : String(error) }
      }
      const result = classify(response.status, response.headers.get('retry-after'))
      if (result.kind !== 'delivered') return result
    }
    return { kind: 'delivered', status: 200, diagnostic: null }
  }
}
