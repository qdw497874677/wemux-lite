import type { AbortReason, AgentFailureReason, ApprovalId, NativeSessionRef, RuntimeUsage, Timestamp } from '@wemux/domain'
import type { AgentContent } from './content.js'

export type AgentStreamKind = 'assistant_text' | 'reasoning_text' | 'plan_text' | 'command_output' | 'file_change_output'

export interface AgentEventActions {
  readonly stateDelta?: Readonly<Record<string, unknown>>
  readonly artifactDelta?: Readonly<Record<string, number>>
  readonly transferToAgent?: string
  readonly escalate?: boolean
}

export interface WemuxEventMetadata {
  readonly terminal?: 'completed' | 'failed' | 'cancelled'
  readonly error?: {
    readonly code: 'interrupted' | 'agent-unavailable' | 'agent-error' | 'internal-error'
    readonly message: string
    readonly abortReason?: AbortReason
    readonly failureReason?: AgentFailureReason
    readonly retryable?: boolean
  }
  readonly usage?: RuntimeUsage
  readonly nativeSession?: NativeSessionRef
  /** @deprecated Read approval.id; retained for older consumers during protocol rollout. */
  readonly approvalId?: ApprovalId
  readonly approval?:
    | { readonly kind: 'requested'; readonly id: ApprovalId; readonly action: unknown; readonly reason?: string }
    | { readonly kind: 'resolved'; readonly id: ApprovalId; readonly decision: 'approve' | 'deny' }
}

export interface AgentEvent {
  readonly id: string
  readonly invocationId: string
  readonly author: string
  readonly content?: AgentContent
  readonly actions: AgentEventActions
  /** Provider-neutral semantic channel for streamed content and activity. */
  readonly streamKind?: AgentStreamKind
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
