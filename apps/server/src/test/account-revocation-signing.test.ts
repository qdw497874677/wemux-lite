import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, CommandId, EventSeq, JournalEvent, MessageId, ModelId, SessionId, Timestamp, TurnId, UserId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.js'
import { CommandSigningIdentity } from '../application/command-signing.js'
import { ServerService } from '../application/server-service.js'
import { TaskService } from '../application/task-service.js'
import { WorkerService } from '../application/worker-service.js'
import { Notifications } from '../application/notifications.js'
import { IdentityService } from '../application/identity-service.js'
import { AccountLifecycleService } from '../application/account-lifecycle-service.js'
import { administratorDirectory, instanceOperatorId, seedLocalAccount, seedOperator } from './fixtures/administrator.js'

/**
 * Ticket 02 修复回归：账号停用/销号的撤销类 turn.stop 必须带有效断言。
 * 生产装配（server.ts 构造 AccountLifecycleService 时传入 commandSigning）下，
 * 停用账号的在跑 Turn 由签发主体（操作的管理员/请求销号的账号本人）签名；
 * 签名实例的 deliverable() 不得滤掉该停止帧。历史回归：第 7 参 commandAuthority
 * 从未接线导致撤销停止恒不签名，在签名实例上被 fail-closed 拒收（停不掉在跑 Turn）。
 */

const context = { actor: instanceOperatorId, requestId: 'account-revocation-signing' }
const digestOf = (command: unknown) => createHash('sha256').update(JSON.stringify(command)).digest('hex')

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'account-revocation-signing-')), path = join(dir, 'server.db')
  const database = new SharedSqliteDatabase(path)
  const store = new SqliteServerStore(database)
  const commandSigning = new CommandSigningIdentity(database.connection)
  const signals = new Notifications()
  const server = new ServerService(store, signals, { commandSigning: commandSigning })
  await seedOperator(store, server)
  const { worker } = await server.enroll({ token: (await server.createEnrollment({})).token, name: 'Revocation worker' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
  const tasks = new TaskService(store, event => signals.project(event), server)
  const task = await tasks.create('default-project', { title: 'Revocation signing' }, context)
  const provision = await tasks.createWorkspace(task.projectId, task.id, { name: task.title, workerId: worker.id, source: 'empty' }, context)
  await store.transaction(tx => tx.resources.saveWorkspace({ ...provision.workspace, status: 'ready', placements: provision.workspace.placements.map(placement => ({ ...placement, status: 'ready' })) }))
  const assignment = { workspaceId: provision.workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' }
  await tasks.assignment(task.projectId, task.id, { version: 1, assignee: assignment }, false, context)
  const { session } = await tasks.createSession(task.projectId, task.id, { title: 'Member turn', requestId: 'member-session' }, context)
  const member = await seedLocalAccount(store, { username: 'member', email: 'member@wemux.test', password: 'member-pass-123' })
  // 与 server.ts:143 完全一致的生产装配：commandSigning 传入，不再依赖外部 authority resolver
  const identity = IdentityService.fromEnvironment(store, administratorDirectory(store))
  const lifecycle = new AccountLifecycleService(store, administratorDirectory(store), identity, new Notifications(), undefined, commandSigning)
  return {
    dir, database, store, commandSigning, signals, lifecycle, session, worker, member,
    async close() { database.close(); await rm(dir, { recursive: true, force: true }) },
  }
}

/** 直接落一条成员发起的在跑 Turn（会话属操作者，Turn 属成员）：revokeExecution 按执行归属扫描全部会话。 */
async function fabricateMemberTurn(store: SqliteServerStore, sessionId: SessionId, memberId: UserId, turnId: TurnId) {
  const event = (seq: number, payload: JournalEvent['payload']): JournalEvent => ({ sessionId, seq: seq as EventSeq, occurredAt: new Date().toISOString() as Timestamp, payload })
  await store.transaction(tx => tx.cache.applyEvents(sessionId, [
    event(1, { kind: 'message.queued', commandId: 'member-enqueue' as CommandId, messageId: 'member-message' as MessageId, content: 'member turn', position: 0, sentByAccountId: memberId }),
    event(2, { kind: 'turn.started', messageId: 'member-message' as MessageId, turnId }),
  ]))
}

test('account disable signs the revocation stop with the acting administrator and stays deliverable', async t => {
  const f = await fixture(); t.after(() => f.close())
  await fabricateMemberTurn(f.store, f.session.id, f.member.id, 'member-turn' as TurnId)
  await f.lifecycle.disable(instanceOperatorId, f.member.id)
  const commandId = `account-disable:${f.member.id}:${f.session.id}:member-turn` as CommandId
  const pending = await f.store.commands.getPendingCommand(commandId)
  assert.ok(pending, 'disable inserts the revocation stop')
  assert.equal(pending.command.kind, 'turn.stop')
  assert.deepEqual(pending.command, { kind: 'turn.stop', sessionId: f.session.id, turnId: 'member-turn' as TurnId })
  const claims = pending.authorization?.claims
  assert.ok(claims, 'revocation stop carries an assertion on signing assemblies')
  assert.equal(claims.version, 3)
  assert.equal(claims.kind, 'turn.stop')
  assert.equal(claims.actorId, instanceOperatorId)
  assert.equal(claims.workerId, f.worker.id)
  assert.equal(claims.sessionId, f.session.id)
  assert.equal(claims.commandDigest, digestOf(pending.command))
  assert.ok(f.commandSigning.verify(pending.authorization!), 'stop assertion verifies against the pinned key')
  // 签名实例的投递过滤不得拦截撤销停止帧（历史回归点）
  const strict = await new WorkerService(f.store, f.signals, { signingConfigured: true }).deliverable(f.worker.id)
  assert.ok(strict.some(frame => frame.type === 'command' && frame.commandId === commandId && frame.authorization), 'signed instance delivers the signed stop')
  // 兼容装配（无签名能力）下同一服务仍落未签名停止并照常投递
  const legacyStore = f.store
  const legacy = await new WorkerService(legacyStore, f.signals).deliverable(f.worker.id)
  assert.ok(legacy.some(frame => frame.type === 'command' && frame.commandId === commandId), 'legacy assembly still delivers the stop')
})

test('account deletion request signs its own revocation stop while the account is still active', async t => {
  const f = await fixture(); t.after(() => f.close())
  await fabricateMemberTurn(f.store, f.session.id, f.member.id, 'self-turn' as TurnId)
  const view = await f.lifecycle.requestDeletion(f.member.id)
  assert.equal(view.status, 'deletion_pending')
  const commandId = `account-delete:${f.member.id}:${f.session.id}:self-turn` as CommandId
  const pending = await f.store.commands.getPendingCommand(commandId)
  assert.ok(pending, 'deletion request inserts the revocation stop')
  const claims = pending.authorization?.claims
  assert.ok(claims, 'self-deletion stop carries an assertion issued by the account itself')
  assert.equal(claims.version, 3)
  assert.equal(claims.kind, 'turn.stop')
  assert.equal(claims.actorId, f.member.id, 'authority is the requesting account, captured before the status change commits')
  assert.ok(f.commandSigning.verify(pending.authorization!), 'self-deletion stop assertion verifies')
  const strict = await new WorkerService(f.store, f.signals, { signingConfigured: true }).deliverable(f.worker.id)
  assert.ok(strict.some(frame => frame.type === 'command' && frame.commandId === commandId), 'signed instance delivers the self-deletion stop')
})
