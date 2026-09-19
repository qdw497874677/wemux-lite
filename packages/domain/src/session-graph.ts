import type { ProjectId, SessionId, WorkerId, WorkspaceId } from './ids.js'
import { assertForkTargetsAnotherSession, type SessionForkContextPolicy, type SessionForkPoint, type SessionRelation } from './session-lineage.js'
import type { SessionRuntimeState } from './session.js'
import type { AgentKey, ModelId, Timestamp } from './values.js'

/**
 * C0 freeze: the graph read model is application-facing and transport-neutral.
 * React Flow `Node`/`Edge` must never appear here, and neither may HTTP envelopes,
 * SQLite rows or transport cursors. `apps/web/src/features/session-canvas/adapters/react-flow`
 * is the only place allowed to translate this shape into renderer types.
 */

/**
 * `placeholder` means the viewer may know the Session exists without reading its
 * title, branch count or members. Callers must treat a missing summary as "do not
 * render content", never as "not yet loaded" and never retry for it.
 */
export const sessionGraphNodeVisibilities = ['visible', 'placeholder'] as const

export type SessionGraphNodeVisibility = (typeof sessionGraphNodeVisibilities)[number]

export interface SessionGraphNodeSummary {
  readonly title: string
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly agentKey: AgentKey
  /** Null means the Agent runtime uses its own default model. */
  readonly modelId: ModelId | null
  readonly runtimeState: SessionRuntimeState
  /**
   * Newest durable event time, or null when the Session has no durable events yet.
   * C1 amendment: a Session carries no creation timestamp, so a fabricated value here
   * would make the graph lie about activity. Renderers must omit relative time when null.
   */
  readonly lastActivityAt: Timestamp | null
  /** Number of outbound Fork relations the viewer may see; never a global count. */
  readonly branchCount: number
}

export interface SessionGraphNode {
  readonly sessionId: SessionId
  readonly visibility: SessionGraphNodeVisibility
  /** Present only when `visibility` is `visible`. */
  readonly summary: SessionGraphNodeSummary | null
}

export interface SessionGraphEdge {
  /** Stable identity for renderer keys and incremental diffing: `fork:<forkId>`. */
  readonly key: string
  readonly relation: SessionRelation
  readonly sourceSessionId: SessionId
  readonly targetSessionId: SessionId
}

/**
 * Application read model. `revision` is the Server-authoritative graph revision:
 * clients may compare it for staleness but never merge graph facts locally.
 */
export interface SessionGraphSnapshot {
  readonly revision: string
  readonly nodes: readonly SessionGraphNode[]
  readonly edges: readonly SessionGraphEdge[]
  /**
   * Relations withheld by authorization. Only populated when revealing the count
   * is not a side channel; otherwise the Server reports `null`.
   */
  readonly hiddenRelationCount: number | null
}

export interface SessionGraphQuery {
  readonly projectId: ProjectId
  /** Omit to query the whole Project graph; provide a Session to center the query. */
  readonly rootSessionId?: SessionId
  /** Traversal depth from the root; ignored without a root. */
  readonly depth?: number
  /** Upper bound on returned nodes so one request cannot materialize a huge graph. */
  readonly nodeLimit?: number
}

export interface ForkSessionCommand {
  readonly sourceSessionId: SessionId
  /** Explicit boundary: source events at or below this sequence seed the target. */
  readonly sourceEventCursor?: number
  readonly contextPolicy?: SessionForkContextPolicy
  readonly targetWorkspaceId: WorkspaceId
  readonly targetWorkerId: WorkerId
  readonly targetAgentKey: AgentKey
  readonly targetModelId: ModelId | null
  /** Caller-supplied idempotency key; a retried Fork must not create a second Session. */
  readonly requestId: string
}

export interface ForkSessionResult {
  readonly fork: SessionForkPoint
  readonly targetSessionId: SessionId
  readonly graphRevision: string
  /** True when the same `requestId` already produced this Fork. */
  readonly replayed: boolean
}

/** Invariant: a visible node always carries a summary, a placeholder never does. */
export function assertNodeVisibilityIsHonest(node: SessionGraphNode): void {
  if (node.visibility === 'visible' && node.summary === null) throw new Error('Visible Session graph node requires a summary')
  if (node.visibility === 'placeholder' && node.summary !== null) throw new Error('Placeholder Session graph node must not carry a summary')
}

/** Invariant: an edge is only returned when both endpoints are in the same snapshot. */
export function assertEdgesReferenceReturnedNodes(snapshot: SessionGraphSnapshot): void {
  const returned = new Set(snapshot.nodes.map(node => node.sessionId))
  for (const edge of snapshot.edges) {
    if (!returned.has(edge.sourceSessionId) || !returned.has(edge.targetSessionId)) throw new Error(`Session graph edge ${edge.key} references a node outside the snapshot`)
    assertForkTargetsAnotherSession(edge)
  }
}