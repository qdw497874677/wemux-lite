import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { ApprovalDecisionRouter } from '../application/approval-decision-router.ts'

function input(requestId = 'request-1', sourceRevision = '4:pending') {
  const base = { decision: 'approve' as const, requestId, sourceRevision }
  return { ...base, fingerprint: createHash('sha256').update(JSON.stringify({ decision: base.decision, note: null, requestId, sourceRevision: base.sourceRevision })).digest('hex') }
}
const pending = { projectionKey: 'task_review:task-1:run-1:review-1', projectId: 'project-1', source: { kind: 'task_review', taskId: 'task-1', runId: 'run-1', reviewId: 'review-1' }, status: 'pending', title: 'Review task', reason: null, requestedBy: { kind: 'user', id: 'user-1' }, requestedAt: '2026-04-01T00:00:00.000Z', decidedAt: null, decisionCapabilities: ['approve', 'changes_requested'], sourceRevision: '4:pending', freshness: { status: 'current', observedAt: '2026-04-01T00:00:00.000Z' } } as const

test('approval decision router delegates to task authority and replays an identical requestId', async () => {
  let calls = 0, remembered = null
  const router = new ApprovalDecisionRouter({ approval: async () => pending, rememberDecision: (value: unknown) => { remembered = value } } as never, { reviewAction: async () => { calls += 1 } } as never, {} as never)
  const first = await router.decide('actor-1' as never, pending.projectionKey, input())
  const second = await router.decide('actor-1' as never, pending.projectionKey, input())
  assert.equal(calls, 1); assert.equal(first.approval.status, 'approved'); assert.equal(second.replayed, true); assert.ok(remembered)
})

test('approval decision router rejects stale source revision and offline session approval', async () => {
  const taskRouter = new ApprovalDecisionRouter({ approval: async () => pending } as never, {} as never, {} as never)
  await assert.rejects(() => taskRouter.decide('actor-1' as never, pending.projectionKey, input('request-stale', '3:pending')), /source revision changed/)
  const session = { ...pending, projectionKey: 'session_tool:session-1:turn-1:approval-1', source: { kind: 'session_tool', sessionId: 'session-1', turnId: 'turn-1', approvalId: 'approval-1' }, decisionCapabilities: ['approve', 'deny'], freshness: { status: 'offline', observedAt: pending.requestedAt } }
  const sessionInput = { ...input(), sourceRevision: session.sourceRevision }
  const sessionRouter = new ApprovalDecisionRouter({ approval: async () => session } as never, {} as never, { resolveRuntimeApproval: async () => undefined } as never)
  await assert.rejects(() => sessionRouter.decide('actor-1' as never, session.projectionKey, sessionInput as never), /approval is stale/i)
})
