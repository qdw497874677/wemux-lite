import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertEdgesReferenceReturnedNodes,
  assertForkCursorIsDurable,
  assertForkTargetsAnotherSession,
  assertNodeVisibilityIsHonest,
  isCanvasLayout,
  isSessionForkContextPolicy,
  isSessionRelationKind,
  narrowForkAccess,
  sessionGraphNodeVisibilities,
  sessionRelationKinds,
  type CanvasLayout,
  type SessionGraphSnapshot,
} from '@wemux/server-domain'

// C0 冻结契约（Ticket 16）：这些不变量是画布、血缘与布局的验收基线。
// 实现 Fork 事务与画布 UI 时必须复用同一 Module，不得在调用方重写规则。

const summary = {
  title: 'source',
  projectId: 'p1',
  workspaceId: 'w1',
  workerId: 'wk1',
  agentKey: 'pi',
  modelId: null,
  runtimeState: 'idle',
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  branchCount: 1,
} as never

test('a Fork never targets its own source Session', () => {
  assertForkTargetsAnotherSession({ sourceSessionId: 's1', targetSessionId: 's2' } as never)
  assert.throws(() => assertForkTargetsAnotherSession({ sourceSessionId: 's1', targetSessionId: 's1' } as never), /must differ/)
})

test('the Fork cursor is a durable boundary, never ahead of the Journal', () => {
  assertForkCursorIsDurable(0, 0)
  assertForkCursorIsDurable(7, 7)
  assert.throws(() => assertForkCursorIsDurable(8, 7), /ahead of durable sequence 7/)
  assert.throws(() => assertForkCursorIsDurable(-1, 0), /non-negative integer/)
  assert.throws(() => assertForkCursorIsDurable(1.5, 7), /non-negative integer/)
})

test('placeholder nodes cannot leak a summary, visible nodes cannot omit one', () => {
  assertNodeVisibilityIsHonest({ sessionId: 's1', visibility: 'visible', summary } as never)
  assertNodeVisibilityIsHonest({ sessionId: 's1', visibility: 'placeholder', summary: null } as never)
  assert.throws(() => assertNodeVisibilityIsHonest({ sessionId: 's1', visibility: 'placeholder', summary } as never), /must not carry a summary/)
  assert.throws(() => assertNodeVisibilityIsHonest({ sessionId: 's1', visibility: 'visible', summary: null } as never), /requires a summary/)
})

test('an edge is only returned when both endpoints are visible in the same snapshot', () => {
  const edge = (source: string, target: string) => ({ key: `fork:${source}-${target}`, relation: { type: 'fork', forkId: 'f1' }, sourceSessionId: source, targetSessionId: target })
  const snapshot = (edges: unknown[]) => ({ revision: 'r1', nodes: [{ sessionId: 's1', visibility: 'visible', summary }, { sessionId: 's2', visibility: 'placeholder', summary: null }], edges, hiddenRelationCount: null }) as unknown as SessionGraphSnapshot
  assertEdgesReferenceReturnedNodes(snapshot([edge('s1', 's2')]))
  assert.throws(() => assertEdgesReferenceReturnedNodes(snapshot([edge('s1', 'hidden')])), /outside the snapshot/)
  assert.throws(() => assertEdgesReferenceReturnedNodes(snapshot([edge('s1', 's1')])), /must differ/)
})

test('Fork authorization narrows and never widens access', () => {
  assert.equal(narrowForkAccess('visible', 'visible'), 'visible')
  assert.equal(narrowForkAccess('visible', 'placeholder'), 'placeholder')
  assert.equal(narrowForkAccess('placeholder', 'visible'), 'placeholder')
  assert.equal(narrowForkAccess('visible', 'omitted'), 'omitted')
  assert.equal(narrowForkAccess('omitted', 'visible'), 'omitted')
})

test('relation kinds and context policies are closed unions', () => {
  for (const kind of sessionRelationKinds) assert.ok(isSessionRelationKind(kind))
  assert.ok(isSessionRelationKind('fork'))
  assert.ok(!isSessionRelationKind('merge'))
  assert.ok(!isSessionRelationKind('anything_else'))
  assert.ok(isSessionForkContextPolicy('through_cursor'))
  assert.ok(!isSessionForkContextPolicy('full_history'))
  for (const visibility of sessionGraphNodeVisibilities) assert.ok(['visible', 'placeholder'].includes(visibility))
})

test('layout payloads are validated before persistence', () => {
  const valid: CanvasLayout = {
    scope: 'personal',
    graphRevision: 'r1',
    nodePositions: { ['s1']: { x: 0, y: 12.5 } },
    collapsedGroups: ['g1'],
    viewport: { x: 0, y: 0, zoom: 1 },
  }
  assert.ok(isCanvasLayout(valid))
  assert.ok(!isCanvasLayout({ ...valid, viewport: { x: 0, y: 0, zoom: undefined } }))
  assert.ok(!isCanvasLayout({ ...valid, graphRevision: '' }))
  assert.ok(!isCanvasLayout({ ...valid, viewport: { x: 0, y: 0, zoom: 0 } }))
  assert.ok(!isCanvasLayout({ ...valid, nodePositions: { s1: { x: 0, y: Number.NaN } } }))
  assert.ok(!isCanvasLayout({ ...valid, nodePositions: [] }))
  assert.ok(!isCanvasLayout({ ...valid, collapsedGroups: [1] }))
  assert.ok(!isCanvasLayout({ ...valid, scope: 'team' }))
})