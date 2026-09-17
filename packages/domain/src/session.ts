import type {
  CommandId,
  MessageId,
  SessionId,
  TurnId,
  WorkspaceId,
} from './ids.js'
import type { AgentRef } from './agent.js'
import type { CapabilitySnapshot } from './capabilities.js'
import type { ModelId, Timestamp } from './values.js'

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

export interface SessionExecutionSpec {
  readonly sessionId: SessionId
  readonly binding: SessionBinding
}

export interface UserMessageInput {
  readonly messageId: MessageId
  readonly content: string
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
