import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { projectSessionGraph } from '../src/features/session-canvas/model/session-canvas-projection.ts'

const visible = (sessionId, title, overrides = {}) => ({
  sessionId,
  visibility: 'visible',
  summary: {
    title,
    workspaceId: 'w-1',
    workerId: 'worker-1',
    agentKey: 'pi',
    modelId: 'gpt-5',
    runtimeState: 'idle',
    lastActivityAt: '2026-03-25T00:00:00.000Z',
    branchCount: 0,
  },
  ...overrides,
})

const graph = {
  revision: 'graph-1',
  nodes: [
    visible('s-root', '规划发布', { summary: { ...visible('x', 'x').summary, title: '规划发布', branchCount: 2 } }),
    visible('s-child', '修复部署'),
    { sessionId: 's-hidden', visibility: 'placeholder' },
  ],
  edges: [
    { key: 'fork-1', sourceSessionId: 's-root', targetSessionId: 's-child', relation: { type: 'fork', forkId: 'fork-1' } },
    { key: 'fork-2', sourceSessionId: 's-root', targetSessionId: 's-hidden', relation: { type: 'fork', forkId: 'fork-2' } },
  ],
  hiddenRelationCount: 1,
}

test('session graph projection is deterministic and preserves authoritative fork metadata', () => {
  const canvas = projectSessionGraph(graph, 's-child')
  assert.equal(canvas.revision, 'graph-1')
  assert.deepEqual(canvas.nodes.map(node => [node.sessionId, node.position]), [
    ['s-root', { x: 0, y: 0 }],
    ['s-child', { x: 360, y: 0 }],
    ['s-hidden', { x: 360, y: 176 }],
  ])
  assert.equal(canvas.nodes.find(node => node.sessionId === 's-child')?.selected, true)
  assert.deepEqual(canvas.edges[0], { key: 'fork-1', sourceSessionId: 's-root', targetSessionId: 's-child', forkId: 'fork-1' })
  assert.equal(canvas.hiddenRelationCount, 1)
})

test('saved local positions override automatic layout without changing graph facts', () => {
  const canvas = projectSessionGraph(graph, '', { 's-child': { x: 42, y: 84 } })
  assert.deepEqual(canvas.nodes.find(node => node.sessionId === 's-child')?.position, { x: 42, y: 84 })
  assert.equal(canvas.edges[0]?.forkId, 'fork-1')
})

test('React Flow adapter keeps authorization placeholders closed and relations read-only', async () => {
  const source = await readFile(new URL('../src/features/session-canvas/adapters/react-flow/react-flow-canvas.tsx', import.meta.url), 'utf8')
  assert.match(source, /@xyflow\/react/)
  assert.match(source, /MiniMap/)
  assert.match(source, /Controls/)
  assert.match(source, /Fork · \$\{edge\.forkId\}/)
  assert.match(source, /nodesConnectable=\{false\}/)
  assert.match(source, /data\.kind === 'placeholder'/)
  assert.match(source, /受限会话/)
  assert.doesNotMatch(source, /node\.summary\?\./)
})

test('canvas composes AI Elements workflow semantics, contextual toolbar and filters', async () => {
  const source = await readFile(new URL('../src/features/session-canvas/adapters/react-flow/react-flow-canvas.tsx', import.meta.url), 'utf8')
  for (const name of ['NodeHeader', 'NodeTitle', 'NodeDescription', 'NodeAction', 'NodeContent', 'NodeFooter', 'Toolbar', 'Panel']) assert.match(source, new RegExp(`<${name}`))
  assert.match(source, /展开对话/)
  assert.match(source, /打开专注会话/)
  assert.match(source, /复制会话 ID/)
  assert.match(source, /仅活跃/)
  assert.match(source, /仅 Fork/)
  assert.match(source, /AiEdge\.Animated/)
  assert.match(source, /AiEdge\.Temporary/)
  assert.match(source, /const handles = \{ target: incoming\.has\(node\.sessionId\), source: outgoing\.has\(node\.sessionId\) \}/)
})

test('canvas shell contains an error boundary and non-canvas session fallback', async () => {
  const source = await readFile(new URL('../src/features/session-canvas/session-canvas.tsx', import.meta.url), 'utf8')
  assert.match(source, /class CanvasRenderBoundary extends Component/)
  assert.match(source, /交互画布加载失败/)
  assert.match(source, /onOpen\(node\.sessionId\)/)
})
