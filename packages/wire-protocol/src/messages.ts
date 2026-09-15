import type {
  AgentCapability,
  EventSeq,
  JournalEvent,
  MessageId,
  SessionId,
  SessionJournalHead,
  Timestamp,
  WorkerId,
  WorkspaceId,
  WorkspaceLocationObservation,
  WorkspaceStatus,
} from '@wemux/domain'
import type { CommandReceipt, WorkerCommand } from './commands.js'
import type { Envelope, ProtocolErrorPayload } from './envelope.js'

export interface WorkerHello extends Envelope {
  readonly type: 'hello'
  readonly side: 'worker'
  readonly workerId: WorkerId
  readonly workerVersion: string
  readonly name: string
  readonly platform: string
  readonly architecture: string
}

export interface ServerHello extends Envelope {
  readonly type: 'hello'
  readonly side: 'server'
  readonly connectionId: string
  readonly acceptedAt: Timestamp
}

export interface Heartbeat extends Envelope {
  readonly type: 'heartbeat'
  readonly nonce: string
  readonly sentAt: Timestamp
}

export interface CapabilityMessage extends Envelope {
  readonly type: 'capability'
  readonly workerId: WorkerId
  readonly capabilities: readonly AgentCapability[]
  readonly detectedAt: Timestamp
}

export interface CommandMessage extends Envelope {
  readonly type: 'command'
  readonly commandId: import('@wemux/domain').CommandId
  readonly command: WorkerCommand
}

export interface AckMessage extends Envelope {
  readonly type: 'ack'
  readonly receipt: CommandReceipt
}

export interface WorkspaceOperationReport {
  /** Provision attempt identity; absent on legacy Workers. Not a Run identity. */
  readonly commandId?: import('@wemux/domain').CommandId
  readonly workspaceId: WorkspaceId
  readonly status: WorkspaceStatus
  readonly reason: string | null
  readonly location: WorkspaceLocationObservation | null
  readonly occurredAt: Timestamp
}

export type EventMessage =
  | (Envelope & {
      readonly type: 'event'
      readonly scope: 'session'
      readonly event: JournalEvent
    })
  | (Envelope & {
      readonly type: 'event'
      readonly scope: 'workspace'
      readonly report: WorkspaceOperationReport
    })

export type SyncMessage =
  | (Envelope & {
      readonly type: 'sync'
      readonly kind: 'heads'
      readonly complete: boolean
      readonly heads: readonly SessionJournalHead[]
    })
  | (Envelope & {
      readonly type: 'sync'
      readonly kind: 'request'
      readonly sessionId: SessionId
      /** Inclusive first sequence requested. */
      readonly fromSeq: EventSeq
      readonly limit: number
    })
  | (Envelope & {
      readonly type: 'sync'
      readonly kind: 'batch'
      readonly sessionId: SessionId
      readonly throughSeq: EventSeq
      readonly hasMore: boolean
      readonly events: readonly JournalEvent[]
    })
  | (Envelope & {
      readonly type: 'sync'
      readonly kind: 'gap'
      readonly sessionId: SessionId
      readonly fromSeq: EventSeq
      readonly reason: string
    })

export interface ProtocolErrorMessage extends Envelope {
  readonly type: 'error'
  readonly error: ProtocolErrorPayload
}

export type ServerToWorker =
  | ServerHello
  | Heartbeat
  | CommandMessage
  | Extract<SyncMessage, { readonly kind: 'request' }>
  | ProtocolErrorMessage

export type WorkerToServer =
  | WorkerHello
  | Heartbeat
  | CapabilityMessage
  | AckMessage
  | EventMessage
  | Exclude<SyncMessage, { readonly kind: 'request' }>
  | ProtocolErrorMessage

export type ProtocolMessage = ServerToWorker | WorkerToServer

export type { MessageId }
