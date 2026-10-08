import type { CommandId, MessageId, SessionId, ToolCallId, TurnId, UserId } from './ids.js'
import type { ApprovalId, RuntimeUsage } from './agent-profile.js'
import type { SessionRuntimeState, TurnFailure } from './session.js'
import type { EventSeq, ModelId, Timestamp } from './values.js'

export type AgentStreamKind = 'assistant_text' | 'reasoning_text' | 'plan_text' | 'command_output' | 'file_change_output'

export type SessionEventPayload =
  | {
      readonly kind: 'message.queued'
      readonly commandId: CommandId
      readonly messageId: MessageId
      readonly content: string
      readonly position: number
      /** Actual cluster account that submitted the message; absent for local/legacy history. */
      readonly sentByAccountId?: UserId
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
      /** Claim-time selection; null means the Agent default, omission is legacy/unknown. */
      readonly modelId?: ModelId | null
    }
  | {
      readonly kind: 'assistant.text.delta'
      readonly turnId: TurnId
      readonly text: string
      readonly streamKind?: Extract<AgentStreamKind, 'assistant_text' | 'reasoning_text' | 'plan_text'>
    }
  | {
      readonly kind: 'tool.started'
      readonly turnId: TurnId
      readonly toolCallId: ToolCallId
      readonly toolName: string
      readonly input: unknown
      readonly streamKind?: Extract<AgentStreamKind, 'command_output' | 'file_change_output'>
    }
  | {
      readonly kind: 'tool.output.delta'
      readonly turnId: TurnId
      readonly toolCallId: ToolCallId
      readonly text: string
      readonly streamKind?: Extract<AgentStreamKind, 'command_output' | 'file_change_output'>
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
      /** Actual cluster account that resolved the approval; absent for local/legacy history. */
      readonly decidedByAccountId?: UserId
    }
  | {
      /** Automatic invalidation, never a human denial or approval. */
      readonly kind: 'approval.expired'
      readonly turnId: TurnId
      readonly approvalId: ApprovalId
      readonly reason: 'timeout' | 'cancelled' | 'turn_released' | 'shutdown'
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
      readonly kind: 'model.changed'
      readonly previousModelId: ModelId | null
      readonly modelId: ModelId
    }
  | {
      /** 运行时非致命提示（自动重试、额度冷却等）：让用户看到「为什么还没回复」。 */
      readonly kind: 'runtime.notice'
      readonly level: 'info' | 'warning'
      readonly code: string
      readonly message: string
      readonly retry?: SessionNoticeRetry
    }
  | {
      readonly kind: 'session.runtime.changed'
      readonly state: SessionRuntimeState
      readonly reason: string | null
    }

export interface SessionNoticeRetry {
  readonly attempt: number
  readonly maxAttempts: number | null
  readonly delayMs: number | null
}

/**
 * 事件种类清单：Server 校验、Worker 投影与测试共用一份，避免新增 kind 时出现白名单漂移
 * （历史上 approvals / compaction / usage 已因此被拒收为 400 Unknown event kind）。
 */
export const SESSION_EVENT_KINDS = [
  'message.queued',
  'message.cancelled',
  'turn.started',
  'assistant.text.delta',
  'tool.started',
  'tool.output.delta',
  'tool.finished',
  'approval.requested',
  'approval.resolved',
  'approval.expired',
  'usage.updated',
  'compaction.started',
  'compaction.finished',
  'model.changed',
  'runtime.notice',
  'turn.finished',
  'session.runtime.changed',
] as const satisfies readonly SessionEventPayload['kind'][]

export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number]

// 新增 kind 却忘记登记时，下面这行会编译失败（MissingSessionEventKind 不再是 never）。
type MissingSessionEventKind = Exclude<SessionEventPayload['kind'], SessionEventKind>
const sessionEventKindsAreComplete: MissingSessionEventKind extends never ? true : never = true
void sessionEventKindsAreComplete

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
