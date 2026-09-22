import type { SessionGraphNode, SessionGraphSnapshot } from '@wemux/web-contract/session-graph'

export interface SessionCanvasNode extends SessionGraphNode {
  readonly column: number
  readonly selected: boolean
}

export interface SessionCanvasProjection {
  readonly revision: string
  readonly nodes: readonly SessionCanvasNode[]
  readonly columns: readonly (readonly SessionCanvasNode[])[]
  readonly edges: SessionGraphSnapshot['edges']
  readonly hiddenRelationCount: number | null
}

/**
 * 把 Server 权威血缘图投影成稳定的列布局。这里只决定呈现顺序，绝不补写边、摘要或权限事实。
 * 没有祖先的节点从第 0 列开始；Fork 目标位于来源后一列；断开的子图按 Session id 稳定排序。
 */
export function deriveSessionCanvas(graph: SessionGraphSnapshot, selectedSessionId: string): SessionCanvasProjection {
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
  const nodes = graph.nodes
    .map(node => ({ ...node, column: depthOf(node.sessionId), selected: node.sessionId === selectedSessionId }))
    .sort((left, right) => left.column - right.column || Number(left.visibility === 'placeholder') - Number(right.visibility === 'placeholder') || visibleTitle(left).localeCompare(visibleTitle(right), 'zh-CN') || left.sessionId.localeCompare(right.sessionId))
  const columns: SessionCanvasNode[][] = []
  for (const node of nodes) (columns[node.column] ??= []).push(node)
  return { revision: graph.revision, nodes, columns, edges: graph.edges, hiddenRelationCount: graph.hiddenRelationCount }
}

const visibleTitle = (node: SessionGraphNode): string => node.visibility === 'visible' ? node.summary!.title : ''
