import type { AuditEntryId, ProjectId, SessionId, TeamId, Timestamp, UserId, WorkerId, WorkspaceId } from '@wemux/domain'

export type AuditResource =
  | { readonly kind: 'team'; readonly id: TeamId }
  | { readonly kind: 'worker'; readonly id: WorkerId }
  | { readonly kind: 'project'; readonly id: ProjectId }
  | { readonly kind: 'workspace'; readonly id: WorkspaceId }
  | { readonly kind: 'session'; readonly id: SessionId }
  | { readonly kind: 'user'; readonly id: UserId }

export interface AuditEntry {
  readonly id: AuditEntryId
  readonly actorId: UserId | null
  readonly action: string
  readonly resource: AuditResource
  readonly result: 'succeeded' | 'failed'
  readonly occurredAt: Timestamp
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>
}

export interface AuditQuery {
  /** Internal visibility filter: actor, target user resource, or metadata.userId. Never accepted as an arbitrary public override. */
  readonly subjectUserId?: UserId
  readonly actorId?: UserId
  readonly action?: string
  readonly resourceKind?: AuditResource['kind']
  readonly resourceId?: string
  readonly result?: AuditEntry['result']
  readonly from?: Timestamp
  readonly to?: Timestamp
  readonly cursor?: string
  readonly limit: number
}

export interface AuditPage {
  readonly items: readonly AuditEntry[]
  readonly nextCursor: string | null
}
