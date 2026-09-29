import type {
  CommandId,
  MessageId,
  SessionId,
  TurnId,
  UserId,
  WorkspaceId,
} from './ids.js'
import type { AgentRef } from './agent.js'
import type { CapabilitySnapshot } from './capabilities.js'
import type { ModelId, Timestamp } from './values.js'
import type { AbortReason, AgentFailureReason } from './agent-failure.js'

export type SessionRuntimeState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'stopping'
  | 'unavailable'
  | 'failed'

export type QueuedMessageState = 'queued' | 'claimed' | 'cancelled'
export type TurnState = 'running' | 'stopping' | 'completed' | 'cancelled' | 'failed'

export interface SessionBinding {
  readonly workspaceId: WorkspaceId
  readonly agent: AgentRef
  /** Optional: a Session binds the Agent runtime, not a specific model.
   * When null the Agent CLI uses its own default model; users may switch models mid-conversation. */
  readonly modelId: ModelId | null
}

export type SessionStorageMode = 'local' | 'replicated' | 'central'

/** An absent mode on an older command means local; only local is executable today. */
export interface SessionExecutionSpec {
  readonly sessionId: SessionId
  readonly binding: SessionBinding
  readonly storageMode?: SessionStorageMode
}

export interface UserMessageInput {
  readonly messageId: MessageId
  readonly content: string
  /** Cluster account that submitted this message; absent for Worker-local Sessions and legacy records. */
  readonly sentByAccountId?: UserId
}

export interface QueuedMessage {
  readonly sessionId: SessionId
  readonly submissionCommandId: CommandId
  readonly message: UserMessageInput
  readonly position: number
  readonly state: QueuedMessageState
  readonly queuedAt: Timestamp
  readonly capabilitySnapshot: CapabilitySnapshot | null
  readonly capabilityToken: string | null
  readonly capabilityTurnId: TurnId | null
}

export interface TurnFailure {
  readonly code: 'interrupted' | 'agent-unavailable' | 'agent-error' | 'internal-error'
  readonly message: string
  readonly abortReason?: AbortReason
  readonly failureReason?: AgentFailureReason
  readonly retryable?: boolean
}

export interface Turn {
  readonly id: TurnId
  readonly sessionId: SessionId
  readonly message: UserMessageInput
  readonly state: TurnState
  readonly startedAt: Timestamp
  readonly finishedAt: Timestamp | null
  readonly failure: TurnFailure | null
  readonly capabilitySnapshot: CapabilitySnapshot | null
  readonly capabilityToken: string | null
}
