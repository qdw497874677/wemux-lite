/**
 * C0 freeze: wire DTOs for Session graph queries, Fork commands and layout persistence.
 * Types are re-exported from `@wemux/domain` (the single source) and wrapped only where a
 * wire envelope differs. No `@xyflow/react` type may appear in this file.
 */
import type {
  CanvasLayout,
  CanvasLayoutScope,
  SessionForkContextPolicy,
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

/**
 * `POST /api/projects/:projectId/session-forks`
 *
 * 浏览器 DTO 与其它 web-contract 请求一致使用纯字符串标识：品牌标识只属于领域命令，
 * 由服务端在 `parseForkCommand` 处解释与校验。JSON 形状与领域命令完全相同，
 * 因此这里收窄标识类型不会改变线上协议，也不会让调用方为了构造请求而做类型断言。
 */
export interface SessionForkRequest {
  readonly sourceSessionId: string
  /** 固定边界：来源会话中序号不超过该值的事件才进入目标上下文。 */
  readonly sourceEventCursor?: number
  readonly contextPolicy?: SessionForkContextPolicy
  readonly targetWorkspaceId: string
  readonly targetWorkerId: string
  readonly targetAgentKey: string
  readonly targetModelId: string | null
  /** 调用方生成的幂等键：重试不得创建第二个会话。 */
  readonly requestId: string
}

export interface SessionForkResponse {
  readonly fork: SessionForkPoint
  readonly targetSessionId: string
  readonly graphRevision: string
  /** True when the same `requestId` already produced this Fork. */
  readonly replayed: boolean
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