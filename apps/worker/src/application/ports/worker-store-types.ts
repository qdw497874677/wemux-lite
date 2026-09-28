import type {
  CommandId,
  JournalEvent,
  MessageId,
  SessionBinding,
  SessionId,
  SessionJournalHead,
  SessionRuntimeState,
  Timestamp,
  Turn,
  TurnFailure,
  TurnId,
  UserMessageInput,
  WorkspaceId,
} from '@wemux/domain'
import type { CapabilityRuntimePayload, CommandReceipt, WorkerCommand } from '@wemux/wire-protocol'
import type { LocalWorkspace, RepositoryCheckout } from '../../domain/local-workspace.js'
import type {
  CommandRecord,
  NativeSessionBinding,
  SessionExecution,
} from '../../domain/session-execution.js'

export interface RecordedWorkerCommand {
  readonly commandId: CommandId
  readonly command: WorkerCommand
  readonly payloadFingerprint: string
}

export interface EnqueueMessage {
  readonly sessionId: SessionId
  readonly submissionCommandId: CommandId
  readonly message: UserMessageInput
  readonly queuedAt: Timestamp
  readonly capabilities?: CapabilityRuntimePayload
}

export type CancelQueuedResult =
  | { readonly status: 'cancelled'; readonly messageId: MessageId }
  | { readonly status: 'already-started'; readonly turnId: TurnId }
  | { readonly status: 'not-found' }

export type RequestStopResult =
  | { readonly status: 'stopping' }
  | { readonly status: 'already-finished' }
  | { readonly status: 'not-found' }

export type TurnResult =
  | {
      readonly turnId: TurnId
      readonly outcome: 'completed' | 'cancelled'
      readonly finishedAt: Timestamp
    }
  | {
      readonly turnId: TurnId
      readonly outcome: 'failed'
      readonly failure: TurnFailure
      readonly finishedAt: Timestamp
    }

export interface LocalWorkspaceReader {
  get(workspaceId: WorkspaceId): Promise<LocalWorkspace | null>
  listRepositoryCheckouts(workspaceId: WorkspaceId): Promise<readonly RepositoryCheckout[]>
}

export interface LocalWorkspaceWriter {
  save(workspace: LocalWorkspace): Promise<void>
  saveRepositoryCheckouts(checkouts: readonly RepositoryCheckout[]): Promise<void>
  remove(workspaceId: WorkspaceId): Promise<void>
}

export interface SessionExecutionReader {
  get(sessionId: SessionId): Promise<SessionExecution | null>
  getTurn(turnId: TurnId): Promise<Turn | null>
  listQueued(sessionId: SessionId): Promise<readonly import('@wemux/domain').QueuedMessage[]>
}

export interface SessionExecutionWriter {
  createSession(sessionId: SessionId, binding: SessionBinding): Promise<void>
  enqueue(message: EnqueueMessage): Promise<import('@wemux/domain').QueuedMessage>
  cancelQueued(sessionId: SessionId, submissionCommandId: CommandId): Promise<CancelQueuedResult>
  claimNext(sessionId: SessionId): Promise<Turn | null>
  bindNativeSession(binding: NativeSessionBinding): Promise<void>
  setModel(sessionId: SessionId, modelId: import('@wemux/domain').ModelId): Promise<void>
  deleteSession(sessionId: SessionId): Promise<void>
  requestStop(sessionId: SessionId, turnId: TurnId): Promise<RequestStopResult>
  setRuntimeState(sessionId: SessionId, state: SessionRuntimeState): Promise<void>
  finishTurn(result: TurnResult): Promise<void>
}

export interface WorkerCommandReader {
  get(commandId: CommandId): Promise<CommandRecord | null>
  listRecoverable(limit: number): Promise<readonly CommandRecord[]>
}

export interface WorkerCommandWriter {
  record(command: RecordedWorkerCommand, receipt: CommandReceipt): Promise<void>
  setExecutionState(input: {
    readonly commandId: CommandId
    readonly state: CommandRecord['state']
    readonly result: unknown
    readonly updatedAt: Timestamp
  }): Promise<void>
}

export interface WorkerJournalReader {
  read(input: {
    readonly sessionId: SessionId
    readonly fromSeq: import('@wemux/domain').EventSeq
    readonly limit: number
  }): Promise<import('@wemux/domain').JournalPage>
  listHeads(): Promise<readonly SessionJournalHead[]>
  getEvent(sessionId: SessionId, seq: import('@wemux/domain').EventSeq): Promise<JournalEvent | null>
}
