import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentKey, EventSeq, ModelId } from '@wemux/domain'
import { Notifications } from '../application/notifications.ts'
import { ServerService, now } from '../application/server-service.ts'
import { WorkerService } from '../application/worker-service.ts'
import { TaskService } from '../application/task-service.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import { instanceOperatorId, seedOperator } from './fixtures/administrator.ts'

test('unchanged Worker heads do not invalidate conversation or redeliver commands; recovery and gaps still do', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  const signals = new Notifications(), server = new ServerService(store, signals)
  await seedOperator(store, server)
  const { worker } = await server.enroll({ token: (await server.createEnrollment({})).token, name: 'Head fixture' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
  const tasks = new TaskService(store, event => signals.project(event), server)
  const context = { actor: instanceOperatorId, requestId: 'head-fixture' }
  const task = await tasks.create('default-project', { title: 'Head fixture' }, context)
  const { workspace } = await tasks.createWorkspace(task.projectId, task.id, { name: task.title, workerId: worker.id, source: 'empty' }, context)
  await store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready' }))
  await tasks.assignment(task.projectId, task.id, { version: 1, assignee: { workspaceId: workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' } }, false, context)
  const { session } = await tasks.createSession(task.projectId, task.id, { title: 'Head fixture', requestId: 'head-session' }, context)
  const ingress = new WorkerService(store, signals)
  let invalidations = 0, deliveries = 0
  signals.onSession(session.id, () => { invalidations++ })
  signals.onCommands(worker.id, () => { deliveries++ })
  const head = (lastSeq: number) => ingress.receive(worker.id, { type: 'sync', kind: 'heads', complete: true, heads: [{ sessionId: session.id, lastSeq: lastSeq as EventSeq }] })
  await head(0)
  const initial = { invalidations, deliveries }
  assert.equal(initial.invalidations, 1)
  for (let repeat = 0; repeat < 10; repeat++) assert.deepEqual(await head(0), [])
  assert.deepEqual({ invalidations, deliveries }, initial, 'identical periodic heads must not refresh or dispatch')
  const queued = await server.enqueue(session.id, { content: 'Rejected before Journal' }, instanceOperatorId)
  assert.equal((await server.sessionView(session.id)).queuedMessages.length, 1)
  const reject = () => ingress.receive(worker.id, { type: 'ack', receipt: { commandId: queued.commandId, status: 'rejected', error: { code: 'invalid-input', message: 'Runtime unavailable', retryable: false } } })
  await reject()
  assert.equal((await server.sessionView(session.id)).queuedMessages.length, 0)
  assert.equal(invalidations, initial.invalidations + 1, 'standalone rejection invalidates queue without a Journal event')
  const rejected = { invalidations, deliveries }
  await reject(); await head(0)
  assert.deepEqual({ invalidations, deliveries }, rejected, 'duplicate rejection and identical head stay quiet')
  initial.invalidations = invalidations
  await ingress.disconnected(worker.id)
  assert.equal(invalidations, initial.invalidations + 1)
  await ingress.connected(worker.id, { workerVersion: 'test', platform: 'test' })
  await head(0)
  assert.equal(invalidations, initial.invalidations + 2, 'same cursor still invalidates offline-to-synced recovery')
  const gap = await head(2)
  assert.equal(invalidations, initial.invalidations + 3)
  assert.equal(gap[0]?.type, 'sync')
  const beforeRepeat = { invalidations, deliveries }
  assert.deepEqual(await head(2), gap, 'unchanged gap must still request missing events')
  assert.deepEqual({ invalidations, deliveries }, beforeRepeat)
  const unavailable = worker.capabilities // Empty capabilities remove the test Agent.
  await ingress.receive(worker.id, { type: 'capability', workerId: worker.id, capabilities: unavailable, detectedAt: now() })
  assert.equal(invalidations, beforeRepeat.invalidations + 1, 'capability changes explicitly invalidate without periodic head polling')
  await ingress.receive(worker.id, { type: 'capability', workerId: worker.id, capabilities: unavailable, detectedAt: now() })
  assert.equal(invalidations, beforeRepeat.invalidations + 1, 'identical capability reports are quiet')
  const beforeRegression = { invalidations, deliveries }
  await assert.rejects(head(-1), /Worker journal head regressed/)
  assert.deepEqual({ invalidations, deliveries }, beforeRegression, 'rejected transaction emits nothing')
})
