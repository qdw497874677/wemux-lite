import test from 'node:test'
import assert from 'node:assert/strict'
import { canvasColumnGap, canvasRowGap, layoutSessionGraph } from '../src/lib/session-canvas-layout.ts'

const summary = overrides => ({ title: '会话', projectId: 'p', workspaceId: 'w', workerId: 'worker', agentKey: 'agent', modelId: null, runtimeState: 'idle', lastActivityAt: null, branchCount: 0, ...overrides })
const visible = (sessionId, title, overrides) => ({ sessionId, visibility: 'visible', summary: summary({ title, ...overrides }) })
const placeholder = sessionId => ({ sessionId, visibility: 'placeholder', summary: null })
const fork = (sourceSessionId, targetSessionId, forkId) => ({ key: `fork:${forkId}`, relation: { type: 'fork', forkId }, sourceSessionId, targetSessionId })
const graph = (nodes, edges) => ({ revision: 'g0', nodes, edges, hiddenRelationCount: null })
const packed = layout => layout.nodes.map(node => [node.node.sessionId, node.column, node.row, node.x, node.y])

test('按血缘深度分列，位置由列行确定且不依赖输入顺序', () => {
  const nodes = [visible('a', 'A'), visible('b', 'B'), visible('c', 'C')]
  const edges = [fork('a', 'b', 'f1'), fork('b', 'c', 'f2')]
  const layout = layoutSessionGraph(graph(nodes, edges))
  assert.deepEqual(packed(layout), [['a', 0, 0, 0, 0], ['b', 1, 0, canvasColumnGap, 0], ['c', 2, 0, canvasColumnGap * 2, 0]])
  assert.equal(layout.columns, 3)
  assert.equal(layout.width, canvasColumnGap * 3)
  assert.equal(layout.height, canvasRowGap)
  assert.deepEqual(layout.edges.map(edge => [edge.edge.key, edge.source.node.sessionId, edge.target.node.sessionId]), [['fork:f1', 'a', 'b'], ['fork:f2', 'b', 'c']])
  const reversed = layoutSessionGraph(graph([...nodes].reverse(), [...edges].reverse()))
  assert.deepEqual(packed(reversed), packed(layout))
  assert.deepEqual(reversed.edges.map(edge => edge.edge.key), ['fork:f1', 'fork:f2'])
})

test('同列按标题排序、标题相同按会话标识排序，受限节点排在最后且不带标题', () => {
  const nodes = [visible('r', '根'), visible('z', '乙分支'), visible('j', '甲分支'), visible('j2', '甲分支'), placeholder('h')]
  const edges = [fork('r', 'z', 'f1'), fork('r', 'j', 'f2'), fork('r', 'j2', 'f3'), fork('r', 'h', 'f4')]
  const layout = layoutSessionGraph(graph(nodes, edges))
  const column = layout.nodes.filter(node => node.column === 1)
  assert.deepEqual(column.map(node => node.node.sessionId), ['j', 'j2', 'z', 'h'])
  assert.deepEqual(column.map(node => node.row), [0, 1, 2, 3])
  assert.deepEqual(column.map(node => node.y), [0, canvasRowGap, canvasRowGap * 2, canvasRowGap * 3])
  assert.equal(column[3].node.visibility, 'placeholder')
  assert.equal(column[3].node.summary, null)
  assert.equal(layout.height, canvasRowGap * 4)
})

test('环形关系终止且不产生无限深度；无根环与空图都有确定结果', () => {
  const cycle = layoutSessionGraph(graph([visible('r', '根'), visible('a', 'A'), visible('b', 'B')], [fork('r', 'a', 'f1'), fork('a', 'b', 'f2'), fork('b', 'a', 'f3')]))
  assert.deepEqual(packed(cycle), [['r', 0, 0, 0, 0], ['a', 1, 0, canvasColumnGap, 0], ['b', 2, 0, canvasColumnGap * 2, 0]])
  const ring = layoutSessionGraph(graph([visible('a', 'A'), visible('b', 'B')], [fork('a', 'b', 'f1'), fork('b', 'a', 'f2')]))
  assert.deepEqual(ring.nodes.map(node => [node.node.sessionId, node.column]), [['a', 0], ['b', 0]])
  assert.deepEqual(ring.edges.map(edge => edge.edge.key), ['fork:f1', 'fork:f2'])
  const empty = layoutSessionGraph(graph([], []))
  assert.deepEqual([empty.nodes, empty.edges, empty.columns, empty.width, empty.height], [[], [], 0, 0, 0])
})

test('缺少端点的边不会被画出，也不会改变布局尺寸', () => {
  const layout = layoutSessionGraph(graph([visible('a', 'A')], [fork('a', 'missing', 'f1')]))
  assert.deepEqual(packed(layout), [['a', 0, 0, 0, 0]])
  assert.deepEqual(layout.edges, [])
  assert.equal(layout.width, canvasColumnGap)
})
