import type { SessionForkId, SessionId, UserId } from './ids.js'
import type { Timestamp } from './values.js'

/**
 * C0 freeze: the lineage value objects live here, with no renderer, transport or
 * host dependency. `@xyflow/react` node/edge types, HTTP DTOs and SQLite rows
 * must never appear in this file.
 */

export const sessionForkContextPolicies = ['through_cursor', 'summary', 'explicit_selection'] as const

/**
 * How much of the source Session seeds the target. The cursor stays authoritative
 * regardless of policy: source events accepted after the Fork never leak in.
 */
export type SessionForkContextPolicy = (typeof sessionForkContextPolicies)[number]

/**
 * Durable Fork fact. Creating it, creating the target Session, snapshotting the
 * binding and writing this row are one application transaction; a failure leaves
 * neither an orphan target nor a dangling edge.
 */
export interface SessionFork {
  readonly id: SessionForkId
  readonly sourceSessionId: SessionId
  /** Highest source event sequence already durable when the Fork was accepted. */
  readonly sourceEventCursor: number
  readonly targetSessionId: SessionId
  readonly createdBy: UserId
  readonly createdAt: Timestamp
  readonly contextPolicy: SessionForkContextPolicy
}

/** The public, serializable projection of a SessionFork: what a lineage query returns per edge. */
export interface SessionForkPoint {
  readonly forkId: SessionForkId
  readonly sourceSessionId: SessionId
  readonly sourceEventCursor: number
  readonly targetSessionId: SessionId
}

/** Relation kinds the Session graph may project. Closed union, never a free-form string. */
export const sessionRelationKinds = ['fork', 'delegation', 'artifact_reference', 'run_attachment'] as const

export type SessionRelationKind = (typeof sessionRelationKinds)[number]

export interface SessionForkRelation {
  readonly type: 'fork'
  readonly forkId: SessionForkId
}

/**
 * C0 freezes `fork`; the union is closed on purpose so no caller can invent a
 * relation kind that bypasses authorization, audit and lifecycle rules. Ticket 23
 * adds the `delegation`, `artifact_reference` and `run_attachment` payloads after
 * the orchestration contract exists. `sessionRelationKinds` already lists them so
 * readers reject unknown kinds instead of guessing.
 */
export type SessionRelation = SessionForkRelation

export const isSessionRelationKind = (value: unknown): value is SessionRelationKind =>
  typeof value === 'string' && (sessionRelationKinds as readonly string[]).includes(value)

export const isSessionForkContextPolicy = (value: unknown): value is SessionForkContextPolicy =>
  typeof value === 'string' && (sessionForkContextPolicies as readonly string[]).includes(value)

/** Invariant: a Fork never targets its own source, so target and source stay independent. */
export function assertForkTargetsAnotherSession(fork: Pick<SessionFork, 'sourceSessionId' | 'targetSessionId'>): void {
  if (fork.sourceSessionId === fork.targetSessionId) throw new Error('Session Fork target must differ from its source')
}

/** Invariant: the cursor is a real durable boundary, never a position ahead of the Journal. */
export function assertForkCursorIsDurable(sourceEventCursor: number, durableThroughSeq: number): void {
  if (!Number.isInteger(sourceEventCursor) || sourceEventCursor < 0) throw new Error('Session Fork cursor must be a non-negative integer')
  if (sourceEventCursor > durableThroughSeq) throw new Error(`Session Fork cursor ${sourceEventCursor} is ahead of durable sequence ${durableThroughSeq}`)
}