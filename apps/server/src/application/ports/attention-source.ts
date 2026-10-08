import type { ProjectId, UserId } from '@wemux/domain'

export interface AttentionApprovalSourceItem {
  readonly reviewId: string
  readonly taskId: string
  readonly runId: string
  readonly projectId: ProjectId
  readonly title: string
  readonly requestedAt: string
}

export interface AttentionApprovalSourcePageQuery extends AttentionSourcePageQuery {
  readonly actorId: UserId
}

export interface AttentionTaskSourceItem {
  readonly taskId: string
  readonly projectId: ProjectId
  readonly title: string
  readonly status: 'in_progress' | 'in_review'
  readonly assigneeUserIds: readonly UserId[]
}

export interface AttentionRunSourceItem {
  readonly runId: string
  readonly taskId: string
  readonly projectId: ProjectId
  readonly title: string
  readonly status: 'blocked' | 'failed'
  readonly createdBy: UserId | null
}

export interface AttentionDeadLetterSourceItem {
  readonly id: string
  readonly projectId: ProjectId
  readonly title: string
  readonly detail: string
}

export interface AttentionSourcePageQuery {
  /** Already authorized by the caller, intersected with any requested Project filter. Empty means no access. */
  readonly authorizedProjectIds: readonly ProjectId[]
  /** Defaults to 50; only integers from 1 to 100 are accepted. */
  readonly limit?: number
  /** Opaque source-specific cursor returned by the preceding page. Invalid cursors are rejected. */
  readonly cursor?: string
}

export interface AttentionRunSourcePageQuery extends AttentionSourcePageQuery {
  /** The authenticated actor, matched only against the Run's enqueue-command submitter. */
  readonly actorId: UserId
}

export interface AttentionDeadLetterSourceQuery {
  readonly actorId: UserId
  readonly authorizedProjectIds: readonly ProjectId[]
}

export interface AttentionDeadLetterSourcePageQuery extends AttentionSourcePageQuery, AttentionDeadLetterSourceQuery {}

export interface AttentionSourcePage<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

export interface AttentionSourcePort {
  /** Human Task reviews only. Enforce current owner/member-manager, not submitter,
   * and current Task/Review/Run eligibility before lookahead or cursor creation.
   * requestedAt DESC, review id ASC; no snapshot across requests. */
  listApprovalsPage(query: AttentionApprovalSourcePageQuery): Promise<AttentionSourcePage<AttentionApprovalSourceItem>>
  /**
   * Failed Runs only, ordered by persisted finishedAt (falling back to createdAt, then an empty
   * string for legacy missing timestamps) DESC and id ASC, using SQLite binary text order.
   * Strict seek pages return at most limit items with one bounded lookahead row. No snapshot
   * across requests: timestamp/status changes can move items; unchanged rows have no gaps.
   */
  listRunsPage(query: AttentionRunSourcePageQuery): Promise<AttentionSourcePage<AttentionRunSourceItem>>
  /**
   * Administrator-only: the service must authorize the actor before calling this method.
   * No caller-supplied admin flag grants access. Sources must enforce current Project
   * manager/owner and Session read authority before selecting rows or creating cursors.
   * Ordered by persisted updated_at DESC and id ASC, with the same seek/limit semantics.
   */
  listDeadLettersPage(query: AttentionDeadLetterSourcePageQuery): Promise<AttentionSourcePage<AttentionDeadLetterSourceItem>>
  listTasks(): Promise<readonly AttentionTaskSourceItem[]>
  listRuns(): Promise<readonly AttentionRunSourceItem[]>
  /** Same administrator and resource-authority contract as listDeadLettersPage, for grouped counts. */
  listDeadLetters(query: AttentionDeadLetterSourceQuery): Promise<readonly AttentionDeadLetterSourceItem[]>
}
