import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ApprovalDecisionRouter } from '../application/approval-decision-router.ts'
import { SqliteApprovalDecisionRepository } from '../storage/sqlite/approval-decision-repository.ts'

const pending = { projectionKey: 'task_review:task-1:run-1:review-1', projectId: 'project-1', source: { kind: 'task_review', taskId: 'task-1', runId: 'run-1', reviewId: 'review-1' }, status: 'pending', title: 'Review task', reason: null, requestedBy: { kind: 'user', id: 'user-1' }, requestedAt: '2026-04-01T00:00:00.000Z', decidedAt: null, decisionCapabilities: ['approve', 'changes_requested'], sourceRevision: '4:pending', freshness: { status: 'current', observedAt: '2026-04-01T00:00:00.000Z' } } as const
function input(requestId: string) {
  const base = { decision: 'approve' as const, requestId, sourceRevision: pending.sourceRevision }
  return { ...base, fingerprint: createHash('sha256').update(JSON.stringify({ decision: base.decision, note: null, requestId, sourceRevision: base.sourceRevision })).digest('hex') }
}

test('approval replay receipt and optimistic overlay survive SQLite reopen and expire together', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-approval-overlay-'))
  const path = join(directory, 'server.sqlite')
  t.after(() => rm(directory, { recursive: true, force: true }))
  let authorityCalls = 0
  const firstRepository = new SqliteApprovalDecisionRepository(path)
  const first = new ApprovalDecisionRouter({ approval: async () => pending, requireApprovalProject: async () => {} } as never, { get: async () => ({ metadataJson: { values: { reviewPolicy: 'none' } } }), authorizeReviewReplay: async () => {}, reviewAction: async () => { authorityCalls += 1 } } as never, {} as never, firstRepository, () => new Date('2026-04-01T01:00:00.000Z'))
  assert.equal((await first.decide('actor-1' as never, pending.projectionKey, input('durable-request'))).replayed, false)
  firstRepository.close()

  const reopened = new SqliteApprovalDecisionRepository(path)
  const second = new ApprovalDecisionRouter({ approval: async () => pending, requireApprovalProject: async () => {} } as never, { get: async () => ({ metadataJson: { values: { reviewPolicy: 'none' } } }), authorizeReviewReplay: async () => {}, reviewAction: async () => { authorityCalls += 1 } } as never, {} as never, reopened, () => new Date('2026-04-01T02:00:00.000Z'))
  const replay = await second.decide('actor-1' as never, pending.projectionKey, input('durable-request'))
  assert.equal(replay.replayed, true)
  assert.equal(authorityCalls, 1)
  assert.equal((await reopened.listOverlays('2026-04-01T02:00:00.000Z' as never))[0]?.status, 'approved')
  assert.equal(await reopened.purgeExpired('2026-04-02T01:00:00.001Z' as never), 2)
  assert.deepEqual(await reopened.listOverlays('2026-04-02T01:00:00.001Z' as never), [])
  reopened.close()
})
