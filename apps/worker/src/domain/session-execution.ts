import type {
  CommandId,
  NativeSessionRef,
  QueuedMessage,
  SessionBinding,
  SessionId,
  SessionRuntimeState,
  SessionStorageMode,
  Timestamp,
  Turn,
  TurnId,
} from '@wemux/domain'
import type { WorkerCommand } from '@wemux/wire-protocol'

export interface SessionExecution {
  readonly sessionId: SessionId
  /** Older rows omit this field; read as local without rewriting the row. */
  readonly storageMode?: SessionStorageMode
  readonly binding: SessionBinding
  readonly runtimeState: SessionRuntimeState
  readonly activeTurnId: TurnId | null
  readonly nativeSession: NativeSessionRef | null
  readonly updatedAt: Timestamp
}

export interface NativeSessionBinding {
  readonly sessionId: SessionId
  readonly nativeSession: NativeSessionRef
}

export type CommandExecutionState =
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'

export interface CommandRecord {
  readonly commandId: CommandId
  readonly command: WorkerCommand
  readonly payloadFingerprint: string
  readonly state: CommandExecutionState
  readonly result: unknown
  readonly recordedAt: Timestamp
  readonly updatedAt: Timestamp
}

export type { QueuedMessage, Turn }
