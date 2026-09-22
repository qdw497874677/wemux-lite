import type { SessionGraphNode, SessionGraphSnapshot } from '@wemux/web-contract/session-graph'

export interface CanvasPoint {
  readonly x: number
  readonly y: number
}

export interface SessionCanvasProjectionNode extends SessionGraphNode {
  readonly position: CanvasPoint
  readonly selected: boolean
}

export interface SessionCanvasProjectionEdge {
  readonly key: string
  readonly sourceSessionId: string
  readonly targetSessionId: string
  readonly forkId: string
}

export interface SessionCanvasProjection {
  readonly revision: string
  readonly nodes: readonly SessionCanvasProjectionNode[]
  readonly edges: readonly SessionCanvasProjectionEdge[]
  readonly hiddenRelationCount: number | null
}

const columnGap = 360
const rowGap = 176

/**
 * Canvas Projection Module: maps Server-authoritative graph facts to renderer-neutral
 * positions and presentation flags. It does not infer authorization or relations from UI metadata.
 */
export function projectSessionGraph(graph: SessionGraphSnapshot, selectedSessionId: string, savedPositions: Readonly<Record<string, CanvasPoint>> = {}): SessionCanvasProjection {
  const byId = new Map(graph.nodes.map(node => [node.sessionId, node]))
  const parents = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!byId.has(edge.sourceSessionId) || !byId.has(edge.targetSessionId)) continue
    parents.set(edge.targetSessionId, [...(parents.get(edge.targetSessionId) ?? []), edge.sourceSessionId])
  }

  const resolving = new Set<string>()
  const depths = new Map<string, number>()
  const depthOf = (sessionId: string): number => {
    const known = depths.get(sessionId)
    if (known !== undefined) return known
    if (resolving.has(sessionId)) return 0
    resolving.add(sessionId)
    const sources = parents.get(sessionId) ?? []
    const depth = sources.length === 0 ? 0 : 1 + Math.max(...sources.map(depthOf))
    resolving.delete(sessionId)
    depths.set(sessionId, depth)
    return depth
  }

  const ordered = [...graph.nodes].sort((left, right) => {
    const column = depthOf(left.sessionId) - depthOf(right.sessionId)
    if (column) return column
    const visibility = Number(left.visibility === 'placeholder') - Number(right.visibility === 'placeholder')
    if (visibility) return visibility
    return visibleTitle(left).localeCompare(visibleTitle(right), 'zh-CN') || left.sessionId.localeCompare(right.sessionId)
  })
  const rows = new Map<number, number>()
  const nodes = ordered.map(node => {
    const column = depthOf(node.sessionId)
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return {
      ...node,
      position: savedPositions[node.sessionId] ?? { x: column * columnGap, y: row * rowGap },
      selected: node.sessionId === selectedSessionId,
    }
  })

  return {
    revision: graph.revision,
    nodes,
    edges: graph.edges.map(edge => ({
      key: edge.key,
      sourceSessionId: edge.sourceSessionId,
      targetSessionId: edge.targetSessionId,
      forkId: edge.relation.forkId,
    })),
    hiddenRelationCount: graph.hiddenRelationCount,
  }
}

const visibleTitle = (node: SessionGraphNode): string => node.visibility === 'visible' ? node.summary!.title : ''
