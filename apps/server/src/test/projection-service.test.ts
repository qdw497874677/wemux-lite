import assert from 'node:assert/strict'
import test from 'node:test'
import { ProjectionService, decodeProjectionCursor } from '../application/projection-service.ts'
import type { ApprovalView } from '@wemux/server-domain'

const now = '2026-04-01T12:00:00.000Z'
function serviceFixture(overlays: readonly ApprovalView[] = []) {
  const projects = [{ id: 'project-visible', name: 'Visible' }]
  const task = { id: 'task-1', projectId: 'project-visible', title: 'Ship approval', version: 3 }
  const review = { id: 'review-1', taskId: 'task-1', taskRunId: 'run-1', actor: 'user-reviewer', requestedAt: now, status: 'pending' }
  const session = { id: 'session-1', projectId: 'project-visible', title: 'Connector session', binding: { agent: { agentKey: 'pi' } } }
  const store = {
    tasks: {
      pendingReviews: async (projectId: string) => projectId === 'project-visible' ? [review] : [],
      get: async (id: string) => id === 'task-1' ? task : null,
      projectActivity: async () => [{ activity: { taskId: 'task-1', seq: 1, type: 'review.requested', requestId: 'request-review', occurredAt: now, actor: 'user-reviewer' } }],
    },
    cache: {
      getFreshness: async () => ({ status: 'synced', contiguousSeq: 2 }),
      readEvents: async () => ({ events: [
        { seq: 1, occurredAt: '2026-04-01T11:59:00.000Z', payload: { kind: 'approval.requested', approvalId: 'approval-1', turnId: 'turn-1', reason: '允许连接外部服务' } },
        { seq: 2, occurredAt: '2026-04-01T12:00:00.000Z', payload: { kind: 'turn.started', turnId: 'turn-1' } },
      ] }),
    },
    identity: { queryAudit: async () => ({ items: [{ id: 'audit-1', actorId: 'user-reviewer', action: 'review.requested', resource: { kind: 'project', id: 'project-visible' }, metadata: { requestId: 'request-review' }, occurredAt: now, result: 'success' }] }) },
  }
  return new ProjectionService(store as never, { list: async () => projects } as never, { list: async () => [session] } as never, { listOverlays: async () => overlays } as never)
}

test('projection service aggregates task and session approvals with freshness and stable cursor', async () => {
  const service = serviceFixture()
  const first = await service.approvals('viewer' as never, { limit: 1 })
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor); assert.equal(first.items[0]?.freshness.status, 'current')
  const cursor = decodeProjectionCursor(first.nextCursor ?? undefined); assert.equal(cursor?.occurredAt, now)
  const second = await service.approvals('viewer' as never, { limit: 1, cursor: first.nextCursor ?? undefined })
  assert.equal(second.items.length, 1); assert.notEqual(second.items[0]?.projectionKey, first.items[0]?.projectionKey)
})

test('projection service filters inaccessible projects and deduplicates timeline authority', async () => {
  const service = serviceFixture()
  assert.deepEqual(await service.approvals('viewer' as never, { projectId: 'project-hidden' as never }), { items: [], nextCursor: null })
  const timeline = await service.timeline('viewer' as never, {})
  assert.equal(timeline.items.length, 1); assert.equal(timeline.items[0]?.sourceKind, 'task_activity')
})

test('projection service filters approvals by status before pagination', async () => {
  const service = serviceFixture()
  assert.equal((await service.approvals('viewer' as never, { status: 'pending' })).items.length, 2)
  assert.equal((await service.approvals('viewer' as never, { status: 'approved' })).items.length, 0)
})

test('projection service reads a persisted decision overlay and exposes the corresponding timeline event', async () => {
  const pending = (await serviceFixture().approvals('viewer' as never, { sourceKind: 'task_review' })).items[0]
  assert.ok(pending)
  const decided: ApprovalView = { ...pending, status: 'approved', decidedAt: '2026-04-01T12:01:00.000Z' as never, decisionCapabilities: [] }
  const service = serviceFixture([decided])
  assert.equal((await service.approvals('viewer' as never, { sourceKind: 'task_review' })).items[0]?.status, 'approved')
  assert.ok((await service.timeline('viewer' as never, {})).items.some(item => item.action === 'approval.decided'))
})
