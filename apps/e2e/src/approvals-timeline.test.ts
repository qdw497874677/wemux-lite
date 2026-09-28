import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { ProjectionService } from '../../server/src/application/projection-service.ts'
import { ApprovalDecisionRouter } from '../../server/src/application/approval-decision-router.ts'

const now = '2026-04-01T12:00:00.000Z'
test('task review and connector approval aggregate, decision changes status, timeline supports cursor paging', async () => {
  const review = { id: 'review-1', taskId: 'task-1', taskRunId: 'run-1', actor: 'reviewer', requestedAt: now, status: 'pending' }
  const store = { tasks: { pendingReviews: async () => [review], get: async () => ({ id: 'task-1', projectId: 'project-1', title: 'E2E review', version: 4 }), projectActivity: async () => [{ activity: { taskId: 'task-1', seq: 1, type: 'review.requested', requestId: 'review-request', occurredAt: now, actor: 'reviewer' } }] }, cache: { getFreshness: async () => ({ status: 'synced', contiguousSeq: 1 }), readEvents: async () => ({ events: [{ seq: 1, occurredAt: '2026-04-01T11:59:00.000Z', payload: { kind: 'approval.requested', approvalId: 'connector-approval', turnId: 'turn-1', reason: 'Connector 外部调用' } }] }) }, identity: { queryAudit: async () => ({ items: [] }) } }
  const savedOverlays: unknown[] = []
  const decisions = { listOverlays: async () => savedOverlays, cleanupExpired: async () => undefined, getReceipt: async () => null, save: async (_receipt: unknown, overlay: unknown) => { savedOverlays.push(overlay) } }
  const projections = new ProjectionService(store as never, { list: async () => [{ id: 'project-1', name: 'E2E project' }] } as never, { list: async () => [{ id: 'session-1', projectId: 'project-1', title: 'Connector session', binding: { agent: { agentKey: 'pi' } } }] } as never, decisions as never)
  const page = await projections.approvals('viewer' as never, { limit: 100 })
  assert.equal(page.items.length, 2); assert.deepEqual(new Set(page.items.map(item => item.source.kind)), new Set(['task_review', 'session_tool']))
  let authorityCalls = 0
  const router = new ApprovalDecisionRouter(projections, { reviewAction: async () => { authorityCalls += 1 } } as never, {} as never, decisions as never)
  const approval = page.items.find(item => item.source.kind === 'task_review'); assert.ok(approval)
  const requestId = 'e2e-approve', base = { decision: 'approve' as const, requestId, sourceRevision: approval.sourceRevision }, fingerprint = createHash('sha256').update(JSON.stringify({ decision: base.decision, note: null, requestId, sourceRevision: base.sourceRevision })).digest('hex')
  const result = await router.decide('viewer' as never, approval.projectionKey, { ...base, fingerprint })
  assert.equal(authorityCalls, 1); assert.equal(result.approval.status, 'approved')
  const timelineFirst = await projections.timeline('viewer' as never, { limit: 1 }); assert.equal(timelineFirst.items.length, 1); assert.ok(timelineFirst.nextCursor)
  const timelineSecond = await projections.timeline('viewer' as never, { limit: 100, cursor: timelineFirst.nextCursor ?? undefined }); assert.ok([...timelineFirst.items, ...timelineSecond.items].some(item => item.action === 'approval.decided'))
})
