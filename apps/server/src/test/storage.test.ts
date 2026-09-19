import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { AuthenticationService, hashSecret } from '../application/auth.js'
import { Notifications } from '../application/notifications.js'
import { ServerService, newId, now } from '../application/server-service.js'
import { WorkerService, envelope } from '../application/worker-service.js'
import { workerMessage } from '../application/validation.js'
import type { EventSeq, Timestamp } from '@wemux/domain'
import { seedOperator, administratorDirectory } from './fixtures/administrator.js'

test('replayed frames for entities the server no longer has are ignored', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  const notifications = new Notifications(), service = new ServerService(store, notifications), workers = new WorkerService(store, notifications)
  await seedOperator(store, service)
  const worker = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'Replay' })
  // 服务器数据被重置后，Worker 持久化的 outbox 仍会重放这些旧帧。
  // 它们已经没有任何可对账的对象，必须被安静地忽略：回 transport.error 会把还在线的节点打成离线。
  await workers.receive(worker.workerId, { ...envelope(), type: 'ack', receipt: { commandId: newId<'CommandId'>(), status: 'accepted' } })
  await workers.receive(worker.workerId, { ...envelope(), type: 'event', scope: 'workspace', report: { workspaceId: newId<'WorkspaceId'>(), status: 'ready', reason: null, location: null, occurredAt: now() } })
  await workers.receive(worker.workerId, { ...envelope(), type: 'event', scope: 'session', event: { sessionId: newId<'SessionId'>(), seq: 1 as EventSeq, occurredAt: now(), payload: { kind: 'session.runtime.changed' as const, state: 'running' as const, reason: null } } })
  await workers.receive(worker.workerId, { ...envelope(), type: 'sync', kind: 'heads', complete: true, heads: [{ sessionId: newId<'SessionId'>(), lastSeq: 3 as EventSeq }] })
  await workers.receive(worker.workerId, { ...envelope(), type: 'sync', kind: 'batch', sessionId: newId<'SessionId'>(), throughSeq: 1 as EventSeq, hasMore: false, events: [] })
  assert.equal((await store.resources.listWorkers()).length, 1)
})

test('transaction rollback, expired enrollment, revocation and worker ownership', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  const notifications = new Notifications(), service = new ServerService(store, notifications), workers = new WorkerService(store, notifications)
  const bootstrap = await seedOperator(store, service)
  const team = bootstrap.team!, user = bootstrap.user!
  const failedId = newId<'ProjectId'>()
  await assert.rejects(store.transaction(async tx => {
    await tx.resources.saveProject({ id: failedId, teamId: team.id, ownerId: user.id, name: 'rolled back', shareScope: 'owner-only', deletedAt: null })
    throw new Error('rollback')
  }), /rollback/)
  assert.equal(await store.resources.getProject(failedId), null)
  await store.transaction(tx => tx.identity.saveEnrollmentToken({ id: newId(), teamId: team.id, createdBy: user.id, tokenHash: hashSecret('expired'), expiresAt: '2000-01-01T00:00:00.000Z' as Timestamp, consumedByWorkerId: null, consumedAt: null }))
  await assert.rejects(service.enroll({ token: 'expired', name: 'Expired' }), /expired/)
  assert.equal((await store.resources.listWorkers()).length, 0)
  const first = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'First' })
  const second = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'Second' })
  const created = await service.createWorkspace({ projectId: bootstrap.project!.id, workerId: first.workerId, name: 'Repo', repository: { gitUrl: 'https://example.com/repo.git' } })
  assert.ok(created.commandId)
  const { workspace, commandId } = created
  await assert.rejects(workers.receive(second.workerId, { ...envelope(), type: 'ack', receipt: { commandId, status: 'accepted' } }), /another worker/)
  assert.equal((await store.commands.get(commandId))!.status, 'pending')
  await assert.rejects(workers.receive(second.workerId, { ...envelope(), type: 'event', scope: 'workspace', report: { workspaceId: workspace.id, status: 'ready', reason: null, location: null, occurredAt: now() } }), /ownership/)
  assert.equal((await store.resources.getWorkspace(workspace.id))!.status, 'pending')
  await store.transaction(async tx => {
    await tx.resources.saveWorkspace({ ...workspace, status: 'ready' })
    await tx.resources.saveWorker({ ...first.worker, capabilities: [{ agentKey: 'pi' as import('@wemux/domain').AgentKey, displayName: 'Pi', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'custom' as import('@wemux/domain').ModelId, displayName: 'Custom', source: 'detected' }] }] })
  })
  const { session } = await service.createSession({ requestId: 'storage-create', workspaceId: workspace.id, title: 'Chat', agentKey: 'pi', modelId: 'custom' })
  const event = { sessionId: session.id, seq: 1 as EventSeq, occurredAt: now(), payload: { kind: 'session.runtime.changed' as const, state: 'running' as const, reason: null } }
  await assert.rejects(workers.receive(second.workerId, { ...envelope(), type: 'event', scope: 'session', event }), /another worker/)
  assert.deepEqual((await service.events(session.id, 1, 100)).events, [])
  await workers.receive(first.workerId, { ...envelope(), type: 'event', scope: 'session', event })
  assert.equal((await service.getSession(session.id)).runtimeState, 'running')
  await workers.receive(first.workerId, { ...envelope(), type: 'sync', kind: 'batch', sessionId: session.id, throughSeq: 1 as EventSeq, hasMore: true, events: [event] })
  assert.equal((await service.events(session.id, 1, 100)).events.length, 1)
  await assert.rejects(workers.receive(first.workerId, { ...envelope(), type: 'event', scope: 'session', event: { ...event, payload: { ...event.payload, reason: 'different' } } }), /Conflicting event/)
  assert.equal((await service.events(session.id, 1, 100)).events.length, 1)
  await workers.receive(first.workerId, { ...envelope(), type: 'sync', kind: 'gap', sessionId: session.id, fromSeq: 1 as EventSeq, reason: 'Journal lost' })
  assert.equal((await service.events(session.id, 1, 100)).freshness!.status, 'gap')
  await store.transaction(tx => tx.identity.revokeWorkerCredential(first.workerId, now()))
  await assert.rejects(new AuthenticationService(store, administratorDirectory(store)).authenticateWorker(first.credential), /Unauthorized/)
  assert.throws(() => workerMessage({ ...envelope(), type: 'capability', workerId: first.workerId, detectedAt: now(), capabilities: [{}] }), /Invalid/)
  assert.throws(() => workerMessage({ ...envelope(), protocolVersion: 2, type: 'hello' }), /Unknown message type/)
})

test('只有提供连接的 Server 启动才重置在线状态，只读入口不动 Worker 状态', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-presence-')), path = join(dir, 'server.sqlite')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const serving = new SqliteServerStore(path)
  const service = new ServerService(serving, new Notifications())
  await seedOperator(serving, service)
  const worker = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'Presence' })
  await serving.transaction(async tx => tx.resources.saveWorker({ ...(await tx.resources.getWorker(worker.workerId))!, connectionState: 'online', lastSeenAt: now() }))
  serving.close()
  // 本机 CLI、验收脚本、备份都用默认构造：它们不拥有连接，不得把在线 Worker 刷成离线。
  const tooling = new SqliteServerStore(path)
  assert.equal((await tooling.resources.getWorker(worker.workerId))!.connectionState, 'online')
  tooling.close()
  // 真正提供连接的进程启动时可以清成离线：崩溃后残留的 online 必须自己收敛。
  const restarted = new SqliteServerStore(path, { presenceReset: true })
  assert.equal((await restarted.resources.getWorker(worker.workerId))!.connectionState, 'offline')
  restarted.close()
})
