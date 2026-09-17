import type { ApprovalId, NativeSessionRef, RuntimeUsage, Timestamp } from '@wemux/domain'
import type { AgentContent } from './content.js'

export interface AgentEventActions {
  readonly stateDelta?: Readonly<Record<string, unknown>>
  readonly artifactDelta?: Readonly<Record<string, number>>
  readonly transferToAgent?: string
  readonly escalate?: boolean
}

export interface WemuxEventMetadata {
  readonly terminal?: 'completed' | 'failed' | 'cancelled'
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly retryable?: boolean
  }
  readonly usage?: RuntimeUsage
  readonly nativeSession?: NativeSessionRef
  readonly approvalId?: ApprovalId
}

export interface AgentEvent {
  readonly id: string
  readonly invocationId: string
  readonly author: string
  readonly content?: AgentContent
  readonly actions: AgentEventActions
  readonly partial?: boolean
  readonly timestamp: Timestamp
  readonly customMetadata?: {
    readonly wemux?: WemuxEventMetadata
    readonly provider?: Readonly<Record<string, unknown>>
    readonly [key: string]: unknown
  }
}

export function isTerminalEvent(event: AgentEvent): boolean {
  return event.customMetadata?.wemux?.terminal !== undefined
}
