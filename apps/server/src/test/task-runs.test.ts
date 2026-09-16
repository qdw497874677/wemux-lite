import test from 'node:test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { AuthenticationService } from '../application/auth.js'
import { httpHandler } from '../http/handler.js'
import { SessionStreams } from '../http/sse.js'
import { WebSocket } from 'ws'
import type { ServerToWorker } from '@wemux/wire-protocol'
import { createWemuxServer } from '../server.js'
import type { ServerStore, ServerStoreTx } from '../application/ports/server-store.js'
import assert from 'node:assert/strict'
import { projectRuns } from '../application/run-projection.js'
import { WorkerService } from '../application/worker-service.js'
import type { JournalEvent, SessionId, EventSeq, Timestamp, CommandId, MessageId, TurnId, UserId, AgentKey, ModelId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { TaskService } from '../application/task-service.js'

const context = { actor: 'bootstrap-admin' as UserId, requestId: 'runs-test' }
async function fixture(path = ':memory:') {
  const store = new SqliteServerStore(path)
  const server = new ServerService(store, new Notifications())
  await server.bootstrap()
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
    const receipt = { protocolVersion: 1 as const, messageId: 'project-rejection' as MessageId, type: 'ack' as const, receipt: { commandId: run.createCommandId as CommandId, status: 'rejected' as const, error: { code: 'invalid-input' as const, message: 'create failed', retryable: false } } }
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
    const store: ServerStore = { tasks: f.store.tasks, resources: f.store.resources, identity: f.store.identity, commands: f.store.commands, cache: f.store.cache,
      transaction: work => f.store.transaction(async tx => { await work(tx); throw Error('forced rollback') }) }
    const workers = new WorkerService(store, notifications)
    await assert.rejects(workers.receive(f.worker.id, { protocolVersion: 1, messageId: 'rollback-project' as MessageId, type: 'ack', receipt: { commandId: run.createCommandId as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'create failed', retryable: false } } }), /forced rollback/)
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
test('review cycles close ordinary exits, preserve decisions and reject stale same-state assignment CAS', async () => {
  const f = await reviewFixture()
  try {
    let task = f.task
    for (const exit of ['done', 'in_progress', 'blocked', 'cancelled'] as const) {
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
      if (exit === 'done') task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
      if (exit === 'blocked' || exit === 'cancelled') {
        task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_review' }, context)
        assert.notEqual(task.currentReviewId, pending.id)
        task = await f.tasks.patch(task.projectId, task.id, { version: task.version, status: 'in_progress' }, context)
      }
    }
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
    const store: ServerStore = { tasks: f.store.tasks, resources: f.store.resources, identity: f.store.identity, commands: f.store.commands, cache: f.store.cache,
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
  const token = 'current-review-http'
  const http = createServer(httpHandler(f.server, new AuthenticationService(f.store, token), new SessionStreams(f.server), undefined, undefined, undefined, undefined, undefined, tasks))
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
    const decide = (status: string) => fetch(`http://127.0.0.1:${address.port}/projects/${task.projectId}/tasks/${task.id}/runs/${run.id}/review`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: task.version, status }) })
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
  const tasks = new TaskService(f.store, e => events.push(e), f.server), token = 'corrupt-http-token'
  const http = createServer(httpHandler(f.server, new AuthenticationService(f.store, token), new SessionStreams(f.server), undefined, undefined, undefined, undefined, undefined, tasks))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  try {
    db.exec('PRAGMA ignore_check_constraints=ON')
    if (corruption === 'review') { db.exec('DROP TRIGGER review_identity'); db.prepare("UPDATE review_requests SET data=json_set(data,'$.actor','') WHERE run_id=?").run(f.run.id) }
    else { db.exec('DROP TRIGGER run_invariants_update; DROP TRIGGER run_identity_immutable'); db.prepare("UPDATE task_runs SET data=json_set(data,'$.sessionId','wrong-session') WHERE id=?").run(f.run.id) }
    const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => [row.name, db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()])
    const before = snapshot()
    const response = await fetch(`http://127.0.0.1:${address.port}/projects/${task.projectId}/tasks/${task.id}/runs/${f.run.id}/review`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: task.version, status: 'approved' }) })
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
    const store: ServerStore = { tasks: f.store.tasks, resources: f.store.resources, identity: f.store.identity, commands: f.store.commands, cache: f.store.cache,
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
  const auth = new AuthenticationService(f.store, 'review-http-token')
  const streams = new SessionStreams(f.server)
  const http = createServer(httpHandler(f.server, auth, streams, undefined, undefined, undefined, undefined, undefined, f.tasks))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address() as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}/api/projects/${f.task.projectId}`
  const endpoint = `${base}/tasks/${f.task.id}/runs/${f.run.id}/review`
  const headers = { Authorization: 'Bearer review-http-token', 'Content-Type': 'application/json' }
  try {
    const before = await f.store.tasks.projectActivity(f.task.projectId, 0)
    for (const [url, token, body, status] of [
      [endpoint, 'bad', '{}', 401],
      [`${endpoint}?teamId=wrong`, 'review-http-token', '{}', 403],
      [endpoint.replace(f.task.id, 'missing'), 'review-http-token', '{}', 404],
      [endpoint.replace(f.run.id, 'missing'), 'review-http-token', '{}', 404],
      [endpoint, 'review-http-token', '{', 400],
      [endpoint, 'review-http-token', '{"status":"requested"}', 400],
      [endpoint, 'review-http-token', '{"status":"requested","version":1}', 409],
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
    const { session } = await f.tasks.createSession(f.task.projectId, f.task.id, { title: 'Idle candidate' }, context)
    await f.store.transaction(tx => tx.cache.recordWorkerHead(session.id, 0 as EventSeq))
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
    assert.equal((await f.store.tasks.runs(f.task.id)).length, 0)
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
    const store: import('../application/ports/server-store.js').ServerStore = { ...f.store, tasks: f.store.tasks, resources: f.store.resources, identity: f.store.identity, commands: f.store.commands, cache: f.store.cache, transaction: work => f.store.transaction(tx => work({ ...tx, resources: wrap(tx.resources), commands: wrap(tx.commands), tasks: wrap(tx.tasks), audit: wrap(tx.audit, 'audit') })) }
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
    const { session } = await f.tasks.createSession(f.task.projectId, f.task.id, { title: 'Independent' }, context)
    assert.equal(session.taskId, f.task.id); assert.equal(session.runId, null)
    assert.equal((await f.store.tasks.runs(f.task.id)).length, 0)
    await assert.rejects(f.tasks.createSession(f.task.projectId, f.task.id, { title: 'Bad', runId: 'override' }, context), /unknown fields/)
    await assert.rejects(f.tasks.createSession(f.task.projectId, f.task.id, { title: 'Bad' }, { ...context, teamId: 'wrong' }), /ownership/)
    await assert.rejects(f.store.transaction(tx => tx.resources.saveSession({ ...session, runId: 'rebound' })), /provenance/)
    const { run } = await f.launch()
    const duringRun = await f.tasks.createSession(f.task.projectId, f.task.id, { title: 'During active Run' }, context)
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
    const before = await f.store.tasks.activity(run.taskId, 0)
    await apply([events[2]!, events[0]!])
    await cancel()
    assert.deepEqual(await f.store.tasks.run(run.id), done)
    assert.deepEqual(await f.store.tasks.activity(run.taskId, 0), before)
    assert.equal(before.filter(a => a.type === 'run.finished').length, 1)
    if (cancelFirst) {
      const workers = new WorkerService(f.store, new Notifications())
      await workers.receive(f.worker.id, { protocolVersion: 1, messageId: 'late-rejection' as MessageId, type: 'ack', receipt: { commandId: done.cancelCommandIds[0] as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'Already finished', retryable: false } } })
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
    await workers.receive(f.worker.id, { protocolVersion: 1, messageId: 'reject-cancel' as MessageId, type: 'ack', receipt: { commandId: first.cancelCommandIds[0] as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'Target unavailable', retryable: false } } })
    const replay = (await cancel()).run
    assert.equal(replay.failure?.code, 'cancel_rejected')
    assert.equal(replay.cancelCommandIds.length, 1)
    const retry = { ...input, requestId: 'cancel-recovery' }
    const [a, b] = await Promise.all([cancel(retry), cancel(retry)])
    assert.deepEqual(a, b); assert.equal(a.run.cancelCommandIds.length, 2); assert.equal(a.run.failure, null)
    await workers.receive(f.worker.id, { protocolVersion: 1, messageId: 'accept-cancel' as MessageId, type: 'ack', receipt: { commandId: a.run.cancelCommandIds[1] as CommandId, status: 'accepted' } })
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
    await workers.receive(f.worker.id, { protocolVersion: 1, messageId: 'ack' as MessageId, type: 'ack', receipt: { commandId: run.createCommandId as CommandId, status: 'accepted' } })
    assert.ok((await ids()).includes(run.enqueueCommandId as CommandId))
    assert.ok((await ids()).includes(run.enqueueCommandId as CommandId))
    assert.equal((await f.store.tasks.run(run.id))!.status, 'pending')
    const rejected = { protocolVersion: 1 as const, messageId: 'reject' as MessageId, type: 'ack' as const, receipt: { commandId: run.enqueueCommandId as CommandId, status: 'rejected' as const, error: { code: 'invalid-input' as const, message: 'failed', retryable: false } } }
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
  return { tasks: store.tasks, resources: store.resources, identity: store.identity, commands: store.commands, cache: store.cache, transaction: callback => store.transaction(tx => callback(work(tx))) }
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
  const token = 'paused-http-reader-token'
  const http = createServer(httpHandler(f.server, new AuthenticationService(f.store, token), new SessionStreams(f.server), undefined, undefined, undefined, undefined, undefined, f.tasks))
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
    const httpRead = fetch(`http://127.0.0.1:${address.port}/projects/${f.task.projectId}/tasks/${f.task.id}/runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } }).then(async response => { const data = await response.json(); settled++; return { status: response.status, data } })
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
    app = createWemuxServer({ databasePath: path, bootstrapToken: 'ws-test-isolated-token' }); const base = await app.listen(0)
    const db = new DatabaseSync(path)
    const counts = () => ({ activity: db.prepare('SELECT * FROM task_activity ORDER BY task_id,seq').all(), audit: db.prepare("SELECT * FROM records WHERE kind='audit' ORDER BY id").all() })
    const before = counts()
    ws = new WebSocket(base.replace('http', 'ws') + '/worker/ws', { headers: { Authorization: `Bearer ${f.credential}` } })
    const received: Array<Record<string, unknown>> = []
    ws.on('message', data => { const frame = JSON.parse(data.toString()); received.push(frame); transcript.push({ direction: 'server', frame }) })
    await once(ws, 'open')
    const send = (frame: object) => { const message = { protocolVersion: 1, messageId: String(transcript.length), ...frame }; transcript.push({ direction: 'worker', frame: message }); ws!.send(JSON.stringify(message)) }
    send({ type: 'hello', side: 'worker', workerId: f.worker.id, name: 'late-terminal-probe', workerVersion: 'test', platform: 'linux', architecture: 'x64' })
    for (const seq of [5, 4]) send({ type: 'event', scope: 'session', event: { sessionId, seq, occurredAt: run.createdAt, payload: { kind: 'turn.finished', turnId: 'ws-turn', outcome: seq % 2 ? 'failed' : 'completed', failure: null } } })
    send({ type: 'sync', kind: 'heads', complete: false, heads: [{ sessionId, lastSeq: 5 }] })
    send({ type: 'heartbeat', nonce: 'probe-complete', sentAt: new Date().toISOString() })
    for (let i = 0; i < 200 && !received.some(frame => frame.nonce === 'probe-complete'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(received.some(frame => frame.nonce === 'probe-complete'))
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
    assert.ok(received.some(frame => frame.type === 'error'))
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
      await worker.receive(f.worker.id, { protocolVersion: 1, messageId: `late-${seq}` as MessageId, type: 'event', scope: 'session', event: { ...event, seq: seq as EventSeq, payload: { kind: 'turn.finished', turnId: 'old-turn' as TurnId, outcome: 'failed', failure: null } } })
      await worker.receive(f.worker.id, { protocolVersion: 1, messageId: `head-${seq}` as MessageId, type: 'sync', kind: 'heads', complete: true, heads: [{ sessionId, lastSeq: seq as EventSeq }] })
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
      const server = createWemuxServer({ databasePath: path, bootstrapToken: 'isolated-test-token' })
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
    db.exec('DROP TRIGGER IF EXISTS project_activity_append; DROP TABLE project_activity; DROP TABLE review_requests; DROP TRIGGER session_creation_provenance; DROP TRIGGER session_task_scope; DROP TRIGGER active_run_session_delete; DROP TRIGGER run_session_scope; DROP TABLE run_cancel_requests; DROP TABLE command_dependencies; DROP TABLE task_runs; DROP INDEX task_activity_source; ALTER TABLE task_activity DROP COLUMN source_key; DELETE FROM schema_migrations WHERE version>=5;')
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version), [1, 2, 3, 4])
  } finally { db.close() }
  try {
    for (let i = 0; i < 2; i++) {
      const store = new SqliteServerStore(path)
      try {
        const service = new ServerService(store, new Notifications())
        await service.bootstrap(); await service.bootstrap()
        assert.deepEqual(await store.tasks.get(f.task.id), before)
        assert.deepEqual(await store.tasks.runs(f.task.id), [])
      } finally { store.close() }
    }
    const check = new DatabaseSync(path)
    try {
      assert.deepEqual(check.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
      assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), [])
    } finally { check.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

 test('real gateway hello reconnect and disk server restart redeliver create/enqueue IDs after lost ACK', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket05-delivery-')), path = join(dir, 'server.db')
  const f = await fixture(path), { run } = await f.launch()
  f.store.close()
  const token = 'delivery-test-isolated-token'
  let app = createWemuxServer({ databasePath: path, bootstrapToken: token }), base = await app.listen(0)
  let socket: WebSocket | undefined
  const connect = async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/worker/ws`, { headers: { Authorization: `Bearer ${f.credential}` } })
    socket = ws
    const received: ServerToWorker[] = []
    ws.on('message', data => received.push(JSON.parse(data.toString())))
    await once(ws, 'open')
    ws.send(JSON.stringify({ protocolVersion: 1, messageId: 'hello', type: 'hello', side: 'worker', workerId: f.worker.id, name: 'Reconnect worker', workerVersion: 'test', platform: 'linux', architecture: 'x64' }))
    const waitCommand = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const command = received.find(m => m.type === 'command' && m.commandId === id)
        if (command) return command
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.fail(`No command ${id}: ${JSON.stringify(received)}`)
    }
    return { ws, received, waitCommand }
  }
  const disconnect = async (ws: WebSocket) => {
    const closed = once(ws, 'close'); ws.close(); await closed
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${base}/api/workers/${f.worker.id}`, { headers: { Authorization: `Bearer ${token}` } })
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
    second.ws.send(JSON.stringify({ protocolVersion: 1, messageId: 'ack', type: 'ack', receipt: { commandId: run.createCommandId, status: 'accepted' } }))
    await second.waitCommand(run.enqueueCommandId)
    await disconnect(second.ws) // received enqueue, no receipt: ACK lost
    await app.close()
    app = createWemuxServer({ databasePath: path, bootstrapToken: token }); base = await app.listen(0)
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
  const f = await fixture(dbPath), token = 'run-http-complete-matrix'
  const auth = new AuthenticationService(f.store, token)
  const outsider = 'outsider' as UserId
  await f.store.transaction(async tx => {
    await tx.identity.saveUser({ id: outsider, username: 'outsider', email: null, createdAt: new Date().toISOString() as Timestamp })
    await tx.identity.saveMembership({ teamId: f.worker.teamId, userId: outsider, role: 'member', joinedAt: new Date().toISOString() as Timestamp })
  })
  const outsiderToken = (await auth.issueAdminSession(outsider, 60000)).token
  const project = await f.server.createProject({ name: 'Other project' })
  const other = await f.tasks.create(f.task.projectId, { title: 'Other task' }, context)
  const cross = await f.tasks.create(project.id, { title: 'Cross project' }, context)
  const { run } = await f.launch()
  let notifications = 0
  const signals = new Notifications(); signals.commands = () => { notifications++ }
  const service = new ServerService(f.store, signals)
  const tasks = new TaskService(f.store, () => { notifications++ }, service)
  const http = createServer(httpHandler(service, auth, new SessionStreams(service), undefined, undefined, undefined, undefined, undefined, tasks))
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
    await check(path + '/transition', 'POST', JSON.stringify({ version: 2, status: 'in_review' }), 409, { code: 'invalid_transition', message: 'Transition not permitted' })
    const independentPath = path + '/sessions'
    for (const bearer of [outsiderToken]) await check(independentPath, 'POST', JSON.stringify({ title: 'Independent' }), 403, { code: 'forbidden', message: 'Project ownership required' }, bearer)
    await check(independentPath + '?teamId=wrong', 'POST', JSON.stringify({ title: 'Independent' }), 403, { code: 'forbidden', message: 'Project ownership required' })
    await check(`/projects/${project.id}/tasks/${f.task.id}/sessions`, 'POST', JSON.stringify({ title: 'Independent' }), 404, { code: 'not_found', message: 'Task not found in this project' })
    await check(independentPath, 'POST', '{', 400, { code: 'invalid_request', message: 'Invalid JSON' })
    for (const body of [{ title: '' }, { title: 'Independent', workspaceId: 'wrong' }, { title: 'Independent', assignment: {} }, { title: 'Independent', runId: run.id }, { title: 'Independent', requestId: 'unsupported' }, { title: 'Independent', taskId: other.id }]) await check(independentPath, 'POST', JSON.stringify(body), 400, { code: 'invalid_request', message: 'Session title required; unknown fields are not allowed' })
    await check(`/projects/${project.id}/tasks/${cross.id}/sessions`, 'POST', JSON.stringify({ title: 'Independent' }), 409, { code: 'assignment_changed', message: 'Task assignment required' })
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

test('real HTTP Run launch rejection envelopes leave all launch resources unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket05-rejections-')), dbPath = join(dir, 'server.db')
  const f = await fixture(dbPath), token = 'run-http-matrix-token', db = new DatabaseSync(dbPath)
  let notifications = 0
  f.server.notifications.commands = () => { notifications++ }
  const observedTasks = new TaskService(f.store, () => { notifications++ }, f.server)
  const auth = new AuthenticationService(f.store, token)
  const http = createServer(httpHandler(f.server, auth, new SessionStreams(f.server), undefined, undefined, undefined, undefined, undefined, observedTasks))
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
    const expired = await auth.issueAdminSession(context.actor, -1000)
    await check('unauthorized', 401, f.request, path + '/launch', expired.token)
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
  const f = await fixture(), token = 'run-management-http-token'
  const http = createServer(httpHandler(f.server, new AuthenticationService(f.store, token), new SessionStreams(f.server), undefined, undefined, undefined, undefined, undefined, f.tasks))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const path = `/projects/${f.task.projectId}/tasks/${f.task.id}`
  const call = async (suffix: string, method: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${suffix}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
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
    for (const status of ['todo', 'in_progress', 'in_review']) {
      const task = await f.tasks.get(f.task.projectId, f.task.id, context)
      assert.equal((await call(path, 'PATCH', { version: task.version, status })).status, 200)
    }
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
    assert.equal((await call(path, 'PATCH', { version: current.version, status: 'in_review' })).status, 200)
    current = await f.tasks.get(f.task.projectId, f.task.id, context)
    assert.equal((await call(path, 'PATCH', { version: current.version, status: 'done' })).status, 200)
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
  const token = 'capability-http-token'
  const http = createServer(httpHandler(f.server, new AuthenticationService(f.store, token), new SessionStreams(f.server), undefined, undefined, undefined, undefined, undefined, f.tasks))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
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
    const before = await f.store.tasks.activity(task.id, 0)
    const outcomes = await Promise.allSettled([tasks.patch(task.projectId, task.id, input, context), tasks.patch(task.projectId, task.id, input, context)])
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter(r => r.status === 'rejected' && r.reason.code === 'version_conflict').length, 1)
    assert.equal(events.length, 1)
    assert.equal((await f.store.tasks.run(run.id))?.status, 'pending')
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
