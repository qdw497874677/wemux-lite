import type { SessionId } from './ids.js'

/**
 * C0 freeze: layout is presentation data continuously persisted from a viewer's
 * canvas. It never carries lineage, authorization or Session state, and a stale
 * layout write must never overwrite a newer relation.
 */

/** A layout belongs either to one viewer or to the project default. */
export const canvasLayoutScopes = ['personal', 'project'] as const

export type CanvasLayoutScope = (typeof canvasLayoutScopes)[number]

export interface CanvasNodePosition {
  readonly x: number
  readonly y: number
}

export interface CanvasViewport {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

export interface CanvasLayout {
  readonly scope: CanvasLayoutScope
  /** Graph revision this layout was computed against; writes against a stale revision are rejected. */
  readonly graphRevision: string
  /**
   * Keyed by `SessionId`. Keys stay plain strings because this payload round-trips
   * through JSON, where branded keys cannot be recovered without a cast.
   */
  readonly nodePositions: Readonly<Record<string, CanvasNodePosition>>
  readonly collapsedGroups: readonly string[]
  readonly viewport: CanvasViewport
}

/** Typed read access for callers that already hold a `SessionId`. */
export function nodePosition(layout: CanvasLayout, sessionId: SessionId): CanvasNodePosition | null {
  return layout.nodePositions[sessionId] ?? null
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isPosition = (value: unknown): value is CanvasNodePosition => {
  if (typeof value !== 'object' || value === null) return false
  const position = value as Record<string, unknown>
  return isFiniteNumber(position.x) && isFiniteNumber(position.y)
}

const isViewport = (value: unknown): value is CanvasViewport => {
  if (typeof value !== 'object' || value === null) return false
  const viewport = value as Record<string, unknown>
  return isFiniteNumber(viewport.x) && isFiniteNumber(viewport.y) && isFiniteNumber(viewport.zoom)
    && viewport.zoom > 0
}

/** Layout is an untrusted client payload: reject anything that is not storable as-is. */
export function isCanvasLayout(value: unknown): value is CanvasLayout {
  if (typeof value !== 'object' || value === null) return false
  const layout = value as Record<string, unknown>
  if (!(canvasLayoutScopes as readonly unknown[]).includes(layout.scope)) return false
  if (typeof layout.graphRevision !== 'string' || !layout.graphRevision) return false
  if (typeof layout.nodePositions !== 'object' || layout.nodePositions === null || Array.isArray(layout.nodePositions)) return false
  if (!Object.values(layout.nodePositions as Record<string, unknown>).every(isPosition)) return false
  if (!Array.isArray(layout.collapsedGroups) || !layout.collapsedGroups.every(group => typeof group === 'string')) return false
  return isViewport(layout.viewport)
}

export const isCanvasLayoutScope = (value: unknown): value is CanvasLayoutScope =>
  typeof value === 'string' && (canvasLayoutScopes as readonly string[]).includes(value)