import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket, type WebSocketServer } from 'ws'
import type { AgentKey, CommandId, ModelId, ProjectId, SessionId, Timestamp, UserId, WorkspaceId, WorkerId } from '@wemux/domain'
import type { CommandReceipt, ServerDataFrame, ServerPayload, WorkerCommand } from '@wemux/wire-protocol'
import type { EnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'
import type { ServerToWorkerFrame, WorkerHelloFrame } from '@wemux/wire-protocol'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.js'
import { CommandSigningIdentity } from '../application/command-signing.js'
import { ServerService } from '../application/server-service.js'
import { SessionAccessService } from '../application/session-access-service.js'
import { ProjectAccessService } from '../application/project-access-service.js'
import { TaskService } from '../application/task-service.js'
import { WorkerService } from '../application/worker-service.js'
import { Notifications } from '../application/notifications.js'
import { AuthenticationService, hashSecret } from '../application/auth.js'
import { AdministratorDirectory } from '../application/administrator-directory.js'
import { WorkerGateway } from '../worker-ws/gateway.js'
import { ServerTransportStore } from '../worker-ws/transport-store.js'
import { buildCommandAssertionClaims } from '../application/command-assertion-issuer.js'
import { instanceOperatorId, seedOperator } from './fixtures/administrator.js'

const context = { actor: instanceOperatorId, requestId: 'assertion-refresh' }
const minute = 60_000

function signedStore(path: string) {
  const database = new SharedSqliteDatabase(path)
  const store = new SqliteServerStore(database)
  const commandSigning = new CommandSigningIdentity(database.connection)
  return { database, store, commandSigning }
}

/** 服务级夹具：带签名身份与会话访问服务的完整 ServerService，外加独立会话。 */
async function serviceFixture(path: string) {
  const { database, store, commandSigning } = signedStore(path)
  const signals = new Notifications()
  const server = new ServerService(store, signals, undefined, undefined, undefined, new SessionAccessService(store, new ProjectAccessService(store)), commandSigning)
  await seedOperator(store, server)
  const { worker } = await server.enroll({ token: (await server.createEnrollment({})).token, name: 'Refresh worker' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
  const tasks = new TaskService(store, event => signals.project(event), server)
  const task = await tasks.create('default-project', { title: 'Assertion refresh' }, context)
  const { workspace } = await tasks.createWorkspace(task.projectId, task.id, { name: task.title, workerId: worker.id, source: 'empty' }, context)
  await store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready' }))
  await tasks.assignment(task.projectId, task.id, { version: 1, assignee: { workspaceId: workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' } }, false, context)
  const { session } = await tasks.createSession(task.projectId, task.id, { title: 'Refresh', requestId: 'refresh-session' }, context)
  return { database, store, commandSigning, server, tasks, signals, task, worker, session }
}

/** 把存储中的断言替换为同身份但已过期的版本（模拟 5 分钟窗口过去且 Worker 一直离线）。 */
async function expireStoredAuthorization(f: Awaited<ReturnType<typeof serviceFixture>>, commandId: CommandId) {
  const original = (await f.store.commands.getPendingCommand(commandId))!.authorization!
  const expired = f.commandSigning.sign({ ...original.claims, issuedAt: new Date(Date.now() - 6 * minute).toISOString(), expiresAt: new Date(Date.now() - minute).toISOString() })
  await f.store.transaction(tx => tx.commands.refreshCommandAuthorization(commandId, expired))
  return { original, expired }
}

const claimIdentity = (claims: object) => Object.fromEntries(Object.entries(claims as Record<string, unknown>).filter(([key]) => key !== 'issuedAt' && key !== 'expiresAt'))

const helloFor = (id: WorkerId): WorkerHelloFrame => ({
  frameType: 'transport.hello', side: 'worker', workerId: id, name: 'Fixture', workerVersion: 'test', platform: 'linux', architecture: 'x64',
  transport: { supportedMajors: [2], preferredMinorByMajor: { '2': 0 } }, adkProfiles: ['wemux.adk.v1'], features: [],
  resume: { logicalConnectionId: null, workerToServer: { deliveryEpoch: 'worker-epoch', ackThrough: 0 }, serverToWorker: null },
})

// ---------------------------------------------------------------------------
// 服务级：过期断言的重签与安全负例
// ---------------------------------------------------------------------------

test('expired session.enqueue assertion is re-signed at delivery wake with identity preserved', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assertion-refresh-')), path = join(dir, 'server.db')
  const f = await serviceFixture(path)
  t.after(async () => { f.database.close(); await rm(dir, { recursive: true, force: true }) })
  const commandId = 'refresh-enqueue' as CommandId
  await f.server.enqueue(f.session.id, { commandId, content: '恢复后自动继续' }, instanceOperatorId)
  const { original, expired } = await expireStoredAuthorization(f, commandId)
  assert.ok(Date.parse(expired.claims.expiresAt) < Date.now(), 'fixture must leave a stale assertion')
  assert.equal(await f.server.refreshPendingCommandAuthorization(f.worker.id, commandId), true)
  const fresh = (await f.store.commands.getPendingCommand(commandId))!.authorization!
  assert.ok(Date.parse(fresh.claims.expiresAt) > Date.now(), 're-signed window is current')
  assert.deepEqual(claimIdentity(fresh.claims), claimIdentity(original.claims), 're-sign keeps domain identity')
  // 仍在窗口内时不重复签发。
  assert.equal(await f.server.refreshPendingCommandAuthorization(f.worker.id, commandId), true)
  const again = (await f.store.commands.getPendingCommand(commandId))!.authorization!
  assert.deepEqual(again, fresh, 'fresh window is not re-signed')
})

test('re-sign is refused when the actor is disabled, the worker is revoked, or permission is lost', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assertion-refresh-negative-')), path = join(dir, 'server.db')
  const f = await serviceFixture(path)
  t.after(async () => { f.database.close(); await rm(dir, { recursive: true, force: true }) })
  const commandId = 'refresh-negative' as CommandId
  await f.server.enqueue(f.session.id, { commandId, content: '负例' }, instanceOperatorId)
  const { expired } = await expireStoredAuthorization(f, commandId)

  // 主体停用：不得重签，存储保持过期断言（诚实失败）。
  const actor = (await f.store.identity.getUser(instanceOperatorId))!
  await f.store.transaction(tx => tx.identity.saveUser({ ...actor, status: 'disabled' }))
  assert.equal(await f.server.refreshPendingCommandAuthorization(f.worker.id, commandId), false)
  assert.deepEqual((await f.store.commands.getPendingCommand(commandId))!.authorization, expired)
  await f.store.transaction(tx => tx.identity.saveUser({ ...actor, status: 'active' }))

  // Worker 已撤销：不得重签。
  await f.store.transaction(tx => tx.resources.saveWorker({ ...f.worker, connectionState: 'revoked' }))
  assert.equal(await f.server.refreshPendingCommandAuthorization(f.worker.id, commandId), false)
  assert.deepEqual((await f.store.commands.getPendingCommand(commandId))!.authorization, expired)
  await f.store.transaction(tx => tx.resources.saveWorker({ ...f.worker, connectionState: 'online' }))

  // 权限丧失（会话已删除，写权限不再满足）：不得重签。
  await f.store.transaction(tx => tx.resources.saveSession({ ...f.session, deletedAt: new Date().toISOString() as Timestamp }))
  assert.equal(await f.server.refreshPendingCommandAuthorization(f.worker.id, commandId), false)
  assert.deepEqual((await f.store.commands.getPendingCommand(commandId))!.authorization, expired)
})

test('tampered persisted claims are rejected by the store seam and never laundered', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assertion-refresh-tamper-')), path = join(dir, 'server.db')
  const f = await serviceFixture(path)
  t.after(async () => { f.database.close(); await rm(dir, { recursive: true, force: true }) })
  const commandId = 'refresh-tamper' as CommandId
  await f.server.enqueue(f.session.id, { commandId, content: '防洗白' }, instanceOperatorId)
  const original = (await f.store.commands.getPendingCommand(commandId))!.authorization!
  const tampered = f.commandSigning.sign({ ...original.claims, actorId: 'someone-else' as UserId })
  await assert.rejects(f.store.transaction(tx => tx.commands.refreshCommandAuthorization(commandId, tampered)), /identity changed/)
  // 篡改身份后签名失效的过期断言也不会被重签。
  const expired = f.commandSigning.sign({ ...original.claims, issuedAt: new Date(Date.now() - 6 * minute).toISOString(), expiresAt: new Date(Date.now() - minute).toISOString() })
  const staleSigned = { ...expired, signature: 'invalid' }
  await f.store.transaction(tx => tx.commands.refreshCommandAuthorization(commandId, staleSigned as never))
  assert.equal(await f.server.refreshPendingCommandAuthorization(f.worker.id, commandId), false)
  assert.deepEqual((await f.store.commands.getPendingCommand(commandId))!.authorization, staleSigned)
})

test('turn.stop refresh requires the acting subject to still be active', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assertion-refresh-stop-')), path = join(dir, 'server.db')
  const f = await serviceFixture(path)
  t.after(async () => { f.database.close(); await rm(dir, { recursive: true, force: true }) })
  const commandId = 'refresh-turn-stop' as CommandId
  const command: WorkerCommand = { kind: 'turn.stop', sessionId: f.session.id, turnId: 'turn' as never }
  const claims = buildCommandAssertionClaims({ keyId: f.commandSigning.keyId, commandId, command, workerId: f.worker.id, scope: { sessionId: f.session.id, projectId: f.session.projectId, workspaceId: f.session.workspaceId, taskId: f.session.taskId ?? null }, actorId: instanceOperatorId, actorAuthVersion: 0 })
  await f.store.transaction(tx => tx.commands.insertPending({ commandId, workerId: f.worker.id, command, payloadFingerprint: createHash('sha256').update(JSON.stringify(command)).digest('hex'), createdAt: new Date().toISOString() as Timestamp, authorization: f.commandSigning.sign(claims) }))
  const stored = (await f.store.commands.getPendingCommand(commandId))!.authorization!
  const expired = f.commandSigning.sign({ ...stored.claims, issuedAt: new Date(Date.now() - 6 * minute).toISOString(), expiresAt: new Date(Date.now() - minute).toISOString() })
  await f.store.transaction(tx => tx.commands.refreshCommandAuthorization(commandId, expired))
  assert.equal(await f.server.refreshPendingCommandAuthorization(f.worker.id, commandId), true)
  assert.ok(Date.parse((await f.store.commands.getPendingCommand(commandId))!.authorization!.claims.expiresAt) > Date.now())
  // 主体停用后撤销类命令保持失败关闭：不重签。
  const again = (await f.store.commands.getPendingCommand(commandId))!.authorization!
  const expiredAgain = f.commandSigning.sign({ ...again.claims, issuedAt: new Date(Date.now() - 6 * minute).toISOString(), expiresAt: new Date(Date.now() - minute).toISOString() })
  await f.store.transaction(tx => tx.commands.refreshCommandAuthorization(commandId, expiredAgain))
  const actor = (await f.store.identity.getUser(instanceOperatorId))!
  await f.store.transaction(tx => tx.identity.saveUser({ ...actor, status: 'disabled' }))
  assert.equal(await f.server.refreshPendingCommandAuthorization(f.worker.id, commandId), false)
  assert.deepEqual((await f.store.commands.getPendingCommand(commandId))!.authorization, expiredAgain)
})

test('approval kinds keep delegating to the approval refresh path', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assertion-refresh-approval-')), path = join(dir, 'server.db')
  const f = await serviceFixture(path)
  t.after(async () => { f.database.close(); await rm(dir, { recursive: true, force: true }) })
  const commandId = 'refresh-approval' as CommandId
  await f.server.resolveRuntimeApproval(f.session.id, 'approval' as never, { commandId, turnId: 'turn', decision: 'approve' }, instanceOperatorId)
  assert.equal(await f.server.refreshPendingCommandAuthorization(f.worker.id, commandId), true)
  // 审批命令仍走 refreshApprovalAuthorization 通道，新通道拒绝审批身份写入。
  const stored = (await f.store.commands.getPendingCommand(commandId))!.authorization!
  await assert.rejects(f.store.transaction(tx => tx.commands.refreshCommandAuthorization(commandId, stored)), /non-command/)
})

// ---------------------------------------------------------------------------
// 传输级：过期命令帧的重放屏障与原位替换
// ---------------------------------------------------------------------------

test('expired non-approval command frames are barriered without includeExpired and replaceable in place', async t => {
  const store = new ServerTransportStore(':memory:')
  t.after(() => store.close())
  const worker = 'transport-worker' as WorkerId
  const claims = (delta: number): EnqueueAuthorization => ({ version: 3, kind: 'session.enqueue', keyId: 'key', commandId: 'cmd' as CommandId, workerId: worker, sessionId: 'session' as SessionId, projectId: 'project' as ProjectId, workspaceId: 'workspace' as WorkspaceId, taskId: 'task', actorId: 'actor' as UserId, actorAuthVersion: 0, commandDigest: 'digest', issuedAt: new Date(Date.now() - 6 * minute).toISOString(), expiresAt: new Date(Date.now() + delta).toISOString() })
  const enqueueCommand: WorkerCommand = { kind: 'session.enqueue', sessionId: 'session' as never, message: { messageId: 'message' as never, content: 'x' } }
  const payload: ServerPayload = { type: 'command', commandId: 'cmd' as CommandId, command: enqueueCommand, authorization: { claims: claims(-minute), signature: 'sig' } }
  const frame: ServerDataFrame = { frameType: 'data', durability: 'durable', deliveryEpoch: 'server-epoch', directionSeq: 1, messageId: 'm1' as never, lane: 'control', payloadVersion: 'wemux.server.payload.v1', expiresAt: null, payload }
  store.negotiate(worker, helloFor(worker))
  store.enqueue(worker, frame.payload)
  assert.deepEqual(store.pending(worker, 8), [], 'expired frame is a replay barrier by default')
  const [retained] = store.pending(worker, 8, true)
  if (!retained || retained.durability !== 'durable') throw new Error('expected a retained durable frame')
  // 已发送行也能原位替换（Worker 从未处理时的恢复路径）。
  store.sent(worker, retained)
  const fresh = { ...payload, authorization: { claims: claims(5 * minute), signature: 'sig2' } } as ServerPayload
  assert.equal(store.refreshStaleCommand(worker, retained, fresh), true)
  const [replaced] = store.pending(worker, 8, true)
  if (!replaced || replaced.durability !== 'durable') throw new Error('expected a replaced durable frame')
  assert.equal(replaced.directionSeq, retained.directionSeq, 'sequence is preserved')
  assert.equal(replaced.messageId, retained.messageId, 'message identity is preserved')
  assert.deepEqual(replaced.payload, fresh)
  // 审批命令不走新通道。
  const approvalCommand: WorkerCommand = { kind: 'runtime.approval.resolve', sessionId: 'session' as never, turnId: 'turn' as never, approvalId: 'a' as never, decision: 'approve', decidedByAccountId: 'actor' as UserId }
  const approvalPayload: ServerPayload = { type: 'command', commandId: 'approval' as CommandId, command: approvalCommand, authorization: { claims: { ...claims(-minute), kind: 'runtime.approval.resolve', commandId: 'approval' as CommandId }, signature: 'sig' } }
  store.enqueue(worker, approvalPayload)
  const approvalRetained = store.pending(worker, 8, true).find(f => f.payload.type === 'command' && f.payload.commandId === 'approval')!
  assert.ok(approvalRetained)
  assert.equal(store.refreshStaleCommand(worker, approvalRetained, fresh), false, 'approval kinds stay on the immutable approval path')
})

// ---------------------------------------------------------------------------
// 网关级：真实 WebSocket 重连下的重签投递
// ---------------------------------------------------------------------------

const gwHello = helloFor

class Peer {
  readonly frames: ServerToWorkerFrame[] = []
  private readonly waiters = new Set<() => void>()
  constructor(readonly ws: WebSocket) { ws.on('message', data => { this.frames.push(JSON.parse(data.toString())); for (const notify of this.waiters) notify() }) }
  raw(frame: unknown) { this.ws.send(JSON.stringify(frame)) }
  wait(predicate: (f: ServerToWorkerFrame) => boolean): Promise<ServerToWorkerFrame> {
    const found = this.frames.find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise(resolve => { const notify = () => { const frame = this.frames.find(predicate); if (frame) { this.waiters.delete(notify); resolve(frame) } }; this.waiters.add(notify) })
  }
  async checkpoint() { const nonce = randomUUID(); this.raw({ frameType: 'transport.ping', nonce, sentAt: new Date().toISOString() }); await this.wait(f => f.frameType === 'transport.pong' && f.nonce === nonce) }
  async close() { if (this.ws.readyState === WebSocket.CLOSED) return; const done = once(this.ws, 'close'); this.ws.close(); await done }
}

/** 网关夹具：真实 HTTP + WebSocket 网关，签名服务，命令在 Worker 离线期间积压。 */
async function gatewayFixture(path: string) {
  const { database, store, commandSigning } = signedStore(join(path, 'server.db'))
  const transport = new ServerTransportStore(join(path, 'transport.sqlite'))
  const signals = new Notifications()
  const server = new ServerService(store, signals, undefined, undefined, undefined, new SessionAccessService(store, new ProjectAccessService(store)), commandSigning)
  await seedOperator(store, server)
  const { worker, credential } = await server.enroll({ token: (await server.createEnrollment({})).token, name: 'Gateway worker' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'offline', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
  const tasks = new TaskService(store, event => signals.project(event), server)
  const task = await tasks.create('default-project', { title: 'Gateway' }, context)
  const { workspace } = await tasks.createWorkspace(task.projectId, task.id, { name: task.title, workerId: worker.id, source: 'empty' }, context)
  await store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready' }))
  await tasks.assignment(task.projectId, task.id, { version: 1, assignee: { workspaceId: workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' } }, false, context)
  const { session } = await tasks.createSession(task.projectId, task.id, { title: 'Gateway', requestId: 'gateway-session' }, context)
  const http = createServer(); http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const port = (http.address() as { port: number }).port
  const gateway = new WorkerGateway(http, new AuthenticationService(store, new AdministratorDirectory(store.identity)), new WorkerService(store, signals, undefined, undefined, null, null, undefined, true), signals, transport, undefined, server)
  const connect = async () => {
    const peer = new Peer(new WebSocket(`ws://127.0.0.1:${port}/worker/ws`, { headers: { authorization: `Bearer ${credential}` } }))
    await once(peer.ws, 'open')
    peer.raw(gwHello(worker.id))
    await peer.wait(f => f.frameType === 'transport.hello')
    return peer
  }
  const close = async (peer?: Peer) => {
    if (peer) await peer.close()
    await gateway.close()
    await new Promise<void>(resolve => http.close(() => resolve()))
    store.close(); database.close()
    await rm(path, { recursive: true, force: true })
  }
  return { store, transport, commandSigning, server, worker, session, connect, close }
}

const isCommandFrame = (commandId: string) => (f: ServerToWorkerFrame) => f.frameType === 'data' && f.payload.type === 'command' && f.payload.commandId === commandId

test('worker reconnecting after the signing window expires receives a re-signed command', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assertion-refresh-gateway-'))
  const f = await gatewayFixture(dir)
  const commandId = 'gateway-refresh' as CommandId
  await f.server.enqueue(f.session.id, { commandId, content: '长离线后的第一条消息' }, instanceOperatorId)
  const original = (await f.store.commands.getPendingCommand(commandId))!.authorization!
  const expired = f.commandSigning.sign({ ...original.claims, issuedAt: new Date(Date.now() - 6 * minute).toISOString(), expiresAt: new Date(Date.now() - minute).toISOString() })
  await f.store.transaction(tx => tx.commands.refreshCommandAuthorization(commandId, expired))
  const peer = await f.connect()
  const frame = await peer.wait(isCommandFrame(commandId))
  t.after(() => f.close(peer))
  if (frame.frameType !== 'data' || frame.durability !== 'durable') throw new Error('expected a durable data frame')
  const claims = frame.payload.type === 'command' ? frame.payload.authorization!.claims : null
  assert.ok(claims, 'delivered frame carries an assertion')
  assert.ok(Date.parse(claims.expiresAt) > Date.now(), 'delivered window is current')
  assert.deepEqual(claimIdentity(claims), claimIdentity(original.claims), 'delivered identity is unchanged')
  const stored = (await f.store.commands.getPendingCommand(commandId))!.authorization!
  assert.ok(Date.parse(stored.claims.expiresAt) > Date.now(), 'stored assertion was refreshed')
  // Worker 确认接收。
  const receipt: CommandReceipt = { commandId, status: 'accepted' }
  peer.raw({ frameType: 'data', durability: 'durable', deliveryEpoch: 'worker-epoch', directionSeq: 1, messageId: randomUUID(), lane: 'control', payloadVersion: 'wemux.worker.payload.v1', expiresAt: null, payload: { type: 'ack', receipt } })
  await peer.checkpoint()
  peer.raw({ frameType: 'transport.ack', deliveryEpoch: frame.deliveryEpoch, ackThrough: frame.directionSeq })
  await peer.checkpoint()
  assert.deepEqual(f.transport.pending(f.worker.id, 100), [])
  assert.equal((await f.store.commands.get(commandId))!.status, 'accepted', 'worker receipt is recorded')
})

test('a sent but never processed stale frame is replaced in place on reconnect', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assertion-refresh-sent-'))
  const f = await gatewayFixture(dir)
  const commandId = 'gateway-sent-refresh' as CommandId
  await f.server.enqueue(f.session.id, { commandId, content: '断线前最后一帧' }, instanceOperatorId)
  const pending = (await f.store.commands.getPendingCommand(commandId))!
  const expired = f.commandSigning.sign({ ...pending.authorization!.claims, issuedAt: new Date(Date.now() - 6 * minute).toISOString(), expiresAt: new Date(Date.now() - minute).toISOString() })
  await f.store.transaction(tx => tx.commands.refreshCommandAuthorization(commandId, expired))
  // 直接把过期帧放入传输并标记已发送：模拟 Worker 从未处理该帧。
  f.transport.enqueue(f.worker.id, { type: 'command', commandId, command: pending.command, authorization: expired })
  const [row] = f.transport.pending(f.worker.id, 8, true)
  if (!row || row.durability !== 'durable') throw new Error('expected a durable transport row')
  f.transport.sent(f.worker.id, row)
  const peer = await f.connect()
  const frame = await peer.wait(isCommandFrame(commandId))
  if (frame.frameType !== 'data' || frame.durability !== 'durable') throw new Error('expected a durable data frame')
  assert.equal(frame.directionSeq, row!.directionSeq, 'replacement keeps the original sequence')
  const claims = frame.payload.type === 'command' ? frame.payload.authorization!.claims : null
  assert.ok(claims && Date.parse(claims.expiresAt) > Date.now(), 'replaced frame carries a current window')
  await f.close(peer)
})

test('denied refresh delivers the stale frame honestly and records the terminal rejection', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'assertion-refresh-denied-'))
  const f = await gatewayFixture(dir)
  const commandId = 'gateway-denied' as CommandId
  await f.server.enqueue(f.session.id, { commandId, content: '主体已停用' }, instanceOperatorId)
  const pending = (await f.store.commands.getPendingCommand(commandId))!
  const expired = f.commandSigning.sign({ ...pending.authorization!.claims, issuedAt: new Date(Date.now() - 6 * minute).toISOString(), expiresAt: new Date(Date.now() - minute).toISOString() })
  await f.store.transaction(tx => tx.commands.refreshCommandAuthorization(commandId, expired))
  const actor = (await f.store.identity.getUser(instanceOperatorId))!
  await f.store.transaction(tx => tx.identity.saveUser({ ...actor, status: 'disabled' }))
  const peer = await f.connect()
  t.after(() => f.close(peer))
  const frame = await peer.wait(isCommandFrame(commandId))
  if (frame.frameType !== 'data') throw new Error('expected a data frame')
  const claims = frame.payload.type === 'command' ? frame.payload.authorization!.claims : null
  assert.ok(claims && Date.parse(claims.expiresAt) < Date.now(), 'stale claims are delivered as-is when refresh is denied')
  const receipt: CommandReceipt = { commandId, status: 'rejected', error: { code: 'invalid-input', message: 'Command authorization unavailable', retryable: false } }
  peer.raw({ frameType: 'data', durability: 'durable', deliveryEpoch: 'worker-epoch', directionSeq: 1, messageId: randomUUID(), lane: 'control', payloadVersion: 'wemux.worker.payload.v1', expiresAt: null, payload: { type: 'ack', receipt } })
  await peer.checkpoint()
  assert.equal((await f.store.commands.get(commandId))!.status, 'rejected', 'terminal rejection is recorded')
})
