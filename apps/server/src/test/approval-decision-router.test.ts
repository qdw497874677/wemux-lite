import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { ApprovalDecisionRouter } from '../application/approval-decision-router.ts'
import { SqliteApprovalDecisionRepository } from '../storage/sqlite/approval-decision-repository.ts'

const repository = () => new SqliteApprovalDecisionRepository(':memory:')

function input(requestId = 'request-1', sourceRevision = '4:pending') {
  const base = { decision: 'approve' as const, requestId, sourceRevision }
  return { ...base, fingerprint: createHash('sha256').update(JSON.stringify({ decision: base.decision, note: null, requestId, sourceRevision: base.sourceRevision })).digest('hex') }
}
const pending = { projectionKey: 'task_review:task-1:run-1:review-1', projectId: 'project-1', source: { kind: 'task_review', taskId: 'task-1', runId: 'run-1', reviewId: 'review-1' }, status: 'pending', title: 'Review task', reason: null, requestedBy: { kind: 'user', id: 'user-1' }, requestedAt: '2026-04-01T00:00:00.000Z', decidedAt: null, decisionCapabilities: ['approve', 'changes_requested'], sourceRevision: '4:pending', freshness: { status: 'current', observedAt: '2026-04-01T00:00:00.000Z' } } as const

test('approval decision router delegates to task authority and replays an identical requestId', async () => {
  let calls = 0
  const decisions = repository()
  const router = new ApprovalDecisionRouter({ approval: async () => pending, requireApprovalProject: async () => {} } as never, { get: async () => ({ metadataJson: { values: { reviewPolicy: 'none' } } }), authorizeReviewReplay: async () => {}, reviewAction: async () => { calls += 1 } } as never, {} as never, decisions)
  const first = await router.decide('actor-1' as never, pending.projectionKey, input())
  const second = await router.decide('actor-1' as never, pending.projectionKey, input())
  assert.equal(calls, 1); assert.equal(first.approval.status, 'approved'); assert.equal(second.replayed, true)
  decisions.close()
})

test('approval decision router rejects stale source revision and offline session approval', async () => {
  const taskDecisions = repository()
  const taskRouter = new ApprovalDecisionRouter({ approval: async () => pending, requireApprovalProject: async () => {} } as never, {} as never, {} as never, taskDecisions)
  await assert.rejects(() => taskRouter.decide('actor-1' as never, pending.projectionKey, input('request-stale', '3:pending')), /source revision changed/)
  const session = { ...pending, projectionKey: 'session_tool:session-1:turn-1:approval-1', source: { kind: 'session_tool', sessionId: 'session-1', turnId: 'turn-1', approvalId: 'approval-1' }, decisionCapabilities: ['approve', 'deny'], freshness: { status: 'offline', observedAt: pending.requestedAt } }
  const sessionInput = { ...input(), sourceRevision: session.sourceRevision }
  const sessionDecisions = repository()
  const sessionRouter = new ApprovalDecisionRouter({ approval: async () => session } as never, {} as never, { resolveRuntimeApproval: async () => undefined } as never, sessionDecisions)
  await assert.rejects(() => sessionRouter.decide('actor-1' as never, session.projectionKey, sessionInput as never), /approval is stale/i)
  taskDecisions.close(); sessionDecisions.close()
})

test('approval replay rejects another projection before authorization and never calls authority again', async t => {
  const decisions = repository(); t.after(() => decisions.close())
  let actions = 0, checks = 0
  const router = new ApprovalDecisionRouter({ approval: async () => pending, requireApprovalProject: async () => { checks++ } } as never,
    { get: async () => ({ metadataJson: { values: { reviewPolicy: 'none' } } }), reviewAction: async () => { actions++ }, authorizeReviewReplay: async () => {} } as never, {} as never, decisions)
  await router.decide('actor-1' as never, pending.projectionKey, input())
  await assert.rejects(router.decide('actor-1' as never, `${pending.projectionKey}-other`, input()), { code: 'idempotency_conflict' })
  assert.equal(checks, 0); assert.equal(actions, 1)
  await router.decide('actor-1' as never, pending.projectionKey, input())
  assert.equal(checks, 1); assert.equal(actions, 1)
})

test('receipt actor partitions do not share results', async t => {
  const decisions = repository(); t.after(() => decisions.close())
  const actors: string[] = []
  const router = new ApprovalDecisionRouter({ approval: async () => pending } as never,
    { get: async () => ({ metadataJson: { values: { reviewPolicy: 'none' } } }), reviewAction: async (_project: string, _task: string, _run: string, _input: unknown, context: { actor: string }) => { actors.push(context.actor) } } as never, {} as never, decisions)
  for (const actor of ['actor-1', 'actor-2']) assert.equal((await router.decide(actor as never, pending.projectionKey, input())).replayed, false)
  assert.deepEqual(actors, ['actor-1', 'actor-2'])
})
