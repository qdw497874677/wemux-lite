import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService, newId, now } from '../application/server-service.js'
import { WorkerService } from '../application/worker-service.js'
import { Notifications } from '../application/notifications.js'

const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

for (const rollback of [true, false]) test(`public reads and delivery wait for ${rollback ? 'rollback' : 'commit'}`, { timeout: 5000 }, async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  const notifications = new Notifications(), service = new ServerService(store, notifications)
  const workers = new WorkerService(store, notifications)
  const { project } = await service.bootstrap()
  const worker = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'reader-test' })
  const paused = gate(), release = gate()
  const id = newId<'ProjectId'>()
  const write = store.transaction(async tx => {
    await tx.resources.saveProject({ ...project!, id, name: 'uncommitted' })
    await service.createWorkspaceInTx(tx, { projectId: id, workerId: worker.workerId, name: 'pending', source: 'empty' })
    assert.equal((await tx.resources.getProject(id))?.name, 'uncommitted')
    assert.equal((await tx.commands.listDeliverable(worker.workerId, 100)).length, 1)
    paused.resolve()
    await release.promise
    if (rollback) throw new Error('intentional rollback')
  })
  const outcome = rollback ? assert.rejects(write, /intentional rollback/) : write
  await paused.promise
  let settled = false
  const reads = Promise.all([
    store.commands.listDeliverable(worker.workerId, 100),
    store.resources.getProject(id),
    workers.deliverable(worker.workerId),
  ]).then(result => { settled = true; return result })
  try {
    await setImmediate()
    assert.equal(settled, false, 'public reads must not escape an open transaction')
  } finally { release.resolve(); await outcome }
  const [commands, resource, delivery] = await reads
  assert.equal(commands.length, rollback ? 0 : 1)
  assert.equal(resource?.id ?? null, rollback ? null : id)
  assert.equal(delivery.length, rollback ? 0 : 1)
  assert.equal((await workers.deliverable(worker.workerId)).length, rollback ? 0 : 1)
})

test('concurrent transactions queue in order and continue after failure', { timeout: 5000 }, async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  const paused = gate(), release = gate(), order: string[] = []
  const first = store.transaction(async () => { order.push('first'); paused.resolve(); await release.promise; throw new Error('first failed') })
  const failure = assert.rejects(first, /first failed/)
  await paused.promise
  const second = store.transaction(async () => { order.push('second'); return 2 })
  const third = store.transaction(async () => { order.push('third'); return 3 })
  try { await setImmediate(); assert.deepEqual(order, ['first']) } finally { release.resolve() }
  await failure
  assert.deepEqual(await Promise.all([second, third]), [2, 3])
  assert.deepEqual(order, ['first', 'second', 'third'])
})

test('public reads and nested transactions fail fast inside tx; queue remains usable', { timeout: 5000 }, async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  await assert.rejects(store.transaction(async () => {
    await store.transaction(async () => undefined)
  }), /Nested transactions/)
  await assert.rejects(store.transaction(async () => {
    await store.resources.listProjects()
  }), /Use tx readers/)
  assert.deepEqual(await store.resources.listProjects(), [])
  await store.transaction(async tx => { assert.deepEqual(await tx.resources.listProjects(), []) })
})

test('credential and cache public readers also wait for rollback', { timeout: 5000 }, async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  const paused = gate(), release = gate()
  const userId = newId<'UserId'>(), sessionId = newId<'SessionId'>()
  const failure = assert.rejects(store.transaction(async tx => {
    await tx.identity.saveLocalAccountCredential({ userId, passwordHash: 'pending', updatedAt: now() })
    await tx.cache.markSessionGap(sessionId)
    assert.equal((await tx.identity.getLocalAccountCredential(userId))?.passwordHash, 'pending')
    assert.equal((await tx.cache.getFreshness(sessionId))?.status, 'gap')
    paused.resolve(); await release.promise
    throw new Error('rollback')
  }), /rollback/)
  await paused.promise
  let settled = false
  const reads = Promise.all([store.identity.getLocalAccountCredential(userId), store.cache.getFreshness(sessionId)])
    .then(result => { settled = true; return result })
  try { await setImmediate(); assert.equal(settled, false) } finally { release.resolve(); await failure }
  const [credential, freshness] = await reads
  assert.equal(credential, null)
  assert.equal(freshness?.status, 'unknown')
})
