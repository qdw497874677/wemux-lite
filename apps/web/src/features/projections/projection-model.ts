export type FreshnessStatus = 'current' | 'syncing' | 'stale' | 'offline' | 'unavailable'
export interface ProjectionFreshness { readonly status: FreshnessStatus; readonly observedAt: string; readonly detail?: string }
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'changes_requested' | 'expired' | 'unavailable'
export type ApprovalSourceKind = 'session_tool' | 'connector_call' | 'task_review' | 'channel_governance'
export interface ApprovalView {
  readonly projectionKey: string; readonly projectId: string; readonly source: { readonly kind: ApprovalSourceKind; readonly [key: string]: string }
  readonly status: ApprovalStatus; readonly title: string; readonly reason: string | null; readonly requestedBy: { readonly kind: string; readonly id: string }
  readonly requestedAt: string; readonly decidedAt: string | null; readonly decisionCapabilities: readonly ('approve' | 'deny' | 'changes_requested')[]
  readonly sourceRevision: string; readonly freshness: ProjectionFreshness
}
export type TimelineSourceKind = 'audit' | 'task_activity' | 'run' | 'channel_delivery' | 'session'
export interface TimelineEvent {
  readonly cursor: string; readonly sourceKind: TimelineSourceKind; readonly sourceId: string; readonly sourceKey: string; readonly occurredAt: string; readonly projectId: string | null
  readonly actor: { readonly kind: string; readonly id: string | null; readonly label: string }; readonly action: string
  readonly subject: { readonly kind: string; readonly id: string; readonly label: string }; readonly summary: string
  readonly result: 'success' | 'failure' | 'informational'; readonly href: string | null; readonly freshness: ProjectionFreshness
}
export interface CursorPage<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
export interface ProjectionFilters { readonly projectId?: string; readonly sourceKind?: string; readonly status?: string }
