import type {
  EventSeq,
  ModelId,
  SessionId,
  SessionRuntimeState,
  Timestamp,
  TurnId,
  WorkerId,
  WorkspaceId,
} from '@wemux/domain'

export type SessionFreshness =
  | { readonly status: 'unknown' }
  | { readonly status: 'syncing'; readonly workerLastSeq: EventSeq | null }
  | { readonly status: 'synced'; readonly throughSeq: EventSeq }
  | { readonly status: 'gap'; readonly contiguousSeq: EventSeq; readonly workerLastSeq: EventSeq }
  | { readonly status: 'offline'; readonly cachedThroughSeq: EventSeq }
  | { readonly status: 'orphaned'; readonly cachedThroughSeq: EventSeq }

export interface SessionSummaryView {
  readonly id: SessionId
  readonly title: string
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly agentKey: string
  readonly modelId: ModelId
  readonly runtimeState: SessionRuntimeState
  readonly activeTurnId: TurnId | null
  readonly queuedMessageCount: number
  readonly freshness: SessionFreshness
  readonly updatedAt: Timestamp
  readonly canRead: boolean
  readonly canSend: boolean
  readonly canManage: boolean
}
