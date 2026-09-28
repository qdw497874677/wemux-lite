import type {
  ApprovalId,
  CommandId,
  EventSeq,
  JournalEvent,
  ProjectId,
  SessionId,
  Timestamp,
  TurnId,
  UserId,
  WorkerId,
} from '@wemux/domain'

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

export interface CursorPage<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

export type ProjectionFreshness =
  | { readonly status: 'current'; readonly observedAt: Timestamp }
  | { readonly status: 'syncing' | 'stale' | 'offline' | 'unavailable'; readonly observedAt: Timestamp; readonly detail: string | null }

export type ApprovalSource =
  | { readonly kind: 'session_tool'; readonly sessionId: SessionId; readonly turnId: TurnId; readonly approvalId: ApprovalId }
  | { readonly kind: 'connector_call'; readonly sessionId: SessionId; readonly requestId: string }
  | { readonly kind: 'task_review'; readonly taskId: string; readonly runId: string; readonly reviewId: string }
  | { readonly kind: 'channel_governance'; readonly channelId: string; readonly operationId: string }

export type ApprovalProjectionStatus = 'pending' | 'approved' | 'denied' | 'changes_requested' | 'expired' | 'unavailable'
export type ApprovalDecision = 'approve' | 'deny' | 'changes_requested'

export interface ProjectionActor {
  readonly kind: 'user' | 'agent' | 'channel' | 'system'
  readonly id: string | null
  readonly label: string
}

export interface ApprovalView {
  readonly projectionKey: string
  readonly projectId: ProjectId
  readonly source: ApprovalSource
  readonly status: ApprovalProjectionStatus
  readonly title: string
  readonly reason: string | null
  readonly requestedBy: Omit<ProjectionActor, 'label'>
  readonly requestedAt: Timestamp
  readonly decidedAt: Timestamp | null
  readonly decisionCapabilities: readonly ApprovalDecision[]
  readonly sourceRevision: string
  readonly freshness: ProjectionFreshness
}

export interface ApprovalQuery {
  readonly projectId?: ProjectId
  readonly status?: ApprovalProjectionStatus
  readonly sourceKind?: ApprovalSource['kind']
  readonly cursor?: string
  readonly limit?: number
}

export type ApprovalPage = CursorPage<ApprovalView>

/** Reserved F1 seam for G50. Batch one deliberately returns an empty page. */
export interface AttentionView {
  readonly projectionKey: string
  readonly projectId: ProjectId
  readonly occurredAt: Timestamp
  readonly freshness: ProjectionFreshness
}
export interface AttentionQuery {
  readonly projectId?: ProjectId
  readonly status?: ApprovalProjectionStatus
  readonly cursor?: string
  readonly limit?: number
}
export type AttentionPage = CursorPage<AttentionView>

export type TimelineSourceKind = 'audit' | 'task_activity' | 'run' | 'channel_delivery' | 'session'
export interface TimelineEvent {
  readonly cursor: string
  readonly sourceKind: TimelineSourceKind
  readonly sourceId: string
  readonly sourceKey: string
  readonly occurredAt: Timestamp
  readonly projectId: ProjectId | null
  readonly actor: ProjectionActor
  readonly action: string
  readonly subject: { readonly kind: string; readonly id: string; readonly label: string }
  readonly summary: string
  readonly result: 'succeeded' | 'failed' | 'informational'
  readonly href: string | null
  readonly freshness: ProjectionFreshness
}

export interface TimelineQuery {
  readonly projectId?: ProjectId
  readonly sourceKind?: TimelineSourceKind
  readonly actorKind?: ProjectionActor['kind']
  readonly actorId?: string
  readonly subjectKind?: string
  readonly from?: Timestamp
  readonly to?: Timestamp
  readonly cursor?: string
  readonly limit?: number
}
export type TimelinePage = CursorPage<TimelineEvent>

export interface CrossEntityProjectionPort {
  approvals(actorId: UserId, query: ApprovalQuery): Promise<ApprovalPage>
  approval(actorId: UserId, projectionKey: string): Promise<ApprovalView | null>
  attention(actorId: UserId, query: AttentionQuery): Promise<AttentionPage>
  timeline(actorId: UserId, query: TimelineQuery): Promise<TimelinePage>
}

export interface ApprovalDecisionInput {
  readonly requestId: string
  readonly fingerprint: string
  readonly sourceRevision: string
  readonly decision: ApprovalDecision
  readonly note?: string
}
export interface ApprovalDecisionResult {
  readonly approval: ApprovalView
  readonly replayed: boolean
}
export interface ApprovalDecisionPort {
  decide(actorId: UserId, projectionKey: string, input: ApprovalDecisionInput): Promise<ApprovalDecisionResult>
}
