import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { Notifications, type NotificationFailure } from '../application/notifications.js'
import { ServerService, newId } from '../application/server-service.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'

test('after-commit subscriber throws/rejections do not fail the API or skip later subscribers', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  const failures: NotificationFailure[] = []
  const notifications = new Notifications(failure => { failures.push(failure) })
  const service = new ServerService(store, notifications)
  const { project } = await service.bootstrap()
  const worker = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'notification-test' })
  const sync = new Error('sync subscriber'), asyncError = new Error('async subscriber')
  notifications.onCommands(worker.workerId, () => { throw sync })
  notifications.onCommands(worker.workerId, async () => { throw asyncError })
  let observed!: Promise<void>
  const unsubscribe = notifications.onCommands(worker.workerId, () => {
    observed = (async () => {
      assert.equal((await store.resources.listWorkspaces()).length, 1)
      await store.transaction(async tx => { assert.equal((await tx.commands.listDeliverable(worker.workerId, 100)).length, 1) })
    })()
    return observed
  })
  const { workspace } = await service.createWorkspace({ projectId: project!.id, workerId: worker.workerId, name: 'committed', source: 'empty' })
  await observed
  await setImmediate()
  assert.equal((await store.resources.getWorkspace(workspace.id))?.name, 'committed')
  assert.deepEqual(failures.map(f => f.error), [sync, asyncError])
  assert.ok(failures.every(f => f.key === `commands:${worker.workerId}`))
  unsubscribe()
})

for (const asyncReporter of [false, true]) test(`session subscribers and ${asyncReporter ? 'rejecting' : 'throwing'} diagnostics sink are isolated`, async () => {
  const notifications = new Notifications(() => {
    if (asyncReporter) return Promise.reject(new Error('reporter rejected'))
    throw new Error('reporter threw')
  })
  const id = newId<'SessionId'>()
  let calls = 0
  notifications.onSession(id, () => { throw new Error('sync') })
  notifications.onSession(id, async () => { throw new Error('async') })
  const unsubscribe = notifications.onSession(id, () => { calls++ })
  notifications.session(id)
  await setImmediate()
  assert.equal(calls, 1)
  unsubscribe()
  notifications.session(id)
  await setImmediate()
  assert.equal(calls, 1)
})
