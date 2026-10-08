import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import { ServerService } from '../application/server-service.ts'
import { Notifications } from '../application/notifications.ts'
import { TaskService } from '../application/task-service.ts'
import { ProjectionService } from '../application/projection-service.ts'
import { ProjectAccessService } from '../application/project-access-service.ts'
import { SessionAccessService } from '../application/session-access-service.ts'
import { AttentionService } from '../application/attention-service.ts'
import { instanceOperatorId, seedOperator } from './fixtures/administrator.ts'
import type { ServerStore } from '../application/ports/server-store.js'
import type { Run, TaskDetail } from '@wemux/web-contract/task-platform'
import type { Timestamp, UserId, AgentKey, ModelId } from '@wemux/domain'

const context = { actor: instanceOperatorId, requestId: 'trace' }

async function fixture() {
  const store = new SqliteServerStore(':memory:')
  const server = new ServerService(store, new Notifications())
  await seedOperator(store, server)
  const enrollment = await server.createEnrollment({})
  const { worker } = await server.enroll({ token: enrollment.token, name: 'Stage worker' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
  const tasks = new TaskService(store, () => {}, server)
  const task = await tasks.create('default-project', { title: 'Staged review task' }, context)
  const created = await tasks.createWorkspace(task.projectId, task.id, { name: task.title, workerId: worker.id, source: 'empty' }, context)
  await store.transaction(tx => tx.resources.saveWorkspace({ ...created.workspace, status: 'ready' }))
  const assignment = { workspaceId: created.workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' }
  await tasks.assignment(task.projectId, task.id, { version: 1, assignee: assignment }, false, context)
  return { store, tasks, task, worker, request: { requestId: 'stable', mode: 'new' as const, reuseSessionId: null, prompt: 'prompt', assignment } }
}

async function seeded(f: Awaited<ReturnType<typeof fixture>>, reviewPolicy: 'multi-stage' | 'human' | 'agent') {
  const project = await f.store.resources.getProject(f.task.projectId as never)
  assert.ok(project)
  await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy, reviewPolicyVersion: 2 }))
  const { run } = await f.tasks.launch(f.task.projectId, f.task.id, f.request, context)
  await f.store.transaction(async tx => {
    const at = new Date().toISOString() as Timestamp
    await tx.tasks.saveRun({ ...run, status: 'succeeded', startedAt: run.createdAt, finishedAt: at, failure: null, resultSummary: 'done' })
  })
  let task: TaskDetail = await f.tasks.get(f.task.projectId, f.task.id, context)
  for (const status of ['todo', 'in_progress'] as const) task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status }, context)
  return { run, task }
}

async function grant(store: ServerStore, projectId: string, teamId: string, role: 'manager' | 'contributor', name: string) {
  const id = randomUUID() as UserId, now = new Date().toISOString() as Timestamp
  await store.transaction(async tx => {
    await tx.identity.saveUser({ id, username: `stage-${name}-${role}`, email: null, status: 'active', authVersion: 0, createdAt: now, statusChangedAt: now, deletedAt: null })
    await tx.identity.saveMembership({ teamId: teamId as never, userId: id, role: 'member', joinedAt: now })
    await tx.identity.saveProjectGrant({ projectId: projectId as never, userId: id, role })
  })
  return id
}

function projections(store: ServerStore) {
  const access = new ProjectAccessService(store)
  return new ProjectionService(store, access, new SessionAccessService(store, access), { listOverlays: async () => [] } as never)
}

test('multi-stage review chains advance stage by stage with independent deciders and no skipping', async () => {
  const f = await fixture()
  try {
    const { run, task } = await seeded(f, 'multi-stage')
    const project = await f.store.resources.getProject(f.task.projectId as never); assert.ok(project)
    const first = await grant(f.store, task.projectId, project.teamId, 'manager', 'one')
    const second = await grant(f.store, task.projectId, project.teamId, 'manager', 'two')
    const outsider = await grant(f.store, task.projectId, project.teamId, 'contributor', 'three')
    assert.equal(task.metadataJson.values.reviewPolicy, 'multi-stage', 'launch freezes the project default without rewriting it to human')
    const submission = await f.tasks.submitHumanReview(task.projectId, task.id, { version: task.version, requestId: 'stage-submit', runId: run.id, summary: '成果', evidence: ['ref://a'] }, context)
    assert.equal(submission.task.status, 'in_review')
    assert.equal(submission.review.stageIndex, 1)
    assert.equal(submission.review.stageCount, 2)
    assert.equal(submission.task.metadataJson.values.reviewPolicy, 'multi-stage')
    assert.equal(submission.task.metadataJson.values.reviewPolicyFrozen, true)
    const decide = (actor: UserId, body: Record<string, unknown>) => f.tasks.decideHumanReview(task.projectId, task.id, body, { actor, requestId: 'trace' })
    const stage1 = { version: submission.task.version, requestId: 'stage-1', reviewId: submission.review.id, status: 'approved' as const }
    for (const actor of [context.actor, outsider]) await assert.rejects(decide(actor, stage1), { code: 'forbidden' })
    await assert.rejects(decide(first, { ...stage1, version: stage1.version - 1 }), { code: 'version_conflict' })
    const advanced = await decide(first, stage1)
    assert.equal(advanced.task.version, submission.task.version + 1, 'a staged advance still observes Task CAS')
    assert.equal(advanced.review.status, 'approved')
    assert.equal(advanced.review.reviewer, first)
    assert.equal(advanced.review.stageIndex, 1)
    assert.equal(advanced.task.status, 'in_review', 'stage 1 approval advances the chain instead of finishing the Task')
    assert.notEqual(advanced.task.currentReviewId, submission.review.id)
    assert.ok(advanced.task.currentReviewId)
    assert.deepEqual(await decide(first, stage1), advanced, 'duplicate decision replays the exact receipt')
    const stage2Review = (await f.tasks.review(task.projectId, task.id, run.id, context))!
    assert.equal(stage2Review.id, advanced.task.currentReviewId)
    assert.equal(stage2Review.stageIndex, 2)
    assert.equal(stage2Review.stageCount, 2)
    await assert.rejects(decide(first, { version: advanced.task.version, requestId: 'stage-2-self', reviewId: stage2Review.id, status: 'approved' }), { code: 'forbidden' }, 'an earlier-stage reviewer cannot decide the next stage')
    await assert.rejects(decide(second, { version: submission.task.version, requestId: 'stage-2-stale', reviewId: submission.review.id, status: 'approved' }), (error: Error & { code?: string }) => error.code === 'version_conflict' || error.code === 'invalid_transition', 'the closed stage review cannot be decided again through a new request (CAS or transition rejection)')
    const finish = await decide(second, { version: advanced.task.version, requestId: 'stage-2', reviewId: stage2Review.id, status: 'approved' })
    assert.equal(finish.task.status, 'done')
    assert.equal(finish.task.currentReviewId, null)
    assert.equal(finish.review.stageIndex, 2)
    const activity = (await f.tasks.activity(task.projectId, task.id, 0, context)).map(item => item.payload.action ?? null)
    assert.ok(activity.includes('review.stage_advanced'))
    const chain = await f.store.transaction(tx => tx.tasks.reviews(task.id))
    assert.deepEqual(chain.filter(item => item.status === 'approved').map(item => item.stageIndex), [1, 2])
    assert.equal((await f.tasks.pendingReviews(task.projectId, context)).length, 0)
  } finally { f.store.close() }
})

test('changes_requested at any multi-stage stage returns the Task to implementation; agent policy stays blocked', async () => {
  const f = await fixture()
  try {
    const { run, task } = await seeded(f, 'multi-stage')
    const project = await f.store.resources.getProject(f.task.projectId as never); assert.ok(project)
    const reviewer = await grant(f.store, task.projectId, project.teamId, 'manager', 'return')
    const submission = await f.tasks.submitHumanReview(task.projectId, task.id, { version: task.version, requestId: 'return-submit', runId: run.id, summary: '成果', evidence: [] }, context)
    const returned = await f.tasks.decideHumanReview(task.projectId, task.id, { version: submission.task.version, requestId: 'return-1', reviewId: submission.review.id, status: 'changes_requested', reason: '缺少测试' }, { actor: reviewer, requestId: 'trace' })
    assert.equal(returned.task.status, 'in_progress')
    assert.equal(returned.task.currentReviewId, null)
    assert.equal(returned.review.status, 'changes_requested')
    assert.equal((await f.tasks.pendingReviews(task.projectId, context)).length, 0)
    const reopened = await f.tasks.submitHumanReview(task.projectId, task.id, { version: returned.task.version, requestId: 'return-submit-2', runId: run.id, summary: '修复后', evidence: [] }, context)
    assert.equal(reopened.review.stageIndex, 1, 'a new cycle restarts the full stage chain')
    await assert.rejects(f.tasks.complete(task.projectId, task.id, { version: reopened.task.version, requestId: 'no-bypass', runId: run.id, summary: 'done', evidence: [] }, context), { code: 'invalid_transition' }, 'completion cannot bypass the staged policy')
  } finally { f.store.close() }
  const agent = await fixture()
  try {
    const { run, task } = await seeded(agent, 'agent')
    await assert.rejects(agent.tasks.submitHumanReview(task.projectId, task.id, { version: task.version, requestId: 'agent-submit', runId: run.id, summary: '成果', evidence: [] }, context), { code: 'invalid_transition' }, 'agent policy has no authorized decision workflow yet and never degrades silently')
  } finally { agent.store.close() }
})

test('multi-stage attention capabilities and receipt replay exclude earlier-stage reviewers and non-managers', async () => {
  const f = await fixture()
  try {
    const { run, task } = await seeded(f, 'multi-stage')
    const project = await f.store.resources.getProject(f.task.projectId as never); assert.ok(project)
    const first = await grant(f.store, task.projectId, project.teamId, 'manager', 'cap-one')
    const second = await grant(f.store, task.projectId, project.teamId, 'manager', 'cap-two')
    const service = projections(f.store)
    const capabilities = async (actor: UserId) => (await service.approvals(actor, { sourceKind: 'task_review', status: 'pending' })).items.map(item => item.decisionCapabilities)
    const submission = await f.tasks.submitHumanReview(task.projectId, task.id, { version: task.version, requestId: 'cap-submit', runId: run.id, summary: '成果', evidence: [] }, context)
    assert.deepEqual(await capabilities(first), [['approve', 'changes_requested']])
    assert.deepEqual(await capabilities(second), [['approve', 'changes_requested']])
    assert.deepEqual(await capabilities(context.actor), [[]], 'submitter sees the pending review without decision capabilities')
    const advanced = await f.tasks.decideHumanReview(task.projectId, task.id, { version: submission.task.version, requestId: 'cap-1', reviewId: submission.review.id, status: 'approved' }, { actor: first, requestId: 'trace' })
    assert.deepEqual(await capabilities(first), [[]], 'the stage 1 decider sees stage 2 without decision capabilities')
    assert.deepEqual(await capabilities(second), [['approve', 'changes_requested']])
    const stage2 = (await f.tasks.review(task.projectId, task.id, run.id, context))!
    assert.equal(stage2.stageIndex, 2)
    await f.tasks.authorizeReviewReplay(task.projectId, task.id, run.id, advanced.review.id, { actor: first, requestId: 'trace' })
    const finish = await f.tasks.decideHumanReview(task.projectId, task.id, { version: advanced.task.version, requestId: 'cap-2', reviewId: stage2.id, status: 'approved' }, { actor: second, requestId: 'trace' })
    assert.equal(finish.task.status, 'done')
    assert.deepEqual(await capabilities(second), [])
    await assert.rejects(f.tasks.authorizeReviewReplay(task.projectId, task.id, run.id, finish.review.id, { actor: first, requestId: 'trace' }), { code: 'forbidden' }, 'earlier-stage reviewers cannot read later-stage receipts')
    await f.tasks.authorizeReviewReplay(task.projectId, task.id, run.id, finish.review.id, { actor: second, requestId: 'trace' })
    await f.store.transaction(tx => tx.identity.removeProjectGrant(task.projectId as never, second))
    await assert.rejects(f.tasks.authorizeReviewReplay(task.projectId, task.id, run.id, finish.review.id, { actor: second, requestId: 'trace' }), { code: 'forbidden' }, 'losing manager authority also loses terminal receipt access')
  } finally { f.store.close() }
})
