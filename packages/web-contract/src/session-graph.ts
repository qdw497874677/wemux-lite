/**
 * C0 freeze: wire DTOs for Session graph queries, Fork commands and layout persistence.
 * Types are re-exported from `@wemux/domain` (the single source) and wrapped only where a
 * wire envelope differs. No `@xyflow/react` type may appear in this file.
 */
import type {
  CanvasLayout,
  CanvasLayoutScope,
  ForkSessionCommand,
  ForkSessionResult,
  SessionForkPoint,
  SessionGraphNode,
  SessionGraphEdge,
  SessionGraphQuery,
  SessionGraphSnapshot,
} from '@wemux/domain'

export type {
  CanvasLayout,
  CanvasLayoutScope,
  CanvasNodePosition,
  CanvasViewport,
  ForkSessionCommand,
  ForkSessionResult,
  SessionFork,
  SessionForkContextPolicy,
  SessionForkPoint,
  SessionGraphEdge,
  SessionGraphNode,
  SessionGraphNodeSummary,
  SessionGraphNodeVisibility,
  SessionGraphQuery,
  SessionGraphSnapshot,
  SessionRelation,
  SessionRelationKind,
} from '@wemux/domain'

/** `GET /api/projects/:projectId/session-graph?rootSessionId=&depth=&nodeLimit=` */
export interface SessionGraphResponse {
  readonly graph: SessionGraphSnapshot
}

/** `GET /api/sessions/:sessionId/lineage`：祖先（由近及远）与直接子分支。 */
export interface SessionLineageResponse {
  readonly sessionId: string
  readonly ancestors: readonly SessionForkPoint[]
  readonly children: readonly SessionForkPoint[]
  readonly graphRevision: string
}

/** `GET /api/session-forks/:forkId` */
export interface SessionForkPointResponse {
  readonly fork: SessionForkPoint
  readonly graphRevision: string
}

/** `POST /api/projects/:projectId/session-forks` */
export interface SessionForkRequest extends Omit<ForkSessionCommand, 'sourceSessionId'> {
  readonly sourceSessionId: string
}

export interface SessionForkResponse extends Omit<ForkSessionResult, 'fork'> {
  readonly fork: SessionForkPoint
}

/** `GET /api/projects/:projectId/canvas-layout?scope=` */
export interface CanvasLayoutRequest {
  readonly projectId: string
  readonly scope: CanvasLayoutScope
}

export interface CanvasLayoutResponse {
  /** Null when the viewer has no saved layout for this scope yet. */
  readonly layout: CanvasLayout | null
  /** Server-authoritative graph revision the returned layout was saved against. */
  readonly graphRevision: string
}

/** `PUT /api/projects/:projectId/canvas-layout` with revision compare-and-swap. */
export interface CanvasLayoutSaveRequest {
  readonly scope: CanvasLayoutScope
  /** Must equal the current graph revision or the write is rejected as stale. */
  readonly graphRevision: string
  readonly layout: CanvasLayout
}

export interface CanvasLayoutSaveResponse {
  readonly graphRevision: string
  /** False when the payload equaled the stored layout and nothing was written. */
  readonly written: boolean
}

/** Layout writes fail closed on a stale revision instead of overwriting newer lineage. */
export type CanvasLayoutSaveError = 'stale_revision' | 'invalid_layout' | 'forbidden'