import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentKey, ModelId, WorkerId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.js'
import { ServerService } from '../application/server-service.js'
import { TaskService, TaskError } from '../application/task-service.js'
import { Notifications } from '../application/notifications.js'
import { instanceOperatorId, seedOperator } from './fixtures/administrator.js'

/**
 * 派发票据 01 的应用层合同：机器范围、执行意图、申领与容量准入。
 * 这里只用真实 SQLite 与真实事务路径，不用替身，避免「单测绿、竞态崩」。
 */

const context = { actor: instanceOperatorId, teamId: 'default-team', requestId: 'dispatch-service' }
const capabilities = (available: boolean) => [{
  agentKey: 'pi' as AgentKey, displayName: 'Pi', version: null, mode: 'execution' as const,
  availability: available ? { status: 'available' as const } : { status: 'unavailable' as const, reason: '未认证' },
  models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' as const }],
}]

async function fixture() {
  const dir = await mkdtemp(join('/var/tmp', 'wemux-p01-dispatch-service-'))
  const path = join(dir, 'server.db')
  const database = new SharedSqliteDatabase(path)
  const store = new SqliteServerStore(database)
  const signals = new Notifications()
  const server = new ServerService(store, signals)
  await seedOperator(store, server)
  const tasks = new TaskService(store, event => signals.project(event), server)
  const enroll = async (name: string, options: { limit?: number; available?: boolean } = {}) => {
    const { worker } = await server.enroll({ token: (await server.createEnrollment({})).token, name })
    await store.transaction(tx => tx.resources.saveWorker({
      ...worker, connectionState: 'online',
      ...(options.limit === undefined ? {} : { executionCapacityLimit: options.limit }),
      capabilities: capabilities(options.available ?? true),
    }))
    return worker.id as string
  }
  const failure = async (work: Promise<unknown>) => {
    try { await work; throw new Error('expected rejection') }
    catch (error) { assert.ok(error instanceof TaskError, `expected TaskError, got ${String(error)}`); return error as TaskError }
  }
  return {
    dir, path, database, store, server, tasks, enroll, failure,
    async close() { database.close(); await rm(dir, { recursive: true, force: true }) },
  }
}

test('backlog 不派发；进入 todo 自动建立执行意图且重复状态事件不复制', async () => {
  const f = await fixture()
  try {
    const created = await f.tasks.create('default-project', { title: '派发' }, context)
    assert.equal(created.status, 'backlog')
    const initial = await f.tasks.dispatch(created.projectId, created.id, context)
    assert.equal(initial.intent, null, 'backlog 不建立执行意图，也没有额外入队操作')
    assert.deepEqual(initial.machineScope, { kind: 'any' })

    const todo = await f.tasks.patch(created.projectId, created.id, { status: 'todo', version: created.version }, context)
    const queued = await f.tasks.dispatch(created.projectId, created.id, context)
    assert.equal(queued.intent?.kind, 'dispatch')
    assert.equal(queued.intent?.generation, 0)
    assert.equal(queued.intent?.queueOrder, 1)
    assert.equal(queued.claim, null)
    assert.equal(queued.waitingReason, 'no_candidate', '没有机器承接时按原因等待，不是错误')

    const edited = await f.tasks.patch(created.projectId, created.id, { description: '改动' }, context)
    const afterEdit = await f.tasks.dispatch(created.projectId, created.id, context)
    assert.equal(afterEdit.intent?.intentId, queued.intent?.intentId, '内容改动不重排也不复制意图')

    // blocked 只暂停派发：意图保留，等待原因变成不可派发，而不是撤销排队。
    const blocked = await f.tasks.patch(created.projectId, created.id, { status: 'blocked', version: edited.version }, context)
    const paused = await f.tasks.dispatch(created.projectId, created.id, context)
    assert.equal(paused.intent?.intentId, queued.intent?.intentId)
    assert.equal(paused.waitingReason, 'intent_not_dispatchable')
    assert.equal((await f.store.tasks.dispatchIntent(queued.intent!.intentId))?.state, 'pending')

    const restored = await f.tasks.patch(created.projectId, created.id, { status: 'todo', version: blocked.version }, context)
    const reentry = await f.tasks.dispatch(created.projectId, created.id, context)
    assert.equal(reentry.intent?.intentId, queued.intent?.intentId, '重入 todo 复用同一次在途安排，不复制执行')
    assert.equal(reentry.intent?.queueOrder, 1, '重复状态事件不重排')

    const parked = await f.tasks.patch(created.projectId, created.id, { status: 'blocked', version: restored.version }, context)
    await f.tasks.patch(created.projectId, created.id, { status: 'cancelled', version: parked.version }, context)
    assert.equal((await f.store.tasks.dispatchIntent(queued.intent!.intentId))?.state, 'cancelled', '终态撤销未被承接的意图')

    // 另一次安排拿到新的入队序号，不套用旧意图的排队位置。
    const other = await f.tasks.create('default-project', { title: '后来者' }, context)
    await f.tasks.patch(other.projectId, other.id, { status: 'todo', version: other.version }, context)
    const later = await f.tasks.dispatch(other.projectId, other.id, context)
    assert.equal(later.intent?.queueOrder, 2)
    assert.equal(later.intent?.generation, 0)
  } finally { await f.close() }
})

test('机器范围：任意/候选/固定三形态生效，越权与非法范围被拒', async () => {
  const f = await fixture()
  try {
    const first = await f.enroll('W1')
    const second = await f.enroll('W2')
    const created = await f.tasks.create('default-project', { title: '范围' }, context)
    const any = await f.tasks.setMachineScope(created.projectId, created.id, { requestId: 'scope-any', version: 1, scope: { kind: 'any' } }, context)
    assert.deepEqual(any.machineScope, { kind: 'any' })

    const candidates = await f.tasks.setMachineScope(created.projectId, created.id, { requestId: 'scope-candidates', version: any.version, scope: { kind: 'candidates', workerIds: [first, second, first] } }, context)
    assert.deepEqual(candidates.machineScope, { kind: 'candidates', workerIds: [first, second] }, '候选去重且保序')

    const fixed = await f.tasks.setMachineScope(created.projectId, created.id, { requestId: 'scope-fixed', version: candidates.version, scope: { kind: 'fixed', workerId: second } }, context)
    assert.deepEqual(fixed.machineScope, { kind: 'fixed', workerId: second })

    assert.equal((await f.failure(f.tasks.setMachineScope(created.projectId, created.id, { requestId: 'scope-bad', version: fixed.version, scope: { kind: 'bogus' } }, context))).code, 'machine_scope_invalid')
    assert.equal((await f.failure(f.tasks.setMachineScope(created.projectId, created.id, { requestId: 'scope-empty', version: fixed.version, scope: { kind: 'candidates', workerIds: [] } }, context))).code, 'machine_scope_invalid')
    const stranger = await f.failure(f.tasks.setMachineScope(created.projectId, created.id, { requestId: 'scope-stranger', version: fixed.version, scope: { kind: 'fixed', workerId: 'unknown-worker' } }, context))
    assert.ok(['machine_scope_unauthorized', 'not_found'].includes(stranger.code), `越权范围必须被拒，实际 ${stranger.code}`)
    const stale = await f.failure(f.tasks.setMachineScope(created.projectId, created.id, { requestId: 'scope-stale', version: 1, scope: { kind: 'any' } }, context))
    assert.equal(stale.code, 'version_conflict')
  } finally { await f.close() }
})

test('申领：范围、资格、身份与容量都在服务端裁决；释放后按等待原因重新匹配', async () => {
  const f = await fixture()
  try {
    const allowed = await f.enroll('W1')
    const excluded = await f.enroll('W2')
    const unqualified = await f.enroll('W3', { available: false })
    const outsider = await f.enroll('W4')
    const created = await f.tasks.create('default-project', { title: '申领' }, context)
    const scoped = await f.tasks.setMachineScope(created.projectId, created.id, { requestId: 'scope', version: created.version, scope: { kind: 'candidates', workerIds: [allowed, excluded] } }, context)
    const todo = await f.tasks.patch(created.projectId, created.id, { status: 'todo', version: scoped.version }, context)
    const queued = await f.tasks.dispatch(created.projectId, created.id, context)
    const intentId = queued.intent!.intentId

    const excludedAttempt = await f.failure(f.tasks.claimDispatch(outsider, { requestId: 'claim-excluded', intentId, generation: 0 }))
    assert.equal(excludedAttempt.code, 'worker_not_a_candidate')

    let state = await f.store.tasks.dispatchIntent(intentId)
    assert.equal(state?.state, 'pending', '被拒的申领不改变意图')

    const claimed = await f.tasks.claimDispatch(allowed, { requestId: 'claim-1', intentId, generation: 0 })
    assert.equal(claimed.changed, true)
    assert.equal(claimed.claim.state, 'reserved')
    assert.equal(claimed.claim.workerId, allowed)
    assert.equal((await f.store.tasks.dispatchIntent(intentId))?.state, 'claimed')

    const replay = await f.tasks.claimDispatch(allowed, { requestId: 'claim-1', intentId, generation: 0 })
    assert.equal(replay.changed, false)
    assert.equal(replay.claim.claimId, claimed.claim.claimId, '同 requestId 幂等重放同一条承接')
    const conflict = await f.failure(f.tasks.claimDispatch(excluded, { requestId: 'claim-1', intentId, generation: 0 }))
    assert.ok(['request_id_conflict', 'worker_identity_mismatch', 'worker_not_a_candidate'].includes(conflict.code))

    const duplicated = await f.failure(f.tasks.claimDispatch(allowed, { requestId: 'claim-2', intentId, generation: 0 }))
    assert.equal(duplicated.code, 'claim_already_held', '同一执行意图只能有一个有效承接')

    const identity = await f.failure(f.tasks.claimDispatch(allowed, { requestId: 'claim-3', intentId, generation: 0, workerId: excluded }))
    assert.equal(identity.code, 'worker_identity_mismatch', 'Worker 只能以自身身份申领')

    const foreignRelease = await f.failure(f.tasks.releaseDispatch(excluded, { requestId: 'release-x', claimId: claimed.claim.claimId, reason: 'declined' }))
    assert.equal(foreignRelease.code, 'worker_identity_mismatch', '只有承接方本人能释放')

    await f.tasks.releaseDispatch(allowed, { requestId: 'release-1', claimId: claimed.claim.claimId, reason: 'declined' })
    assert.equal((await f.store.tasks.dispatchIntent(intentId))?.state, 'pending', '启动前释放退回待安排')
    const reclaimed = await f.tasks.claimDispatch(excluded, { requestId: 'claim-4', intentId, generation: 0 })
    assert.equal(reclaimed.changed, true)
    assert.equal((await f.store.tasks.dispatchClaim(claimed.claim.claimId))?.state, 'released', '释放记录保留')

    // 结果未知继续占位：不凭超时释放，也不允许第二个承接。
    await f.store.transaction(tx => tx.tasks.saveDispatchClaim({ ...reclaimed.claim, state: 'unknown' }))
    const blocked = await f.failure(f.tasks.claimDispatch(allowed, { requestId: 'claim-5', intentId, generation: 0 }))
    assert.equal(blocked.code, 'claim_already_held')
    assert.equal(blocked.details?.reason, 'already_claimed')

    // 容量：默认 1 个执行槽位，被占用后其他意图无法落到同一台机器。
    const second = await f.tasks.create('default-project', { title: '第二个' }, context)
    await f.tasks.patch(second.projectId, second.id, { status: 'todo', version: second.version }, context)
    const secondIntent = await f.tasks.dispatch(second.projectId, second.id, context)
    const noCapacity = await f.failure(f.tasks.claimDispatch(excluded, { requestId: 'claim-6', intentId: secondIntent.intent!.intentId, generation: 0 }))
    assert.equal(noCapacity.code, 'insufficient_capacity')
    assert.equal(noCapacity.details?.reason, 'no_capacity')

    // 资格：未认证/不可用的 Agent 不能凭旧结论启动。
    const third = await f.tasks.create('default-project', { title: '第三个' }, context)
    await f.tasks.patch(third.projectId, third.id, { status: 'todo', version: third.version }, context)
    const thirdIntent = await f.tasks.dispatch(third.projectId, third.id, context)
    const unqualifiedAttempt = await f.failure(f.tasks.claimDispatch(unqualified, { requestId: 'claim-7', intentId: thirdIntent.intent!.intentId, generation: 0 }))
    assert.equal(unqualifiedAttempt.code, 'runtime_unavailable')
    assert.ok(todo.version >= 2)
  } finally { await f.close() }
})

test('接手：绑定被接替的执行身份与代次，旧执行未对账前不得越过交接边界', async () => {
  const f = await fixture()
  try {
    const holder = await f.enroll('H1')
    const challenger = await f.enroll('H2')
    const created = await f.tasks.create('default-project', { title: '接手' }, context)
    const todo = await f.tasks.patch(created.projectId, created.id, { status: 'todo', version: created.version }, context)
    const first = await f.tasks.dispatch(created.projectId, created.id, context)
    const firstClaim = await f.tasks.claimDispatch(holder, { requestId: 'claim-first', intentId: first.intent!.intentId, generation: 0 })
    await f.tasks.releaseDispatch(holder, { requestId: 'start-first', claimId: firstClaim.claim.claimId, reason: 'started' })

    const running = await f.tasks.patch(created.projectId, created.id, { status: 'in_progress', version: todo.version }, context)
    const arranged = await f.tasks.openHandoff(created.projectId, created.id, { requestId: 'handoff-1', version: running.version, machineScope: { kind: 'any' } }, context)
    assert.equal(arranged.generation, 1)

    const view = await f.tasks.dispatch(created.projectId, created.id, context)
    assert.equal(view.intent?.kind, 'handoff')
    assert.equal(view.intent?.supersedes?.claimId, firstClaim.claim.claimId, '接手绑定被接替的执行身份')
    assert.equal(view.intent?.supersedes?.generation, 0)

    const tooEarly = await f.failure(f.tasks.claimDispatch(challenger, { requestId: 'handoff-claim-early', intentId: arranged.intentId, generation: 1 }))
    assert.equal(tooEarly.code, 'prior_execution_in_flight', '旧执行未确认停止时不启动新执行')
    assert.equal(tooEarly.details?.reason, 'prior_execution_in_flight')

    const stale = await f.failure(f.tasks.claimDispatch(challenger, { requestId: 'handoff-claim-stale', intentId: arranged.intentId, generation: 0 }))
    assert.equal(stale.code, 'claim_stale_generation', '旧代次不得越过交接边界复活')

    await f.tasks.releaseDispatch(holder, { requestId: 'reconcile', claimId: firstClaim.claim.claimId, reason: 'reconciled_stopped' })
    const winners = await Promise.allSettled([
      f.tasks.claimDispatch(holder, { requestId: 'handoff-claim-a', intentId: arranged.intentId, generation: 1 }),
      f.tasks.claimDispatch(challenger, { requestId: 'handoff-claim-b', intentId: arranged.intentId, generation: 1 }),
    ])
    assert.equal(winners.filter(entry => entry.status === 'fulfilled').length, 1, '不同 requestId 同时接替只能一个成功')
    const active = await f.store.tasks.activeDispatchClaim(arranged.intentId)
    assert.equal(active?.generation, 1)
    assert.equal((await f.store.tasks.dispatchClaim(firstClaim.claim.claimId))?.state, 'released')
  } finally { await f.close() }
})

test('多连接并发申领同一执行意图只产生一个有效承接', async () => {
  const f = await fixture()
  try {
    const worker = await f.enroll('C1')
    const created = await f.tasks.create('default-project', { title: '并发' }, context)
    await f.tasks.patch(created.projectId, created.id, { status: 'todo', version: created.version }, context)
    const queued = await f.tasks.dispatch(created.projectId, created.id, context)

    // 第二个连接：同进程但独立 SqliteServerStore，走真实的 BEGIN IMMEDIATE 抢锁路径。
    const competing = new SqliteServerStore(new SharedSqliteDatabase(f.path))
    const competingTasks = new TaskService(competing, () => {})
    const attempts = await Promise.allSettled([
      f.tasks.claimDispatch(worker, { requestId: 'concurrent-a', intentId: queued.intent!.intentId, generation: 0 }),
      competingTasks.claimDispatch(worker, { requestId: 'concurrent-b', intentId: queued.intent!.intentId, generation: 0 }),
    ])
    assert.equal(attempts.filter(entry => entry.status === 'fulfilled').length, 1, '并发申领只能有一个有效承接')
    const claims = await f.store.transaction(tx => tx.tasks.dispatchClaimsByWorker(worker))
    assert.equal(claims.filter(claim => claim.state !== 'released').length, 1)
    competing.close()
  } finally { await f.close() }
})
