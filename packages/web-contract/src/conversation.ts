import type { TaskSessionView } from './task-platform.js'

/** Current cluster Session wire view; legacy Sessions may not yet have a Task. */
export type ConversationSession = Omit<TaskSessionView, 'taskId'> & { readonly taskId: string | null }
export type ConversationFreshness = TaskSessionView['freshness']
/** Validated history envelope, not a projected or variant-validated Journal payload.
 * Consumers must validate payload fields before interpreting a particular kind.
 */
export interface ConversationEvent {
  readonly sessionId: string
  readonly seq: number
  readonly occurredAt: string
  readonly payload: Readonly<Record<string, unknown>> & { readonly kind: string }
}
export interface ConversationHistoryPage {
  readonly events: readonly ConversationEvent[]
  readonly nextSeq: number | null
  readonly freshness: ConversationFreshness
}
/** Identities belong to the caller, including after an ambiguous network failure. */
export interface SendConversationMessage { readonly commandId: string; readonly messageId: string; readonly content: string }
export type ConversationCommandStatus = 'pending' | 'accepted' | 'rejected' | 'completed' | 'failed' | 'cancelled'
/** Command admission/transport status, never proof of Turn completion. */
export interface ConversationSendReceipt { readonly commandId: string; readonly messageId: string; readonly status: ConversationCommandStatus }
/** Existing cluster command observation route is administrator-only. */
export interface ConversationCommandReceipt {
  readonly commandId: string
  readonly workerId: string
  readonly payloadFingerprint: string
  readonly status: ConversationCommandStatus
  readonly createdAt: string
  readonly updatedAt: string
}

/** Queue cancellation targets an enqueue commandId, not a messageId. */
export interface CancelQueuedConversationMessage { readonly commandId: string }
/** Explicit immutable target: retries must never select a later active Turn. */
export interface StopConversationTurn { readonly commandId: string; readonly turnId: string }
/** Selection for subsequent Turns; admission does not confirm execution. */
export interface SelectConversationModel { readonly commandId: string; readonly modelId: string }
export interface ResolveConversationApproval { readonly commandId: string; readonly turnId: string; readonly decision: 'approve' | 'deny' }
/** HTTP admission only. No claim about cancellation, stopping, or a no-op outcome. */
export interface ConversationControlReceipt { readonly commandId: string }
