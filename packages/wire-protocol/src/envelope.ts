import type { MessageId } from '@wemux/domain'

export const PROTOCOL_VERSION = 1 as const

export interface Envelope {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly messageId: MessageId
}

export interface ProtocolErrorPayload {
  readonly code:
    | 'unsupported-version'
    | 'unauthorized'
    | 'invalid-message'
    | 'integrity-error'
    | 'internal-error'
  readonly message: string
  readonly retryable: boolean
  readonly relatedMessageId: MessageId | null
}
