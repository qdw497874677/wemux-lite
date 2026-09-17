import type { CommandId, MessageId, SessionId, ToolCallId, TurnId } from './ids.js'
import type { ApprovalId, RuntimeUsage } from './runtime-protocol.js'
import type { SessionRuntimeState, TurnFailure } from './session.js'
import type { EventSeq, Timestamp } from './values.js'

export type SessionEventPayload =
  | {
      readonly kind: 'message.queued'
      readonly commandId: CommandId
      readonly messageId: MessageId
      readonly content: string
      readonly position: number
    }
  | {
      readonly kind: 'message.cancelled'
      readonly commandId: CommandId
      readonly messageId: MessageId
    }
  | {
      readonly kind: 'turn.started'
      readonly turnId: TurnId
      readonly messageId: MessageId
    }
  | {
      readonly kind: 'assistant.text.delta'
      readonly turnId: TurnId
      readonly text: string
    }
  | {
      readonly kind: 'tool.started'
      readonly turnId: TurnId
      readonly toolCallId: ToolCallId
      readonly toolName: string
      readonly input: unknown
    }
  | {
      readonly kind: 'tool.output.delta'
      readonly turnId: TurnId
      readonly toolCallId: ToolCallId
      readonly text: string
    }
  | {
      readonly kind: 'tool.finished'
      readonly turnId: TurnId
      readonly toolCallId: ToolCallId
      readonly exitCode: number | null
    }
  | {
      readonly kind: 'approval.requested'
      readonly turnId: TurnId
      readonly approvalId: ApprovalId
      readonly action: unknown
      readonly reason?: string
    }
  | {
      readonly kind: 'approval.resolved'
      readonly turnId: TurnId
      readonly approvalId: ApprovalId
      readonly decision: 'approve' | 'deny'
    }
  | {
      readonly kind: 'usage.updated'
      readonly turnId: TurnId
      readonly usage: RuntimeUsage
    }
  | {
      readonly kind: 'compaction.started'
      readonly turnId: TurnId
      readonly reason?: string
    }
  | {
      readonly kind: 'compaction.finished'
      readonly turnId: TurnId
      readonly summary?: string
    }
  | {
      readonly kind: 'turn.finished'
      readonly turnId: TurnId
      readonly outcome: 'completed' | 'cancelled' | 'failed'
      readonly failure: TurnFailure | null
    }
  | {
      readonly kind: 'session.runtime.changed'
      readonly state: SessionRuntimeState
      readonly reason: string | null
    }

export interface JournalEventDraft {
  readonly occurredAt: Timestamp
  readonly payload: SessionEventPayload
}

export interface JournalEvent extends JournalEventDraft {
  readonly sessionId: SessionId
  readonly seq: EventSeq
}

export interface SessionJournalHead {
  readonly sessionId: SessionId
  readonly lastSeq: EventSeq
}

export interface JournalPage {
  readonly events: readonly JournalEvent[]
  readonly throughSeq: EventSeq
  readonly hasMore: boolean
}
