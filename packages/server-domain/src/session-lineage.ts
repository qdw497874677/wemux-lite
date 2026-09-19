import type { ProjectId, SessionForkContextPolicy, SessionForkId, SessionId, Timestamp, UserId } from '@wemux/domain'

/**
 * C0 freeze: Server-side lineage records and the authorization association the graph
 * layer needs. No renderer, transport or HTTP type may enter this file; the domain
 * value objects stay in `@wemux/domain` and this file only adds persistence identity.
 */

/**
 * Durable Session Fork row. Written in the same application transaction that creates
 * the target Session and snapshots its binding, so a failed Fork leaves neither an
 * orphan target nor a dangling edge.
 */
export interface SessionForkRecord {
  readonly id: SessionForkId
  /**
   * Owning Project. Graph queries, layout scope and authorization are all decided per
   * Project, so every edge resolves to one Project without re-reading both Sessions.
   */
  readonly projectId: ProjectId
  readonly sourceSessionId: SessionId
  readonly sourceEventCursor: number
  readonly targetSessionId: SessionId
  readonly createdBy: UserId
  readonly createdAt: Timestamp
  readonly contextPolicy: SessionForkContextPolicy
  /**
   * Durable idempotency identity, following the existing `Session.creation` pattern.
   * `fingerprint` binds the request to one target binding, so a retried Fork whose
   * payload changed is rejected instead of silently reusing the first target.
   */
  readonly creation: {
    readonly requestId: string
    readonly fingerprint: string
  }
}

/**
 * What the Authorization Module is asked to decide for a graph read. Callers submit
 * operator and target only; they never re-implement the Grant intersection.
 */
export interface SessionLineageAuthorizationTarget {
  readonly projectId: ProjectId
  readonly sessionIds: readonly SessionId[]
}

/**
 * Per-node authorization outcome. `placeholder` keeps the node visible without
 * exposing title, members or summary, and never carries a partial summary.
 */
export type SessionLineageNodeDecision = 'visible' | 'placeholder' | 'omitted'

/**
 * Lineage never widens access: the target Session's effective access is the
 * intersection of Project, target Workspace, target Worker and explicit Session
 * policy. Callers must use this helper rather than re-deriving the rule.
 */
export function narrowForkAccess(sourceDecision: SessionLineageNodeDecision, targetDecision: SessionLineageNodeDecision): SessionLineageNodeDecision {
  if (sourceDecision === 'omitted' || targetDecision === 'omitted') return 'omitted'
  if (sourceDecision === 'placeholder' || targetDecision === 'placeholder') return 'placeholder'
  return 'visible'
}