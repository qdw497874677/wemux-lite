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
