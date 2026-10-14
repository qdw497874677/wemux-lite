// 画布投影的确定性布局：只把后端给出的图快照摆成列，不发任何领域写命令。
// 第一版不做自由拖动与持久化布局，位置完全由图事实推出，因此刷新与重连不会让画布漂移。
import type { SessionGraphEdge, SessionGraphNode, SessionGraphSnapshot } from '@wemux/web-contract/session-graph'

export const canvasNodeWidth = 208
export const canvasNodeHeight = 96
export const canvasColumnGap = 280
export const canvasRowGap = 120

export interface CanvasLayoutNode {
  readonly node: SessionGraphNode
  readonly column: number
  readonly row: number
  readonly x: number
  readonly y: number
}

export interface CanvasLayoutEdge {
  readonly edge: SessionGraphEdge
  readonly source: CanvasLayoutNode
  readonly target: CanvasLayoutNode
}

export interface CanvasLayout {
  readonly nodes: readonly CanvasLayoutNode[]
  readonly edges: readonly CanvasLayoutEdge[]
  readonly columns: number
  readonly rows: number
  readonly width: number
  readonly height: number
}

function depthOf(nodes: readonly SessionGraphNode[], edges: readonly SessionGraphEdge[]): Map<string, number> {
  const known = new Set(nodes.map(node => node.sessionId))
  const outgoing = new Map<string, string[]>()
  const incoming = new Set<string>()
  for (const edge of edges) {
    if (!known.has(edge.sourceSessionId) || !known.has(edge.targetSessionId)) continue
    const list = outgoing.get(edge.sourceSessionId)
    if (list) list.push(edge.targetSessionId)
    else outgoing.set(edge.sourceSessionId, [edge.targetSessionId])
    incoming.add(edge.targetSessionId)
  }
  const depth = new Map<string, number>()
  const placed = new Set<string>()
  // 从没有任何入边的节点出发按最短距离分列：环上的节点保留首次落列的深度，深度不会无尽增长。
  const queue = nodes.map(node => node.sessionId).filter(id => !incoming.has(id)).sort().map(id => [id, 0] as const)
  for (let index = 0; index < queue.length; index += 1) {
    const [sessionId, distance] = queue[index]!
    if (placed.has(sessionId)) continue
    placed.add(sessionId)
    depth.set(sessionId, distance)
    for (const target of outgoing.get(sessionId) ?? []) {
      if (!placed.has(target)) queue.push([target, distance + 1])
    }
  }
  return depth
}

function titleOf(node: SessionGraphNode) {
  return node.visibility === 'visible' && node.summary ? node.summary.title : ''
}

export function layoutSessionGraph(graph: SessionGraphSnapshot): CanvasLayout {
  const depth = depthOf(graph.nodes, graph.edges)
  const ordered = [...graph.nodes].sort((left, right) => {
    const column = (depth.get(left.sessionId) ?? 0) - (depth.get(right.sessionId) ?? 0)
    if (column !== 0) return column
    // 受限节点排在可见节点之后：它们的标题不可知，不能参与标题排序。
    const restricted = (left.visibility === 'placeholder' ? 1 : 0) - (right.visibility === 'placeholder' ? 1 : 0)
    if (restricted !== 0) return restricted
    const title = titleOf(left).localeCompare(titleOf(right), 'zh-CN')
    return title !== 0 ? title : left.sessionId.localeCompare(right.sessionId)
  })
  const rows = new Map<number, number>()
  const nodes: CanvasLayoutNode[] = ordered.map(node => {
    const column = depth.get(node.sessionId) ?? 0
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return { node, column, row, x: column * canvasColumnGap, y: row * canvasRowGap }
  })
  const bySession = new Map(nodes.map(node => [node.node.sessionId, node]))
  const edges: CanvasLayoutEdge[] = graph.edges.flatMap(edge => {
    // 两端都可见才有边；悬空边直接丢弃，不画半截关系。
    const source = bySession.get(edge.sourceSessionId)
    const target = bySession.get(edge.targetSessionId)
    return source && target ? [{ edge, source, target }] : []
  })
  edges.sort((left, right) => compareEdges(left, right))
  const columns = new Set(nodes.map(node => node.column)).size
  const height = rows.size ? Math.max(...rows.values()) * canvasRowGap : 0
  return { nodes, edges, columns, rows: rows.size ? Math.max(...rows.values()) : 0, width: columns * canvasColumnGap, height }
}

function compareEdges(left: CanvasLayoutEdge, right: CanvasLayoutEdge) {
  for (const [a, b] of [
    [left.source.column, right.source.column],
    [left.source.row, right.source.row],
    [left.target.column, right.target.column],
    [left.target.row, right.target.row],
  ] as const) {
    if (a !== b) return a - b
  }
  return left.edge.key.localeCompare(right.edge.key)
}
