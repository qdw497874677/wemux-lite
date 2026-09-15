import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { transitionTask, taskTargets, type UserId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { migrate } from '../storage/sqlite/migrations.js'
import { ServerService } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { TaskService } from '../application/task-service.js'
import { createWemuxServer } from '../server.js'
const context = { actor: 'bootstrap-admin' as UserId, teamId: 'default-team', requestId: 'test-request' }
test('Task transitions: review decision, block/cancel restoration, CAS-independent no-op, active guard', async () => {
  const store = new SqliteServerStore(':memory:')
  try {
    await new ServerService(store, new Notifications()).bootstrap()
    const tasks = new TaskService(store)
    let task = await tasks.create('default-project', { title: 'Task' }, context)
    assert.throws(() => transitionTask(task, 'done'), /invalid_transition/)
    for (const status of ['todo', 'in_progress', 'in_review', 'in_progress', 'in_review', 'done'] as const) task = transitionTask(task, status)
    assert.equal(task.version, 7)
    assert.deepEqual(taskTargets(task), ['in_progress', 'blocked', 'cancelled'])
    const blocked = transitionTask(task, 'blocked')
    assert.equal(transitionTask(blocked, 'blocked'), blocked)
    assert.equal(transitionTask(blocked, 'done').status, 'done')
    const cancelled = transitionTask(blocked, 'cancelled')
    assert.equal(transitionTask(cancelled, 'blocked').blockedFrom, 'done')
    assert.throws(() => transitionTask(task, 'cancelled', true), /active_run/)
  } finally { store.close() }
})
test('migration replay preserves legacy rows and task project index', () => {
  const db = new DatabaseSync(':memory:')
  try { migrate(db); db.prepare('INSERT INTO records VALUES(?,?,?)').run('legacy', '1', '{}'); migrate(db)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records').get()!.n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n, 13)
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='tasks_project'").get())
  } finally { db.close() }
})
test('task + activity rollback, post-commit publication and concurrent CAS', async () => {
  const store = new SqliteServerStore(':memory:')
  try {
    await new ServerService(store, new Notifications()).bootstrap()
    const events: unknown[] = [], service = new TaskService(store, event => events.push(event))
    const task = await service.create('default-project', { title: 'Atomic' }, context)
    assert.equal(events.length, 1)
    await assert.rejects(store.transaction(async tx => { await tx.tasks.save({ ...task, title: 'rolled back' }); await tx.tasks.append({ taskId: task.id, projectId: task.projectId, type: 'task.updated', actor: context.actor, requestId: 'rollback', occurredAt: task.createdAt, payload: {} }); throw Error('rollback') }))
    assert.equal((await store.tasks.get(task.id))!.title, 'Atomic')
    assert.equal((await store.tasks.activity(task.id, 0)).length, 1)
    const outcomes = await Promise.allSettled([service.patch(task.projectId, task.id, { status: 'todo', version: 1 }, context), service.patch(task.projectId, task.id, { status: 'blocked', version: 1 }, context)])
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
    assert.equal(events.length, 2)
    const edited = await service.patch(task.projectId, task.id, { description: 'updated' }, context)
    assert.equal(edited.version, 2)
    assert.deepEqual((await store.tasks.activity(task.id, 0)).map(event => event.seq), [1, 2, 3])
  } finally { store.close() }
})
test('HTTP task CRUD without delete, validation, ownership, invalid transition and stale CAS', async () => {
  const token = 'ticket-03-test-token', server = createWemuxServer({ databasePath: ':memory:', bootstrapToken: token })
  const base = await server.listen(0)
  const call = async (path: string, method = 'GET', body?: unknown, auth = token) => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', 'X-Request-ID': 'http-test' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  try {
    await call('/bootstrap', 'POST', {})
    const path = '/projects/default-project/tasks'
    assert.equal((await call(path, 'GET', undefined, 'bad')).data.error.code, 'unauthorized')
    assert.equal((await call(`${path}?teamId=wrong`)).status, 403)
    assert.equal((await call(path, 'POST', { title: '' })).status, 400)
    const created = await call(path, 'POST', { title: 'HTTP task' }); assert.equal(created.status, 201)
    const taskPath = `${path}/${created.data.id}`
    assert.equal((await call(`${taskPath}/move`, 'POST', { status: 'done', version: 1 })).data.error.code, 'invalid_transition')
    assert.equal((await call(taskPath, 'PATCH', { status: 'todo' })).status, 400)
    assert.equal((await call(taskPath, 'PATCH', { status: 'todo', version: 1 })).data.version, 2)
    const conflict = await call(taskPath, 'PATCH', { title: 'do not save', status: 'blocked', version: 1 })
    assert.equal(conflict.data.error.code, 'version_conflict'); assert.equal(conflict.data.error.details.currentVersion, 2)
    assert.equal((await call(taskPath)).data.title, 'HTTP task')
    assert.equal((await call(taskPath, 'PATCH', { priority: 'high' })).data.version, 2)
    assert.equal((await call(`${taskPath}/links`, 'POST', { url: 'https://evil.example/issues/1' })).status, 400)
    const linked = await call(`${taskPath}/links`, 'POST', { url: 'https://github.com/example/repo/issues/12' })
    assert.equal(linked.data.linkCount, 1)
    assert.equal((await call(path)).data.items[0].linkCount, 1)
    assert.equal((await call(`${taskPath}/links/${linked.data.links[0].id}`, 'DELETE')).data.linkCount, 0)
    const activity = await call(`${taskPath}/activity`)
    assert.equal(activity.data.items.length, 5); assert.equal(activity.data.items[0].requestId, 'http-test')
    assert.equal((await call(taskPath, 'DELETE')).status, 404)
    assert.equal((await call('/projects/missing/tasks')).status, 404)
    const other = await call('/projects', 'POST', { name: 'Other project' })
    assert.equal((await call(`/projects/${other.data.id}/tasks/${created.data.id}`)).status, 404)
    assert.equal((await call(taskPath, 'PATCH', { metadataJson: { schemaVersion: 2, values: {} } })).data.error.code, 'invalid_request')
    assert.equal((await call(taskPath, 'PATCH', { assignee: null, version: 2 })).data.error.code, 'invalid_request')
    assert.equal((await call(`${taskPath}/activity?after=-1`)).status, 400)
    assert.equal((await call(taskPath, 'PATCH', { status: 'todo', version: 2 })).data.version, 2)
    assert.equal((await call(`${taskPath}/activity`)).data.items.length, 5)
  } finally { await server.close() }
})

for (const first of ['blocked', 'cancelled'] as const) test(`restoration survives repeated ${first} round trips through domain and HTTP/SQLite`, async () => {
  const server = createWemuxServer({ databasePath: ':memory:', bootstrapToken: 'restore-test-token' })
  const base = await server.listen(0)
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { Authorization: 'Bearer restore-test-token', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    assert.ok(response.ok); return response.json()
  }
  try {
    await call('/bootstrap', 'POST', {})
    let task = await call('/projects/default-project/tasks', 'POST', { title: 'Restore' })
    let domain = task
    const other = first === 'blocked' ? 'cancelled' : 'blocked'
    const path = `/projects/default-project/tasks/${task.id}`
    for (let round = 0; round < 3; round++) {
      for (const status of [first, other, first, other, first, 'backlog'] as const) {
        domain = transitionTask(domain, status)
        await call(path, 'PATCH', { status, version: task.version })
        task = await call(path)
        assert.equal(task.status, domain.status)
        assert.equal(task.blockedFrom, domain.blockedFrom)
        assert.equal(task.cancelledFrom, domain.cancelledFrom)
      }
      assert.equal(task.status, 'backlog')
    }
  } finally { await server.close() }
})
test('HTTP create and PATCH reject every non-string priority with stable invalid_request', async () => {
  const server = createWemuxServer({ databasePath: ':memory:', bootstrapToken: 'priority-test-token' })
  const base = await server.listen(0)
  const call = (path: string, method: string, body: unknown) => fetch(`${base}/api${path}`, { method, headers: { Authorization: 'Bearer priority-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    await call('/bootstrap', 'POST', {})
    const path = '/projects/default-project/tasks'
    const task = await (await call(path, 'POST', { title: 'Priority' })).json()
    for (const priority of [['high'], [], {}, { toString: null }, { toString: 'high' }, null, 1, true, 'urgent']) {
      for (const method of ['POST', 'PATCH']) {
        const response = await call(method === 'POST' ? path : `${path}/${task.id}`, method, { title: 'Priority', priority })
        assert.equal(response.status, 400, `${method}: ${JSON.stringify(priority)}`)
        assert.equal((await response.json()).error.code, 'invalid_request')
      }
    }
  } finally { await server.close() }
})
