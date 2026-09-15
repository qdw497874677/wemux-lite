import type { JournalEvent, JournalEventDraft, SessionId } from '@wemux/domain'
import type {
  LocalWorkspaceReader,
  LocalWorkspaceWriter,
  SessionExecutionReader,
  SessionExecutionWriter,
  WorkerCommandReader,
  WorkerCommandWriter,
  WorkerJournalReader,
} from './worker-store-types.js'

/**
 * Worker persistence seam. Queue state, command idempotency, execution recovery,
 * and Journal events are committed atomically. Sequence numbers are allocated by
 * the Store, never supplied by Server or an Agent adapter.
 */
export interface WorkerStore {
  readonly workspaces: LocalWorkspaceReader
  readonly sessions: SessionExecutionReader
  readonly commands: WorkerCommandReader
  readonly journal: WorkerJournalReader

  transaction<T>(work: (tx: WorkerStoreTx) => Promise<T>): Promise<T>
}

export interface WorkerStoreTx {
  readonly workspaces: LocalWorkspaceWriter
  readonly sessions: SessionExecutionWriter
  readonly commands: WorkerCommandWriter

  appendJournal(
    sessionId: SessionId,
    events: readonly JournalEventDraft[],
  ): Promise<readonly JournalEvent[]>
}

/**
 * A message ACK occurs only after command record + FIFO item + message.queued
 * event commit. Turn claim/finish and their Journal events follow the same rule.
 */
