import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, CommandId, ModelId, ProjectId, SessionId, Timestamp, UserId, WorkerId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.js'
import { CommandSigningIdentity } from '../application/command-signing.js'
import { ServerService } from '../application/server-service.js'
import { SessionAccessService } from '../application/session-access-service.js'
import { ProjectAccessService } from '../application/project-access-service.js'
import { TaskService } from '../application/task-service.js'
import { WorkerService } from '../application/worker-service.js'
import { Notifications } from '../application/notifications.js'
import type { EnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'
import { administratorApp, instanceOperatorId, seedOperator } from './fixtures/administrator.js'

/**
 * Ticket 02（命令帧授权）：Server 侧签发与在线复核。
 * 覆盖：所有副作用命令在签发点携带 v3 断言、authorizeEnqueueLaunch 的按类授权矩阵、
 * deliverable() 对未签命令的阻断，以及 Connector 分布/测试命令的签名。
 */

const context = { actor: instanceOperatorId, requestId: 'command-frame-signing' }
const digestOf = (command: unknown) => createHash('sha256').update(JSON.stringify(command)).digest('hex')

async function fixture(options: { launch?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'command-frame-signing-')), path = join(dir, 'server.db')
  const database = new SharedSqliteDatabase(path)
  const store = new SqliteServerStore(database)
  const commandSigning = new CommandSigningIdentity(database.connection)
  const signals = new Notifications()
  const server = new ServerService(store, signals, undefined, undefined, undefined, undefined, commandSigning)
  await seedOperator(store, server)
  const { worker } = await server.enroll({ token: (await server.createEnrollment({})).token, name: 'Signing worker' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
  const tasks = new TaskService(store, event => signals.project(event), server)
  const task = await tasks.create('default-project', { title: 'Signing' }, context)
  const provision = await tasks.createWorkspace(task.projectId, task.id, { name: task.title, workerId: worker.id, source: 'empty' }, context)
  await store.transaction(tx => tx.resources.saveWorkspace({ ...provision.workspace, status: 'ready', placements: provision.workspace.placements.map(placement => ({ ...placement, status: 'ready' })) }))
  const assignment = { workspaceId: provision.workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' }
  await tasks.assignment(task.projectId, task.id, { version: 1, assignee: assignment }, false, context)
  const { session: independent } = await tasks.createSession(task.projectId, task.id, { title: 'Independent', requestId: 'independent-session' }, context)
  const launch = options.launch === false ? null : await tasks.launch(task.projectId, task.id, { requestId: 'launch', mode: 'new', reuseSessionId: null, prompt: 'Prompt', assignment }, context)
  // 显式排队消息：enqueue 帧在运行开始前即可直接签发（复用 enqueueInTx 公共入口）
  if (options.launch !== false) await server.enqueue(independent.id, { commandId: 'direct-enqueue', content: 'Direct' }, instanceOperatorId)
  const withAccess = new ServerService(store, signals, undefined, undefined, new ProjectAccessService(store), new SessionAccessService(store, new ProjectAccessService(store)), commandSigning)
  return {
    dir, database, store, commandSigning, signals, server, tasks, task, worker, withAccess, independent, assignment, run: launch ? (await store.tasks.run(launch.run.id))! : null,
    async close() { database.close(); await rm(dir, { recursive: true, force: true }) },
  }
}

test('every side-effecting issuance site signs a v3 assertion bound to command and scope', async t => {
  const f = await fixture(); t.after(() => f.close())
  const pending = await f.store.commands.listDeliverable(f.worker.id, 100)
  const byKind = new Map(pending.filter(item => item.authorization).map(item => [item.command.kind, item]))
  const expect = (kind: string) => {
    const item = byKind.get(kind as never)
    assert.ok(item, `expected a signed ${kind} pending command`)
    const claims = item.authorization!.claims
    assert.equal(claims.version, 3)
    assert.equal(claims.kind, kind)
    assert.equal(claims.workerId, f.worker.id)
    assert.equal(claims.actorId, instanceOperatorId)
    assert.equal(claims.commandDigest, digestOf(item.command))
    assert.ok(f.commandSigning.verify(item.authorization!), `${kind} assertion verifies against the pinned key`)
    return claims
  }
  // tasks.createWorkspace → workspace.provision
  const provisionClaims = expect('workspace.provision')
  assert.equal(provisionClaims.sessionId, null)
  assert.equal(provisionClaims.workspaceId, f.assignment.workspaceId)
  // tasks.createSession → session.create（运行专属会话之外还有独立会话，逐一比对各自声明）
  const creates = pending.filter(item => item.authorization && item.command.kind === 'session.create')
  assert.ok(creates.length >= 1)
  for (const item of creates) {
    if (item.command.kind !== 'session.create') continue
    assert.equal(item.authorization!.claims.version, 3)
    assert.equal(item.authorization!.claims.sessionId, item.command.session.sessionId)
    assert.equal(item.authorization!.claims.workspaceId, item.command.session.binding.workspaceId)
    assert.ok(f.commandSigning.verify(item.authorization!))
  }
  assert.ok(creates.some(item => item.authorization!.claims.sessionId === f.independent.id), 'independent session create is signed')
  // 直接 enqueue：断言绑定独立会话
  const enqueue = (await f.store.commands.getPendingCommand('direct-enqueue' as CommandId))!
  assert.equal(enqueue.command.kind, 'session.enqueue')
  assert.equal(enqueue.authorization?.claims.version, 3)
  assert.equal(enqueue.authorization?.claims.kind, 'session.enqueue')
  assert.equal(enqueue.authorization?.claims.sessionId, f.independent.id)
  assert.equal(enqueue.authorization?.claims.commandDigest, digestOf(enqueue.command))
  assert.ok(f.commandSigning.verify(enqueue.authorization!))
  // 运行时命令与排队消息取消同属副作用入口（取消的是独立会话上未投递的排队消息）
  await f.server.invokeRuntimeCommand(f.independent.id, { commandId: 'compact', name: 'compact' }, instanceOperatorId)
  await f.server.cancelQueued(f.independent.id, 'direct-enqueue' as CommandId, { commandId: 'cancel-queued' }, instanceOperatorId)
  const runtime = (await f.store.commands.getPendingCommand('compact' as CommandId))!
  assert.equal(runtime.authorization?.claims.kind, 'runtime.command')
  assert.equal(runtime.authorization?.claims.sessionId, f.independent.id)
  const cancel = (await f.store.commands.getPendingCommand('cancel-queued' as CommandId))!
  assert.equal(cancel.authorization?.claims.kind, 'session.cancel-queued')
  assert.equal(cancel.authorization?.claims.sessionId, f.independent.id)
  // Run 取消经 clusterCommandIssuer 补签（turn.stop / session.cancel-queued）
  assert.ok(f.run, 'fixture launched a run')
  await f.tasks.cancelRun(f.task.projectId, f.task.id, f.run.id, { runId: f.run.id, sessionId: f.run.sessionId, requestId: 'cancel-run' }, context)
  const refreshed = (await f.store.tasks.run(f.run.id))!
  const stopIds = refreshed.cancelCommandIds
  assert.ok(stopIds.length >= 1, 'run cancellation recorded a stop command')
  const stop = (await f.store.commands.getPendingCommand(stopIds[stopIds.length - 1] as CommandId))!
  assert.equal(stop.command.kind, 'session.cancel-queued')
  assert.ok(stop.authorization, 'run cancellation stop is signed')
  assert.equal(stop.authorization!.claims.kind, 'session.cancel-queued')
  assert.equal(stop.authorization!.claims.sessionId, f.run.sessionId)
  assert.equal(stop.authorization!.claims.commandDigest, digestOf(stop.command))
  assert.ok(f.commandSigning.verify(stop.authorization!))
})

test('authorizeEnqueueLaunch enforces audience, freshness fields, actor liveness and per-kind scope', async t => {
  const f = await fixture(); t.after(() => f.close())
  const pending = await f.store.commands.listDeliverable(f.worker.id, 100)
  const provision = pending.find(item => item.command.kind === 'workspace.provision')!
  const enqueue = (await f.store.commands.getPendingCommand('direct-enqueue' as CommandId))!
  // 合法的 provision 与 enqueue 均放行（operator 同时是项目所有者）
  assert.deepEqual(await f.withAccess.authorizeEnqueueLaunch(f.worker.id, provision.commandId), { allowed: true })
  assert.deepEqual(await f.withAccess.authorizeEnqueueLaunch(f.worker.id, enqueue.commandId), { allowed: true })
  // 受众不匹配
  assert.deepEqual(await f.withAccess.authorizeEnqueueLaunch('another-worker' as WorkerId, enqueue.commandId), { allowed: false })
  // 未签名的遗留命令不得启动新副作用
  const unsigned = 'unsigned-probe' as CommandId
  const command = { kind: 'turn.stop' as const, sessionId: f.independent.id, turnId: 'turn' as never }
  await f.store.transaction(tx => tx.commands.insertPending({ commandId: unsigned, workerId: f.worker.id, command, payloadFingerprint: digestOf(command), createdAt: new Date().toISOString() as Timestamp }))
  assert.deepEqual(await f.withAccess.authorizeEnqueueLaunch(f.worker.id, unsigned), { allowed: false })
  // 摘要与声明 kind 被篡改的签名一律拒绝
  for (const [id, mutation] of [
    ['tampered-digest' as CommandId, (claims: EnqueueAuthorization) => ({ ...claims, commandDigest: digestOf({ ...provision.command, workspace: null }) })],
    ['tampered-kind' as CommandId, (claims: EnqueueAuthorization) => ({ ...claims, kind: 'turn.stop' as never })],
  ] as const) {
    const claims = mutation(provision.authorization!.claims)
    await f.store.transaction(tx => tx.commands.insertPending({ commandId: id, workerId: f.worker.id, command: provision.command, payloadFingerprint: digestOf(provision.command), createdAt: new Date().toISOString() as Timestamp, authorization: f.commandSigning.sign(claims as never) }))
    assert.deepEqual(await f.withAccess.authorizeEnqueueLaunch(f.worker.id, id), { allowed: false }, `${id} rejected`)
  }
  // 已删除的 Workspace、已撤销的 Worker、已停用主体都不得 provision/enqueue
  await f.store.transaction(async tx => {
    const workspace = (await tx.resources.getWorkspace(f.assignment.workspaceId))!
    await tx.resources.saveWorkspace({ ...workspace, deletedAt: new Date().toISOString() as Timestamp })
  })
  assert.deepEqual(await f.withAccess.authorizeEnqueueLaunch(f.worker.id, provision.commandId), { allowed: false })
  await f.store.transaction(async tx => {
    const workspace = (await tx.resources.getWorkspace(f.assignment.workspaceId))!
    await tx.resources.saveWorkspace({ ...workspace, deletedAt: null })
    const worker = (await tx.resources.getWorker(f.worker.id))!
    await tx.resources.saveWorker({ ...worker, connectionState: 'revoked' })
  })
  assert.deepEqual(await f.withAccess.authorizeEnqueueLaunch(f.worker.id, provision.commandId), { allowed: false })
  await f.store.transaction(async tx => {
    const worker = (await tx.resources.getWorker(f.worker.id))!
    await tx.resources.saveWorker({ ...worker, connectionState: 'online' })
    const user = (await tx.identity.getUser(instanceOperatorId))!
    await tx.identity.saveUser({ ...user, status: 'disabled', authVersion: (user.authVersion ?? 0) + 1 })
  })
  assert.deepEqual(await f.withAccess.authorizeEnqueueLaunch(f.worker.id, enqueue.commandId), { allowed: false })
})

test('deliverable blocks unsigned side-effecting frames once signing is configured', async t => {
  const f = await fixture(); t.after(() => f.close())
  const stopId = 'legacy-stop' as CommandId, enqueueId = 'legacy-enqueue' as CommandId
  const stop = { kind: 'turn.stop' as const, sessionId: f.independent.id, turnId: 'turn' as never }
  const enqueueCommand = { kind: 'session.enqueue' as const, sessionId: f.independent.id, message: { messageId: 'legacy' as never, content: 'legacy', sentByAccountId: instanceOperatorId } }
  await f.store.transaction(async tx => {
    await tx.commands.insertPending({ commandId: stopId, workerId: f.worker.id, command: stop, payloadFingerprint: digestOf(stop), createdAt: new Date().toISOString() as Timestamp })
    await tx.commands.insertPending({ commandId: enqueueId, workerId: f.worker.id, command: enqueueCommand, payloadFingerprint: digestOf(enqueueCommand), createdAt: new Date().toISOString() as Timestamp })
  })
  // 兼容装配（未声明签名能力）：旧的未签名 stop 仍可投递，enqueue/approval 始终阻断
  const legacy = await new WorkerService(f.store, f.signals).deliverable(f.worker.id)
  assert.equal(legacy.some(frame => frame.type === 'command' && frame.commandId === stopId), true)
  assert.equal(legacy.some(frame => frame.type === 'command' && frame.commandId === enqueueId), false)
  // 生产装配：所有未签名的副作用命令都阻断投递，签名命令携带断言
  const strict = await new WorkerService(f.store, f.signals, undefined, undefined, null, null, null, true).deliverable(f.worker.id)
  assert.equal(strict.some(frame => frame.type === 'command' && frame.commandId === stopId), false)
  assert.equal(strict.some(frame => frame.type === 'command' && frame.commandId === enqueueId), false)
  assert.ok(strict.every(frame => frame.type !== 'command' || frame.authorization), 'delivered cluster frames carry assertions')
  assert.ok(strict.some(frame => frame.type === 'command' && frame.command.kind === 'workspace.provision' && frame.authorization?.claims.version === 3))
})

test('connector distribution and test commands are signed for the acting manager', async t => {
  const f = await administratorApp(); t.after(() => f.close())
  const workerId = 'connector-worker' as WorkerId
  await f.app.store.transaction(tx => tx.resources.saveWorker({ id: workerId, teamId: 'default-team' as never, ownerId: f.userId, name: 'Connector Worker', shareScope: 'owner-only', connectionState: 'online', version: '1.0.0', platform: 'linux', capabilities: [], lastSeenAt: '2026-03-22T00:00:00.000Z' as Timestamp }))
  const projectId = 'default-project' as ProjectId
  const definition = {
    kind: 'http', name: 'Weather', description: null, enabled: true, allowedWorkerIds: [] as never[], credentialRef: null,
    riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false },
    config: {
      baseUrl: 'https://connector.example.test/api',
      allowedOperations: [{ id: 'status', description: 'Get status', method: 'GET', pathTemplate: '/status', allowedQueryNames: [], allowedRequestHeaderNames: [], requestContentTypes: [], responseContentTypes: [], redactResponse: false }],
      authentication: 'none', publicHeaders: {}, allowPrivateNetwork: false,
    },
  }
  const call = async (path: string, body: unknown, method = 'POST') => (await fetch(`${f.base}/api${path}`, { method, headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>
  const created = await call(`/projects/${projectId}/connectors`, { requestId: 'connector-create', definition })
  assert.ok(created.commandIds.length === 1)
  const sync = (await f.app.store.commands.getPendingCommand(created.commandIds[0] as CommandId))!
  assert.equal(sync.command.kind, 'connector.definition.sync')
  assert.equal(sync.authorization?.claims.version, 3)
  assert.equal(sync.authorization?.claims.kind, 'connector.definition.sync')
  assert.equal(sync.authorization?.claims.sessionId, null)
  assert.equal(sync.authorization?.claims.projectId, projectId)
  assert.equal(sync.authorization?.claims.actorId, f.userId)
  const tested = await call(`/projects/${projectId}/connectors/${created.definition.id}/test`, { requestId: 'connector-test', workerId, expectedRevision: 1 })
  const probe = (await f.app.store.commands.getPendingCommand(tested.commandId as CommandId))!
  assert.equal(probe.command.kind, 'connector.test')
  assert.equal(probe.authorization?.claims.kind, 'connector.test')
  assert.equal(probe.authorization?.claims.projectId, projectId)
  assert.equal(probe.authorization?.claims.workerId, workerId)
})

test('session deletion issues a signed teardown command bound to the session scope', async t => {
  const f = await fixture({ launch: false }); t.after(() => f.close())
  // 会话删除要求 Journal 已同步：直接标记缓存为 synced（无真实 Worker 连接的干净实例）
  f.database.connection.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run('cache', f.independent.id, JSON.stringify({ sessionId: f.independent.id, contiguousSeq: 0, workerLastSeq: 0, status: 'synced' }))
  await f.server.delete('sessions', f.independent.id, instanceOperatorId)
  const commandId = `session-delete:${f.independent.id}` as CommandId
  const teardown = await f.store.commands.getPendingCommand(commandId)
  assert.equal(teardown?.command.kind, 'session.delete')
  assert.equal(teardown?.authorization?.claims.version, 3)
  assert.equal(teardown?.authorization?.claims.kind, 'session.delete')
  assert.equal(teardown?.authorization?.claims.sessionId, f.independent.id)
  assert.equal(teardown?.authorization?.claims.actorId, instanceOperatorId)
  assert.equal(teardown?.authorization?.claims.commandDigest, digestOf(teardown.command))
})

// suppress unused warnings for types referenced by assertions
export type _ = SessionId | UserId
