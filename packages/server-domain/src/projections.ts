import type { CommandId, EventSeq, JournalEvent, SessionId, Timestamp, WorkerId } from '@wemux/domain'

export type CommandProjectionStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface CommandProjection {
  readonly commandId: CommandId
  readonly workerId: WorkerId
  readonly payloadFingerprint: string
  readonly status: CommandProjectionStatus
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type SessionCacheFreshness =
  | 'unknown'
  | 'syncing'
  | 'synced'
  | 'gap'
  | 'offline'
  | 'orphaned'

export interface SessionCacheState {
  readonly sessionId: SessionId
  readonly contiguousSeq: EventSeq
  readonly workerLastSeq: EventSeq | null
  readonly status: SessionCacheFreshness
}

export interface CachedSessionEvent {
  readonly event: JournalEvent
  readonly cachedAt: Timestamp
}
