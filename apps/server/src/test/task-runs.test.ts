import test from 'node:test'
import { ProjectionService } from '../application/projection-service.ts'
import { ApprovalDecisionRouter } from '../application/approval-decision-router.ts'
import { SharedSqliteDatabase, type SqliteDatabaseSource } from '../storage/sqlite/shared-database.ts'
import { SqliteApprovalDecisionRepository } from '../storage/sqlite/approval-decision-repository.ts'
import { ProjectAccessService } from '../application/project-access-service.ts'
import { SessionAccessService } from '../application/session-access-service.ts'
import { AttentionService } from '../application/attention-service.ts'
import { administratorDirectory, administratorEmail, administratorToken, instanceOperatorId, seedAdministrator, seedLocalAccount, seedOperator } from './fixtures/administrator.js'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { AuthenticationService, hashSecret } from '../application/auth.js'
import { httpHandler } from '../http/handler.js'
import { SessionStreams } from '../http/sse.js'
import { WebSocket } from 'ws'
import { createWemuxServer } from '../server.js'
import { TransportV2Peer } from './transport-v2-peer.js'
import type { ServerStore, ServerStoreTx } from '../application/ports/server-store.js'
import assert from 'node:assert/strict'
import { projectRuns, saveRunProjection } from '../application/run-projection.js'
import { WorkerService } from '../application/worker-service.js'
import type { CredentialId, JournalEvent, SessionId, EventSeq, Timestamp, CommandId, MessageId, TurnId, UserId, AgentKey, ModelId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { migrationCount } from '../storage/sqlite/migrations.js'
import { runInvariants } from '../storage/sqlite/run-invariants.ts'
import { ServerService } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { TaskService } from '../application/task-service.js'

const context = { actor: instanceOperatorId, requestId: 'runs-test' }

/** 直接写入 PAT：任务/运行测试关注语义，不掺入凭据签发路由；ttl 为负数可造出已过期凭据。 */
async function issuePat(store: ServerStore, userId: UserId, ttlMs: number, scopes: ('read' | 'write' | 'execute' | 'admin')[] = ['read', 'write', 'execute', 'admin']): Promise<string> {
  const token = `test-pat-${randomUUID()}`
  const expiresAt = new Date(Date.now() + ttlMs).toISOString() as Timestamp
  await store.transaction(async tx => tx.identity.savePersonalAccessToken({ id: randomUUID() as CredentialId, userId, name: '任务测试', scopes, tokenHash: hashSecret(token), createdAt: new Date().toISOString() as Timestamp, expiresAt, lastUsedAt: null, revokedAt: null }))
  return token
}

async function fixture(path: SqliteDatabaseSource = ':memory:') {
  const store = new SqliteServerStore(path)
  const server = new ServerService(store, new Notifications())
  await seedOperator(store, server)
  const enrollment = await server.createEnrollment({})
  const { worker, credential } = await server.enroll({ token: enrollment.token, name: 'Run worker' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
  const tasks = new TaskService(store, () => {}, server)
  const task = await tasks.create('default-project', { title: 'Run task' }, context)
  const created = await tasks.createWorkspace(task.projectId, task.id, { name: task.title, workerId: worker.id, source: 'empty' }, context)
  await store.transaction(tx => tx.resources.saveWorkspace({ ...created.workspace, status: 'ready' }))
  const assignment = { workspaceId: created.workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' }
  await tasks.assignment(task.projectId, task.id, { version: 1, assignee: assignment }, false, context)
  const request = { requestId: 'stable', mode: 'new' as const, reuseSessionId: null, prompt: '  Full prompt\n', assignment }
  const launch = (body = request) => tasks.launch(task.projectId, task.id, body, context)
  return { store, server, tasks, task, worker, credential, launch, request }
}

test('ordered model changes update Run Session selection without rewriting historical Run binding', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch(), sessionId = run.sessionId as SessionId
    const workers = new WorkerService(f.store, new Notifications())
    const event: JournalEvent = { sessionId, seq: 1 as EventSeq, occurredAt: run.createdAt as Timestamp, payload: { kind: 'model.changed', previousModelId: 'model' as ModelId, modelId: 'next' as ModelId } }
    const message = { protocolVersion: 1 as const, messageId: 'model-batch' as MessageId, type: 'sync' as const, kind: 'batch' as const, sessionId, throughSeq: 1 as EventSeq, hasMore: false, events: [event] }
    await workers.receive(f.worker.id, message)
    assert.equal((await f.store.resources.getSession(sessionId))!.binding.modelId, 'next')
    assert.deepEqual((await f.store.tasks.run(run.id))!.snapshot, run.snapshot)
    await workers.receive(f.worker.id, message)
    assert.equal((await f.store.cache.readEvents(sessionId, 1 as EventSeq, 100)).events.length, 1)
    await assert.rejects(f.store.transaction(tx => tx.tasks.saveRun({ ...run, snapshot: { ...run.snapshot, modelId: 'next' } })), /Immutable Run identity/)
    const session = (await f.store.resources.getSession(sessionId))!
    await assert.rejects(f.store.transaction(tx => tx.resources.saveSession({ ...session, binding: { ...session.binding, agent: { ...session.binding.agent, agentKey: 'other' as AgentKey } } })), /provenance is immutable/)
    assert.equal((await f.store.resources.getSession(sessionId))!.binding.modelId, 'next')
  } finally { f.store.close() }
})

test('model-selection migration upgrades retained Run data and preserves immutable guards after reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-selection-upgrade-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  let upgraded: SqliteServerStore | undefined
  try {
    const { run } = await f.launch(), sessionId = run.sessionId as SessionId
    f.store.close()
    const db = new DatabaseSync(path)
    try {
      for (const name of ['invalid_run_identity', 'invalid_session_source']) {
        const definition = runInvariants.match(new RegExp(`CREATE VIEW ${name} AS[\\s\\S]*?;`))?.[0]
        assert.ok(definition); db.exec(`DROP VIEW ${name}; ${definition}`)
      }
      // These attention indexes were added after v34 and must not survive the legacy fixture reset.
      db.exec('DROP INDEX attention_failed_runs_order; DROP INDEX attention_dead_letters_order; DROP INDEX attention_human_reviews_order')
      db.exec('DROP TRIGGER command_rejection_no_dispatch; DROP TABLE command_rejections')
      db.prepare('DELETE FROM schema_migrations WHERE version>=?').run(35)
      assert.throws(() => db.prepare("UPDATE records SET data=json_set(data,'$.binding.modelId','next') WHERE kind='session' AND id=?").run(sessionId), /Invalid Session source|Invalid Run identity/)
    } finally { db.close() }
    upgraded = new SqliteServerStore(path)
    assert.deepEqual(await upgraded.tasks.run(run.id), run)
    const session = (await upgraded.resources.getSession(sessionId))!
    await upgraded.transaction(tx => tx.resources.saveSession({ ...session, binding: { ...session.binding, modelId: 'next' as ModelId } }))
    await assert.rejects(upgraded.transaction(tx => tx.tasks.saveRun({ ...run, snapshot: { ...run.snapshot, modelId: 'next' } })), /Immutable Run identity/)
    upgraded.close(); upgraded = new SqliteServerStore(path)
    assert.equal((await upgraded.resources.getSession(sessionId))?.binding.modelId, 'next')
    assert.deepEqual(await upgraded.tasks.run(run.id), run)
  } finally { upgraded?.close(); f.store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('Worker project Run invalidations see committed state and duplicate receipts stay silent', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    const notifications = new Notifications()
    const reads: Promise<unknown>[] = []
    notifications.onProject(f.task.projectId, event => {
      assert.equal(event.type, 'run.changed')
      reads.push(f.store.tasks.run(run.id).then(value => assert.equal(value?.status, 'failed')))
    })
    const workers = new WorkerService(f.store, notifications)
    const receipt = { type: 'ack' as const, receipt: { commandId: run.createCommandId as CommandId, status: 'rejected' as const, error: { code: 'invalid-input' as const, message: 'create failed', retryable: false } } }
    await workers.receive(f.worker.id, receipt)
    await Promise.all(reads)
    assert.equal(reads.length, 1)
    await workers.receive(f.worker.id, receipt)
    assert.equal(reads.length, 1)
    assert.equal((await f.tasks.get(f.task.projectId, f.task.id, context)).status, 'backlog')
  } finally { f.store.close() }
})

test('Worker rolled back receipt publishes no project invalidation', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    const notifications = new Notifications()
    let count = 0
    notifications.onProject(f.task.projectId, () => { count++ })
    const store: ServerStore = { fileWrites: f.store.fileWrites, tasks: f.store.tasks, resources: f.store.resources, identity: f.store.identity, commands: f.store.commands, cache: f.store.cache,
      transaction: work => f.store.transaction(async tx => { await work(tx); throw Error('forced rollback') }) }
    const workers = new WorkerService(store, notifications)
    await assert.rejects(workers.receive(f.worker.id, { type: 'ack', receipt: { commandId: run.createCommandId as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'create failed', retryable: false } } }), /forced rollback/)
    assert.equal(count, 0)
    assert.equal((await f.store.tasks.run(run.id))?.status, 'pending')
  } finally { f.store.close() }
})

async function reviewFixture(path = ':memory:') {
  const f = await fixture(path)
  const { run } = await f.launch()
  await f.store.transaction(tx => saveReviewRun(tx, run))
  let task = await f.tasks.get(f.task.projectId, f.task.id, context)
  task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
  task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
  return { ...f, run, task }
}
test('first Run freezes inherited review without changing Task CAS; project changes and metadata replacement cannot erase it', async () => {
  const f = await fixture()
  try {
    const project = await f.store.resources.getProject(f.task.projectId as never)
    assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const before = await f.tasks.get(f.task.projectId, f.task.id, context)
    await assert.rejects(f.tasks.launch(f.task.projectId, f.task.id, { ...f.request, assignment: { ...f.request.assignment, workerId: 'missing' } }, context))
    assert.equal((await f.tasks.get(f.task.projectId, f.task.id, context)).metadataJson.values.reviewPolicyFrozen, undefined)
    const { run } = await f.launch()
    const frozen = await f.tasks.get(f.task.projectId, f.task.id, context)
    assert.equal(frozen.version, before.version, 'server snapshot is part of Run launch, not a separate user edit')
    assert.equal(frozen.metadataJson.values.reviewPolicy, 'human')
    assert.equal(frozen.metadataJson.values.reviewPolicyFrozen, true)
    assert.equal((await f.launch()).run.id, run.id, 'exact launch replay leaves snapshot unchanged')
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'none', reviewPolicyVersion: 3 }))
    await assert.rejects(f.tasks.patch(f.task.projectId, f.task.id, { version: frozen.version, metadataJson: { schemaVersion: 1, values: { reviewPolicy: 'none' } } }, context), { code: 'invalid_transition' })
    const updated = await f.tasks.patch(f.task.projectId, f.task.id, { version: frozen.version, metadataJson: { schemaVersion: 1, values: { note: 'retained' } } }, context)
    assert.equal(updated.metadataJson.values.reviewPolicyFrozen, true)
    assert.equal(updated.metadataJson.values.reviewPolicy, 'human')
    assert.equal(updated.metadataJson.values.note, 'retained')
    const updatedDetail = await f.tasks.get(f.task.projectId, f.task.id, context)
    assert.equal(updatedDetail.capabilities?.transitions.in_review.allowed, false)
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    await assert.rejects(f.tasks.complete(task.projectId, task.id, { version: task.version, requestId: 'no-bypass', runId: run.id, summary: 'done', evidence: [] }, context), { code: 'invalid_transition' })
  } finally { f.store.close() }
})

test('human review submission is atomic, replayable and never grants a decision', async () => {
  const f = await fixture()
  try {
    const project = await f.store.resources.getProject(f.task.projectId as never)
    assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const input = { version: task.version, requestId: 'human-review-1', runId: run.id, summary: '结果', evidence: ['ref://test'] }
    const prior = await f.tasks.activity(task.projectId, task.id, 0, context)
    const result = await f.tasks.submitHumanReview(task.projectId, task.id, input, context)
    assert.equal(result.task.status, 'in_review')
    assert.equal(result.task.currentReviewId, result.review.id)
    assert.equal(result.review.status, 'requested')
    assert.equal(result.review.reviewer, null)
    assert.equal(result.task.metadataJson.values.reviewPolicyFrozen, true)
    assert.equal((await f.tasks.pendingReviews(task.projectId, context)).length, 1)
    assert.equal((await f.tasks.activity(task.projectId, task.id, 0, context)).length, prior.length + 1)
    assert.deepEqual(await f.tasks.submitHumanReview(task.projectId, task.id, input, context), result)
    assert.equal((await f.tasks.activity(task.projectId, task.id, 0, context)).length, prior.length + 1)
    await assert.rejects(f.tasks.submitHumanReview(task.projectId, task.id, { ...input, summary: 'other' }, context), { code: 'request_id_conflict' })
    await assert.rejects(f.tasks.submitHumanReview(task.projectId, task.id, { ...input, requestId: 'new' }, context), { code: 'version_conflict' })
    await assert.rejects(f.tasks.reviewAction(task.projectId, task.id, run.id, { version: result.task.version, status: 'approved' }, context), { code: 'invalid_transition' })
    await assert.rejects(f.tasks.complete(task.projectId, task.id, { ...input, version: result.task.version, requestId: 'complete' }, context), { code: 'invalid_transition' })
    assert.equal((await f.tasks.get(task.projectId, task.id, context)).status, 'in_review')
  } finally { f.store.close() }
})

function humanReviewProjections(store: ServerStore) {
  const projects = new ProjectAccessService(store)
  const projections = new ProjectionService(store, projects, new SessionAccessService(store, projects), { listOverlays: async () => [] } as never)
  const attention = new AttentionService(projections, { listTasks: async () => [], listRuns: async () => [], listDeadLetters: async () => [], listApprovalsPage: async () => ({ items: [], nextCursor: null }), listRunsPage: async () => ({ items: [], nextCursor: null }), listDeadLettersPage: async () => ({ items: [], nextCursor: null }) }, store)
  return { projections, attention }
}

test('current Project manager decides human review once; submitter, viewer, contributor and stale CAS cannot decide', async () => {
  const f = await fixture()
  try {
    const owner = await f.store.resources.getProject(f.task.projectId as never); assert.ok(owner)
    await f.store.transaction(tx => tx.resources.saveProject({ ...owner, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    for (const status of ['todo', 'in_progress'] as const) task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status }, context)
    const submission = await f.tasks.submitHumanReview(task.projectId, task.id, { version: task.version, requestId: 'decision-submission', runId: run.id, summary: '结果', evidence: ['ref://test'] }, context)
    const manager = randomUUID() as UserId, contributor = randomUUID() as UserId, viewer = randomUUID() as UserId
    const now = new Date().toISOString() as Timestamp
    await f.store.transaction(async tx => {
      for (const [id, role] of [[manager, 'manager'], [contributor, 'contributor'], [viewer, 'viewer']] as const) {
        await tx.identity.saveUser({ id, username: `review-${role}`, email: null, status: 'active', authVersion: 0, createdAt: now, statusChangedAt: now, deletedAt: null })
        await tx.identity.saveMembership({ teamId: f.worker.teamId, userId: id, role: 'member', joinedAt: now })
        await tx.identity.saveProjectGrant({ projectId: task.projectId as never, userId: id, role })
      }
    })
    const body = { version: submission.task.version, requestId: 'human-vote', reviewId: submission.review.id, status: 'approved' }
    for (const actor of [context.actor, contributor, viewer]) await assert.rejects(f.tasks.decideHumanReview(task.projectId, task.id, body, { actor, requestId: 'trace' }), { code: 'forbidden' })
    const { projections, attention } = humanReviewProjections(f.store)
    const pending = async (actor: UserId) => (await projections.approvals(actor, { sourceKind: 'task_review', status: 'pending' })).items
    for (const actor of [context.actor, contributor, viewer]) {
      const rows = await pending(actor)
      assert.equal(rows.length, 1, 'readable pending review remains visible without decision authority')
      assert.deepEqual(rows[0]?.decisionCapabilities, [])
      assert.equal((await attention.query(actor, false, { kind: 'approval' })).total, 0)
    }
    assert.deepEqual((await pending(manager))[0]?.decisionCapabilities, ['approve', 'changes_requested'])
    assert.equal((await attention.query(manager, false, { kind: 'approval' })).total, 1)
    const authorized = { actor: manager, requestId: 'trace' }
    await f.store.transaction(tx => tx.identity.removeMembership(f.worker.teamId, manager))
    assert.deepEqual(await pending(manager), [])
    assert.equal((await attention.query(manager, false, { kind: 'approval' })).total, 0)
    await assert.rejects(f.tasks.decideHumanReview(task.projectId, task.id, body, authorized), { code: 'forbidden' })
    await f.store.transaction(tx => tx.identity.saveMembership({ teamId: f.worker.teamId, userId: manager, role: 'member', joinedAt: now }))
    assert.deepEqual((await pending(manager))[0]?.decisionCapabilities, ['approve', 'changes_requested'])
    await f.store.transaction(tx => tx.identity.removeProjectGrant(task.projectId as never, manager))
    assert.ok((await pending(manager)).every(row => row.decisionCapabilities.length === 0))
    assert.equal((await attention.query(manager, false, { kind: 'approval' })).total, 0)
    await assert.rejects(f.tasks.decideHumanReview(task.projectId, task.id, body, authorized), { code: 'forbidden' })
    await f.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: task.projectId as never, userId: manager, role: 'manager' }))
    await assert.rejects(f.tasks.decideHumanReview(task.projectId, task.id, { ...body, version: body.version - 1 }, authorized), { code: 'version_conflict' })
    const before = await f.tasks.activity(task.projectId, task.id, 0, context)
    const first = await f.tasks.decideHumanReview(task.projectId, task.id, body, authorized)
    assert.equal(first.task.status, 'done'); assert.equal(first.task.currentReviewId, null)
    assert.equal(first.review.status, 'approved'); assert.equal(first.review.reviewer, manager)
    assert.deepEqual(await pending(manager), [])
    assert.equal((await attention.query(manager, false, { kind: 'approval' })).total, 0)
    assert.equal((await f.tasks.pendingReviews(task.projectId, context)).length, 0)
    assert.equal((await f.tasks.activity(task.projectId, task.id, 0, context)).length, before.length + 1)
    assert.deepEqual(await f.tasks.decideHumanReview(task.projectId, task.id, body, authorized), first)
    await assert.rejects(f.tasks.decideHumanReview(task.projectId, task.id, { ...body, status: 'changes_requested', reason: '不完整' }, authorized), { code: 'request_id_conflict' })
    await assert.rejects(f.tasks.decideHumanReview(task.projectId, task.id, { ...body, requestId: 'second-vote' }, authorized), { code: 'version_conflict' })
    assert.equal((await f.tasks.activity(task.projectId, task.id, 0, context)).length, before.length + 1)
    await f.store.transaction(tx => tx.identity.removeProjectGrant(task.projectId as never, manager))
    await assert.rejects(f.tasks.decideHumanReview(task.projectId, task.id, body, authorized), { code: 'forbidden' })
  } finally { f.store.close() }
})

test('human reviewer changes requested returns to implementation, closes old cycle and permits another Run', async () => {
  const f = await fixture()
  try {
    const project = await f.store.resources.getProject(f.task.projectId as never); assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    for (const status of ['todo', 'in_progress'] as const) task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status }, context)
    const submitter = randomUUID() as UserId, now = new Date().toISOString() as Timestamp
    await f.store.transaction(async tx => {
      await tx.identity.saveUser({ id: submitter, username: 'review-submitter', email: null, status: 'active', authVersion: 0, createdAt: now, statusChangedAt: now, deletedAt: null })
      await tx.identity.saveMembership({ teamId: f.worker.teamId, userId: submitter, role: 'member', joinedAt: now })
      await tx.identity.saveProjectGrant({ projectId: task.projectId as never, userId: submitter, role: 'contributor' })
    })
    const submitted = await f.tasks.submitHumanReview(task.projectId, task.id, { version: task.version, requestId: 'needs-fix', runId: run.id, summary: '成果', evidence: [] }, { actor: submitter, requestId: 'submit-trace' })
    const input = { version: submitted.task.version, requestId: 'return-fix', reviewId: submitted.review.id, status: 'changes_requested', reason: '缺少复现步骤' }
    const { projections, attention } = humanReviewProjections(f.store)
    await f.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: task.projectId as never, userId: submitter, role: 'manager' }))
    const selfReview = (await projections.approvals(submitter, { sourceKind: 'task_review', status: 'pending' })).items
    assert.equal(selfReview.length, 1)
    assert.deepEqual(selfReview[0]?.decisionCapabilities, [])
    assert.equal((await attention.query(submitter, false, { kind: 'approval' })).total, 0)
    await assert.rejects(f.tasks.decideHumanReview(task.projectId, task.id, input, { actor: submitter, requestId: 'self-vote' }), { code: 'forbidden' })
    const pending = (await projections.approvals(context.actor, { sourceKind: 'task_review', status: 'pending' })).items
    assert.equal(pending.length, 1)
    assert.deepEqual(pending[0]?.decisionCapabilities, ['approve', 'changes_requested'])
    assert.equal((await attention.query(context.actor, false, { kind: 'approval' })).total, 1)
    const decision = await f.tasks.decideHumanReview(task.projectId, task.id, input, context)
    assert.equal((await attention.query(context.actor, false, { kind: 'approval' })).total, 0)
    assert.equal(decision.task.status, 'in_progress'); assert.equal(decision.review.status, 'changes_requested')
    assert.equal(decision.task.currentReviewId, null); assert.equal(decision.review.closedAt, decision.review.decidedAt)
    assert.deepEqual(await f.tasks.pendingReviews(task.projectId, context), [])
    assert.equal((await f.tasks.activity(task.projectId, task.id, 0, context)).at(-1)?.payload.reason, input.reason)
    assert.deepEqual(await f.tasks.decideHumanReview(task.projectId, task.id, input, context), decision)
    const nextRun = await f.tasks.launch(task.projectId, task.id, { ...f.request, requestId: 'after-changes' }, context)
    assert.equal(nextRun.run.attempt, run.attempt + 1)
    await assert.rejects(f.tasks.decideHumanReview(task.projectId, task.id, { ...input, requestId: 'late-vote' }, context), { code: 'version_conflict' })
  } finally { f.store.close() }
})

test('real HTTP human submission checks auth, PAT scope, exact replay and old decision denial', async () => {
  const f = await fixture()
  const http = createServer(httpHandler({ service: f.server, auth: new AuthenticationService(f.store, administratorDirectory(f.store)), streams: new SessionStreams(f.server), tasks: f.tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/projects/${f.task.projectId}/tasks/${f.task.id}`
  const post = async (suffix: string, body: unknown, token: string | null = administratorToken) => {
    const response = await fetch(base + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    return { status: response.status, data: await response.json() as Record<string, any> }
  }
  try {
    const project = await f.store.resources.getProject(f.task.projectId as never); assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const input = { version: task.version, requestId: 'human-http', runId: run.id, summary: '提交成果', evidence: ['test://ref'] }
    const before = await f.tasks.activity(task.projectId, task.id, 0, context)
    assert.equal((await post('/human-review-submission', input, null)).status, 401)
    assert.equal((await post('/human-review-submission', input, await issuePat(f.store, context.actor, -1000))).status, 401)
    assert.equal((await post('/human-review-submission', input, await issuePat(f.store, context.actor, 60_000, ['read']))).status, 403)
    assert.equal((await post('/human-review-submission', { ...input, requestId: 'invalid', evidence: Array(21).fill('ref') })).status, 400)
    assert.equal((await post('/human-review-submission', input, 'bad-pat')).status, 401)
    assert.deepEqual(await f.tasks.activity(task.projectId, task.id, 0, context), before)
    const first = await post('/human-review-submission', input)
    assert.equal(first.status, 200, JSON.stringify(first))
    assert.equal(first.data.review.status, 'requested')
    assert.equal(first.data.review.reviewer, null)
    const replay = await post('/human-review-submission', input)
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.data, first.data)
    assert.equal((await post('/human-review-submission', { ...input, summary: 'different' })).status, 409)
    assert.equal((await post(`/runs/${run.id}/review`, { status: 'approved', version: first.data.task.version })).status, 409)
    assert.equal((await f.tasks.activity(task.projectId, task.id, 0, context)).length, before.length + 1)
  } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); f.store.close() }
})

test('real HTTP human decision enforces PAT write, current authority, explicit identity and exact replay', async () => {
  const f = await fixture()
  const http = createServer(httpHandler({ service: f.server, auth: new AuthenticationService(f.store, administratorDirectory(f.store)), streams: new SessionStreams(f.server), tasks: f.tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/projects/${f.task.projectId}/tasks/${f.task.id}`
  const post = async (body: unknown, token: string | null = administratorToken, taskId = f.task.id) => {
    const response = await fetch(base.replace(`/${f.task.id}`, `/${taskId}`) + '/human-review-decision', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    return { status: response.status, data: await response.json() as Record<string, any> }
  }
  try {
    const project = await f.store.resources.getProject(f.task.projectId as never); assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    for (const status of ['todo', 'in_progress'] as const) task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status }, context)
    const submitter = randomUUID() as UserId, now = new Date().toISOString() as Timestamp
    await f.store.transaction(async tx => {
      await tx.identity.saveUser({ id: submitter, username: 'decision-http-submitter', email: null, status: 'active', authVersion: 0, createdAt: now, statusChangedAt: now, deletedAt: null })
      await tx.identity.saveMembership({ teamId: f.worker.teamId, userId: submitter, role: 'member', joinedAt: now })
      await tx.identity.saveProjectGrant({ projectId: task.projectId as never, userId: submitter, role: 'contributor' })
    })
    const submitted = await f.tasks.submitHumanReview(task.projectId, task.id, { version: task.version, requestId: 'http-submit-for-decision', runId: run.id, summary: '成果', evidence: [] }, { actor: submitter, requestId: 'trace' })
    const body = { version: submitted.task.version, requestId: 'http-approve', reviewId: submitted.review.id, status: 'approved' }
    const before = await f.tasks.activity(task.projectId, task.id, 0, context)
    assert.equal((await post(body, null)).status, 401)
    assert.equal((await post(body, await issuePat(f.store, context.actor, -1000))).status, 401)
    assert.equal((await post(body, await issuePat(f.store, context.actor, 60_000, ['read']))).status, 403)
    assert.equal((await post({ ...body, status: 'changes_requested' })).status, 400)
    assert.equal((await post({ ...body, reviewId: 'unrelated' })).status, 404)
    assert.equal((await post(body, administratorToken, 'other-task')).status, 404)
    assert.deepEqual(await f.tasks.activity(task.projectId, task.id, 0, context), before)
    const first = await post(body)
    assert.equal(first.status, 200, JSON.stringify(first)); assert.equal(first.data.task.status, 'done')
    const replay = await post(body); assert.equal(replay.status, 200); assert.deepEqual(replay.data, first.data)
    assert.equal((await post({ ...body, status: 'changes_requested', reason: '拒绝' })).status, 409)
    assert.equal((await f.tasks.activity(task.projectId, task.id, 0, context)).length, before.length + 1)
  } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); f.store.close() }
})

test('legacy no-policy review receipt authorization still permits a current contributor', async () => {
  const f = await reviewFixture()
  try {
    const requested = await f.tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { version: f.task.version, status: 'requested' }, context)
    const contributor = randomUUID() as UserId, now = new Date().toISOString() as Timestamp
    await f.store.transaction(async tx => {
      await tx.identity.saveUser({ id: contributor, username: 'legacy-reviewer', email: null, status: 'active', authVersion: 0, createdAt: now, statusChangedAt: now, deletedAt: null })
      await tx.identity.saveMembership({ teamId: f.worker.teamId, userId: contributor, role: 'member', joinedAt: now })
      await tx.identity.saveProjectGrant({ projectId: f.task.projectId as never, userId: contributor, role: 'contributor' })
    })
    const legacyContext = { actor: contributor, requestId: 'legacy-vote' }
    const decided = await f.tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { version: requested.task.version, status: 'approved' }, legacyContext)
    await f.tasks.authorizeReviewReplay(f.task.projectId, f.task.id, f.run.id, decided.review.id, legacyContext)
    assert.equal(decided.review.status, 'approved')
  } finally { f.store.close() }
})

for (const decision of ['approve', 'changes_requested'] as const) test(`approval router HTTP ${decision} dispatches frozen human policy and reauthorizes durable replay`, async () => {
  const f = await fixture()
  const directory = await mkdtemp(join(tmpdir(), 'human-approval-router-'))
  const receiptPath = join(directory, 'receipts.sqlite')
  let receipts = new SqliteApprovalDecisionRepository(receiptPath)
  const projects = new ProjectAccessService(f.store)
  const projections = new ProjectionService(f.store, projects, new SessionAccessService(f.store, projects), receipts)
  let router = new ApprovalDecisionRouter(projections, f.tasks, f.server, receipts)
  const http = createServer(httpHandler({ service: f.server, auth: new AuthenticationService(f.store, administratorDirectory(f.store)), streams: new SessionStreams(f.server), tasks: f.tasks, projections, approvalDecisions: router }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/approvals`
  try {
    const project = await f.store.resources.getProject(f.task.projectId as never); assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    for (const status of ['todo', 'in_progress'] as const) task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status }, context)
    const submitted = await f.tasks.submitHumanReview(task.projectId, task.id, { version: task.version, requestId: 'router-submit', runId: run.id, summary: '成果', evidence: [] }, context)
    const manager = randomUUID() as UserId, now = new Date().toISOString() as Timestamp
    await f.store.transaction(async tx => {
      await tx.identity.saveUser({ id: manager, username: 'router-reviewer', email: null, status: 'active', authVersion: 0, createdAt: now, statusChangedAt: now, deletedAt: null })
      await tx.identity.saveMembership({ teamId: project.teamId, userId: manager, role: 'member', joinedAt: now })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId: manager, role: 'manager' })
    })
    const token = await issuePat(f.store, manager, 60_000)
    const listing = await fetch(`${base}?sourceKind=task_review`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(listing.status, 200)
    const pending = (await listing.json() as { items: import('@wemux/server-domain').ApprovalView[] }).items[0]!
    assert.deepEqual(pending.decisionCapabilities, ['approve', 'changes_requested'])
    assert.equal(pending.projectionKey, `task_review:${task.id}:${run.id}:${submitted.review.id}`)
    assert.equal(pending.sourceRevision, `${submitted.task.version}:requested`)
    const body = { decision, requestId: 'router-vote', sourceRevision: pending.sourceRevision, ...(decision === 'changes_requested' ? { note: '请补充验证步骤' } : {}) }
    const post = async (value: unknown = body, credential: string | null = token) => {
      const response = await fetch(`${base}/${encodeURIComponent(pending.projectionKey)}/decisions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(value) })
      return { status: response.status, data: await response.json() as Record<string, any> }
    }
    const before = await f.tasks.activity(task.projectId, task.id, 0, context)
    assert.equal((await post(body, null)).status, 401)
    assert.equal((await post(body, await issuePat(f.store, manager, 60_000, ['read']))).status, 403)
    assert.equal((await post(body, administratorToken)).data.error.code, 'approval_stale', 'submitter cannot review')
    await f.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: manager, role: 'contributor' }))
    assert.equal((await post()).data.error.code, 'approval_stale', 'contributor cannot decide')
    await f.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: manager, role: 'manager' }))
    assert.equal((await post({ ...body, sourceRevision: `${submitted.task.version - 1}:requested` })).data.error.code, 'source_revision_conflict')
    assert.equal((await post({ ...body, decision: 'deny' })).data.error.code, 'approval_stale')
    for (const note of [undefined, '', '   ']) assert.equal((await post({ ...body, decision: 'changes_requested', note })).status, 400)
    assert.deepEqual(await f.tasks.activity(task.projectId, task.id, 0, context), before)
    const first = await post()
    assert.equal(first.status, 200, JSON.stringify(first.data))
    assert.equal(first.data.replayed, false)
    assert.equal(first.data.approval.status, decision === 'approve' ? 'approved' : 'changes_requested')
    assert.deepEqual(first.data.approval.source, pending.source)
    const savedTask = await f.tasks.get(task.projectId, task.id, context)
    const review = await f.store.tasks.reviewById(submitted.review.id)
    assert.equal(savedTask.status, decision === 'approve' ? 'done' : 'in_progress')
    assert.equal(savedTask.currentReviewId, null)
    assert.equal(review?.reviewer, manager)
    assert.equal(review?.status, first.data.approval.status)
    const after = await f.tasks.activity(task.projectId, task.id, 0, context)
    assert.equal(after.length, before.length + 1)
    assert.equal(after.at(-1)?.payload.reason, body.note ?? null)
    assert.equal(await projections.approval(manager, pending.projectionKey), null, 'terminal review disappears from pending projections')
    const replay = await post()
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.data, { ...first.data, replayed: true })
    assert.equal((await post({ ...body, note: 'different' })).data.error.code, 'idempotency_conflict')
    await f.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: manager, role: 'contributor' }))
    const revokedReplay = await post()
    assert.equal(revokedReplay.status, 403)
    assert.equal(revokedReplay.data.approval, undefined)
    assert.equal(revokedReplay.data.replayed, undefined)
    await f.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: manager, role: 'manager' }))
    // The router must pass precisely the same identity/body as the domain receipt.
    const domainReplay = await f.tasks.decideHumanReview(task.projectId, task.id, { version: submitted.task.version, reviewId: submitted.review.id, requestId: body.requestId, status: review!.status, reason: body.note }, { actor: manager, requestId: body.requestId })
    assert.deepEqual(domainReplay.review, review)
    const { capabilities: _capabilities, ...storedTask } = savedTask
    assert.deepEqual(domainReplay.task, storedTask)
    receipts.close(); receipts = new SqliteApprovalDecisionRepository(receiptPath)
    router = new ApprovalDecisionRouter(projections, f.tasks, f.server, receipts)
    const signed = { ...body, fingerprint: createHash('sha256').update(JSON.stringify({ decision, note: body.note ?? null, requestId: body.requestId, sourceRevision: body.sourceRevision })).digest('hex') }
    assert.deepEqual(await router.decide(manager, pending.projectionKey, signed), { ...first.data, replayed: true })
    await f.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: manager, role: 'contributor' }))
    await assert.rejects(router.decide(manager, pending.projectionKey, signed), { code: 'forbidden' })
    await assert.rejects(f.tasks.decideHumanReview(task.projectId, task.id, { version: submitted.task.version, reviewId: submitted.review.id, requestId: body.requestId, status: review!.status, reason: body.note }, { actor: manager, requestId: body.requestId }), { code: 'forbidden' })
    await f.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: manager, role: 'manager' }))
    await f.store.transaction(tx => tx.identity.removeMembership(project.teamId, manager))
    await assert.rejects(router.decide(manager, pending.projectionKey, signed))
    assert.deepEqual(await f.tasks.activity(task.projectId, task.id, 0, context), after)
  } finally {
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
    receipts.close(); f.store.close(); await rm(directory, { recursive: true, force: true })
  }
})

test('human review submission concurrent CAS, durable replay, revoked writer and wrong-scoped replay', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'human-review-')), 'server.sqlite')
  let f = await fixture(path)
  try {
    const project = await f.store.resources.getProject(f.task.projectId as never)
    assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const input = { version: task.version, requestId: 'human-race', runId: run.id, summary: 'verified result', evidence: [] }
    const decisions = await Promise.allSettled([f.tasks.submitHumanReview(task.projectId, task.id, input, context), f.tasks.submitHumanReview(task.projectId, task.id, input, context)])
    assert.equal(decisions.filter(item => item.status === 'fulfilled').length, 2)
    const receipt = (decisions[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.tasks.submitHumanReview>>>).value
    assert.deepEqual((decisions[1] as typeof decisions[0]).status === 'fulfilled' ? (decisions[1] as PromiseFulfilledResult<typeof receipt>).value : null, receipt)
    assert.equal((await f.tasks.activity(task.projectId, task.id, 0, context)).filter(event => event.type === 'task.transitioned' && event.payload.action === 'review.submitted').length, 1)
    const taskId = task.id, projectId = task.projectId
    const ownerBefore = await f.store.resources.getProject(projectId as never)
    assert.ok(ownerBefore)
    f.store.close()
    const persisted = new SqliteServerStore(path)
    try {
      const reopened = new TaskService(persisted)
      assert.deepEqual(await reopened.submitHumanReview(projectId, taskId, input, context), receipt)
      await assert.rejects(reopened.submitHumanReview(projectId, 'not-this-task', input, context), { code: 'not_found' })
      await persisted.transaction(tx => tx.resources.saveProject({ ...ownerBefore, ownerId: 'another-owner' as never }))
      await assert.rejects(reopened.submitHumanReview(projectId, taskId, input, context), { code: 'forbidden' })
    } finally { persisted.close() }
  } finally { try { f.store.close() } catch { /* already closed */ } await rm(join(path, '..'), { recursive: true, force: true }) }
})

for (const status of ['failed', 'cancelled', 'succeeded'] as const) test(`human review submission checks latest ${status} Run independently of policy`, async () => {
  const f = await fixture()
  try {
    const project = await f.store.resources.getProject(f.task.projectId as never)
    assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const { run } = await f.launch()
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const input = { version: task.version, requestId: 'human-invalid', runId: run.id, summary: '成果', evidence: [] }
    const before = await f.tasks.activity(task.projectId, task.id, 0, context)
    await assert.rejects(f.tasks.submitHumanReview(task.projectId, task.id, input, context), { code: 'active_run' })
    await f.store.transaction(tx => saveRunProjection(tx, { ...run, status, finishedAt: new Date().toISOString() }, 'run.finished'))
    const afterTerminal = await f.tasks.activity(task.projectId, task.id, 0, context)
    assert.equal(afterTerminal.length, before.length + 1)
    await assert.rejects(f.tasks.submitHumanReview(task.projectId, task.id, { ...input, runId: 'wrong-run' }, context), { code: 'invalid_transition' })
    if (status !== 'succeeded') {
      await assert.rejects(f.tasks.submitHumanReview(task.projectId, task.id, input, context), { code: 'invalid_transition' })
      assert.deepEqual(await f.tasks.activity(task.projectId, task.id, 0, context), afterTerminal)
      assert.equal(await f.store.tasks.review(run.id), null)
    }
  } finally { f.store.close() }
})

for (const policy of ['none', 'agent'] as const) test(`human review submission rejects ${policy} policy with an eligible succeeded Run`, async () => {
  const f = await fixture()
  try {
    const project = await f.store.resources.getProject(f.task.projectId as never)
    assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: policy, reviewPolicyVersion: 2 }))
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const before = await f.tasks.activity(task.projectId, task.id, 0, context)
    await assert.rejects(f.tasks.submitHumanReview(task.projectId, task.id, { version: task.version, requestId: `human-${policy}`, runId: run.id, summary: '成果', evidence: [] }, context), { code: 'invalid_transition' })
    assert.equal(await f.store.tasks.review(run.id), null)
    assert.deepEqual(await f.tasks.activity(task.projectId, task.id, 0, context), before)
  } finally { f.store.close() }
})

test('Project default changes pin active pre-Run and legacy executed Tasks without weakening requirements', async () => {
  const f = await fixture()
  try {
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const project = await f.store.resources.getProject(task.projectId as never)
    assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const { ProjectAccessService } = await import('../application/project-access-service.ts')
    const access = new ProjectAccessService(f.store)
    await access.updateReviewPolicy(context.actor, task.projectId as never, { reviewPolicy: 'none', version: 2 })
    const frozen = await f.tasks.get(task.projectId, task.id, context)
    assert.equal(frozen.version, task.version)
    assert.equal(frozen.metadataJson.values.reviewPolicy, 'human')
    assert.equal(frozen.metadataJson.values.reviewPolicyFrozen, true)
    assert.equal(frozen.capabilities?.transitions.in_review.allowed, false)
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    const afterRun = await f.tasks.get(task.projectId, task.id, context)
    await assert.rejects(f.tasks.complete(task.projectId, task.id, { version: afterRun.version, requestId: 'legacy-requirement', runId: run.id, summary: 'done', evidence: [] }, context), { code: 'invalid_transition' })
    // Emulate an upgraded database with a historical Run but no policy snapshot.
    await f.store.transaction(async tx => {
      const saved = await tx.tasks.get(task.id)
      assert.ok(saved)
      await tx.tasks.save({ ...saved, metadataJson: { schemaVersion: 1, values: {} } })
    })
    await access.updateReviewPolicy(context.actor, task.projectId as never, { reviewPolicy: 'human', version: 3 })
    // This record represents a historical Run created before policy snapshots existed.
    await f.store.transaction(async tx => {
      const saved = await tx.tasks.get(task.id)
      assert.ok(saved)
      await tx.tasks.save({ ...saved, metadataJson: { schemaVersion: 1, values: {} } })
    })
    await access.updateReviewPolicy(context.actor, task.projectId as never, { reviewPolicy: 'none', version: 4 })
    const legacy = await f.tasks.get(task.projectId, task.id, context)
    assert.equal(legacy.metadataJson.values.reviewPolicy, 'human')
    assert.equal(legacy.metadataJson.values.reviewPolicyFrozen, true)
    // A legacy Run created under a Project with no review cannot be treated
    // as proof of that old default after the Project changes.
    await f.store.transaction(async tx => {
      const saved = await tx.tasks.get(task.id)
      assert.ok(saved)
      await tx.tasks.save({ ...saved, metadataJson: { schemaVersion: 1, values: {} } })
    })
    await access.updateReviewPolicy(context.actor, task.projectId as never, { reviewPolicy: 'agent', version: 5 })
    assert.equal((await f.tasks.get(task.projectId, task.id, context)).metadataJson.values.reviewPolicy, 'human')
  } finally { f.store.close() }
})

test('explicit completion requires terminal latest Run, CAS, stable receipt, and never follows Run success automatically', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const input = { version: task.version, requestId: 'finish-1', runId: run.id, summary: '测试完成', evidence: ['https://example.org/result'] }
    await assert.rejects(f.tasks.complete(task.projectId, task.id, input, context), { code: 'active_run' })
    await f.store.transaction(tx => saveReviewRun(tx, run))
    assert.equal((await f.tasks.get(task.projectId, task.id, context)).status, 'in_progress')
    await assert.rejects(f.tasks.complete(task.projectId, task.id, { ...input, version: input.version - 1 }, context), { code: 'version_conflict' })
    const receipt = await f.tasks.complete(task.projectId, task.id, input, context)
    assert.equal(receipt.task.status, 'done')
    assert.equal(receipt.task.version, input.version + 1)
    assert.deepEqual(await f.tasks.complete(task.projectId, task.id, input, context), receipt)
    await assert.rejects(f.tasks.complete(task.projectId, task.id, { ...input, summary: 'changed' }, context), { code: 'request_id_conflict' })
    const activities = await f.tasks.activity(task.projectId, task.id, 0, context)
    assert.equal(activities.filter(activity => activity.payload.action === 'completion.submitted').length, 1)
    assert.deepEqual(activities.at(-1)?.payload.evidence, input.evidence)
  } finally { f.store.close() }
})

test('completion HTTP exact replay is durable; revoked Project grant denies replay and creates no new activity', async () => {
  const f = await fixture()
  const http = createServer(httpHandler({ service: f.server, auth: new AuthenticationService(f.store, administratorDirectory(f.store)), streams: new SessionStreams(f.server), tasks: f.tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  try {
    const member = randomUUID() as UserId, now = new Date().toISOString() as Timestamp
    await f.store.transaction(async tx => {
      await tx.identity.saveUser({ id: member, username: 'completion-grantee', email: null, status: 'active', authVersion: 0, createdAt: now, statusChangedAt: now, deletedAt: null })
      await tx.identity.saveMembership({ teamId: f.worker.teamId, userId: member, role: 'member', joinedAt: now })
      await tx.identity.saveProjectGrant({ projectId: f.task.projectId as never, userId: member, role: 'contributor' })
    })
    const token = await issuePat(f.store, member, 60_000)
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    for (const status of ['todo', 'in_progress'] as const) task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status }, context)
    const request = { requestId: 'http-completion-replay', version: task.version, runId: run.id, summary: '已交付', evidence: ['artifact://run'] }
    const path = `http://127.0.0.1:${address.port}/projects/${task.projectId}/tasks/${task.id}/completion`
    const send = async (body = request) => {
      const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, data: await response.json() }
    }
    const first = await send(); assert.equal(first.status, 200)
    assert.equal(first.data.task.status, 'done'); assert.equal(first.data.runId, run.id)
    const replay = await send(); assert.equal(replay.status, 200); assert.deepEqual(replay.data, first.data)
    const conflict = await send({ ...request, summary: '冲突的摘要' }); assert.equal(conflict.status, 409); assert.equal(conflict.data.error.code, 'request_id_conflict')
    const before = await f.tasks.activity(task.projectId, task.id, 0, context)
    await f.store.transaction(tx => tx.identity.removeProjectGrant(task.projectId as never, member))
    const denied = await send(); assert.equal(denied.status, 403); assert.equal(denied.data.error.code, 'forbidden')
    assert.deepEqual(await f.tasks.activity(task.projectId, task.id, 0, context), before)
  } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); f.store.close() }
})

test('completed Task restoration survives block/cancel round trips without permitting first-time done bypass', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    for (const status of ['todo', 'in_progress'] as const) task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status }, context)
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'done' }, context), { code: 'invalid_transition' })
    task = (await f.tasks.complete(task.projectId, task.id, { version: task.version, requestId: 'completion-restorable', runId: run.id, summary: '完成', evidence: [] }, context)).task
    for (const statuses of [
      ['blocked', 'done'], ['cancelled', 'done'], ['blocked', 'cancelled', 'blocked', 'done'], ['cancelled', 'blocked', 'cancelled', 'done'],
    ] as const) {
      for (const status of statuses) task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status }, context)
      assert.equal(task.status, 'done')
    }
  } finally { f.store.close() }
})

test('latest completed Run cannot be replaced while done or in its restoration chain', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    task = (await f.tasks.complete(task.projectId, task.id, { version: task.version, requestId: 'completion-for-run-fence', runId: run.id, summary: '已完成', evidence: [] }, context)).task
    const beforeReplay = await f.tasks.activity(task.projectId, task.id, 0, context)
    const original = await f.launch()
    assert.equal(original.run.id, run.id, 'exact launch receipt replays without restarting a completed Run')
    assert.deepEqual(await f.tasks.activity(task.projectId, task.id, 0, context), beforeReplay)
    const launch = (id: string) => f.launch({ ...f.request, requestId: id })
    for (const status of ['done', 'blocked', 'cancelled', 'blocked', 'done'] as const) {
      if (task.status !== status) task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status }, context)
      await assert.rejects(launch(`reopen-fence-${status}`), { code: 'invalid_transition' })
      await assert.rejects(f.tasks.launch(task.projectId, task.id, { ...f.request, requestId: `reopen-fence-reuse-${status}`, mode: 'reuse', reuseSessionId: run.sessionId }, context), { code: 'invalid_transition' })
      assert.equal((await f.tasks.runs(task.projectId, task.id, context)).length, 1)
    }
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const next = await launch('reopen-after-explicit-progress')
    assert.equal(next.run.attempt, 2)
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'done' }, context), { code: 'active_run' })
    await f.store.transaction(tx => saveReviewRun(tx, next.run))
    task = await f.tasks.get(task.projectId, task.id, context)
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'done' }, context), { code: 'invalid_transition' })
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'blocked' }, context)
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'done' }, context), { code: 'invalid_transition' })
    assert.equal((await f.tasks.get(task.projectId, task.id, context)).status, 'blocked')
  } finally { f.store.close() }
})

test('completion receipt survives store restart; revoked project authority cannot replay and invalid payload never writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'completion-restart-')), path = join(dir, 'db')
  const f = await fixture(path)
  let reopened: SqliteServerStore | undefined
  try {
    const { run } = await f.launch()
    await f.store.transaction(tx => saveReviewRun(tx, run))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const body = { version: task.version, requestId: 'durable-completion', runId: run.id, summary: '已完成', evidence: ['https://example.org/evidence'] }
    for (const invalid of [{ ...body, summary: '中'.repeat(6000) }, { ...body, evidence: ['x\0y'] }, { ...body, requestId: '' }]) {
      await assert.rejects(f.tasks.complete(task.projectId, task.id, invalid, context), { code: 'invalid_request' })
      assert.equal((await f.tasks.get(task.projectId, task.id, context)).status, 'in_progress')
    }
    const receipt = await f.tasks.complete(task.projectId, task.id, body, context)
    f.store.close()
    reopened = new SqliteServerStore(path)
    const reopenedTasks = new TaskService(reopened)
    assert.deepEqual(await reopenedTasks.complete(task.projectId, task.id, body, context), receipt)
    await reopened.transaction(async tx => {
      const project = (await tx.resources.getProject(task.projectId as never))!
      await tx.resources.saveProject({ ...project, ownerId: randomUUID() as UserId, shareScope: 'owner-only' })
    })
    await assert.rejects(reopenedTasks.complete(task.projectId, task.id, body, context), { code: 'forbidden' })
  } finally { reopened?.close(); f.store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('review policy is manager-controlled and direct completion fails closed while required review is configured', async () => {
  const f = await fixture()
  try {
    const contributor = randomUUID() as UserId, at = new Date().toISOString() as Timestamp
    await f.store.transaction(async tx => {
      await tx.identity.saveUser({ id: contributor, email: 'run-contributor@example.test', username: 'run-contributor', status: 'active', createdAt: at })
      await tx.identity.saveMembership({ teamId: f.worker.teamId, userId: contributor, role: 'member', joinedAt: at })
      await tx.identity.saveProjectGrant({ projectId: f.task.projectId as never, userId: contributor, role: 'contributor' })
    })
    const author = { actor: contributor, requestId: 'run-contributor' }
    const metadataJson = { schemaVersion: 1, values: { reviewPolicy: 'human' } }
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { metadataJson }, author), { code: 'forbidden' })
    await assert.rejects(f.tasks.create(task.projectId, { title: 'Contributor review override', metadataJson, requestId: 'review-override' }, author), { code: 'forbidden' })
    task = await f.tasks.patch(task.projectId, task.id, { metadataJson, version: task.version }, context)
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { metadataJson: { schemaVersion: 1, values: {} }, version: task.version }, author), { code: 'forbidden' })
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { metadataJson: { schemaVersion: 1, values: { reviewPolicy: 'future-unknown' } }, version: task.version }, context), { code: 'invalid_request' })
    const { run } = await f.launch()
    assert.equal((await f.tasks.get(task.projectId, task.id, context)).metadataJson.values.reviewPolicyFrozen, true, 'an explicit policy is pinned on the first Run too')
    await f.store.transaction(tx => saveReviewRun(tx, run))
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const advertised = await f.tasks.get(task.projectId, task.id, context)
    assert.equal(advertised.capabilities?.transitions.in_review.allowed, false, 'configured review entry must not advertise an unavailable decision workflow')
    assert.equal((await f.tasks.run(task.projectId, task.id, run.id, context)).capabilities.reviewRequest.allowed, false)
    const completion = { version: task.version, requestId: 'cannot-bypass-policy', runId: run.id, summary: '已完成', evidence: [] }
    await assert.rejects(f.tasks.complete(task.projectId, task.id, completion, context), { code: 'invalid_transition' })
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'done' }, author), { code: 'invalid_transition' })
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { metadataJson: { schemaVersion: 1, values: {} }, version: task.version }, context), { code: 'invalid_transition' })
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { status: 'in_review', version: task.version }, context), { code: 'invalid_transition' })
    await assert.rejects(f.tasks.reviewAction(task.projectId, task.id, run.id, { version: task.version, status: 'requested' }, context), { code: 'invalid_transition' })
    assert.equal((await f.tasks.get(task.projectId, task.id, context)).status, 'in_progress')
  } finally { f.store.close() }
})

test('inherited configured Project review cannot be bypassed and freezes at first Run; manager cannot weaken it after a retry', async () => {
  const f = await fixture()
  try {
    const projectId = f.task.projectId
    await f.store.transaction(async tx => {
      const project = (await tx.resources.getProject(projectId as never))!
      await tx.resources.saveProject({ ...project, reviewPolicy: 'human' })
    })
    let task = await f.tasks.get(projectId, f.task.id, context)
    assert.equal(task.metadataJson.values.reviewPolicy, undefined)
    assert.equal(task.capabilities?.transitions.in_review.allowed, false)
    const { run } = await f.launch()
    task = await f.tasks.get(projectId, task.id, context)
    assert.equal(task.metadataJson.values.reviewPolicy, 'human')
    assert.equal(task.metadataJson.values.reviewPolicyFrozen, true)
    await f.store.transaction(async tx => {
      const project = (await tx.resources.getProject(projectId as never))!
      await tx.resources.saveProject({ ...project, reviewPolicy: 'none' })
    })
    await f.store.transaction(tx => saveReviewRun(tx, run))
    task = await f.tasks.patch(projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    await assert.rejects(f.tasks.patch(projectId, task.id, { version: task.version, metadataJson: { schemaVersion: 1, values: { reviewPolicy: 'none' } } }, context), { code: 'invalid_transition' })
    await assert.rejects(f.tasks.complete(projectId, task.id, { version: task.version, requestId: 'inherited-bypass', runId: run.id, summary: 'no', evidence: [] }, context), { code: 'invalid_transition' })
    await assert.rejects(f.tasks.reviewAction(projectId, task.id, run.id, { version: task.version, status: 'requested' }, context), { code: 'invalid_transition' })
    assert.equal((await f.tasks.get(projectId, task.id, context)).metadataJson.values.reviewPolicy, 'human')
  } finally { f.store.close() }
})

test('legacy Run with no explicit review policy is immutable to manager metadata replacement', async () => {
  const f = await fixture()
  try {
    await f.launch()
    const task = await f.tasks.get(f.task.projectId, f.task.id, context)
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { version: task.version, metadataJson: { schemaVersion: 1, values: { reviewPolicy: 'none' } } }, context), { code: 'invalid_transition' })
  } finally { f.store.close() }
})

test('review cycles close ordinary exits, preserve decisions and reject stale same-state assignment CAS', async () => {
  const f = await reviewFixture()
  try {
    let task = f.task
    for (const exit of ['in_progress', 'blocked', 'cancelled'] as const) {
      task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_review' }, context)
      const pending = (await f.store.tasks.review(f.run.id))!
      assert.equal(task.currentReviewId, pending.id)
      const oldVersion = task.version
      task = await f.tasks.assignment(task.projectId, task.id, { version: task.version }, true, context)
      if (task.version !== oldVersion) await assert.rejects(f.tasks.patch(task.projectId, task.id, { version: oldVersion, status: 'in_review' }, context), { code: 'version_conflict' })
      task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: exit }, context)
      assert.equal(task.currentReviewId, null)
      assert.deepEqual(await f.tasks.pendingReviews(task.projectId, context), [])
      const closed = (await f.store.tasks.reviewById(pending.id))!
      assert.equal(closed.status, 'requested'); assert.ok(closed.closedAt)
      if (exit === 'blocked' || exit === 'cancelled') {
        task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_review' }, context)
        assert.notEqual(task.currentReviewId, pending.id)
        task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
      }
    }
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_review' }, context)
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'done' }, context), { code: 'invalid_transition' })
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const first = await f.tasks.reviewAction(task.projectId, task.id, f.run.id, { version: task.version, status: 'requested' }, context)
    const approved = await f.tasks.reviewAction(task.projectId, task.id, f.run.id, { version: first.task.version, status: 'approved' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: approved.task.version, status: 'in_progress' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_review' }, context)
    assert.notEqual(task.currentReviewId, approved.review.id)
    assert.deepEqual(await f.store.tasks.reviewById(approved.review.id), approved.review)
    const done = await f.tasks.reviewAction(task.projectId, task.id, f.run.id, { version: task.version, status: 'approved' }, context)
    assert.equal(done.task.status, 'done')
  } finally { f.store.close() }
})

for (const operation of ['entry', 'exit', 'decision'] as const) for (const fault of ['saveReview', 'save', 'append', 'audit'] as const) test(`review cycle ${operation}/${fault} rollback preserves entire database and notifications`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cycle-rollback-')), path = join(dir, 'db')
  const f = await reviewFixture(path), db = new DatabaseSync(path)
  try {
    const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => [row.name, db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()])
    const task = operation === 'entry' ? f.task : await f.tasks.patch(f.task.projectId, f.task.id, { version: f.task.version, status: 'in_review' }, context)
    const before = snapshot(), events: unknown[] = []
    const store: ServerStore = { fileWrites: f.store.fileWrites, tasks: f.store.tasks, resources: f.store.resources, identity: f.store.identity, commands: f.store.commands, cache: f.store.cache,
      transaction: work => f.store.transaction(tx => work({ ...tx, tasks: { ...tx.tasks,
        saveReview: async r => { await tx.tasks.saveReview(r); if (fault === 'saveReview') throw Error('cycle fault') },
        save: async t => { await tx.tasks.save(t); if (fault === 'save') throw Error('cycle fault') },
        append: async (...args) => { await tx.tasks.append(...args); if (fault === 'append') throw Error('cycle fault') },
      }, audit: { append: async a => { await tx.audit.append(a); if (fault === 'audit') throw Error('cycle fault') } } })) }
    const tasks = new TaskService(store, e => events.push(e), f.server)
    await assert.rejects(operation === 'decision'
      ? tasks.reviewAction(task.projectId, task.id, f.run.id, { version: task.version, status: 'approved' }, context)
      : tasks.patch(task.projectId, task.id, { version: task.version, status: operation === 'entry' ? 'in_review' : 'in_progress' }, context), /cycle fault/)
    assert.deepEqual(snapshot(), before); assert.deepEqual(events, [])
  } finally { db.close(); f.store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('v12 migration replaces historical approved review with a fresh current cycle on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-migration-')), path = join(dir, 'db')
  const f = await reviewFixture(path)
  const requested = await f.tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { version: f.task.version, status: 'requested' }, context)
  const approved = await f.tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { version: requested.task.version, status: 'approved' }, context)
  f.store.close()
  const db = new DatabaseSync(path)
  try {
    db.exec(`DROP TRIGGER review_scope; DROP TRIGGER review_identity; DROP INDEX review_requests_pending; DROP INDEX review_current_task;
      ALTER TABLE review_requests RENAME TO cycle_reviews;
      CREATE TABLE review_requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES task_runs(id), task_id TEXT NOT NULL REFERENCES tasks(id), project_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      INSERT INTO review_requests SELECT id,run_id,task_id,project_id,status,json_remove(data,'$.closedAt') FROM cycle_reviews;
      DROP TABLE cycle_reviews;
      CREATE TRIGGER review_scope BEFORE INSERT ON review_requests BEGIN SELECT 1; END;
      CREATE TRIGGER review_identity BEFORE UPDATE ON review_requests BEGIN SELECT 1; END;
      DELETE FROM schema_migrations WHERE version=13;`)
    db.prepare("UPDATE tasks SET data=json_remove(json_set(data,'$.status','in_review'),'$.currentReviewId') WHERE id=?").run(f.task.id)
  } finally { db.close() }
  const reopened = new SqliteServerStore(path)
  try {
    const task = (await reopened.tasks.get(f.task.id))!, current = (await reopened.tasks.review(f.run.id))!
    assert.equal(task.currentReviewId, current.id); assert.notEqual(current.id, approved.review.id)
    assert.equal(current.status, 'requested'); assert.equal(current.closedAt, null)
    assert.deepEqual(await reopened.tasks.reviewById(approved.review.id), approved.review)
    assert.deepEqual((await reopened.tasks.pendingReviews(task.projectId)).map(r => r.id), [current.id])
  } finally { reopened.close(); await rm(dir, { recursive: true, force: true }) }
})

test('binding and provisioning producers emit exact identities after commit; duplicates and rollback stay silent', async () => {
  const f = await fixture(), events: import('@wemux/web-contract/task-platform').ProjectEvent[] = [], reads: Promise<unknown>[] = []
  const notifications = new Notifications(), server = new ServerService(f.store, notifications)
  const publish = (e: import('@wemux/web-contract/task-platform').ProjectEvent) => { events.push(e); reads.push(f.store.tasks.get(f.task.id)) }
  notifications.onProject(f.task.projectId, publish)
  const tasks = new TaskService(f.store, publish, server)
  const expect = async (types: string[], workspaceId: string) => {
    await Promise.all(reads.splice(0))
    assert.deepEqual(events.map(e => e.type), types)
    for (const e of events) { assert.equal(e.projectId, f.task.projectId); assert.equal(e.taskId, f.task.id); if (e.type === 'binding.changed' || e.type === 'workspace.provisioning') assert.equal(e.workspaceId, workspaceId); assert.ok(e.id) }
    assert.equal(new Set(events.map(e => e.id)).size, events.length); events.length = 0
  }
  try {
    const task = (await f.store.tasks.get(f.task.id))!, workspaceId = f.request.assignment.workspaceId
    await tasks.unbind(task.projectId, task.id, workspaceId, { version: task.version }, context)
    await expect(['assignment.changed', 'binding.changed'], workspaceId)
    await tasks.unbind(task.projectId, task.id, workspaceId, {}, context); await expect([], workspaceId)
    await tasks.bind(task.projectId, task.id, workspaceId, context); await expect(['binding.changed'], workspaceId)
    await tasks.bind(task.projectId, task.id, workspaceId, context); await expect([], workspaceId)
    const created = await tasks.createWorkspace(task.projectId, task.id, { name: 'event workspace', workerId: f.worker.id, source: 'empty' }, context)
    await expect(['binding.changed', 'workspace.provisioning'], created.workspace.id)
    const fail = () => f.store.transaction(async tx => { const w = (await tx.resources.getWorkspace(created.workspace.id))!; await tx.resources.saveWorkspace({ ...w, status: 'failed' }); const worker = (await tx.resources.getWorker(f.worker.id))!; await tx.resources.saveWorker({ ...worker, connectionState: 'offline' }) })
    await fail()
    await tasks.retryWorkspace(task.projectId, task.id, created.workspace.id, { requestId: 'task-retry' }, context); await expect(['workspace.provisioning'], created.workspace.id)
    await tasks.retryWorkspace(task.projectId, task.id, created.workspace.id, { requestId: 'task-retry' }, context); await expect([], created.workspace.id)
    await fail()
    await server.reprovisionWorkspace(created.workspace.id, 'public-retry'); await expect(['workspace.provisioning'], created.workspace.id)
    await server.reprovisionWorkspace(created.workspace.id, 'public-retry'); await expect([], created.workspace.id)
    await fail()
    const before = await f.store.resources.getWorkspace(created.workspace.id), activity = await f.store.tasks.activity(task.id, 0), commands = await f.store.commands.list({ limit: 1000 })
    const failing = new ServerService(intercepted(f.store, tx => ({ ...tx, audit: { append: async a => { await tx.audit.append(a); throw Error('event rollback') } } })), notifications)
    await assert.rejects(failing.reprovisionWorkspace(created.workspace.id, 'rollback'), /event rollback/)
    await expect([], created.workspace.id)
    assert.deepEqual(await f.store.resources.getWorkspace(created.workspace.id), before); assert.deepEqual(await f.store.tasks.activity(task.id, 0), activity); assert.deepEqual(await f.store.commands.list({ limit: 1000 }), commands)
  } finally { f.store.close() }
})

test('current review isolates historical Runs and concurrent HTTP decisions survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'current-review-')), path = join(dir, 'db')
  const f = await reviewFixture(path), events: unknown[] = [], db = new DatabaseSync(path)
  const tasks = new TaskService(f.store, e => events.push(e), f.server)
  const http = createServer(httpHandler({ service: f.server, auth: new AuthenticationService(f.store, administratorDirectory(f.store)), streams: new SessionStreams(f.server), tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  try {
    const first = await tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { version: f.task.version, status: 'requested' }, context)
    let task = await tasks.patch(f.task.projectId, f.task.id, { version: first.task.version, status: 'in_progress' }, context)
    const { run } = await f.launch({ ...f.request, requestId: 'second-run' })
    await f.store.transaction(tx => saveReviewRun(tx, run))
    task = await tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_review' }, context)
    const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => [row.name, db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()])
    const before = snapshot(), count = events.length
    await assert.rejects(tasks.reviewAction(task.projectId, task.id, f.run.id, { version: task.version, status: 'approved' }, context), { code: 'invalid_transition' })
    assert.deepEqual(snapshot(), before); assert.equal(events.length, count)
    const decide = (status: string) => fetch(`http://127.0.0.1:${address.port}/projects/${task.projectId}/tasks/${task.id}/runs/${run.id}/review`, { method: 'POST', headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: task.version, status }) })
    const responses = await Promise.all([decide('approved'), decide('changes_requested')])
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409])
    const decided = (await f.store.tasks.review(run.id))!
    const finalTask = (await f.store.tasks.get(task.id))!
    assert.equal(finalTask.status, decided.status === 'approved' ? 'done' : 'blocked')
    assert.deepEqual(finalTask.assignee, task.assignee); assert.equal(events.length, count + 1)
    assert.deepEqual(await tasks.pendingReviews(task.projectId, context), [])
    const reopened = new SqliteServerStore(path)
    try { assert.deepEqual(await reopened.tasks.get(task.id), finalTask); assert.deepEqual(await reopened.tasks.review(run.id), decided) } finally { reopened.close() }
  } finally { db.close(); await new Promise<void>(resolve => http.close(() => resolve())); f.store.close(); await rm(dir, { recursive: true, force: true }) }
})

for (const corruption of ['run', 'review'] as const) test(`HTTP rejects corrupt serialized ${corruption} identity without any writes`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'corrupt-review-')), path = join(dir, 'db')
  const f = await reviewFixture(path), db = new DatabaseSync(path), events: unknown[] = []
  const task = await f.tasks.patch(f.task.projectId, f.task.id, { version: f.task.version, status: 'in_review' }, context)
  const tasks = new TaskService(f.store, e => events.push(e), f.server), token = administratorToken
  const http = createServer(httpHandler({ service: f.server, auth: new AuthenticationService(f.store, administratorDirectory(f.store)), streams: new SessionStreams(f.server), tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  try {
    db.exec('PRAGMA ignore_check_constraints=ON')
    if (corruption === 'review') { db.exec('DROP TRIGGER review_identity'); db.prepare("UPDATE review_requests SET data=json_set(data,'$.actor','') WHERE run_id=?").run(f.run.id) }
    else { db.exec('DROP TRIGGER run_invariants_update; DROP TRIGGER run_identity_immutable'); db.prepare("UPDATE task_runs SET data=json_set(data,'$.sessionId','wrong-session') WHERE id=?").run(f.run.id) }
    const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => [row.name, db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()])
    const before = snapshot()
    const response = await fetch(`http://127.0.0.1:${address.port}/projects/${task.projectId}/tasks/${task.id}/runs/${f.run.id}/review`, { method: 'POST', headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: task.version, status: 'approved' }) })
    assert.equal(response.status, 409); assert.deepEqual(snapshot(), before); assert.deepEqual(events, [])
  } finally { db.close(); await new Promise<void>(resolve => http.close(() => resolve())); f.store.close(); await rm(dir, { recursive: true, force: true }) }
})

async function saveReviewRun(tx: ServerStoreTx, run: import('@wemux/web-contract/task-platform').Run) {
  const { saveRunProjection } = await import('../application/run-projection.js')
  await saveRunProjection(tx, { ...run, status: 'succeeded', finishedAt: new Date().toISOString() })
}
for (const decision of ['approved', 'changes_requested'] as const) test(`review ${decision}: unique concurrent request, durable decision, assignment and activity cursor`, async () => {
  const f = await reviewFixture()
  try {
    const events: unknown[] = []
    const tasks = new TaskService(f.store, event => events.push(event))
    const action = (status: string, version: number) => tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { status, version }, context)
    const before = await tasks.projectActivity(f.task.projectId, 0, context)
    const a = await action('requested', f.task.version)
    await assert.rejects(action('requested', f.task.version), { code: 'version_conflict' })
    assert.deepEqual(a.review, (await action('requested', a.task.version)).review)
    assert.equal(events.length, 1)
    assert.equal((await tasks.pendingReviews(f.task.projectId, context)).length, 1)
    const c = await action(decision, a.task.version)
    await assert.rejects(action(decision, a.task.version), { code: 'version_conflict' })
    assert.equal(c.task.status, decision === 'approved' ? 'done' : 'blocked')
    assert.deepEqual(c.task.assignee, f.task.assignee)
    assert.equal(c.review.actor, context.actor)
    assert.equal(c.review.reviewer, context.actor)
    assert.ok(c.review.decidedAt)
    assert.equal(events.length, 2)
    assert.equal((await tasks.pendingReviews(f.task.projectId, context)).length, 0)
    await assert.rejects(action(decision === 'approved' ? 'changes_requested' : 'approved', c.task.version), { code: 'invalid_transition', status: 409 })
    const delta = await tasks.projectActivity(f.task.projectId, before.at(-1)!.cursor, context)
    assert.equal(delta.length, 2)
    assert.ok(delta[1].cursor > delta[0].cursor)
    assert.deepEqual(await tasks.projectActivity(f.task.projectId, delta[1].cursor, context), [])
    assert.equal(events.length, 2)
  } finally { f.store.close() }
})

test('review rollback and committed-read barrier hide paused projection and suppress notification', async () => {
  const f = await reviewFixture()
  try {
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const paused = new Promise<void>(resolve => { entered = resolve })
    let notifications = 0
    const store: ServerStore = { fileWrites: f.store.fileWrites, tasks: f.store.tasks, resources: f.store.resources, identity: f.store.identity, commands: f.store.commands, cache: f.store.cache,
      transaction: work => f.store.transaction(tx => work({ ...tx, audit: { append: async entry => { await tx.audit.append(entry); entered(); await gate; throw Error('review rollback') } } })) }
    const tasks = new TaskService(store, () => { notifications++ })
    const before = await f.store.tasks.projectActivity(f.task.projectId, 0)
    const pending = tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { status: 'requested', version: f.task.version }, context)
    const rejection = assert.rejects(pending, /review rollback/)
    await paused
    let visible = false
    const read = f.store.tasks.review(f.run.id).then(value => { visible = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(visible, false)
    assert.equal(notifications, 0)
    release(); await rejection
    assert.equal(await read, null)
    assert.deepEqual(await f.store.tasks.get(f.task.id), f.task)
    assert.deepEqual(await f.store.tasks.projectActivity(f.task.projectId, 0), before)
    assert.equal(notifications, 0)
  } finally { f.store.close() }
})

for (const terminal of ['failed', 'cancelled'] as const) test(`review cannot submit a ${terminal} Run, including from an otherwise eligible Task`, async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    await f.store.transaction(async tx => saveRunProjection(tx, { ...run, status: terminal, finishedAt: new Date().toISOString() }, 'run.finished'))
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'todo' }, context)
    task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
    const before = await f.tasks.activity(task.projectId, task.id, 0, context)
    assert.equal((await f.tasks.get(task.projectId, task.id, context)).capabilities?.transitions.in_review.allowed, false)
    await assert.rejects(f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_review' }, context), { code: 'invalid_transition' })
    await assert.rejects(f.tasks.reviewAction(task.projectId, task.id, run.id, { version: task.version, status: 'requested' }, context), { code: 'invalid_transition' })
    assert.deepEqual(await f.tasks.activity(task.projectId, task.id, 0, context), before)
    assert.equal(await f.store.tasks.review(run.id), null)
    assert.equal((await f.tasks.get(task.projectId, task.id, context)).status, 'in_progress')
  } finally { f.store.close() }
})

for (const terminal of ['failed', 'cancelled'] as const) test(`persisted review for a now-${terminal} Run cannot approve`, async () => {
  const f = await reviewFixture()
  const auth = new AuthenticationService(f.store, administratorDirectory(f.store))
  const streams = new SessionStreams(f.server)
  const http = createServer(httpHandler({ service: f.server, auth, streams, tasks: f.tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  try {
    const requested = await f.tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { status: 'requested', version: f.task.version }, context)
    await f.store.transaction(tx => saveRunProjection(tx, { ...f.run, status: terminal, finishedAt: new Date().toISOString() }, 'run.finished'))
    const before = await f.tasks.projectActivity(f.task.projectId, 0, context)
    const address = http.address() as import('node:net').AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/${f.task.projectId}/tasks/${f.task.id}/runs/${f.run.id}/review`, {
      method: 'POST', headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', version: requested.task.version }),
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'invalid_transition')
    assert.deepEqual(await f.tasks.projectActivity(f.task.projectId, 0, context), before)
    assert.deepEqual(await f.store.tasks.reviewById(requested.review.id), requested.review)
    assert.equal((await f.tasks.get(f.task.projectId, f.task.id, context)).status, 'in_review')
  } finally { streams.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); f.store.close() }
})

test('review enforces terminal Run, legal workflow and concurrent competing decisions', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    const action = (status: string, version: number) => f.tasks.reviewAction(task.projectId, task.id, run.id, { status, version }, context)
    await assert.rejects(action('requested', task.version), { code: 'active_run' })
    await f.store.transaction(tx => saveReviewRun(tx, run))
    await assert.rejects(action('requested', task.version), { code: 'invalid_transition' })
    task = await f.tasks.patch(task.projectId, task.id, { status: 'todo', version: task.version }, context)
    task = await f.tasks.patch(task.projectId, task.id, { status: 'in_progress', version: task.version }, context)
    const requested = await action('requested', task.version)
    const before = await f.store.tasks.projectActivity(task.projectId, 0)
    const outcomes = await Promise.allSettled([action('approved', requested.task.version), action('changes_requested', requested.task.version)])
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1)
    assert.equal((await f.store.tasks.projectActivity(task.projectId, before.at(-1)!.cursor)).length, 1)
  } finally { f.store.close() }
})

test('review persists across reopen and migration replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-reopen-'))
  const path = join(dir, 'server.db')
  const f = await reviewFixture(path)
  try {
    const result = await f.tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { status: 'requested', version: f.task.version }, context)
    const activity = await f.store.tasks.projectActivity(f.task.projectId, 0)
    f.store.close()
    const store = new SqliteServerStore(path)
    try {
      const tasks = new TaskService(store)
      await assert.rejects(tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { status: 'requested', version: f.task.version }, context), { code: 'version_conflict' })
      const replay = await tasks.reviewAction(f.task.projectId, f.task.id, f.run.id, { status: 'requested', version: result.task.version }, context)
      assert.deepEqual(replay.review, result.review)
      assert.deepEqual(await store.tasks.projectActivity(f.task.projectId, 0), activity)
    } finally { store.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('review HTTP endpoints: malformed JSON, relationship/auth matrix, actions and project readers', async () => {
  const f = await reviewFixture()
  const auth = new AuthenticationService(f.store, administratorDirectory(f.store))
  const streams = new SessionStreams(f.server)
  const http = createServer(httpHandler({ service: f.server, auth, streams, tasks: f.tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address() as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}/api/projects/${f.task.projectId}`
  const endpoint = `${base}/tasks/${f.task.id}/runs/${f.run.id}/review`
  const headers = { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }
  try {
    const before = await f.store.tasks.projectActivity(f.task.projectId, 0)
    for (const [url, token, body, status] of [
      [endpoint, 'bad', '{}', 401],
      [`${endpoint}?teamId=wrong`, administratorToken, '{}', 403],
      [endpoint.replace(f.task.id, 'missing'), administratorToken, '{}', 404],
      [endpoint.replace(f.run.id, 'missing'), administratorToken, '{}', 404],
      [endpoint, administratorToken, '{', 400],
      [endpoint, administratorToken, '{"status":"requested"}', 400],
      [endpoint, administratorToken, '{"status":"requested","version":1}', 409],
    ] as const) {
      const response = await fetch(url, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body })
      assert.equal(response.status, status)
      assert.ok((await response.json()).error.code)
    }
    assert.equal(await f.store.tasks.review(f.run.id), null)
    assert.deepEqual(await f.store.tasks.projectActivity(f.task.projectId, 0), before)
    for (const resource of ['reviews', 'activity']) {
      assert.equal((await fetch(`${base}/${resource}`, { headers: { Authorization: 'Bearer bad' } })).status, 401)
      assert.equal((await fetch(`${base}/${resource}?teamId=wrong`, { headers })).status, 403)
      assert.equal((await fetch(`${base.replace(f.task.projectId, 'missing')}/${resource}`, { headers })).status, 404)
    }
    assert.equal((await fetch(`${base}/activity?after=`, { headers })).status, 400)
    const requested = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ status: 'requested', version: f.task.version }) })
    assert.equal(requested.status, 200)
    const result = await requested.json()
    assert.equal((await (await fetch(`${base}/reviews`, { headers })).json()).items[0].id, result.review.id)
    assert.deepEqual((await (await fetch(endpoint, { headers })).json()).review, result.review)
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ status: 'approved', version: result.task.version }) })).status, 200)
    assert.equal((await (await fetch(`${base}/reviews`, { headers })).json()).items.length, 0)
    const activity = await (await fetch(`${base}/activity?after=${before.at(-1)!.cursor}`, { headers })).json()
    assert.equal(activity.items.length, 2)
  } finally { streams.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); f.store.close() }
})

test('review validation and authorization failures have no side effects', async () => {
  const f = await reviewFixture()
  try {
    const before = await f.store.tasks.projectActivity(f.task.projectId, 0)
    const cases = [
      { project: f.task.projectId, task: f.task.id, run: f.run.id, body: {}, actor: context, status: 400 },
      { project: f.task.projectId, task: f.task.id, run: f.run.id, body: { status: 'requested', version: 1 }, actor: context, status: 409 },
      { project: f.task.projectId, task: f.task.id, run: 'missing', body: {}, actor: context, status: 404 },
      { project: f.task.projectId, task: f.task.id, run: f.run.id, body: {}, actor: { ...context, actor: 'stranger' as UserId }, status: 403 },
    ]
    for (const c of cases) await assert.rejects(f.tasks.reviewAction(c.project, c.task, c.run, c.body, c.actor), { status: c.status })
    assert.equal(await f.store.tasks.review(f.run.id), null)
    assert.deepEqual(await f.store.tasks.projectActivity(f.task.projectId, 0), before)
    assert.deepEqual(await f.store.tasks.get(f.task.id), f.task)
  } finally { f.store.close() }
})

for (const status of ['pending', 'accepted'] as const) test(`idle safety finds ${status} enqueue beyond 100000 newer Worker commands`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idle-window-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  try {
    const { session } = await f.tasks.createSession(f.task.projectId, f.task.id, { title: 'Idle candidate', requestId: 'idle-candidate' }, context)
    await f.store.transaction(tx => tx.cache.recordWorkerHead(session.id, 0 as EventSeq))
    // Reuse now requires a historical Run; settle its command before inserting
    // the independent pending enqueue that this test is designed to detect.
    const prior = await f.server.enqueue(session.id, { content: 'Historical submission' })
    const at = new Date().toISOString() as Timestamp
    await f.store.transaction(async tx => {
      await tx.commands.recordReceipt({ commandId: prior.commandId, status: 'rejected', error: { code: 'invalid-input', message: 'Not queued', retryable: false } }, at)
      await tx.tasks.saveRun({ id: 'idle-historical', taskId: f.task.id, projectId: f.task.projectId, requestId: 'idle-historical', attempt: 1,
        sessionId: session.id, snapshot: f.request.assignment, status: 'failed',
        request: { ...f.request, requestId: 'idle-historical', mode: 'reuse', reuseSessionId: session.id }, fingerprint: 'a'.repeat(64),
        createdAt: at, startedAt: at, finishedAt: at, cancelRequestedAt: null, createCommandId: null, enqueueCommandId: prior.commandId,
        messageId: null, turnId: null, cancelCommandIds: [], failure: { code: 'invalid-input', message: 'Not queued' }, resultSummary: null, lastProjectedSeq: 0 })
    })
    const queued = await f.server.enqueue(session.id, { content: 'Not yet in Journal' })
    if (status === 'accepted') await f.store.transaction(tx => tx.commands.recordReceipt({ commandId: queued.commandId, status }, new Date().toISOString() as Timestamp))
    const db = new DatabaseSync(path)
    try {
      db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100001)
        INSERT INTO commands SELECT 'window-'||x, worker_id, 'completed',
          json_set(data, '$.commandId', 'window-'||x, '$.command.sessionId', 'other-session'),
          json_set(projection, '$.commandId', 'window-'||x, '$.status', 'completed')
          FROM n CROSS JOIN commands WHERE id=?`).run(queued.commandId)
      assert.equal(db.prepare('SELECT count(*) AS n FROM commands WHERE rowid>(SELECT rowid FROM commands WHERE id=?)').get(queued.commandId)!.n, 100001)
    } finally { db.close() }
    await assert.rejects(f.tasks.launch(f.task.projectId, f.task.id, { ...f.request, mode: 'reuse', reuseSessionId: session.id }, context), /pending enqueue delivery/)
    await assert.rejects(f.server.delete('sessions', session.id), /pending enqueue delivery/)
    assert.equal((await f.store.resources.getSession(session.id))!.deletedAt, null)
    assert.equal((await f.store.tasks.runs(f.task.id)).length, 1)
  } finally { f.store.close(); await rm(dir, { recursive: true, force: true }) }
})

for (const point of ['saveSession:1', 'insertPending:1', 'insertPending:2', 'depend:1', 'saveRun:1', 'save:1', 'append:1', 'audit:1', 'audit:2']) test(`Run atomic launch fault ${point} rolls back every resource and attempt with no notification`, async () => {
  const f = await fixture()
  try {
    let notifications = 0
    const signals = new Notifications(); signals.commands = () => { notifications++ }
    const counts = new Map<string, number>()
    const wrap = <T extends object>(target: T, prefix?: string): T => new Proxy(target, { get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => { const result = await value(...args); const name = prefix ?? String(key); const n = (counts.get(name) ?? 0) + 1; counts.set(name, n); if (`${name}:${n}` === point) throw Error('injected'); return result }
    } })
    const store: import('../application/ports/server-store.js').ServerStore = { ...f.store, fileWrites: f.store.fileWrites, tasks: f.store.tasks, resources: f.store.resources, identity: f.store.identity, commands: f.store.commands, cache: f.store.cache, transaction: work => f.store.transaction(tx => work({ ...tx, resources: wrap(tx.resources), commands: wrap(tx.commands), tasks: wrap(tx.tasks), audit: wrap(tx.audit, 'audit') })) }
    const tasks = new TaskService(store, () => { notifications++ }, new ServerService(store, signals))
    const commands = await f.store.commands.list({ limit: 100 }), activity = await f.store.tasks.activity(f.task.id, 0), originalTask = await f.store.tasks.get(f.task.id)
    await assert.rejects(tasks.launch(f.task.projectId, f.task.id, f.request, context), /injected/)
    assert.equal(notifications, 0)
    assert.deepEqual(await f.store.tasks.get(f.task.id), originalTask)
    assert.deepEqual(await f.store.resources.listSessions(), [])
    assert.deepEqual(await f.store.tasks.runs(f.task.id), [])
    assert.deepEqual(await f.store.commands.list({ limit: 100 }), commands)
    assert.deepEqual(await f.store.tasks.activity(f.task.id, 0), activity)
    assert.equal((await f.launch()).run.attempt, 1)
  } finally { f.store.close() }
})

for (const recovery of ['startup', 'public retry'] as const) for (const recordedTarget of [false, true]) test(`cancel accepted identity without dispatch survives restart: ${recovery}, recordedTarget=${recordedTarget}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cancel-missing-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  let reopened: SqliteServerStore | undefined
  try {
    const { run } = await f.launch()
    const input = { runId: run.id, sessionId: run.sessionId, requestId: 'accepted-before-restart' }
    const target = `run-cancel:${run.id}:queued`
    // A recorded dangling ID is now rejected atomically; recover only the valid
    // accepted-intent state with an empty dispatch list.
    if (recordedTarget) await assert.rejects(f.store.transaction(async tx => {
      await tx.tasks.saveCancelRequest(run.id, input.requestId, run.sessionId)
      await tx.tasks.saveRun({ ...run, status: 'cancelling', cancelRequestedAt: run.createdAt, cancelCommandIds: [target] })
    }), { message: 'Invalid Run cancellation dispatch' })
    await f.store.transaction(async tx => {
      await tx.tasks.saveCancelRequest(run.id, input.requestId, run.sessionId)
      await tx.tasks.saveRun({ ...run, status: 'cancelling', cancelRequestedAt: run.createdAt, cancelCommandIds: [] })
    })
    f.store.close(); reopened = new SqliteServerStore(path)
    const tasks = new TaskService(reopened)
    if (recovery === 'startup') {
      const workers = new WorkerService(reopened, new Notifications())
      await workers.recoverRuns(); await workers.recoverRuns()
      assert.ok(await reopened.commands.get(target as CommandId))
    }
    const retry = () => tasks.cancelRun(run.projectId, run.taskId, run.id, input, context)
    const [a, b] = await Promise.all([retry(), retry()])
    assert.deepEqual(a, b)
    assert.deepEqual(a.run.cancelCommandIds, [target])
    assert.equal((await reopened.commands.get(target as CommandId))?.status, 'pending')
    assert.equal((await reopened.commands.list({ limit: 100 })).filter(c => c.commandId.startsWith('run-cancel:')).length, 1)
    assert.equal(await reopened.tasks.cancelRequest(run.id, input.requestId), run.sessionId)
    await assert.rejects(tasks.cancelRun(run.projectId, run.taskId, run.id, { ...input, sessionId: 'wrong' }, context), /matching/)
  } finally { reopened?.close(); try { f.store.close() } catch {} await rm(dir, { recursive: true, force: true }) }
})

test('Run cancel coalesces concurrent requests, survives restart, and converges queued/start race once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'run-cancel-'))
  const path = join(dir, 'server.sqlite')
  const f = await fixture(path)
  try {
    const { run } = await f.launch()
    const request = { runId: run.id, sessionId: run.sessionId, requestId: 'cancel-stable' }
    const cancel = () => f.tasks.cancelRun(run.projectId, run.taskId, run.id, request, context)
    const [a, b] = await Promise.all([cancel(), cancel()])
    assert.deepEqual(a, b); assert.equal(a.run.status, 'cancelling'); assert.equal(a.run.cancelCommandIds.length, 1)
    await assert.rejects(f.tasks.cancelRun(run.projectId, run.taskId, run.id, { ...request, sessionId: 'other' }, context), /matching/)
    await assert.rejects(f.tasks.cancelRun(run.projectId, run.taskId, run.id, request, { ...context, actor: 'other' as UserId }), /ownership/)
    const sessionId = run.sessionId as SessionId
    const event = (seq: number, payload: JournalEvent['payload']): JournalEvent => ({ sessionId, seq: seq as EventSeq, occurredAt: new Date().toISOString() as Timestamp, payload })
    const events = [event(1, { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'initial' as MessageId, content: 'slow', position: 0 }), event(2, { kind: 'turn.started', messageId: 'initial' as MessageId, turnId: 'turn' as TurnId })]
    await f.store.transaction(async tx => { await tx.cache.applyEvents(sessionId, events); await projectRuns(tx, sessionId) })
    const stopping = (await f.store.tasks.run(run.id))!
    assert.equal(stopping.status, 'cancelling'); assert.equal(stopping.cancelCommandIds.length, 2)
    await f.store.transaction(async tx => { await tx.cache.applyEvents(sessionId, [event(3, { kind: 'turn.finished', turnId: 'turn' as TurnId, outcome: 'cancelled', failure: null })]); await projectRuns(tx, sessionId) })
    assert.equal((await cancel()).run.status, 'cancelled')
    assert.equal((await f.store.tasks.get(run.taskId))!.status, 'backlog')
    const activities = await f.store.tasks.activity(run.taskId, 0)
    await f.store.transaction(tx => projectRuns(tx, sessionId))
    assert.deepEqual(await f.store.tasks.activity(run.taskId, 0), activities)
    f.store.close()
    const reopened = new SqliteServerStore(path)
    try {
      const tasks = new TaskService(reopened)
      const replay = await tasks.cancelRun(run.projectId, run.taskId, run.id, request, context)
      assert.equal(replay.run.status, 'cancelled'); assert.equal(replay.run.cancelCommandIds.length, 2)
      assert.deepEqual(await reopened.tasks.activity(run.taskId, 0), activities)
    } finally { reopened.close() }
  } finally { try { f.store.close() } catch {} await rm(dir, { recursive: true, force: true }) }
})

test('task-bound independent Session survives disk restart with immutable provenance and binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'independent-restart-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  try {
    const { session } = await f.tasks.createSession(f.task.projectId, f.task.id, { title: 'Independent', requestId: 'independent' }, context)
    assert.equal(session.taskId, f.task.id); assert.equal(session.runId, null)
    assert.equal((await f.store.tasks.runs(f.task.id)).length, 0)
    await assert.rejects(f.tasks.createSession(f.task.projectId, f.task.id, { title: 'Bad', runId: 'override' }, context), /unknown fields/)
    await assert.rejects(f.tasks.createSession(f.task.projectId, f.task.id, { title: 'Bad' }, { ...context, teamId: 'wrong' }), /ownership/)
    await assert.rejects(f.store.transaction(tx => tx.resources.saveSession({ ...session, runId: 'rebound' })), /provenance/)
    const { run } = await f.launch()
    const duringRun = await f.tasks.createSession(f.task.projectId, f.task.id, { title: 'During active Run', requestId: 'during-run' }, context)
    assert.equal(duringRun.session.runId, null)
    assert.equal(duringRun.session.taskId, f.task.id)
    assert.equal((await f.store.tasks.run(run.id))!.status, 'pending')
    assert.equal((await f.store.tasks.runs(f.task.id)).length, 1)
    const created = (await f.store.resources.getSession(run.sessionId as SessionId))!
    assert.equal(created.runId, run.id); assert.equal(created.taskId, run.taskId)
    await assert.rejects(f.store.transaction(tx => tx.resources.saveSession({ ...created, runId: null })), /provenance/)
    f.store.close()
    const restarted = new SqliteServerStore(path)
    try {
      const service = new ServerService(restarted, new Notifications())
      assert.deepEqual(await service.getSession(session.id), session)
      assert.deepEqual(await service.getSession(created.id), created)
      await assert.rejects(restarted.transaction(tx => tx.resources.saveSession({ ...session, runId: run.id })), /provenance/)
      assert.equal((await restarted.tasks.run(run.id))!.sessionId, created.id)
    } finally { restarted.close() }
  } finally { try { f.store.close() } catch {} await rm(dir, { recursive: true, force: true }) }
})

test('queued Run cancellation terminates without a Turn start and keeps accepted receipts idempotent', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch(), sessionId = run.sessionId as SessionId
    const workers = new WorkerService(f.store, new Notifications())
    const cancelInput = { runId: run.id, sessionId, requestId: 'cancel-before-start' }
    const cancelled = (await f.tasks.cancelRun(run.projectId, run.taskId, run.id, cancelInput, context)).run
    const commandId = cancelled.cancelCommandIds[0] as CommandId
    assert.equal(cancelled.status, 'cancelling')
    assert.deepEqual(cancelled.cancelCommandIds, [`run-cancel:${run.id}:queued`])
    assert.deepEqual((await f.store.commands.getPendingCommand(commandId))?.command, {
      kind: 'session.cancel-queued', sessionId, submissionCommandId: run.enqueueCommandId,
    })
    const receipt = { type: 'ack' as const, receipt: { commandId, status: 'accepted' as const } }
    await workers.receive(f.worker.id, receipt)
    await workers.receive(f.worker.id, receipt)
    assert.equal((await f.store.commands.get(commandId))?.status, 'accepted')
    assert.equal((await f.store.tasks.run(run.id))?.status, 'cancelling', 'command acceptance is not terminal evidence')
    const at = '2020-01-01T00:00:00.000Z' as Timestamp
    const events: JournalEvent[] = [
      { sessionId, seq: 1 as EventSeq, occurredAt: at, payload: { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'queued-only' as MessageId, content: f.request.prompt, position: 0 } },
      { sessionId, seq: 2 as EventSeq, occurredAt: at, payload: { kind: 'message.cancelled', commandId: run.enqueueCommandId as CommandId, messageId: 'queued-only' as MessageId } },
    ]
    const sync = { protocolVersion: 1 as const, messageId: 'queued-cancel-sync' as MessageId, type: 'sync' as const, kind: 'batch' as const, sessionId, throughSeq: 2 as EventSeq, hasMore: false, events }
    await workers.receive(f.worker.id, sync)
    const terminal = (await f.store.tasks.run(run.id))!
    assert.equal(terminal.status, 'cancelled')
    assert.equal(terminal.turnId, null)
    assert.equal(terminal.startedAt, null)
    assert.equal(terminal.finishedAt, at)
    assert.deepEqual(terminal.cancelCommandIds, [commandId])
    assert.equal((await f.store.tasks.get(run.taskId))?.activeRun, null)
    const activity = await f.store.tasks.activity(run.taskId, 0)
    assert.equal(activity.filter(item => item.type === 'run.started').length, 0)
    assert.equal(activity.filter(item => item.type === 'run.finished').length, 1)
    await workers.receive(f.worker.id, sync)
    await workers.receive(f.worker.id, receipt)
    assert.deepEqual((await f.tasks.cancelRun(run.projectId, run.taskId, run.id, cancelInput, context)).run, terminal)
    assert.deepEqual(await f.store.tasks.activity(run.taskId, 0), activity)
    assert.equal((await f.store.commands.list({ limit: 100 })).filter(item => item.commandId.startsWith('run-cancel:')).length, 1)
  } finally { f.store.close() }
})

for (const cancelFirst of [false, true]) test(`natural completion and cancel serialize deterministically: cancelFirst=${cancelFirst}`, async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    const sessionId = run.sessionId as SessionId
    const event = (seq: number, payload: JournalEvent['payload']): JournalEvent => ({ sessionId, seq: seq as EventSeq, occurredAt: new Date().toISOString() as Timestamp, payload })
    const events = [event(1, { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'race-message' as MessageId, content: 'race', position: 0 }), event(2, { kind: 'turn.started', messageId: 'race-message' as MessageId, turnId: 'race-turn' as TurnId }), event(3, { kind: 'turn.finished', turnId: 'race-turn' as TurnId, outcome: 'completed', failure: null })]
    const apply = (batch: JournalEvent[]) => f.store.transaction(async tx => { await tx.cache.applyEvents(sessionId, batch); await projectRuns(tx, sessionId) })
    await apply(events.slice(0, 2))
    const cancel = () => f.tasks.cancelRun(run.projectId, run.taskId, run.id, { requestId: 'race-cancel', runId: run.id, sessionId }, context)
    if (cancelFirst) await cancel()
    await apply(events.slice(2))
    await cancel()
    const done = (await f.store.tasks.run(run.id))!
    assert.equal(done.status, cancelFirst ? 'cancelled' : 'succeeded')
    assert.equal(done.cancelCommandIds.length, cancelFirst ? 1 : 0)
    assert.equal(done.turnId, 'race-turn', 'this race is after start, unlike queued-only cancellation')
    assert.equal(done.failure, null)
    assert.ok(done.finishedAt)
    assert.equal((await f.store.tasks.get(run.taskId))?.activeRun, null)
    const before = await f.store.tasks.activity(run.taskId, 0)
    await apply([events[2]!, events[0]!])
    await cancel()
    assert.deepEqual(await f.store.tasks.run(run.id), done)
    assert.deepEqual(await f.store.tasks.activity(run.taskId, 0), before)
    assert.equal(before.filter(a => a.type === 'run.finished').length, 1)
    assert.equal(before.filter(a => a.type === 'run.started').length, 1)
    const workers = new WorkerService(f.store, new Notifications())
    const enqueueReceipt = { type: 'ack' as const, receipt: { commandId: run.enqueueCommandId as CommandId, status: 'accepted' as const } }
    await workers.receive(f.worker.id, enqueueReceipt)
    await workers.receive(f.worker.id, enqueueReceipt)
    assert.deepEqual(await f.store.tasks.run(run.id), done, 'late duplicate enqueue receipt must not reopen terminal Run')
    assert.deepEqual(await f.store.tasks.activity(run.taskId, 0), before)
    if (cancelFirst) {
      await workers.receive(f.worker.id, { type: 'ack', receipt: { commandId: done.cancelCommandIds[0] as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'Already finished', retryable: false } } })
      assert.deepEqual(await f.store.tasks.run(run.id), done)
      assert.deepEqual(await f.store.tasks.activity(run.taskId, 0), before)
    }
  } finally { f.store.close() }
})

test('cancel rejection requires explicit new request and concurrent recovery emits one target', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    const input = { runId: run.id, sessionId: run.sessionId, requestId: 'cancel-first' }
    const cancel = (request = input) => f.tasks.cancelRun(run.projectId, run.taskId, run.id, request, context)
    const first = (await cancel()).run
    const workers = new WorkerService(f.store, new Notifications())
    await workers.receive(f.worker.id, { type: 'ack', receipt: { commandId: first.cancelCommandIds[0] as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'Target unavailable', retryable: false } } })
    const replay = (await cancel()).run
    assert.equal(replay.failure?.code, 'cancel_rejected')
    assert.equal(replay.cancelCommandIds.length, 1)
    const retry = { ...input, requestId: 'cancel-recovery' }
    const [a, b] = await Promise.all([cancel(retry), cancel(retry)])
    assert.deepEqual(a, b); assert.equal(a.run.cancelCommandIds.length, 2); assert.equal(a.run.failure, null)
    await workers.receive(f.worker.id, { type: 'ack', receipt: { commandId: a.run.cancelCommandIds[1] as CommandId, status: 'accepted' } })
    assert.equal((await cancel(retry)).run.status, 'cancelling')
    const sessionId = run.sessionId as SessionId
    await f.store.transaction(async tx => {
      await tx.cache.applyEvents(sessionId, [{ sessionId, seq: 1 as EventSeq, occurredAt: new Date().toISOString() as Timestamp, payload: { kind: 'message.cancelled', commandId: run.enqueueCommandId as CommandId, messageId: run.enqueueCommandId as MessageId } }])
      await projectRuns(tx, sessionId)
    })
    assert.equal((await cancel(retry)).run.status, 'cancelled')
    assert.equal((await f.store.tasks.activity(run.taskId, 0)).filter(a => a.type === 'run.finished').length, 1)
    await f.store.transaction(tx => projectRuns(tx, sessionId))
    assert.equal((await f.store.tasks.activity(run.taskId, 0)).filter(a => a.type === 'run.finished').length, 1)
  } finally { f.store.close() }
})

test('Run launch coalesces concurrent identity, preserves full prompt, and retries before changed assignment/offline/active checks', async () => {
  const f = await fixture()
  try {
    const [a, b] = await Promise.all([f.launch(), f.launch()])
    assert.deepEqual(a, b)
    assert.equal(a.run.attempt, 1)
    assert.equal(a.run.request.prompt, '  Full prompt\n')
    assert.equal((await f.store.resources.listSessions()).length, 1)
    assert.equal((await f.store.tasks.runs(f.task.id)).length, 1)
    await assert.rejects(f.launch({ ...f.request, prompt: 'changed' }), /different complete request/)
    await assert.rejects(f.launch({ ...f.request, requestId: 'other' }), /active Run/)
    await f.tasks.assignment(f.task.projectId, f.task.id, { version: 2 }, true, context)
    await f.store.transaction(async tx => { const worker = (await tx.resources.getWorker(f.worker.id))!; await tx.resources.saveWorker({ ...worker, connectionState: 'offline' }) })
    assert.deepEqual(await f.launch(), a)
    assert.deepEqual((await f.store.tasks.run(a.run.id))!.snapshot, f.request.assignment)
  } finally { f.store.close() }
})

test('Run continuous Journal waits for gaps, strictly correlates and preserves terminal result across independent messages and replay', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    const sessionId = run.sessionId as SessionId
    const event = (seq: number, payload: JournalEvent['payload']): JournalEvent => ({ sessionId, seq: seq as EventSeq, occurredAt: new Date().toISOString() as Timestamp, payload })
    const events = [event(1, { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'initial' as MessageId, content: f.request.prompt, position: 0 }), event(2, { kind: 'turn.started', messageId: 'initial' as MessageId, turnId: 'turn' as TurnId }), event(3, { kind: 'assistant.text.delta', turnId: 'turn' as TurnId, text: 'Echo result' }), event(4, { kind: 'turn.finished', turnId: 'turn' as TurnId, outcome: 'completed', failure: null })]
    const apply = (batch: JournalEvent[]) => f.store.transaction(async tx => { await tx.cache.applyEvents(sessionId, batch); await projectRuns(tx, sessionId) })
    await apply(events.slice(1))
    assert.equal((await f.store.tasks.run(run.id))!.status, 'pending')
    await apply([events[0]!])
    const done = (await f.store.tasks.run(run.id))!
    assert.equal(done.status, 'succeeded'); assert.equal(done.resultSummary, 'Echo result')
    const count = (await f.store.tasks.activity(f.task.id, 0)).length
    await apply(events)
    await apply([event(5, { kind: 'assistant.text.delta', turnId: 'other' as TurnId, text: 'not part of Run' })])
    assert.equal((await f.store.tasks.run(run.id))!.resultSummary, 'Echo result')
    assert.equal((await f.store.tasks.activity(f.task.id, 0)).length, count)
    assert.equal((await f.store.tasks.get(f.task.id))!.status, 'backlog')
    assert.equal((await f.launch()).run.id, run.id)
    assert.equal((await f.launch({ ...f.request, requestId: 'next' })).run.attempt, 2)
  } finally { f.store.close() }
})

test('create rejection fails Run atomically and blocks dependent enqueue', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    const workers = new WorkerService(f.store, new Notifications())
    const receipt = { protocolVersion: 1 as const, messageId: 'receipt' as MessageId, type: 'ack' as const, receipt: { commandId: run.createCommandId as CommandId, status: 'rejected' as const, error: { code: 'invalid-input' as const, message: 'create failed', retryable: false } } }
    await workers.receive(f.worker.id, receipt)
    assert.equal((await f.store.tasks.run(run.id))!.status, 'failed')
    assert.ok(!(await f.store.commands.listDeliverable(f.worker.id, 100)).some(c => c.commandId === run.enqueueCommandId))
    const count = (await f.store.tasks.activity(f.task.id, 0)).length
    await workers.receive(f.worker.id, receipt)
    assert.equal((await f.store.tasks.activity(f.task.id, 0)).length, count)
  } finally { f.store.close() }
})

test('Run enqueue is not deliverable before create accepted; generic command deletion cannot bypass dependency', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    const commands = await f.store.commands.listDeliverable(f.worker.id, 100)
    assert.ok(commands.some(c => c.commandId === run.createCommandId))
    assert.ok(!commands.some(c => c.commandId === run.enqueueCommandId))
    await assert.rejects(f.server.cancelCommand(run.createCommandId as CommandId), /Run commands cannot be cancelled/)
    await assert.rejects(f.server.cancelCommand(run.enqueueCommandId as CommandId), /Run commands cannot be cancelled/)
  } finally { f.store.close() }
})

 test('different concurrent identities create only one Run and Session without orphan commands', async () => {
  const f = await fixture()
  try {
    const before = (await f.store.commands.list({ limit: 100 })).length
    const results = await Promise.allSettled([f.launch(), f.launch({ ...f.request, requestId: 'other' })])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal((await f.store.tasks.runs(f.task.id)).length, 1)
    assert.equal((await f.store.resources.listSessions()).length, 1)
    assert.equal((await f.store.commands.list({ limit: 100 })).length, before + 2)
  } finally { f.store.close() }
})

 test('Run Session deletion protects pending and terminal history', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    for (const status of ['pending', 'succeeded'] as const) {
      await f.store.transaction(tx => tx.tasks.saveRun({ ...run, status }))
      await assert.rejects(f.server.delete('sessions', run.sessionId), { status: 409, code: 'run_session_protected' })
      assert.equal((await f.server.getSession(run.sessionId as SessionId)).id, run.sessionId)
      assert.ok(await f.server.events(run.sessionId as SessionId, 1, 100))
    }
  } finally { f.store.close() }
})

 test('startup cached replay preserves newer Task activity and old event occurredAt', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    const sessionId = run.sessionId as SessionId
    const at = '2020-01-01T00:00:00.000Z' as Timestamp
    const original = (await f.store.tasks.get(f.task.id))!
    await f.store.transaction(tx => tx.cache.applyEvents(sessionId, [
      { sessionId, seq: 1 as EventSeq, occurredAt: at, payload: { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'm' as MessageId, content: 'test', position: 0 } },
      { sessionId, seq: 2 as EventSeq, occurredAt: at, payload: { kind: 'turn.started', messageId: 'm' as MessageId, turnId: 't' as TurnId } },
      { sessionId, seq: 3 as EventSeq, occurredAt: at, payload: { kind: 'turn.finished', turnId: 't' as TurnId, outcome: 'completed', failure: null } },
    ]))
    assert.equal((await f.store.tasks.run(run.id))!.lastProjectedSeq, 0)
    const workers = new WorkerService(f.store, new Notifications())
    await workers.recoverRuns()
    assert.equal((await f.store.tasks.run(run.id))!.status, 'succeeded')
    assert.equal((await f.store.tasks.get(f.task.id))!.lastActivityAt, original.lastActivityAt)
    const activity = await f.store.tasks.activity(f.task.id, 0)
    assert.equal(activity.find(a => a.type === 'run.finished')!.occurredAt, at)
    await workers.recoverRuns()
    assert.deepEqual(await f.store.tasks.activity(f.task.id, 0), activity)
  } finally { f.store.close() }
})

 test('create accepted opens dependency but Run stays pending; lost ACK redelivers same IDs', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    let workers = new WorkerService(f.store, new Notifications())
    const ids = async () => (await workers.deliverable(f.worker.id)).flatMap(m => m.type === 'command' ? [m.commandId] : [])
    assert.ok((await ids()).includes(run.createCommandId as CommandId))
    await workers.disconnected(f.worker.id)
    workers = new WorkerService(f.store, new Notifications())
    assert.ok((await ids()).includes(run.createCommandId as CommandId))
    await workers.receive(f.worker.id, { type: 'ack', receipt: { commandId: run.createCommandId as CommandId, status: 'accepted' } })
    assert.ok((await ids()).includes(run.enqueueCommandId as CommandId))
    assert.ok((await ids()).includes(run.enqueueCommandId as CommandId))
    assert.equal((await f.store.tasks.run(run.id))!.status, 'pending')
    const rejected = { type: 'ack' as const, receipt: { commandId: run.enqueueCommandId as CommandId, status: 'rejected' as const, error: { code: 'invalid-input' as const, message: 'failed', retryable: false } } }
    await workers.receive(f.worker.id, rejected)
    const activity = await f.store.tasks.activity(f.task.id, 0)
    await workers.receive(f.worker.id, rejected)
    assert.deepEqual(await f.store.tasks.activity(f.task.id, 0), activity)
    assert.equal((await f.store.tasks.run(run.id))!.status, 'failed')
  } finally { f.store.close() }
})

for (const outcome of ['completed', 'failed', 'cancelled'] as const) test(`WorkerService live gap + sync projects ${outcome} with monotonic old timestamps`, async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch(), sessionId = run.sessionId as SessionId
    const original = (await f.store.tasks.get(f.task.id))!
    const workers = new WorkerService(f.store, new Notifications())
    const envelope = { protocolVersion: 1 as const, messageId: 'event' as MessageId }
    const event = (seq: number, payload: JournalEvent['payload']): JournalEvent => ({ sessionId, seq: seq as EventSeq, occurredAt: '2020-01-01T00:00:00.000Z' as Timestamp, payload })
    const events = [event(1, { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'm' as MessageId, content: 'test', position: 0 }), event(2, { kind: 'turn.started', messageId: 'm' as MessageId, turnId: 't' as TurnId }), event(3, { kind: 'turn.finished', turnId: 't' as TurnId, outcome, failure: null })]
    const replies = await workers.receive(f.worker.id, { ...envelope, type: 'event', scope: 'session', event: events[2]! })
    assert.ok(replies.some(r => r.type === 'sync'))
    assert.equal((await f.store.tasks.run(run.id))!.status, 'pending')
    await workers.receive(f.worker.id, { ...envelope, type: 'sync', kind: 'batch', sessionId, throughSeq: 3 as EventSeq, hasMore: false, events })
    assert.equal((await f.store.tasks.run(run.id))!.status, outcome === 'completed' ? 'succeeded' : 'failed')
    assert.equal((await f.store.tasks.get(f.task.id))!.lastActivityAt, original.lastActivityAt)
    const activity = await f.store.tasks.activity(f.task.id, 0)
    await workers.receive(f.worker.id, { ...envelope, type: 'event', scope: 'session', event: event(4, { kind: 'turn.started', messageId: 'm' as MessageId, turnId: 't' as TurnId }) })
    assert.deepEqual(await f.store.tasks.activity(f.task.id, 0), activity)
    const before = await f.store.tasks.run(run.id), task = await f.store.tasks.get(f.task.id), freshness = await f.store.cache.getFreshness(sessionId)
    await assert.rejects(workers.receive(f.worker.id, { ...envelope, type: 'event', scope: 'session', event: event(3, { kind: 'turn.started', messageId: 'm' as MessageId, turnId: 't' as TurnId }) }), /Conflicting event/)
    assert.deepEqual(await f.store.tasks.run(run.id), before)
    assert.deepEqual(await f.store.tasks.get(f.task.id), task)
    assert.deepEqual(await f.store.cache.getFreshness(sessionId), freshness)
    assert.deepEqual(await f.store.tasks.activity(f.task.id, 0), activity)
  } finally { f.store.close() }
})

/** Test-only transaction seam: production store/services execute unchanged. */
function intercepted(store: SqliteServerStore, work: (tx: ServerStoreTx) => ServerStoreTx): ServerStore {
  return { fileWrites: store.fileWrites, tasks: store.tasks, resources: store.resources, identity: store.identity, commands: store.commands, cache: store.cache, transaction: callback => store.transaction(tx => callback(work(tx))) }
}
for (const rollback of [false, true]) test(`cancel public readers wait for ${rollback ? 'rollback' : 'commit'}`, async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), paused = new Promise<void>(resolve => { entered = resolve })
  try {
    const { run } = await f.launch()
    const before = await f.store.commands.list({ limit: 100 })
    const store: ServerStore = { ...f.store, resources: f.store.resources, identity: f.store.identity, commands: f.store.commands, cache: f.store.cache, tasks: f.store.tasks, transaction: work => f.store.transaction(tx => work({ ...tx, tasks: { ...tx.tasks, saveRun: async value => { await tx.tasks.saveRun(value); entered(); await gate; if (rollback) throw Error('cancel rollback') } } })) }
    const tasks = new TaskService(store, () => {}, f.server)
    const operation = tasks.cancelRun(run.projectId, run.taskId, run.id, { runId: run.id, sessionId: run.sessionId, requestId: 'pause-cancel' }, context).catch(error => error)
    await paused
    let read = false
    const reader = Promise.all([f.store.tasks.run(run.id), f.store.commands.list({ limit: 100 }), f.store.tasks.cancelRequest(run.id, 'pause-cancel')]).then(result => { read = true; return result })
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(read, false)
    release(); await operation
    const [after, commands, identity] = await reader
    assert.equal(after?.status, rollback ? 'pending' : 'cancelling')
    assert.equal(commands.length, before.length + (rollback ? 0 : 1))
    assert.equal(identity, rollback ? null : run.sessionId)
  } finally { release?.(); f.store.close() }
})

for (const rollback of [false, true]) test(`paused launch public Task/Run/delivery readers wait until ${rollback ? 'rollback' : 'commit'}`, async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void, runId = ''
  const gate = new Promise<void>(resolve => { release = resolve }), paused = new Promise<void>(resolve => { entered = resolve })
  const http = createServer(httpHandler({ service: f.server, auth: new AuthenticationService(f.store, administratorDirectory(f.store)), streams: new SessionStreams(f.server), tasks: f.tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  try {
    const beforeTask = await f.tasks.get(f.task.projectId, f.task.id, context), beforeCommands = await f.store.commands.listDeliverable(f.worker.id, 100)
    const store = intercepted(f.store, tx => ({ ...tx, tasks: { ...tx.tasks, saveRun: async run => { runId = run.id; await tx.tasks.saveRun(run) }, append: async (...args) => {
      await tx.tasks.append(...args); entered(); await gate; if (rollback) throw Error('paused rollback')
    } } }))
    const tasks = new TaskService(store, () => {}, new ServerService(store, new Notifications()))
    const launch = tasks.launch(f.task.projectId, f.task.id, f.request, context)
    const outcome = launch.then(value => value, error => error as Error)
    await paused
    let settled = 0
    const httpRead = fetch(`http://127.0.0.1:${address.port}/projects/${f.task.projectId}/tasks/${f.task.id}/runs/${runId}`, { headers: { Authorization: `Bearer ${administratorToken}` } }).then(async response => { const data = await response.json(); settled++; return { status: response.status, data } })
    const single = f.tasks.run(f.task.projectId, f.task.id, runId, context).then(value => { settled++; return value }, error => { settled++; return error })
    const reads = [f.tasks.get(f.task.projectId, f.task.id, context), f.tasks.list(f.task.projectId, context), f.tasks.runs(f.task.projectId, f.task.id, context), f.store.tasks.runByRequest(f.task.id, f.request.requestId), f.store.commands.listDeliverable(f.worker.id, 100)].map(p => p.then(value => { settled++; return value }))
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    assert.equal(settled, 0)
    release()
    const result = await outcome
    const [task, list, runs, run, delivery] = await Promise.all(reads)
    const singleResult = await single, httpResult = await httpRead
    if (rollback) {
      assert.match(String(result), /paused rollback/)
      assert.equal(singleResult.status, 404); assert.equal(singleResult.code, 'not_found')
      assert.deepEqual(httpResult, { status: 404, data: { error: { code: 'not_found', message: 'Run not found in this Task' } } })
      assert.deepEqual(task, beforeTask); assert.deepEqual(runs, []); assert.equal(run, null); assert.deepEqual(delivery, beforeCommands)
      assert.deepEqual(await f.store.resources.listSessions(), [])
    } else {
      assert.ok(!(result instanceof Error))
      assert.deepEqual(task, await f.tasks.get(f.task.projectId, f.task.id, context)); assert.deepEqual(list, await f.tasks.list(f.task.projectId, context))
      assert.deepEqual(runs, [singleResult]); assert.deepEqual(run, result.run)
      assert.deepEqual(httpResult, { status: 200, data: singleResult })
      assert.ok(Array.isArray(delivery) && delivery.some(c => 'commandId' in c && c.commandId === result.run.createCommandId))
      assert.equal((await f.store.resources.listSessions()).length, 1)
    }
  } finally { release(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); f.store.close() }
})

for (const point of ['cache', 'run', 'task', 'activity'] as const) test(`WorkerService projection failure after ${point} rolls back cache cursor Run Task activity`, async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch(), sessionId = run.sessionId as SessionId
    const snapshot = async () => ({ run: await f.store.tasks.run(run.id), task: await f.store.tasks.get(f.task.id), activity: await f.store.tasks.activity(f.task.id, 0), freshness: await f.store.cache.getFreshness(sessionId), events: await f.store.cache.readEvents(sessionId, 1 as EventSeq, 500), session: await f.store.resources.getSession(sessionId) })
    const before = await snapshot()
    const fail = async <T>(promise: Promise<T>): Promise<T> => { await promise; throw Error('projection injected') }
    const store = intercepted(f.store, tx => ({ ...tx,
      cache: { ...tx.cache, applyEvents: (...args) => point === 'cache' ? fail(tx.cache.applyEvents(...args)) : tx.cache.applyEvents(...args) },
      tasks: { ...tx.tasks,
        saveRun: (...args) => point === 'run' ? fail(tx.tasks.saveRun(...args)) : tx.tasks.saveRun(...args),
        save: (...args) => point === 'task' ? fail(tx.tasks.save(...args)) : tx.tasks.save(...args),
        append: (...args) => point === 'activity' ? fail(tx.tasks.append(...args)) : tx.tasks.append(...args),
      },
    }))
    const events: JournalEvent[] = [
      { sessionId, seq: 1 as EventSeq, occurredAt: run.createdAt as Timestamp, payload: { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'm' as MessageId, content: 'test', position: 0 } },
      { sessionId, seq: 2 as EventSeq, occurredAt: run.createdAt as Timestamp, payload: { kind: 'turn.started', messageId: 'm' as MessageId, turnId: 't' as TurnId } },
    ]
    const message = { protocolVersion: 1 as const, messageId: 'batch' as MessageId, type: 'sync' as const, kind: 'batch' as const, sessionId, throughSeq: 2 as EventSeq, hasMore: false, events }
    await assert.rejects(new WorkerService(store, new Notifications()).receive(f.worker.id, message), /projection injected/)
    assert.deepEqual(await snapshot(), before)
    await new WorkerService(f.store, new Notifications()).receive(f.worker.id, message)
    assert.equal((await f.store.tasks.run(run.id))!.status, 'running')
  } finally { f.store.close() }
})

test('real WS contradictory terminal Journal cannot regress an undeleted cancelled Run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cancelled-ws-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  let app: ReturnType<typeof createWemuxServer> | undefined, ws: WebSocket | undefined
  const transcript: unknown[] = []
  try {
    const { run } = await f.launch(), sessionId = run.sessionId as SessionId
    await f.tasks.cancelRun(run.projectId, run.taskId, run.id, { runId: run.id, sessionId, requestId: 'ws-cancel' }, context)
    const events: JournalEvent[] = [
      { sessionId, seq: 1 as EventSeq, occurredAt: run.createdAt as Timestamp, payload: { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'ws-message' as MessageId, content: 'test', position: 0 } },
      { sessionId, seq: 2 as EventSeq, occurredAt: run.createdAt as Timestamp, payload: { kind: 'turn.started', messageId: 'ws-message' as MessageId, turnId: 'ws-turn' as TurnId } },
      { sessionId, seq: 3 as EventSeq, occurredAt: run.createdAt as Timestamp, payload: { kind: 'turn.finished', turnId: 'ws-turn' as TurnId, outcome: 'cancelled', failure: null } },
    ]
    await f.store.transaction(async tx => { await tx.cache.applyEvents(sessionId, events); await tx.cache.recordWorkerHead(sessionId, 3 as EventSeq); await projectRuns(tx, sessionId) })
    const terminal = (await f.store.tasks.run(run.id))!
    f.store.close()
    app = createWemuxServer({ databasePath: path, administratorEmails: [administratorEmail] }); const base = await app.listen(0)
    const db = new DatabaseSync(path)
    const counts = () => ({ activity: db.prepare('SELECT * FROM task_activity ORDER BY task_id,seq').all(), audit: db.prepare("SELECT * FROM records WHERE kind='audit' ORDER BY id").all() })
    const before = counts()
    ws = new WebSocket(base.replace('http', 'ws') + '/worker/ws', { headers: { Authorization: `Bearer ${f.credential}` } })
    const peer = new TransportV2Peer(ws, f.worker.id)
    ws.on('message', data => transcript.push({ direction: 'server', frame: JSON.parse(data.toString()) }))
    await peer.connect({ name: 'late-terminal-probe' })
    const send = (payload: Record<string, unknown>) => { transcript.push({ direction: 'worker', payload }); peer.send(payload) }
    for (const seq of [5, 4]) send({ type: 'event', scope: 'session', event: { sessionId, seq, occurredAt: run.createdAt, payload: { kind: 'turn.finished', turnId: 'ws-turn', outcome: seq % 2 ? 'failed' : 'completed', failure: null } } })
    send({ type: 'sync', kind: 'heads', complete: false, heads: [{ sessionId, lastSeq: 5 }] })
    send({ type: 'heartbeat', nonce: 'probe-complete', sentAt: new Date().toISOString() })
    await peer.wait(message => message.type === 'heartbeat' && message.nonce === 'probe-complete')
    const after = JSON.parse(String(db.prepare('SELECT data FROM task_runs WHERE id=?').get(run.id)!.data))
    assert.deepEqual({ ...after, lastProjectedSeq: terminal.lastProjectedSeq }, terminal)
    assert.equal(after.lastProjectedSeq, 5)
    assert.deepEqual(counts(), before)
    const freshness = JSON.parse(String(db.prepare("SELECT data FROM records WHERE kind='cache' AND id=?").get(sessionId)!.data))
    assert.equal(freshness.contiguousSeq, 5); assert.equal(freshness.workerLastSeq, 5); assert.equal(freshness.status, 'synced')
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT data FROM events WHERE session_id=? AND seq=3').get(sessionId)!.data)), events[2])
    assert.equal(db.prepare('SELECT count(*) AS n FROM events WHERE session_id=?').get(sessionId)!.n, 5)
    const evidence = '.scratch/task-board-agent-platform/evidence/ticket-06/current'
    await mkdir(evidence, { recursive: true }); await writeFile(evidence + '/cancelled-session-ws.json', JSON.stringify({ transcript, terminal, after, freshness, activityAuditUnchanged: true }, null, 2))
    const closedByIntegrity = once(ws, 'close')
    send({ type: 'event', scope: 'session', event: { ...events[2], payload: { kind: 'turn.finished', turnId: 'ws-turn', outcome: 'failed', failure: null } } })
    const [closeCode] = await closedByIntegrity
    assert.equal(closeCode, 1008)
    assert.ok(peer.frames.some(frame => frame.frameType === 'transport.error'))
    assert.deepEqual(counts(), before)
    await writeFile(evidence + '/cancelled-session-ws.json', JSON.stringify({ transcript, terminal, after, freshness, activityAuditUnchanged: true, conflictingSeqCloseCode: closeCode }, null, 2))
    db.close()
  } finally { if (ws && ws.readyState !== WebSocket.CLOSED) { const closed = once(ws, 'close'); ws.close(); await closed } await app?.close(); try { f.store.close() } catch {} await rm(dir, { recursive: true, force: true }) }
})

test('deleted Session after disk restart ignores late and out-of-order Worker ingestion without side effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deleted-ingestion-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  let reopened: SqliteServerStore | undefined
  try {
    const { run } = await f.launch(), sessionId = run.sessionId as SessionId
    await f.tasks.cancelRun(run.projectId, run.taskId, run.id, { runId: run.id, sessionId, requestId: 'delete-cancel' }, context)
    const event: JournalEvent = { sessionId, seq: 1 as EventSeq, occurredAt: run.createdAt as Timestamp, payload: { kind: 'message.cancelled', commandId: run.enqueueCommandId as CommandId, messageId: run.enqueueCommandId as MessageId } }
    await f.store.transaction(async tx => {
      await tx.commands.recordReceipt({ commandId: run.enqueueCommandId as CommandId, status: 'accepted' }, run.createdAt as Timestamp)
      await tx.cache.applyEvents(sessionId, [event]); await projectRuns(tx, sessionId)
      await tx.cache.recordWorkerHead(sessionId, 1 as EventSeq)
      // Cancellation Journal proves the submitted message is no longer pending delivery.
      await tx.commands.recordReceipt({ commandId: run.enqueueCommandId as CommandId, status: 'accepted' }, run.createdAt as Timestamp)
      const session = (await tx.resources.getSession(sessionId))!
      await tx.resources.saveSession({ ...session, deletedAt: new Date().toISOString() as Timestamp })
      await tx.cache.deleteSessionHistory(sessionId)
    })
    f.store.close(); reopened = new SqliteServerStore(path)
    let notifications = 0
    const signals = new Notifications(); signals.session = () => { notifications++ }; signals.commands = () => { notifications++ }
    const worker = new WorkerService(reopened, signals)
    const db = new DatabaseSync(path)
    const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => ({ name: row.name, rows: db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all().map(record => { if (record.kind === 'worker') { const worker = JSON.parse(String(record.data)); delete worker.lastSeenAt; return { ...record, data: JSON.stringify(worker) } } return record }) }))
    const before = snapshot()
    for (const seq of [10, 1, 2]) {
      await worker.receive(f.worker.id, { type: 'event', scope: 'session', event: { ...event, seq: seq as EventSeq, payload: { kind: 'turn.finished', turnId: 'old-turn' as TurnId, outcome: 'failed', failure: null } } })
      await worker.receive(f.worker.id, { type: 'sync', kind: 'heads', complete: true, heads: [{ sessionId, lastSeq: seq as EventSeq }] })
    }
    assert.deepEqual(snapshot(), before); assert.equal(notifications, 0)
    assert.equal((await reopened.tasks.run(run.id))!.status, 'cancelled')
    assert.equal((await reopened.cache.readEvents(sessionId, 1 as EventSeq, 100)).events.length, 0)
    db.close()
  } finally { reopened?.close(); try { f.store.close() } catch {} await rm(dir, { recursive: true, force: true }) }
})

test('reverse sync gap then live fill projects across 500-event pages and ignores unrelated chains', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch(), sessionId = run.sessionId as SessionId
    const workers = new WorkerService(f.store, new Notifications())
    const event = (seq: number, payload: JournalEvent['payload']): JournalEvent => ({ sessionId, seq: seq as EventSeq, occurredAt: run.createdAt as Timestamp, payload })
    const events = [event(1, { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'm' as MessageId, content: 'test', position: 0 }), event(2, { kind: 'turn.started', messageId: 'm' as MessageId, turnId: 't' as TurnId })]
    for (let seq = 3; seq <= 1002; seq++) events.push(event(seq, { kind: 'assistant.text.delta', turnId: 'unrelated' as TurnId, text: 'not Run output' }))
    events.push(event(1003, { kind: 'turn.finished', turnId: 'wrong' as TurnId, outcome: 'completed', failure: null }), event(1004, { kind: 'turn.finished', turnId: 't' as TurnId, outcome: 'completed', failure: null }))
    const envelope = { protocolVersion: 1 as const, messageId: 'batch' as MessageId }
    await workers.receive(f.worker.id, { ...envelope, type: 'sync', kind: 'batch', sessionId, throughSeq: 500 as EventSeq, hasMore: true, events: events.slice(1, 500) })
    assert.equal((await f.store.tasks.run(run.id))!.lastProjectedSeq, 0)
    await workers.receive(f.worker.id, { ...envelope, type: 'event', scope: 'session', event: events[0]! })
    assert.equal((await f.store.tasks.run(run.id))!.lastProjectedSeq, 500)
    const replies = await workers.receive(f.worker.id, { ...envelope, type: 'sync', kind: 'batch', sessionId, throughSeq: 1000 as EventSeq, hasMore: true, events: events.slice(500, 1000) })
    assert.ok(replies.some(r => r.type === 'sync' && r.kind === 'request' && r.fromSeq === 1001 && r.limit === 500))
    await workers.receive(f.worker.id, { ...envelope, type: 'sync', kind: 'batch', sessionId, throughSeq: 1004 as EventSeq, hasMore: false, events: events.slice(1000) })
    const done = (await f.store.tasks.run(run.id))!
    assert.equal(done.status, 'succeeded'); assert.equal(done.lastProjectedSeq, 1004); assert.equal(done.resultSummary, null)
    assert.equal((await f.store.cache.getFreshness(sessionId))!.contiguousSeq, 1004)
  } finally { f.store.close() }
})

test('real server listen recovers contiguous disk cache with cursor behind exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket05-startup-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  const { run } = await f.launch(), sessionId = run.sessionId as SessionId
  try {
    await f.store.transaction(tx => tx.cache.applyEvents(sessionId, [
      { sessionId, seq: 1 as EventSeq, occurredAt: run.createdAt as Timestamp, payload: { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'm' as MessageId, content: 'test', position: 0 } },
      { sessionId, seq: 2 as EventSeq, occurredAt: run.createdAt as Timestamp, payload: { kind: 'turn.started', messageId: 'm' as MessageId, turnId: 't' as TurnId } },
      { sessionId, seq: 3 as EventSeq, occurredAt: run.createdAt as Timestamp, payload: { kind: 'turn.finished', turnId: 't' as TurnId, outcome: 'completed', failure: null } },
    ]))
    assert.equal((await f.store.tasks.run(run.id))!.lastProjectedSeq, 0)
  } finally { f.store.close() }
  try {
    for (let restart = 0; restart < 2; restart++) {
      const server = createWemuxServer({ databasePath: path, administratorEmails: [administratorEmail] })
      const { token } = await seedAdministrator(server.store)
      try { await server.listen(0) } finally { await server.close() }
      const db = new DatabaseSync(path)
      try {
        const persisted = JSON.parse(String(db.prepare('SELECT data FROM task_runs WHERE id=?').get(run.id)!.data))
        assert.equal(persisted.status, 'succeeded'); assert.equal(persisted.lastProjectedSeq, 3)
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id=? AND json_extract(data,'$.type')='run.finished'").get(f.task.id)!.n, 1)
      } finally { db.close() }
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

 test('SQLite Run request attempt active uniques and Session/create/enqueue FKs reject direct invalid rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket05-constraints-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  const { run } = await f.launch()
  f.store.close()
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys=ON')
    const insert = (values: Partial<Record<'task' | 'request' | 'attempt' | 'status' | 'session' | 'create' | 'enqueue', string | number>>) => {
      db.prepare('INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,create_command_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?,?)').run('probe', values.task ?? run.taskId, values.request ?? 'fresh', values.attempt ?? 2, values.status ?? 'succeeded', values.session ?? run.sessionId, values.create ?? run.createCommandId, values.enqueue ?? 'probe-enqueue', JSON.stringify({ ...run, id: 'probe', taskId: values.task ?? run.taskId, requestId: values.request ?? 'fresh', request: { ...run.request, mode: 'reuse', reuseSessionId: values.session ?? run.sessionId, requestId: values.request ?? 'fresh' }, attempt: values.attempt ?? 2, status: values.status ?? 'succeeded', sessionId: values.session ?? run.sessionId, createCommandId: values.create ?? run.createCommandId, enqueueCommandId: values.enqueue ?? 'probe-enqueue' }))
    }
    db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run('probe-enqueue', f.worker.id, 'pending', '{}', '{}')
    assert.throws(() => insert({ request: run.requestId }), /UNIQUE constraint failed: task_runs.task_id, task_runs.request_id/)
    assert.throws(() => insert({ attempt: 1 }), /UNIQUE constraint failed: task_runs.task_id, task_runs.attempt/)
    for (const status of ['pending', 'running', 'cancelling']) assert.throws(() => insert({ status }), /UNIQUE constraint failed: task_runs.task_id/)
    for (const key of ['task', 'session', 'create', 'enqueue'] as const) assert.throws(() => insert({ [key]: 'missing' }), /FOREIGN KEY constraint failed|Run Session project mismatch or deleted|Invalid Run identity or binding/)
    assert.throws(() => insert({ enqueue: run.enqueueCommandId }), /UNIQUE constraint failed: task_runs.enqueue_command_id/)
    insert({}) // terminal history does not occupy the active partial index
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n, 2)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})

 test('dependency SQL filters more than delivery limit blocked commands before eligible tail', async () => {
  const f = await fixture()
  try {
    const { run } = await f.launch()
    const template = (await f.store.commands.listDeliverable(f.worker.id, 100)).find(c => c.commandId === run.createCommandId)!
    await f.store.transaction(async tx => {
      // Accepted provision removes the fixture command from the delivery window.
      for (const c of await tx.commands.listDeliverable(f.worker.id, 100)) if (c.commandId !== run.createCommandId) await tx.commands.recordReceipt({ commandId: c.commandId, status: 'accepted' }, run.createdAt as Timestamp)
      for (let i = 0; i < 120; i++) {
        const id = `blocked-${i}` as CommandId
        await tx.commands.insertPending({ ...template, commandId: id })
        await tx.commands.depend(id, run.createCommandId as CommandId)
      }
      await tx.commands.insertPending({ ...template, commandId: 'eligible-tail' as CommandId })
    })
    const commands = await f.store.commands.listDeliverable(f.worker.id, 100)
    assert.deepEqual(commands.map(c => c.commandId), [run.createCommandId, 'eligible-tail'])
  } finally { f.store.close() }
})

 test('v4 disk upgrades to v5 and repeated bootstrap preserves prior resources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket05-migration-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  const before = await f.store.tasks.get(f.task.id)
  f.store.close()
  const db = new DatabaseSync(path)
  try {
    // Remove the empty post-v4 schema, retaining real v4 resources and history.
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view') AND name NOT IN ('task_workspaces_project','session_creation_provenance','session_task_scope','active_run_session_delete','run_session_scope') ORDER BY type").all()) {
      const type = db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(row.name!)!.type
      db.exec(`DROP ${String(type)} "${String(row.name)}"`)
    }
    db.exec('ALTER TABLE records DROP COLUMN source_run_id')
    db.exec('DROP TABLE command_rejections; DROP TRIGGER IF EXISTS project_activity_append; DROP TABLE project_activity; DROP TABLE review_requests; DROP TRIGGER session_creation_provenance; DROP TRIGGER session_task_scope; DROP TRIGGER active_run_session_delete; DROP TRIGGER run_session_scope; DROP TABLE run_cancel_requests; DROP TABLE command_dependencies; DROP TABLE task_runs; DROP INDEX task_activity_source; ALTER TABLE task_activity DROP COLUMN source_key; DELETE FROM schema_migrations WHERE version>=5;')
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version), [1, 2, 3, 4])
  } finally { db.close() }
  try {
    for (let i = 0; i < 2; i++) {
      const store = new SqliteServerStore(path)
      try {
        const service = new ServerService(store, new Notifications())
        await seedOperator(store, service); await seedOperator(store, service)
        assert.deepEqual(await store.tasks.get(f.task.id), before)
        assert.deepEqual(await store.tasks.runs(f.task.id), [])
      } finally { store.close() }
    }
    const check = new DatabaseSync(path)
    try {
      assert.deepEqual(check.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version), Array.from({ length: migrationCount }, (_, index) => index + 1))
      assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), [])
    } finally { check.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

 test('real gateway hello reconnect and disk server restart redeliver create/enqueue IDs after lost ACK', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket05-delivery-')), path = join(dir, 'server.db')
  const f = await fixture(path), { run } = await f.launch()
  f.store.close()
  let app = createWemuxServer({ databasePath: path, administratorEmails: [administratorEmail] }), base = await app.listen(0)
  const { token } = await seedAdministrator(app.store)
  let socket: WebSocket | undefined
  const connect = async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/worker/ws`, { headers: { Authorization: `Bearer ${f.credential}` } })
    socket = ws
    const peer = new TransportV2Peer(ws, f.worker.id)
    await peer.connect({ name: 'Reconnect worker' })
    const received = peer.messages
    const waitCommand = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const command = received.find(m => m.type === 'command' && m.commandId === id)
        if (command) return command
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.fail(`No command ${id}: ${JSON.stringify(received)}`)
    }
    return { ws, peer, received, waitCommand }
  }
  const disconnect = async (ws: WebSocket) => {
    const closed = once(ws, 'close'); ws.close(); await closed
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${base}/api/workers/${f.worker.id}`, { headers: { Authorization: `Bearer ${administratorToken}` } })
      if ((await r.json()).connectionState === 'offline') return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('Worker did not become offline')
  }
  try {
    const first = await connect(); await first.waitCommand(run.createCommandId!)
    assert.ok(!first.received.some(m => m.type === 'command' && m.commandId === run.enqueueCommandId))
    await disconnect(first.ws) // received create, no receipt: ACK lost
    const second = await connect(); await second.waitCommand(run.createCommandId!)
    second.peer.send({ type: 'ack', receipt: { commandId: run.createCommandId, status: 'accepted' } })
    await second.waitCommand(run.enqueueCommandId)
    await disconnect(second.ws) // received enqueue, no receipt: ACK lost
    await app.close()
    app = createWemuxServer({ databasePath: path, administratorEmails: [administratorEmail] }); base = await app.listen(0)
    const third = await connect(); await third.waitCommand(run.enqueueCommandId)
    assert.ok(!third.received.some(m => m.type === 'command' && m.commandId === run.createCommandId))
    const db = new DatabaseSync(path)
    try {
      assert.equal(db.prepare('SELECT status FROM commands WHERE id=?').get(run.createCommandId)!.status, 'accepted')
      assert.equal(db.prepare('SELECT status FROM commands WHERE id=?').get(run.enqueueCommandId)!.status, 'pending')
      assert.equal(db.prepare('SELECT prerequisite_id FROM command_dependencies WHERE command_id=?').get(run.enqueueCommandId)!.prerequisite_id, run.createCommandId)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n, 1)
    } finally { db.close() }
  } finally { socket?.terminate(); await app.close(); await rm(dir, { recursive: true, force: true }) }
})


test('Run HTTP ownership/resource/raw JSON matrix has exact envelopes and zero full database or notification effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket05-http-')), dbPath = join(dir, 'server.db')
  const f = await fixture(dbPath), token = administratorToken
  const auth = new AuthenticationService(f.store, administratorDirectory(f.store))
  const outsider = 'outsider' as UserId
  await f.store.transaction(async tx => {
    await tx.identity.saveUser({ id: outsider, username: 'outsider', email: null, createdAt: new Date().toISOString() as Timestamp })
    await tx.identity.saveMembership({ teamId: f.worker.teamId, userId: outsider, role: 'member', joinedAt: new Date().toISOString() as Timestamp })
  })
  const outsiderToken = await issuePat(f.store, outsider, 60000)
  const project = await f.server.createProject({ name: 'Other project' })
  const other = await f.tasks.create(f.task.projectId, { title: 'Other task' }, context)
  const cross = await f.tasks.create(project.id, { title: 'Cross project' }, context)
  const { run } = await f.launch()
  let notifications = 0
  const signals = new Notifications(); signals.commands = () => { notifications++ }
  const service = new ServerService(f.store, signals)
  const tasks = new TaskService(f.store, () => { notifications++ }, service)
  const http = createServer(httpHandler({ service, auth, streams: new SessionStreams(service), tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const db = new DatabaseSync(dbPath)
  // All persisted tables, including identity/audit, cache, dependencies, receipts and activities; no LIMIT.
  const snapshot = () => ({ notifications, tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => ({ name: row.name, rows: db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all() })) })
  const path = `/projects/${f.task.projectId}/tasks/${f.task.id}`
  const check = async (suffix: string, method: string, body: string | undefined, status: number, error: object, bearer = token) => {
    const before = snapshot()
    const response = await fetch(`http://127.0.0.1:${address.port}${suffix}`, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body })
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error })
    assert.deepEqual(snapshot(), before)
  }
  try {
    for (const [method, suffix, body] of [['POST', '/transition', JSON.stringify({ version: 2, status: 'in_review' })], ['POST', '/runs/' + run.id + '/review', JSON.stringify({ version: 2, status: 'requested' })], ['POST', '/launch', JSON.stringify(f.request)], ['GET', '/runs', undefined], ['GET', '/runs/' + run.id, undefined], ['POST', '/runs/' + run.id + '/cancel', JSON.stringify({ runId: run.id, sessionId: run.sessionId, requestId: 'cancel-http' })]] as const) {
      for (const [query, bearer] of [['', outsiderToken], ['?teamId=wrong', token]]) await check(path + suffix + query, method, body, 403, { code: 'forbidden', message: 'Project ownership required' }, bearer)
      await check(`/projects/${project.id}/tasks/${f.task.id}${suffix}`, method, body, 404, { code: 'not_found', message: 'Task not found in this project' })
    }
    for (const task of [other, cross]) await check(`/projects/${task.projectId}/tasks/${task.id}/runs/${run.id}`, 'GET', undefined, 404, { code: 'not_found', message: 'Run not found in this Task' })
    await check(path + '/transition', 'POST', '{', 400, { code: 'invalid_request', message: 'Invalid JSON' })
    await check(path + '/transition', 'POST', JSON.stringify({ version: 2, status: 'in_review' }), 409, { code: 'active_run', message: 'Review requires a terminal Run and no active Task Run' })
    const independentPath = path + '/sessions'
    for (const bearer of [outsiderToken]) await check(independentPath, 'POST', JSON.stringify({ title: 'Independent' }), 403, { code: 'forbidden', message: 'Project ownership required' }, bearer)
    await check(independentPath + '?teamId=wrong', 'POST', JSON.stringify({ title: 'Independent' }), 403, { code: 'forbidden', message: 'Project ownership required' })
    await check(`/projects/${project.id}/tasks/${f.task.id}/sessions`, 'POST', JSON.stringify({ title: 'Independent' }), 404, { code: 'not_found', message: 'Task not found in this project' })
    await check(independentPath, 'POST', '{', 400, { code: 'invalid_request', message: 'Invalid JSON' })
    for (const body of [{ title: '' }, { title: 'Independent', workspaceId: 'wrong' }, { title: 'Independent', assignment: {} }, { title: 'Independent', runId: run.id }, { title: 'Independent', requestId: '' }, { title: 'Independent', taskId: other.id }]) await check(independentPath, 'POST', JSON.stringify(body), 400, { code: 'invalid_request', message: 'Session title and requestId required; unknown fields are not allowed' })
    await check(`/projects/${project.id}/tasks/${cross.id}/sessions`, 'POST', JSON.stringify({ title: 'Independent', requestId: 'unassigned' }), 409, { code: 'assignment_changed', message: 'Task assignment required' })
    const cancelPath = path + '/runs/' + run.id + '/cancel'
    const cancelBody = { runId: run.id, sessionId: run.sessionId, requestId: 'cancel-http' }
    for (const task of [other, cross]) await check(`/projects/${task.projectId}/tasks/${task.id}/runs/${run.id}/cancel`, 'POST', JSON.stringify(cancelBody), 404, { code: 'not_found', message: 'Run not found in this Task' })
    await check(cancelPath, 'POST', '{', 400, { code: 'invalid_request', message: 'Invalid JSON' })
    for (const body of [{ ...cancelBody, sessionId: 'wrong' }, { ...cancelBody, runId: 'wrong' }, { ...cancelBody, requestId: '' }, { ...cancelBody, extra: true }]) await check(cancelPath, 'POST', JSON.stringify(body), 400, { code: 'invalid_request', message: 'Cancel requires matching runId/sessionId and requestId' })
    await check(path + '/launch', 'POST', '{"requestId":', 400, { code: 'invalid_request', message: 'Invalid JSON' })
    await check(path + '/launch', 'POST', JSON.stringify({ ...f.request, assignment: { ...f.request.assignment, modelId: 'changed' } }), 409, { code: 'request_id_conflict', message: 'requestId already belongs to a different complete request' })
    await check(path + '/launch', 'POST', JSON.stringify({ ...f.request, requestId: 'changed', assignment: { ...f.request.assignment, modelId: 'changed' } }), 409, { code: 'assignment_changed', message: 'Assignment changed; retain draft and explicitly confirm current assignment', details: { assignment: f.request.assignment } })
    await check(path + '/launch', 'POST', JSON.stringify({ ...f.request, requestId: 'new' }), 409, { code: 'active_run', message: 'Task already has an active Run', details: { runId: run.id } })
  } finally { db.close(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); f.store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('real Run cancel HTTP route requires the client target tuple and reaches the service exactly once', async () => {
  const f = await fixture()
  const { run } = await f.launch()
  const auth = new AuthenticationService(f.store, administratorDirectory(f.store))
  const http = createServer(httpHandler({ service: f.server, auth, streams: new SessionStreams(f.server), tasks: f.tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const path = `http://127.0.0.1:${address.port}/projects/${f.task.projectId}/tasks/${f.task.id}/runs/${run.id}/cancel`
  try {
    const input = { runId: run.id, sessionId: run.sessionId, requestId: 'client-target' }
    const first = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    assert.equal(first.status, 200)
    const accepted = await first.json() as { run: { id: string; sessionId: string; cancelRequestedAt: string | null } }
    assert.equal(accepted.run.id, run.id)
    assert.equal(accepted.run.sessionId, run.sessionId)
    assert.ok(accepted.run.cancelRequestedAt)
    const replay = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    assert.equal(replay.status, 200)
    assert.equal((await replay.json() as { run: { id: string } }).run.id, run.id)
    assert.ok(await f.store.transaction(tx => tx.tasks.cancelRequest(run.id, input.requestId)), 'one durable cancellation identity survives replay')
  } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); f.store.close() }
})

test('real HTTP Run launch rejection envelopes leave all launch resources unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket05-rejections-')), dbPath = join(dir, 'server.db')
  const f = await fixture(dbPath), token = administratorToken, db = new DatabaseSync(dbPath)
  let notifications = 0
  f.server.notifications.commands = () => { notifications++ }
  const observedTasks = new TaskService(f.store, () => { notifications++ }, f.server)
  const auth = new AuthenticationService(f.store, administratorDirectory(f.store))
  const http = createServer(httpHandler({ service: f.server, auth, streams: new SessionStreams(f.server), tasks: observedTasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const path = `/projects/${f.task.projectId}/tasks/${f.task.id}`
  const call = async (suffix: string, body: unknown, bearer: string | null = token) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  const snapshot = async () => ({ notifications, tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => ({ name: row.name, rows: db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all() })) })
  const check = async (code: string, status: number, body: unknown = f.request, suffix = path + '/launch', bearer: string | null = token) => {
    const before = await snapshot(), result = await call(suffix, body, bearer)
    assert.equal(result.status, status, JSON.stringify(result))
    assert.equal(result.data.error.code, code)
    assert.equal(typeof result.data.error.message, 'string'); assert.ok(result.data.error.message.length)
    assert.deepEqual(Object.keys(result.data), ['error'])
    assert.ok(Object.keys(result.data.error).every(key => ['code', 'message', 'details'].includes(key)))
    const details = code === 'assignment_changed' ? { assignment: f.request.assignment } : code === 'active_run' ? { runId: (await f.store.tasks.runs(f.task.id))[0]!.id } : undefined
    assert.deepEqual(result.data.error.details, details)
    assert.deepEqual(await snapshot(), before)
  }
  try {
    await check('unauthorized', 401, f.request, path + '/launch', null)
    const expired = await issuePat(f.store, context.actor, -1000)
    await check('unauthorized', 401, f.request, path + '/launch', expired)
    await check('forbidden', 403, f.request, path + '/launch?teamId=wrong')
    await check('not_found', 404, f.request, '/projects/default-project/tasks/missing/launch')
    await check('invalid_request', 400, {})
    await check('reuse_ineligible', 409, { ...f.request, mode: 'reuse', reuseSessionId: 'other' })
    await check('assignment_changed', 409, { ...f.request, assignment: { ...f.request.assignment, modelId: 'changed' } })
    const workspace = (await f.store.resources.getWorkspace(f.request.assignment.workspaceId))!
    await f.store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'failed' }))
    await check('workspace_not_ready', 409)
    await f.store.transaction(tx => tx.resources.saveWorkspace(workspace))
    const worker = (await f.store.resources.getWorker(f.worker.id))!
    await f.store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'offline' }))
    await check('runtime_unavailable', 409)
    await f.store.transaction(tx => tx.resources.saveWorker({ ...worker, capabilities: [] }))
    await check('runtime_unavailable', 409)
    await f.store.transaction(tx => tx.resources.saveWorker(worker))
    assert.equal((await call(path + '/launch', f.request)).status, 200)
    await check('request_id_conflict', 409, { ...f.request, prompt: 'different' })
    await check('active_run', 409, { ...f.request, requestId: 'another' })
  } finally { db.close(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); f.store.close(); await rm(dir, { recursive: true, force: true }) }
})


for (const phase of ['pending', 'running'] as const) for (const outcome of ['completed', 'cancelled'] as const) test(`HTTP ${phase}/${outcome} management protects Run snapshot and Session; terminal releases Task restrictions`, async () => {
  const f = await fixture(), token = administratorToken
  const http = createServer(httpHandler({ service: f.server, auth: new AuthenticationService(f.store, administratorDirectory(f.store)), streams: new SessionStreams(f.server), tasks: f.tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const path = `/projects/${f.task.projectId}/tasks/${f.task.id}`
  const call = async (suffix: string, method: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${suffix}`, { method, headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  try {
    const { run } = await f.launch()
    const sessionId = run.sessionId as SessionId
    const event = (seq: number, payload: JournalEvent['payload']): JournalEvent => ({ sessionId, seq: seq as EventSeq, occurredAt: new Date().toISOString() as Timestamp, payload })
    const start = [event(1, { kind: 'message.queued', commandId: run.enqueueCommandId as CommandId, messageId: 'management-message' as MessageId, content: f.request.prompt, position: 0 }), event(2, { kind: 'turn.started', messageId: 'management-message' as MessageId, turnId: 'management-turn' as TurnId })]
    const apply = (events: JournalEvent[]) => f.store.transaction(async tx => { await tx.cache.applyEvents(sessionId, events); await projectRuns(tx, sessionId) })
    if (phase === 'running') await apply(start)
    assert.equal((await f.store.tasks.run(run.id))!.status, phase)
    for (const status of ['todo', 'in_progress']) {
      const task = await f.tasks.get(f.task.projectId, f.task.id, context)
      assert.equal((await call(path, 'PATCH', { version: task.version, status })).status, 200)
    }
    const reviewEntry = await f.tasks.get(f.task.projectId, f.task.id, context)
    assert.equal((await call(path, 'PATCH', { version: reviewEntry.version, status: 'in_review' })).status, 409)
    for (const status of ['done', 'cancelled']) {
      const before = await f.tasks.get(f.task.projectId, f.task.id, context)
      const response = await call(path, 'PATCH', { version: before.version, status })
      assert.equal(response.status, 409); assert.equal(response.data.error.code, 'active_run')
      assert.deepEqual(await f.tasks.get(f.task.projectId, f.task.id, context), before)
    }
    const another = await call(path + '/launch', 'POST', { ...f.request, requestId: 'new-active' })
    assert.equal(another.status, 409); assert.equal(another.data.error.code, 'active_run')
    let current = await f.tasks.get(f.task.projectId, f.task.id, context)
    assert.equal((await call(path, 'PATCH', { version: current.version, status: 'blocked' })).status, 200)
    current = await f.tasks.get(f.task.projectId, f.task.id, context)
    const replacement = await f.tasks.createWorkspace(f.task.projectId, f.task.id, { name: 'Replacement', workerId: f.worker.id, source: 'empty' }, context)
    await f.store.transaction(tx => tx.resources.saveWorkspace({ ...replacement.workspace, status: 'ready' }))
    const assignment = { ...f.request.assignment, workspaceId: replacement.workspace.id }
    assert.equal((await call(path + '/assignment', 'PUT', { version: current.version, assignee: assignment })).status, 200)
    assert.deepEqual((await f.tasks.get(f.task.projectId, f.task.id, context)).assignee, assignment)
    assert.deepEqual((await f.store.tasks.run(run.id))!.snapshot, run.snapshot)
    current = await f.tasks.get(f.task.projectId, f.task.id, context)
    const unbind = await call(path + '/workspaces/' + run.snapshot.workspaceId, 'DELETE', { version: current.version })
    assert.equal(unbind.status, 409); assert.equal(unbind.data.error.code, 'active_run')
    const deletion = await call('/sessions/' + sessionId, 'DELETE')
    assert.equal(deletion.status, 409); assert.equal(deletion.data.error.code, 'run_session_protected'); assert.equal(typeof deletion.data.error.message, 'string')
    if (phase === 'pending') await apply(start)
    await apply([event(3, { kind: 'turn.finished', turnId: 'management-turn' as TurnId, outcome, failure: null })])
    assert.equal((await f.store.tasks.run(run.id))!.status, outcome === 'completed' ? 'succeeded' : 'failed')
    if (outcome === 'cancelled') assert.equal((await f.store.tasks.run(run.id))!.failure?.code, 'cancelled')
    assert.equal((await f.tasks.get(f.task.projectId, f.task.id, context)).status, 'blocked')
    const terminalDelete = await call('/sessions/' + sessionId, 'DELETE')
    assert.equal(terminalDelete.status, 409); assert.equal(terminalDelete.data.error.code, 'run_session_protected')
    assert.equal((await call('/sessions/' + sessionId + '/events', 'GET')).status, 200)
    current = await f.tasks.get(f.task.projectId, f.task.id, context)
    assert.equal((await call(path, 'PATCH', { version: current.version, status: 'in_review' })).status, 409, 'a blocked Task must return to implementation before review')
    current = await f.tasks.get(f.task.projectId, f.task.id, context)
    for (const [method, suffix] of [['PATCH', ''], ['POST', '/transition'], ['POST', '/move']] as const) {
      const bypass = await call(path + suffix, method, { version: current.version, status: 'done' })
      assert.equal(bypass.status, 409); assert.equal(bypass.data.error.code, 'invalid_transition')
    }
    current = await f.tasks.get(f.task.projectId, f.task.id, context)
    assert.equal((await call(path, 'PATCH', { version: current.version, status: 'in_progress' })).status, 200)
    current = await f.tasks.get(f.task.projectId, f.task.id, context)
    assert.equal((await call(path, 'PATCH', { version: current.version, status: 'in_review' })).status, outcome === 'completed' ? 200 : 409)
    current = await f.tasks.get(f.task.projectId, f.task.id, context)
    assert.equal((await call(path + '/workspaces/' + run.snapshot.workspaceId, 'DELETE', { version: current.version })).status, 200)
    const next = await call(path + '/launch', 'POST', { ...f.request, assignment, requestId: 'terminal-release' })
    assert.equal(next.status, 200); assert.equal(next.data.run.attempt, 2)
    assert.notEqual(next.data.run.sessionId, sessionId)
  } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); f.store.close() }
})

for (const rollback of [false, true]) test(`ordinary review transition is atomic through audit ${rollback ? 'rollback' : 'commit'}`, async () => {
  const f = await reviewFixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), paused = new Promise<void>(resolve => { entered = resolve })
  try {
    const before = await f.store.tasks.activity(f.task.id, 0)
    const events: unknown[] = []
    const store = intercepted(f.store, tx => ({ ...tx, audit: { append: async entry => {
      await tx.audit.append(entry); entered(); await gate; if (rollback) throw Error('transition rollback')
    } } }))
    const tasks = new TaskService(store, event => events.push(event))
    const operation = tasks.patch(f.task.projectId, f.task.id, { version: f.task.version, status: 'in_review' }, context).then(value => value, error => error)
    await paused
    let settled = false
    const reader = Promise.all([f.tasks.get(f.task.projectId, f.task.id, context), f.store.tasks.review(f.run.id), f.store.tasks.activity(f.task.id, 0)]).then(value => { settled = true; return value })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(settled, false); assert.equal(events.length, 0)
    release(); const result = await operation
    const [task, review, activity] = await reader
    assert.equal(task.status, rollback ? 'in_progress' : 'in_review')
    assert.equal(Boolean(review), !rollback)
    assert.equal(activity.length, before.length + (rollback ? 0 : 1))
    assert.equal(events.length, rollback ? 0 : 1)
    if (rollback) assert.match(String(result), /transition rollback/)
    else { assert.equal(review?.taskRunId, f.run.id); assert.equal(activity.at(-1)?.payload.reviewId, review?.id) }
  } finally { release?.(); f.store.close() }
})

for (const corrupt of ['metadata', 'restore', 'snapshot'] as const) test(`corrupt ${corrupt} denies service capabilities and transitions without side effects`, async () => {
  const f = await reviewFixture()
  try {
    // Inject corrupt adapter facts: SQLite separately prevents invalid schema/immutable snapshot writes.
    const store = intercepted(f.store, tx => ({ ...tx, tasks: { ...tx.tasks,
      get: async id => { const task = await tx.tasks.get(id); return task && corrupt !== 'snapshot' ? { ...task, ...(corrupt === 'metadata' ? { metadataJson: { schemaVersion: 1 as const, values: null! } } : { status: 'blocked' as const, blockedFrom: null }) } : task },
      runs: async id => (await tx.tasks.runs(id)).map(run => corrupt === 'snapshot' ? { ...run, snapshot: { ...run.snapshot, modelId: '' } } : run),
    } }))
    const service = new TaskService(store)
    const before = await f.store.tasks.activity(f.task.id, 0)
    const task = await service.get(f.task.projectId, f.task.id, context)
    for (const target of ['in_review', 'done', 'cancelled'] as const) {
      assert.equal(task.capabilities!.transitions[target].reasonCode, 'invalid_metadata')
      await assert.rejects(service.patch(task.projectId, task.id, { status: target, version: task.version }, context), { code: 'invalid_transition', status: 409, message: task.capabilities!.transitions[target].reason })
      assert.deepEqual(await f.store.tasks.activity(task.id, 0), before)
      assert.equal(await f.store.tasks.review(f.run.id), null)
    }
  } finally { f.store.close() }
})

test('capability HTTP readers equal service values and transition rejection has no activity', async () => {
  const f = await fixture()
  const http = createServer(httpHandler({ service: f.server, auth: new AuthenticationService(f.store, administratorDirectory(f.store)), streams: new SessionStreams(f.server), tasks: f.tasks }))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const headers = { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }
  const base = `http://127.0.0.1:${address.port}`
  try {
    const { run } = await f.launch()
    for (const [path, expected] of [
      [`/projects/${f.task.projectId}/tasks/${f.task.id}`, await f.tasks.get(f.task.projectId, f.task.id, context)],
      [`/projects/${f.task.projectId}/tasks/${f.task.id}/runs/${run.id}`, await f.tasks.run(f.task.projectId, f.task.id, run.id, context)],
      [`/sessions/${run.sessionId}`, await f.server.sessionView(run.sessionId as SessionId)],
    ] as const) {
      const response = await fetch(base + path, { headers })
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected)
    }
    const task = await f.tasks.get(f.task.projectId, f.task.id, context)
    const before = await f.store.tasks.activity(task.id, 0)
    for (const target of ['done', 'in_review', 'cancelled'] as const) {
      const capability = task.capabilities!.transitions[target]
      assert.equal(capability.allowed, false)
      const response = await fetch(`${base}/projects/${task.projectId}/tasks/${task.id}/transition`, { method: 'POST', headers, body: JSON.stringify({ version: task.version, status: target }) })
      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), { error: { code: capability.reasonCode, message: capability.reason } })
      assert.deepEqual(await f.store.tasks.activity(task.id, 0), before)
    }
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); f.store.close() }
})

test('ordinary review transition concurrent and restart stale requests conflict; active execution is independent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'transition-review-')), path = join(dir, 'db.sqlite')
  const f = await fixture(path)
  try {
    const { run } = await f.launch()
    let task = await f.tasks.get(f.task.projectId, f.task.id, context)
    for (const status of ['todo', 'in_progress']) task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status }, context)
    const events: unknown[] = []
    const tasks = new TaskService(f.store, event => events.push(event))
    const input = { version: task.version, status: 'in_review' }
    await f.store.transaction(tx => saveReviewRun(tx, run))
    const before = await f.store.tasks.activity(task.id, 0)
    const outcomes = await Promise.allSettled([tasks.patch(task.projectId, task.id, input, context), tasks.patch(task.projectId, task.id, input, context)])
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter(r => r.status === 'rejected' && r.reason.code === 'version_conflict').length, 1)
    assert.equal(events.length, 1)
    assert.equal((await f.store.tasks.run(run.id))?.status, 'succeeded')
    assert.equal((await f.store.tasks.review(run.id))?.status, 'requested')
    assert.equal((await f.store.tasks.activity(task.id, 0)).length, before.length + 1)
    const check = new DatabaseSync(path)
    const audits = () => check.prepare("SELECT * FROM records WHERE kind='audit' ORDER BY id").all()
    const savedAudits = audits()
    f.store.close()
    const reopened = new SqliteServerStore(path)
    try {
      const service = new TaskService(reopened, event => events.push(event))
      await assert.rejects(service.patch(task.projectId, task.id, input, context), { code: 'version_conflict' })
      assert.equal(events.length, 1); assert.deepEqual(audits(), savedAudits)
      assert.equal((await service.pendingReviews(task.projectId, context)).length, 1)
      await reopened.transaction(tx => saveReviewRun(tx, run))
      assert.equal((await reopened.tasks.get(task.id))?.status, 'in_review')
    } finally { reopened.close(); check.close() }
  } finally { try { f.store.close() } catch {} await rm(dir, { recursive: true, force: true }) }
})

for (const decision of ['approve', 'changes_requested'] as const) test(`approval router ${decision}: shared SQLite rollback, concurrent binding and HTTP reopen`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'human-approval-atomic-'))
  const path = join(directory, 'server.sqlite')
  let database = new SharedSqliteDatabase(path)
  const f = await fixture(database)
  let store = f.store
  let service = f.server
  const events: unknown[] = []
  const publishedReceiptCounts: unknown[] = []
  let tasks = new TaskService(store, event => {
    // A separate connection must observe the receipt before publication.
    const observer = new DatabaseSync(path)
    try { publishedReceiptCounts.push(observer.prepare('SELECT COUNT(*) AS n FROM approval_decision_receipts').get()!.n) }
    finally { observer.close() }
    events.push(event)
  }, service)
  let receipts = new SqliteApprovalDecisionRepository(database)
  const start = async () => {
    const projects = new ProjectAccessService(store)
    const projections = new ProjectionService(store, projects, new SessionAccessService(store, projects), receipts)
    const router = new ApprovalDecisionRouter(projections, tasks, service, receipts)
    const http = createServer(httpHandler({ service, auth: new AuthenticationService(store, administratorDirectory(store)), streams: new SessionStreams(service), tasks, projections, approvalDecisions: router }))
    http.listen(0, '127.0.0.1'); await once(http, 'listening')
    const address = http.address(); assert.ok(address && typeof address !== 'string')
    return { http, base: `http://127.0.0.1:${address.port}/api/approvals`, projections }
  }
  let host = await start()
  const stop = () => new Promise<void>((resolve, reject) => host.http.close(error => error ? reject(error) : resolve()))
  try {
    const project = await store.resources.getProject(f.task.projectId as never); assert.ok(project)
    await store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    const manager = randomUUID() as UserId, now = new Date().toISOString() as Timestamp
    await store.transaction(async tx => {
      await tx.identity.saveUser({ id: manager, username: 'atomic-reviewer', email: null, status: 'active', authVersion: 0, createdAt: now, statusChangedAt: now, deletedAt: null })
      await tx.identity.saveMembership({ teamId: project.teamId, userId: manager, role: 'member', joinedAt: now })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId: manager, role: 'manager' })
    })
    const token = await issuePat(store, manager, 60_000)
    const other = await f.tasks.create(project.id, { title: 'Other atomic review' }, context)
    const workspace = await f.tasks.createWorkspace(project.id, other.id, { name: other.title, workerId: f.worker.id, source: 'empty' }, context)
    await store.transaction(tx => tx.resources.saveWorkspace({ ...workspace.workspace, status: 'ready' }))
    const otherAssignment = { ...f.request.assignment, workspaceId: workspace.workspace.id }
    await f.tasks.assignment(project.id, other.id, { version: other.version, assignee: otherAssignment }, false, context)
    for (const [id, assignment] of [[f.task.id, f.request.assignment], [other.id, otherAssignment]] as const) {
      const { run } = await f.tasks.launch(project.id, id, { ...f.request, assignment, requestId: `launch-${id}` }, context)
      await store.transaction(tx => saveReviewRun(tx, run))
      let task = await f.tasks.get(project.id, id, context)
      for (const status of ['todo', 'in_progress'] as const) task = await f.tasks.patch(project.id, id, { version: task.version, status }, context)
      await f.tasks.submitHumanReview(project.id, id, { version: task.version, requestId: `submit-${id}`, runId: run.id, summary: '成果', evidence: [] }, context)
    }
    const approvals = (await host.projections.approvals(manager, { sourceKind: 'task_review', status: 'pending' })).items
    assert.equal(approvals.length, 2)
    const first = approvals.find(a => a.source.kind === 'task_review' && a.source.taskId === f.task.id)!
    const second = approvals.find(a => a.projectionKey !== first.projectionKey)!
    const body = { decision, requestId: 'atomic-vote', sourceRevision: first.sourceRevision, ...(decision === 'changes_requested' ? { note: '补充验证' } : {}) }
    const post = async (approval = first, value: unknown = body) => {
      const response = await fetch(`${host.base}/${encodeURIComponent(approval.projectionKey)}/decisions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
      return { status: response.status, data: await response.json() as Record<string, any> }
    }
    const snapshot = () => {
      const db = database.connection
      return {
        tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
        reviews: db.prepare('SELECT * FROM review_requests ORDER BY id').all(),
        activity: db.prepare('SELECT * FROM task_activity ORDER BY seq').all(),
        records: db.prepare("SELECT * FROM records WHERE kind IN ('audit', 'create-request') ORDER BY kind,id").all(),
        receipts: db.prepare('SELECT * FROM approval_decision_receipts ORDER BY actor_id,request_id').all(),
        overlays: db.prepare('SELECT * FROM approval_decision_overlays ORDER BY projection_key').all(),
      }
    }
    const before = snapshot()
    const save = receipts.save.bind(receipts)
    receipts.save = async (...args) => { await save(...args); throw new Error('injected router save failure') }
    assert.equal((await post()).status, 500)
    assert.deepEqual(snapshot(), before, 'save failure must roll back domain, audit, domain receipt, router receipt and overlay')
    assert.equal(events.length, 0, 'rollback must not publish')
    receipts.save = save

    // HTTP requests also serialize through authentication; direct router overlap is tested below.
    let entered!: () => void, release!: () => void
    const saving = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    receipts.save = async (...args) => { entered(); await held; await save(...args) }
    const winner = post()
    await saving
    const loser = post(second, { ...body, sourceRevision: second.sourceRevision, note: 'conflicting fingerprint' })
    const publicationsBeforeCommit = events.length
    release()
    const [accepted, rejected] = await Promise.all([winner, loser])
    assert.equal(publicationsBeforeCommit, 0, 'domain publication waits for outer commit')
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data))
    assert.equal(rejected.status, 409, JSON.stringify(rejected.data))
    assert.equal(rejected.data.error.code, 'idempotency_conflict')
    assert.equal(accepted.data.approval.status, decision === 'approve' ? 'approved' : 'changes_requested')
    assert.deepEqual(accepted.data.approval.freshness, first.freshness)
    assert.equal((await tasks.get(project.id, f.task.id, context)).status, decision === 'approve' ? 'done' : 'in_progress')
    assert.equal((await tasks.get(project.id, other.id, context)).status, 'in_review')
    assert.equal(events.length, 1)
    assert.deepEqual(publishedReceiptCounts, [1], 'publication sees the committed router receipt on another connection')
    const after = snapshot()
    assert.equal(after.activity.length, before.activity.length + 1)
    assert.equal(after.records.length, before.records.length + 2, 'one audit and one domain receipt')
    assert.equal(after.receipts.length, 1); assert.equal(after.overlays.length, 1)
    const replay = await post()
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.data, { ...accepted.data, replayed: true })
    assert.deepEqual(snapshot(), after)
    // Same fingerprint on another review is also bound to the winning resource.
    assert.equal((await post(second)).data.error.code, 'idempotency_conflict')

    await stop(); receipts.close(); store.close(); database.close()
    database = new SharedSqliteDatabase(path)
    store = new SqliteServerStore(database)
    service = new ServerService(store, new Notifications())
    tasks = new TaskService(store, event => events.push(event), service)
    receipts = new SqliteApprovalDecisionRepository(database)
    host = await start()
    assert.deepEqual((await post()).data, { ...accepted.data, replayed: true })
    assert.equal((await receipts.listOverlays(new Date().toISOString() as Timestamp))[0]!.status, accepted.data.approval.status)
    await store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: manager, role: 'contributor' }))
    const revoked = await post()
    assert.equal(revoked.status, 403); assert.equal(revoked.data.approval, undefined)
    await store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: manager, role: 'manager' }))
    await store.transaction(tx => tx.identity.removeMembership(project.teamId, manager))
    const removed = await post()
    assert.equal(removed.status, 404, 'removed membership hides the Project')
    assert.equal(removed.data.approval, undefined)
    assert.deepEqual(snapshot(), after)
    assert.equal(events.length, 1)
  } finally { await stop(); receipts.close(); store.close(); database.close(); await rm(directory, { recursive: true, force: true }) }
})

for (const decision of ['approve', 'changes_requested'] as const) for (const fingerprint of ['different', 'identical'] as const) test(`approval router direct ${decision}: queued ${fingerprint} fingerprint remains bound to the first review`, { timeout: 10_000 }, async () => {
  const database = new SharedSqliteDatabase(':memory:')
  const f = await fixture(database)
  const receipts = new SqliteApprovalDecisionRepository(database)
  const events: unknown[] = []
  const tasks = new TaskService(f.store, event => events.push(event), f.server)
  const projects = new ProjectAccessService(f.store)
  const projections = new ProjectionService(f.store, projects, new SessionAccessService(f.store, projects), receipts)
  const router = new ApprovalDecisionRouter(projections, tasks, f.server, receipts)
  let release!: () => void
  const operations: Promise<unknown>[] = []
  try {
    const project = await f.store.resources.getProject(f.task.projectId as never); assert.ok(project)
    await f.store.transaction(tx => tx.resources.saveProject({ ...project, reviewPolicy: 'human', reviewPolicyVersion: 2 }))
    // A real Project manager distinct from the submitter; no HTTP auth can serialize calls before the router.
    const actor = randomUUID() as UserId, now = new Date().toISOString() as Timestamp
    await f.store.transaction(async tx => {
      await tx.identity.saveUser({ id: actor, username: 'direct-reviewer', email: null, status: 'active', authVersion: 0, createdAt: now, statusChangedAt: now, deletedAt: null })
      await tx.identity.saveMembership({ teamId: project.teamId, userId: actor, role: 'member', joinedAt: now })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId: actor, role: 'manager' })
    })
    const other = await f.tasks.create(project.id, { title: 'Competing direct review' }, context)
    const workspace = await f.tasks.createWorkspace(project.id, other.id, { name: other.title, workerId: f.worker.id, source: 'empty' }, context)
    await f.store.transaction(tx => tx.resources.saveWorkspace({ ...workspace.workspace, status: 'ready' }))
    const otherAssignment = { ...f.request.assignment, workspaceId: workspace.workspace.id }
    await f.tasks.assignment(project.id, other.id, { version: other.version, assignee: otherAssignment }, false, context)
    for (const [id, assignment] of [[f.task.id, f.request.assignment], [other.id, otherAssignment]] as const) {
      const { run } = await f.tasks.launch(project.id, id, { ...f.request, assignment, requestId: `launch-${id}` }, context)
      await f.store.transaction(tx => saveReviewRun(tx, run))
      let task = await f.tasks.get(project.id, id, context)
      for (const status of ['todo', 'in_progress'] as const) task = await f.tasks.patch(project.id, id, { version: task.version, status }, context)
      await f.tasks.submitHumanReview(project.id, id, { version: task.version, requestId: `submit-${id}`, runId: run.id, summary: '成果', evidence: [] }, context)
    }
    const approvals = (await projections.approvals(actor, { sourceKind: 'task_review', status: 'pending' })).items
    assert.equal(approvals.length, 2)
    const first = approvals.find(a => a.source.kind === 'task_review' && a.source.taskId === f.task.id)!
    const second = approvals.find(a => a.projectionKey !== first.projectionKey)!
    assert.ok(first.decisionCapabilities.includes(decision))
    assert.ok(second.decisionCapabilities.includes(decision))
    const input = (sourceRevision: string, note: string) => {
      const body = { decision, note, requestId: 'direct-atomic-vote', sourceRevision }
      return { ...body, fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
    }
    const winningInput = input(first.sourceRevision, '审核结果')
    const losingInput = fingerprint === 'identical' ? winningInput : input(second.sourceRevision, 'conflicting fingerprint')
    assert.equal(winningInput.fingerprint === losingInput.fingerprint, fingerprint === 'identical')
    const otherBefore = await f.store.tasks.get(other.id)
    const domainSnapshot = () => ({
      tasks: database.connection.prepare('SELECT * FROM tasks ORDER BY id').all(),
      reviews: database.connection.prepare('SELECT * FROM review_requests ORDER BY id').all(),
      activity: database.connection.prepare('SELECT * FROM task_activity ORDER BY seq').all(),
      records: database.connection.prepare("SELECT * FROM records WHERE kind IN ('audit', 'create-request') ORDER BY kind,id").all(),
    })
    let saving!: () => void, submitted!: () => void
    const firstSaving = new Promise<void>(resolve => { saving = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const secondSubmitted = new Promise<void>(resolve => { submitted = resolve })
    const save = receipts.save.bind(receipts)
    receipts.save = async (...args) => { saving(); await held; await save(...args) }
    const transaction = receipts.transaction.bind(receipts)
    let transactionCalls = 0
    const entered: number[] = []
    receipts.transaction = work => {
      const call = ++transactionCalls
      const result = transaction(() => { entered.push(call); return work() })
      // Signal only after the second router has submitted its callback to the real FIFO.
      if (call === 2) queueMicrotask(submitted)
      return result
    }
    const winner = router.decide(actor, first.projectionKey, winningInput)
    operations.push(winner)
    await firstSaving
    const atFirstSave = domainSnapshot()
    const loser = assert.rejects(router.decide(actor, second.projectionKey, losingInput), { status: 409, code: 'idempotency_conflict' })
    operations.push(loser)
    await secondSubmitted
    assert.equal(transactionCalls, 2, 'both calls reached the router transaction boundary')
    assert.deepEqual(entered, [1], 'second transaction callback must not enter while the first save is held')
    assert.equal(events.length, 0, 'publication waits for the first transaction commit')
    release()
    const [accepted] = await Promise.all([winner, loser])
    assert.deepEqual(entered, [1, 2], 'second callback runs after the first transaction releases the FIFO')
    assert.equal(accepted.approval.projectionKey, first.projectionKey)
    assert.equal(accepted.approval.status, decision === 'approve' ? 'approved' : 'changes_requested')
    assert.equal((await f.store.tasks.get(f.task.id))?.status, decision === 'approve' ? 'done' : 'in_progress')
    assert.deepEqual(await f.store.tasks.get(other.id), otherBefore, 'losing review must not mutate its Task')
    assert.deepEqual(domainSnapshot(), atFirstSave, 'loser must not change either Task, review, activity, audit or domain receipt')
    assert.equal(events.length, 1)
    const receipt = await receipts.getReceipt(actor, winningInput.requestId, new Date().toISOString() as Timestamp)
    assert.equal(receipt?.fingerprint, winningInput.fingerprint)
    assert.equal(receipt?.result.approval.projectionKey, first.projectionKey)
    assert.equal(database.connection.prepare('SELECT COUNT(*) AS n FROM approval_decision_receipts').get()!.n, 1)
    assert.deepEqual((await receipts.listOverlays(new Date().toISOString() as Timestamp)).map(a => a.projectionKey), [first.projectionKey])
  } finally {
    release?.()
    await Promise.allSettled(operations)
    receipts.close(); f.store.close(); database.close()
  }
})
