import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { UserId, AgentKey, ModelId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { migrate } from '../storage/sqlite/migrations.js'
import { ServerService } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { WorkerService } from '../application/worker-service.js'
import { newId } from '../application/server-service.js'
import type { CommandId, Timestamp } from '@wemux/domain'
import { TaskService } from '../application/task-service.js'

const context = { actor: 'bootstrap-admin' as UserId, requestId: 'workspace-test' }
async function fixture(path = ':memory:') {
  const store = new SqliteServerStore(path)
  const server = new ServerService(store, new Notifications())
  await server.bootstrap()
  const enrollment = await server.createEnrollment({})
  const { worker } = await server.enroll({ token: enrollment.token, name: 'Offline worker' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
  const tasks = new TaskService(store, () => {}, server)
  const task = await tasks.create('default-project', { title: 'Workspace task' }, context)
  const create = () => tasks.createWorkspace(task.projectId, task.id, { name: task.title, workerId: worker.id, source: 'empty' }, context)
  return { store, server, tasks, task, worker, create }
}

test('task workspace binding is authoritative; A→B and clear preserve history; current unbind CAS is atomic', async () => {
  const f = await fixture()
  try {
    const a = await f.create(), b = await f.create()
    assert.equal(a.workspace.status, 'pending')
    assert.equal(b.task.version, 1)
    const assignment = (workspaceId: string) => ({ workspaceId, workerId: f.worker.id, agentKey: 'test', modelId: 'model' })
    const first = await f.tasks.assignment(f.task.projectId, f.task.id, { version: 1, assignee: assignment(a.workspace.id) }, false, context)
    const second = await f.tasks.assignment(f.task.projectId, f.task.id, { version: first.version, assignee: assignment(b.workspace.id) }, false, context)
    assert.equal(second.version, 3)
    assert.equal(second.workspaces.length, 2)
    await assert.rejects(f.tasks.unbind(f.task.projectId, f.task.id, b.workspace.id, { version: 2 }, context), error => {
      assert.equal((error as { code: string }).code, 'version_conflict')
      assert.equal((error as { details: { currentVersion: number } }).details.currentVersion, 3)
      return true
    })
    assert.equal((await f.store.tasks.get(f.task.id))!.workspaces.length, 2)
    const cleared = await f.tasks.assignment(f.task.projectId, f.task.id, { version: 3 }, true, context)
    assert.equal(cleared.assignee, null)
    assert.equal(cleared.workspaces.length, 2)
    const again = await f.tasks.assignment(f.task.projectId, f.task.id, { version: 4, assignee: assignment(b.workspace.id) }, false, context)
    const unbound = await f.tasks.unbind(f.task.projectId, f.task.id, b.workspace.id, { version: again.version }, context)
    assert.equal(unbound.assignee, null)
    assert.equal(unbound.version, 6)
    assert.deepEqual(unbound.workspaces.map(value => value.workspaceId), [a.workspace.id])
    assert.ok(await f.store.resources.getWorkspace(b.workspace.id))
    await f.store.transaction(tx => tx.tasks.save({ ...unbound, workspaces: [] }))
    assert.equal((await f.store.tasks.get(f.task.id))!.workspaces.length, 1)
  } finally { f.store.close() }
})

test('creation rolls back workspace, binding and command when assignment validation fails', async () => {
  const f = await fixture()
  try {
    const before = await f.store.commands.list({ limit: 100 })
    await assert.rejects(f.tasks.createWorkspace(f.task.projectId, f.task.id, { name: 'Invalid model', workerId: f.worker.id, source: 'git', repository: { gitUrl: 'file:///tmp/not-cloned-by-server' }, version: 1, assignment: { agentKey: 'test', modelId: 'invented' } }, context), /unavailable/)
    assert.deepEqual(await f.store.resources.listWorkspaces(), [])
    assert.deepEqual(await f.store.commands.list({ limit: 100 }), before)
    assert.deepEqual((await f.store.tasks.get(f.task.id))!.workspaces, [])
    assert.equal((await f.store.tasks.activity(f.task.id, 0)).length, 1)
  } finally { f.store.close() }
})

test('workspace unique ownership and cross-project binding are rejected', async () => {
  const f = await fixture()
  try {
    const a = await f.create()
    const other = await f.tasks.create(f.task.projectId, { title: 'Other task' }, context)
    await assert.rejects(f.tasks.bind(other.projectId, other.id, a.workspace.id, context), /already bound/)
    const project = await f.server.createProject({ name: 'Other project' })
    const workspace = await f.server.createWorkspace({ projectId: project.id, workerId: f.worker.id, name: 'Other', source: 'empty' })
    await assert.rejects(f.tasks.bind(f.task.projectId, f.task.id, workspace.workspace.id, context), /another project/)
  } finally { f.store.close() }
})

test('provision attempts: retry identities, coalescing, rejected, stale, duplicate and legacy reports', async () => {
  const f = await fixture()
  try {
    const created = await f.create(), id = created.workspace.id
    const worker = new WorkerService(f.store, new Notifications())
    let tick = Date.now() + 1000
    const report = async (commandId: string | undefined, status: 'provisioning' | 'failed' | 'ready', reason: string | null = null) => {
      const message = { type: 'event' as const, scope: 'workspace' as const, report: { workspaceId: id, ...(commandId ? { commandId: commandId as CommandId } : {}), status, reason, location: null, occurredAt: new Date(tick++).toISOString() as Timestamp } }
      await worker.receive(f.worker.id, message)
      return message
    }
    await report(created.commandId, 'failed', 'source missing')
    const retry = (requestId: string) => f.tasks.retryWorkspace(f.task.projectId, f.task.id, id, { requestId }, context)
    const next = await retry('retry-1')
    assert.notEqual(next.commandId, created.commandId)
    assert.equal((await retry('retry-1')).commandId, next.commandId)
    assert.equal((await retry('retry-concurrent')).commandId, next.commandId)
    for (const state of ['provisioning', 'failed', 'ready'] as const) await report(created.commandId, state)
    await report(undefined, 'ready')
    assert.equal((await f.store.resources.getWorkspace(id))!.status, 'pending')
    await worker.receive(f.worker.id, { type: 'ack', receipt: { commandId: next.commandId as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'rejected without report', retryable: false } } })
    assert.equal((await f.store.resources.getWorkspace(id))!.failureReason, 'rejected without report')
    const third = await retry('retry-2')
    await report(next.commandId, 'ready')
    assert.equal((await f.store.resources.getWorkspace(id))!.status, 'pending')
    const ready = await report(third.commandId, 'ready')
    const count = (await f.store.tasks.activity(f.task.id, 0)).length
    await worker.receive(f.worker.id, ready)
    await report(third.commandId, 'ready')
    await report(third.commandId, 'provisioning')
    await report(third.commandId, 'failed', 'late')
    assert.equal((await f.store.resources.getWorkspace(id))!.status, 'ready')
    assert.equal((await f.store.tasks.activity(f.task.id, 0)).length, count)
    assert.equal((await retry('retry-2')).commandId, third.commandId)
  } finally { f.store.close() }
})

for (const point of ['saveRepository', 'saveWorkspace', 'insertPending', 'audit', 'bind', 'saveTask', 'activity']) test(`atomic creation fault at ${point} leaves no resources or early notification`, async () => {
  const f = await fixture()
  try {
    let notifications = 0
    const signals = new Notifications()
    signals.commands = () => { notifications++ }
    const wrap = <T extends object>(target: T, keys: Record<string, string>): T => new Proxy(target, { get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => { const result = await value(...args); if (keys[String(key)] === point) throw Error('injected'); return result }
    } })
    const store: import('../application/ports/server-store.js').ServerStore = { ...f.store, tasks: f.store.tasks, resources: f.store.resources, identity: f.store.identity, commands: f.store.commands, cache: f.store.cache,
      transaction: work => f.store.transaction(tx => work({ ...tx, resources: wrap(tx.resources, { saveRepository: 'saveRepository', saveWorkspace: 'saveWorkspace' }), commands: wrap(tx.commands, { insertPending: 'insertPending' }), audit: wrap(tx.audit, { append: 'audit' }), tasks: wrap(tx.tasks, { bind: 'bind', save: 'saveTask', append: 'activity' }) })) }
    const tasks = new TaskService(store, () => { notifications++ }, new ServerService(store, signals))
    await assert.rejects(tasks.createWorkspace(f.task.projectId, f.task.id, { name: 'Atomic', workerId: f.worker.id, source: 'git', repository: { gitUrl: 'file:///tmp/atomic' } }, context), /injected/)
    assert.equal(notifications, 0)
    assert.deepEqual(await f.store.resources.listWorkspaces(), [])
    assert.deepEqual(await f.store.commands.list({ limit: 100 }), [])
    assert.deepEqual(await f.store.tasks.bindings(f.task.id), [])
    assert.equal((await f.store.tasks.activity(f.task.id, 0)).length, 1)
  } finally { f.store.close() }
})

test('SQLite reopen retains attempt requests; reconnect current report converges once and old attempt is ignored', async () => {
  const directory = await mkdtemp('/tmp/t04-restart-')
  const f = await fixture(`${directory}/server.sqlite`)
  let reopened: SqliteServerStore | undefined
  try {
    const created = await f.create()
    assert.ok(created.commandId)
    await f.store.transaction(tx => tx.resources.saveWorkspace({ ...created.workspace, status: 'failed', failureReason: 'offline source' }))
    const retry = await f.tasks.retryWorkspace(f.task.projectId, f.task.id, created.workspace.id, { requestId: 'durable' }, context)
    f.store.close()
    reopened = new SqliteServerStore(`${directory}/server.sqlite`)
    const service = new ServerService(reopened, new Notifications()), tasks = new TaskService(reopened, () => {}, service)
    assert.equal((await tasks.retryWorkspace(f.task.projectId, f.task.id, created.workspace.id, { requestId: 'durable' }, context)).commandId, retry.commandId)
    const worker = new WorkerService(reopened, new Notifications())
    const report = (commandId: string) => ({ type: 'event' as const, scope: 'workspace' as const, report: { workspaceId: created.workspace.id, commandId: commandId as CommandId, status: 'ready' as const, reason: null, location: null, occurredAt: new Date().toISOString() as Timestamp } })
    const legacy = report(created.commandId)
    const { commandId: _commandId, ...uncorrelated } = legacy.report
    await worker.receive(f.worker.id, { ...legacy, report: uncorrelated })
    assert.equal((await reopened.resources.getWorkspace(created.workspace.id))!.status, 'pending')
    await worker.receive(f.worker.id, report(created.commandId))
    assert.equal((await reopened.resources.getWorkspace(created.workspace.id))!.status, 'pending')
    await worker.disconnected(f.worker.id)
    await worker.connected(f.worker.id, { name: 'reconnected', workerVersion: 'test', platform: 'linux' })
    const current = report(retry.commandId)
    await worker.receive(f.worker.id, current)
    const count = (await reopened.tasks.activity(f.task.id, 0)).length
    await worker.disconnected(f.worker.id)
    await worker.receive(f.worker.id, current)
    assert.equal((await reopened.resources.getWorkspace(created.workspace.id))!.status, 'ready')
    assert.equal((await reopened.tasks.activity(f.task.id, 0)).length, count)
  } finally { if (reopened) reopened.close(); else f.store.close(); await rm(directory, { recursive: true, force: true }) }
})

test('ordinary pending command cancellation and late receipt semantics remain unchanged', async () => {
  const f = await fixture()
  try {
    const commandId = newId<'CommandId'>()
    await f.store.transaction(tx => tx.commands.insertPending({ commandId, workerId: f.worker.id, command: { kind: 'turn.stop', sessionId: newId<'SessionId'>(), turnId: newId<'TurnId'>() }, payloadFingerprint: 'ordinary-stop', createdAt: new Date().toISOString() as Timestamp }))
    assert.equal((await f.server.cancelCommand(commandId)).status, 'cancelled')
    await assert.rejects(f.server.cancelCommand(commandId), /Only pending/)
    assert.equal((await f.store.commands.listDeliverable(f.worker.id, 100)).length, 0)
    await new WorkerService(f.store, new Notifications()).receive(f.worker.id, { type: 'ack', receipt: { commandId, status: 'accepted' } })
    assert.equal((await f.server.getCommand(commandId)).status, 'accepted')
  } finally { f.store.close() }
})

test('offline provision cancellation is rejected; retry and reconnect retain deliverable attempt', async () => {
  const f = await fixture()
  try {
    const created = await f.create()
    assert.ok(created.commandId)
    for (let i = 0; i < 2; i++) await assert.rejects(f.server.cancelCommand(created.commandId), /protected_command/)
    assert.equal((await f.server.reprovisionWorkspace(created.workspace.id, 'offline-retry')).commandId, created.commandId)
    const worker = new WorkerService(f.store, new Notifications())
    await worker.connected(f.worker.id, { name: 'reconnected', workerVersion: 'test', platform: 'linux' })
    assert.ok((await f.store.commands.listDeliverable(f.worker.id, 100)).some(c => c.commandId === created.commandId))
    await worker.receive(f.worker.id, { type: 'event', scope: 'workspace', report: { workspaceId: created.workspace.id, status: 'ready', reason: null, location: null, occurredAt: new Date(Date.now() + 1000).toISOString() as Timestamp } })
    assert.equal((await f.store.resources.getWorkspace(created.workspace.id))!.status, 'ready')
  } finally { f.store.close() }
})

for (const status of ['pending', 'provisioning'] as const) test(`initial ${status} coalescing still accepts legacy report after restart`, async () => {
  const directory = await mkdtemp('/tmp/t04-legacy-')
  const f = await fixture(`${directory}/server.sqlite`)
  let reopened: SqliteServerStore | undefined
  try {
    const created = await f.create()
    await f.store.transaction(tx => tx.resources.saveWorkspace({ ...created.workspace, status }))
    assert.equal((await f.server.reprovisionWorkspace(created.workspace.id, 'merged')).commandId, created.commandId)
    f.store.close(); reopened = new SqliteServerStore(`${directory}/server.sqlite`)
    await new WorkerService(reopened, new Notifications()).receive(f.worker.id, { type: 'event', scope: 'workspace', report: { workspaceId: created.workspace.id, status: 'ready', reason: null, location: null, occurredAt: new Date(Date.now() + 1000).toISOString() as Timestamp } })
    assert.equal((await reopened.resources.getWorkspace(created.workspace.id))!.status, 'ready')
  } finally { if (reopened) reopened.close(); else f.store.close(); await rm(directory, { recursive: true, force: true }) }
})

test('migration distinguishes old coalescing from actual replacement using command history', async () => {
  const directory = await mkdtemp('/tmp/t04-migration-')
  const path = `${directory}/server.sqlite`, f = await fixture(path)
  try {
    const initial = await f.create(), replaced = await f.create()
    await f.server.reprovisionWorkspace(initial.workspace.id, 'initial-merge')
    await f.store.transaction(tx => tx.resources.saveWorkspace({ ...replaced.workspace, status: 'failed' }))
    await f.server.reprovisionWorkspace(replaced.workspace.id, 'replacement')
    f.store.close()
    const db = new DatabaseSync(path)
    try {
      db.exec("UPDATE records SET data=json_remove(json_remove(data,'$.provisioning.replacedAttempt'),'$.placements[0].provisioning.replacedAttempt') WHERE kind='workspace'; DELETE FROM schema_migrations WHERE version=4;")
      migrate(db); migrate(db)
      const flag = (id: string) => db.prepare("SELECT COALESCE(json_extract(data,'$.provisioning.replacedAttempt'),json_extract(data,'$.placements[0].provisioning.replacedAttempt')) AS flag FROM records WHERE kind='workspace' AND id=?").get(id)!.flag
      assert.equal(flag(initial.workspace.id), 0)
      assert.equal(flag(replaced.workspace.id), 1)
    } finally { db.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('binding migration replays with composite FKs and unique workspace constraint', () => {
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db); migrate(db)
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
    db.prepare('INSERT INTO records VALUES(?,?,?)').run('project', 'p', '{}')
    db.prepare('INSERT INTO records VALUES(?,?,?)').run('workspace', 'w', JSON.stringify({ projectId: 'p' }))
    for (const id of ['a', 'b']) db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(id, 'p', JSON.stringify({ metadataJson: { schemaVersion: 1 } }))
    const bind = db.prepare('INSERT INTO task_workspaces(task_id,project_id,workspace_id,created_at) VALUES(?,?,?,?)')
    bind.run('a', 'p', 'w', 'now')
    assert.throws(() => bind.run('b', 'p', 'w', 'now'), /UNIQUE/)
    assert.throws(() => db.prepare("DELETE FROM records WHERE kind='workspace' AND id='w'").run(), /FOREIGN KEY/)
    assert.throws(() => bind.run('a', 'p', 'missing', 'now'))
    assert.throws(() => db.prepare("DELETE FROM tasks WHERE id='a'").run(), /FOREIGN KEY/)
  } finally { db.close() }
})
