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
import type { ConnectorRevisionReport } from './connectors.js'

export interface WorkspaceFileEntry {
  readonly name: string
  readonly type: 'file' | 'directory'
  readonly size: number
  readonly mtime: Timestamp
}

export interface WorkspaceDiffLine {
  readonly type: 'add' | 'del' | 'ctx'
  readonly oldLine?: number
  readonly newLine?: number
  readonly text: string
}

export type FileRequestPayload =
  | { readonly type: 'fs.request'; readonly requestId: string; readonly sessionId: SessionId; readonly operation: 'list'; readonly subpath: string }
  | { readonly type: 'fs.request'; readonly requestId: string; readonly sessionId: SessionId; readonly operation: 'read'; readonly subpath: string; readonly maxBytes: number }
  | { readonly type: 'fs.request'; readonly requestId: string; readonly sessionId: SessionId; readonly operation: 'write'; readonly subpath: string; readonly base64Content: string }
  | { readonly type: 'fs.request'; readonly requestId: string; readonly sessionId: SessionId; readonly operation: 'diff'; readonly subpath: string }

export type FileResponsePayload =
  | { readonly type: 'fs.response'; readonly requestId: string; readonly ok: true; readonly operation: 'list'; readonly entries: readonly WorkspaceFileEntry[] }
  | { readonly type: 'fs.response'; readonly requestId: string; readonly ok: true; readonly operation: 'read'; readonly content: string | null; readonly base64Content?: string; readonly size: number; readonly truncated: boolean; readonly binary: boolean }
  | { readonly type: 'fs.response'; readonly requestId: string; readonly ok: true; readonly operation: 'write'; readonly subpath: string; readonly size: number }
  | { readonly type: 'fs.response'; readonly requestId: string; readonly ok: true; readonly operation: 'diff'; readonly supported: boolean; readonly reason?: 'not-git'; readonly lines: readonly WorkspaceDiffLine[] }
  | { readonly type: 'fs.response'; readonly requestId: string; readonly ok: false; readonly error: string }

export type TerminalRequestPayload =
  | { readonly type: 'terminal.request'; readonly requestId: string; readonly sessionId: SessionId; readonly operation: 'create'; readonly cols: number; readonly rows: number }
  | { readonly type: 'terminal.request'; readonly requestId: string; readonly sessionId: SessionId; readonly operation: 'write'; readonly terminalId: string; readonly data: string }
  | { readonly type: 'terminal.request'; readonly requestId: string; readonly sessionId: SessionId; readonly operation: 'resize'; readonly terminalId: string; readonly cols: number; readonly rows: number }
  | { readonly type: 'terminal.request'; readonly requestId: string; readonly sessionId: SessionId; readonly operation: 'dispose'; readonly terminalId: string }

export type TerminalResponsePayload =
  | { readonly type: 'terminal.response'; readonly requestId: string; readonly ok: true; readonly operation: 'create'; readonly terminalId: string; readonly pid: number }
  | { readonly type: 'terminal.response'; readonly requestId: string; readonly ok: true; readonly operation: 'write' | 'resize' | 'dispose' }
  | { readonly type: 'terminal.response'; readonly requestId: string; readonly ok: false; readonly error: string }

export type TerminalEventPayload =
  | { readonly type: 'terminal.output'; readonly sessionId: SessionId; readonly terminalId: string; readonly data: string }
  | { readonly type: 'terminal.exit'; readonly sessionId: SessionId; readonly terminalId: string; readonly exitCode: number; readonly signal: number | null }

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
  readonly terminal?: { readonly available: boolean; readonly reason?: string }
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
  | { readonly type: 'event'; readonly scope: 'connector'; readonly report: ConnectorRevisionReport }

export type SyncPayload =
  | { readonly type: 'sync'; readonly kind: 'heads'; readonly complete: boolean; readonly heads: readonly SessionJournalHead[] }
  | { readonly type: 'sync'; readonly kind: 'request'; readonly sessionId: SessionId; readonly fromSeq: EventSeq; readonly limit: number }
  | { readonly type: 'sync'; readonly kind: 'batch'; readonly sessionId: SessionId; readonly throughSeq: EventSeq; readonly hasMore: boolean; readonly events: readonly JournalEvent[] }
  | { readonly type: 'sync'; readonly kind: 'gap'; readonly sessionId: SessionId; readonly fromSeq: EventSeq; readonly reason: string }

export type ServerPayload =
  | HeartbeatPayload
  | CommandPayload
  | FileRequestPayload
  | TerminalRequestPayload
  | Extract<SyncPayload, { readonly kind: 'request' }>

export type WorkerPayload =
  | HeartbeatPayload
  | CapabilityPayload
  | CommandReceiptPayload
  | FileResponsePayload
  | TerminalResponsePayload
  | TerminalEventPayload
  | EventPayload
  | Exclude<SyncPayload, { readonly kind: 'request' }>

export type ProtocolPayload = ServerPayload | WorkerPayload

// Application-level idempotency keys remain in payloads; transport ordering,
// delivery identity, ACK and replay identity live only in transport-v2 frames.
export type ServerToWorker = ServerPayload
export type WorkerToServer = WorkerPayload
