import type {
  AgentCapability,
  EventSeq,
  JournalEvent,
  SessionId,
  SessionJournalHead,
  Timestamp,
  WorkerId,
  WorkspaceId,
  WorkspaceLocationObservation,
  WorkspaceStatus,
} from '@wemux/domain'
import type { CommandReceipt, WorkerCommand } from './commands.js'

/**
 * Application payloads carried by transport v2 data frames.
 * Delivery identity, ordering, ACK and replay belong exclusively to transport-v2.
 */
export interface HeartbeatPayload {
  readonly type: 'heartbeat'
  readonly nonce?: string
  readonly sentAt: Timestamp
}

export interface CapabilityPayload {
  readonly type: 'capability'
  readonly workerId: WorkerId
  readonly capabilities: readonly AgentCapability[]
  readonly detectedAt: Timestamp
}

export interface CommandPayload {
  readonly type: 'command'
  readonly commandId: import('@wemux/domain').CommandId
  readonly command: WorkerCommand
}

export interface CommandReceiptPayload {
  readonly type: 'ack'
  readonly receipt: CommandReceipt
}

export interface WorkspaceOperationReport {
  readonly commandId?: import('@wemux/domain').CommandId
  readonly workspaceId: WorkspaceId
  readonly status: WorkspaceStatus
  readonly reason: string | null
  readonly location: WorkspaceLocationObservation | null
  readonly occurredAt: Timestamp
}

export type EventPayload =
  | { readonly type: 'event'; readonly scope: 'session'; readonly event: JournalEvent }
  | { readonly type: 'event'; readonly scope: 'workspace'; readonly report: WorkspaceOperationReport }

export type SyncPayload =
  | { readonly type: 'sync'; readonly kind: 'heads'; readonly complete: boolean; readonly heads: readonly SessionJournalHead[] }
  | { readonly type: 'sync'; readonly kind: 'request'; readonly sessionId: SessionId; readonly fromSeq: EventSeq; readonly limit: number }
  | { readonly type: 'sync'; readonly kind: 'batch'; readonly sessionId: SessionId; readonly throughSeq: EventSeq; readonly hasMore: boolean; readonly events: readonly JournalEvent[] }
  | { readonly type: 'sync'; readonly kind: 'gap'; readonly sessionId: SessionId; readonly fromSeq: EventSeq; readonly reason: string }

export type ServerPayload =
  | HeartbeatPayload
  | CommandPayload
  | Extract<SyncPayload, { readonly kind: 'request' }>

export type WorkerPayload =
  | HeartbeatPayload
  | CapabilityPayload
  | CommandReceiptPayload
  | EventPayload
  | Exclude<SyncPayload, { readonly kind: 'request' }>

export type ProtocolPayload = ServerPayload | WorkerPayload

// Application-level idempotency keys remain in payloads; transport ordering,
// delivery identity, ACK and replay identity live only in transport-v2 frames.
export type ServerToWorker = ServerPayload
export type WorkerToServer = WorkerPayload
