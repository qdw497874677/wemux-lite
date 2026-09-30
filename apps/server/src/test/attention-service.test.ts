import assert from 'node:assert/strict'
import test from 'node:test'
import { AttentionService } from '../application/attention-service.ts'

const approval = { projectionKey: 'task_review:task-1:run-1:review-1', projectId: 'project-1', source: { kind: 'task_review' }, status: 'pending', title: '审查 Alpha', reason: null, requestedAt: '2026-04-01T00:00:00.000Z', freshness: { status: 'current', observedAt: '2026-04-01T00:00:00.000Z' } }
const projections = {
  approvals: async () => ({ items: [approval], nextCursor: null }),
  allowedProjectIds: async () => new Set(['project-1']),
}
const source = {
  listTasks: async () => [
    { taskId: 'task-1', projectId: 'project-1', title: 'Alpha', status: 'in_progress', assigneeUserIds: ['actor-1'] },
    { taskId: 'task-hidden', projectId: 'project-hidden', title: '隐藏任务', status: 'in_review', assigneeUserIds: ['actor-1'] },
  ],
  listRuns: async () => [
    { runId: 'run-1', taskId: 'task-1', projectId: 'project-1', title: 'Alpha Run', status: 'failed', createdBy: 'actor-1' },
    { runId: 'run-other', taskId: 'task-1', projectId: 'project-1', title: '他人 Run', status: 'blocked', createdBy: 'actor-2' },
  ],
  listDeadLetters: async () => [{ id: 'delivery-1', projectId: 'project-1', title: '飞书投递', detail: '超出重试次数' }],
}

test('attention aggregates approvals, assignments, owned run problems and administrator dead letters with counts', async () => {
  const result = await new AttentionService(projections as never, source as never, () => new Date('2026-04-02T00:00:00.000Z')).query('actor-1' as never, true, { actorId: 'actor-1' as never })
  assert.equal(result.total, 4)
  assert.deepEqual(result.groups.map(group => [group.kind, group.count]), [['approval', 1], ['task_assignment', 1], ['run_problem', 1], ['channel_dead_letter', 1]])
  assert.match(result.groups[0]!.items[0]!.href, /^\/approvals\?projectId=project-1#/)
})

test('attention applies A3 project visibility and hides dead letters from non-administrators', async () => {
  const result = await new AttentionService(projections as never, source as never).query('actor-1' as never, false, { actorId: 'actor-1' as never })
  assert.equal(result.total, 3)
  assert.equal(result.groups.find(group => group.kind === 'channel_dead_letter')?.count, 0)
  assert.equal(result.groups.flatMap(group => group.items).some(item => item.projectId === 'project-hidden'), false)
})

test('attention reads approval pages within the real projection limit', async () => {
  const calls: (string | undefined)[] = []
  const paginated = { ...projections, approvals: async (_actor: unknown, query: { limit: number; cursor?: string }) => {
    assert.ok(query.limit <= 100, 'real ProjectionService rejects larger limits')
    calls.push(query.cursor)
    return query.cursor ? { items: [{ ...approval, projectionKey: 'second' }], nextCursor: null } : { items: [approval], nextCursor: 'next' }
  } }
  const result = await new AttentionService(paginated as never, source as never).query('actor-1' as never, false, { actorId: 'actor-1' as never })
  assert.deepEqual(calls, [undefined, 'next'])
  assert.equal(result.groups[0]?.count, 2)
})

test('attention kind and project filters preserve grouped response shape', async () => {
  const result = await new AttentionService(projections as never, source as never).query('actor-1' as never, true, { actorId: 'actor-1' as never, projectId: 'project-1' as never, kind: 'run_problem' })
  assert.equal(result.total, 1)
  assert.equal(result.groups.find(group => group.kind === 'run_problem')?.count, 1)
  assert.equal(result.groups.filter(group => group.kind !== 'run_problem').every(group => group.count === 0), true)
})
