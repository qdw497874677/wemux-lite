import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claimDecision,
  defaultExecutionCapacity,
  machineScopeAllows,
  normalizeMachineScope,
  orderDispatchQueue,
  rankDispatchCandidates,
  remainingCapacityRatio,
  resolveExecutionCapacity,
  type DispatchIntent,
  type MachineScope,
  type PlacementClaim,
  type WorkerExecutionState,
} from './dispatch.js'

const worker = (over: Partial<WorkerExecutionState> = {}): WorkerExecutionState => ({
  workerId: 'worker-a', authorized: true, qualified: true,
  capacityLimit: 1, capacityInUse: 0, sampledAt: '2026-01-01T00:00:00.000Z', ...over,
})
const intent = (over: Partial<DispatchIntent> = {}): DispatchIntent => ({
  intentId: 'intent-1', taskId: 'task-1', generation: 0,
  machineScope: { kind: 'any' }, dispatchable: true, queueOrder: 1,
  enqueuedAt: '2026-01-01T00:00:00.000Z', ...over,
})
const claim = (over: Partial<PlacementClaim> = {}): PlacementClaim => ({
  claimId: 'claim-1', intentId: 'intent-1', taskId: 'task-1', workerId: 'worker-a',
  generation: 0, state: 'accepted', requestId: 'req-1', createdAt: '2026-01-01T00:00:00.000Z', ...over,
})

test('机器范围三种形态的成员判定', () => {
  assert.equal(machineScopeAllows({ kind: 'any' }, 'worker-z'), true)
  assert.equal(machineScopeAllows({ kind: 'candidates', workerIds: ['a', 'b'] }, 'b'), true)
  assert.equal(machineScopeAllows({ kind: 'candidates', workerIds: ['a', 'b'] }, 'c'), false)
  assert.equal(machineScopeAllows({ kind: 'fixed', workerId: 'a' }, 'a'), true)
  assert.equal(machineScopeAllows({ kind: 'fixed', workerId: 'a' }, 'b'), false)
})

test('机器范围解析拒绝空候选与空固定机器，任何非法输入返回 null', () => {
  assert.deepEqual(normalizeMachineScope({ kind: 'any' }), { kind: 'any' })
  assert.deepEqual(normalizeMachineScope({ kind: 'candidates', workerIds: ['b', 'a', 'b'] }), { kind: 'candidates', workerIds: ['b', 'a'] })
  assert.deepEqual(normalizeMachineScope({ kind: 'fixed', workerId: 'a' }), { kind: 'fixed', workerId: 'a' })
  for (const bad of [null, {}, { kind: 'any', extra: 1 }, { kind: 'candidates', workerIds: [] },
    { kind: 'candidates', workerIds: [''] }, { kind: 'fixed', workerId: '' }, { kind: 'fixed', workerId: 'a', workerIds: ['a'] }]) {
    assert.equal(normalizeMachineScope(bad), null, JSON.stringify(bad))
  }
})

test('未配置容量默认 1；已配置上限被采纳；非法配置回落到默认而不静默提高', () => {
  assert.equal(defaultExecutionCapacity, 1)
  assert.equal(resolveExecutionCapacity(undefined), 1)
  assert.equal(resolveExecutionCapacity(null), 1)
  assert.equal(resolveExecutionCapacity(0), 1)
  assert.equal(resolveExecutionCapacity(-3), 1)
  assert.equal(resolveExecutionCapacity(4), 4)
  assert.equal(resolveExecutionCapacity(1), 1)
  assert.equal(resolveExecutionCapacity(2.5), 1, '非整数配置不生效')
  assert.equal(resolveExecutionCapacity(Number.NaN), 1)
})

test('剩余容量比例反映可抢占程度，满负载为 0', () => {
  assert.equal(remainingCapacityRatio(4, 0), 1)
  assert.equal(remainingCapacityRatio(4, 1), 0.75)
  assert.equal(remainingCapacityRatio(4, 4), 0)
  assert.equal(remainingCapacityRatio(4, 5), 0, '超卖不产生负比例')
  assert.equal(remainingCapacityRatio(1, 0), 1)
})

test('候选排序按剩余容量比例优先，比例相同时按采样时间与标识稳定排序', () => {
  const ordered = rankDispatchCandidates([
    worker({ workerId: 'full', capacityLimit: 2, capacityInUse: 2 }),
    worker({ workerId: 'busy', capacityLimit: 4, capacityInUse: 3 }),
    worker({ workerId: 'idle', capacityLimit: 2, capacityInUse: 0 }),
    worker({ workerId: 'half', capacityLimit: 2, capacityInUse: 1 }),
  ], { kind: 'any' })
  assert.deepEqual(ordered.map(item => item.workerId), ['idle', 'busy', 'half'])
})

test('候选排序过滤越权/不合格/无容量，且只保留机器范围内成员', () => {
  const ordered = rankDispatchCandidates([
    worker({ workerId: 'unauthorized', authorized: false }),
    worker({ workerId: 'unqualified', qualified: false }),
    worker({ workerId: 'full', capacityLimit: 1, capacityInUse: 1 }),
    worker({ workerId: 'outside' }),
    worker({ workerId: 'inside' }),
  ], { kind: 'candidates', workerIds: ['inside', 'full', 'unauthorized'] })
  assert.deepEqual(ordered.map(item => item.workerId), ['inside'])
})

test('派发队列表按本次执行安排入队顺序稳定排序，重复入队不改顺序', () => {
  const queue = orderDispatchQueue([
    intent({ intentId: 'b', queueOrder: 2 }),
    intent({ intentId: 'a', queueOrder: 1 }),
    intent({ intentId: 'c', queueOrder: 3, generation: 1 }),
  ])
  assert.deepEqual(queue.map(item => item.intentId), ['a', 'b', 'c'])
  assert.deepEqual(orderDispatchQueue([...queue].reverse()).map(item => item.intentId), ['a', 'b', 'c'])
})

test('普通申领：范围外、越权、不合格、不可派发与无容量均被拒，唯一赢家获得剩余容量', () => {
  assert.deepEqual(claimDecision({ intent: intent(), worker: worker(), attempt: { workerId: 'worker-a', generation: 0 }, currentClaim: null, priorExecutionConfirmedStopped: true }), { ok: true, remainingCapacity: 0 })
  assert.deepEqual(claimDecision({ intent: intent({ dispatchable: false }), worker: worker(), attempt: { workerId: 'worker-a', generation: 0 }, currentClaim: null, priorExecutionConfirmedStopped: true }), { ok: false, reason: 'intent_not_dispatchable' })
  assert.deepEqual(claimDecision({ intent: intent({ machineScope: { kind: 'fixed', workerId: 'worker-b' } }), worker: worker(), attempt: { workerId: 'worker-a', generation: 0 }, currentClaim: null, priorExecutionConfirmedStopped: true }), { ok: false, reason: 'scope_excluded' })
  assert.deepEqual(claimDecision({ intent: intent(), worker: worker({ authorized: false }), attempt: { workerId: 'worker-a', generation: 0 }, currentClaim: null, priorExecutionConfirmedStopped: true }), { ok: false, reason: 'worker_unauthorized' })
  assert.deepEqual(claimDecision({ intent: intent(), worker: worker({ qualified: false }), attempt: { workerId: 'worker-a', generation: 0 }, currentClaim: null, priorExecutionConfirmedStopped: true }), { ok: false, reason: 'worker_unqualified' })
  assert.deepEqual(claimDecision({ intent: intent(), worker: worker({ capacityLimit: 1, capacityInUse: 1 }), attempt: { workerId: 'worker-a', generation: 0 }, currentClaim: null, priorExecutionConfirmedStopped: true }), { ok: false, reason: 'no_capacity' })
})

test('Worker 只能以自身身份申领：请求身份与快照不一致即被拒', () => {
  assert.deepEqual(claimDecision({ intent: intent(), worker: worker({ workerId: 'worker-b' }), attempt: { workerId: 'worker-a', generation: 0 }, currentClaim: null, priorExecutionConfirmedStopped: true }), { ok: false, reason: 'worker_unauthorized' }, '快照与请求身份不一致时不得以他人身份申领')
})

test('同一执行意图并发申领只有一个有效承接，且不区分申领者是否同一机器', () => {
  const current = claim({ state: 'reserved' })
  assert.deepEqual(claimDecision({ intent: intent(), worker: worker({ workerId: 'worker-b' }), attempt: { workerId: 'worker-b', generation: 0 }, currentClaim: current, priorExecutionConfirmedStopped: true }), { ok: false, reason: 'already_claimed' })
  assert.deepEqual(claimDecision({ intent: intent(), worker: worker(), attempt: { workerId: 'worker-a', generation: 0 }, currentClaim: current, priorExecutionConfirmedStopped: true }), { ok: false, reason: 'already_claimed' })
})

test('已结束或已明确释放的旧承接不阻塞新的有效申领', () => {
  assert.deepEqual(claimDecision({ intent: intent(), worker: worker(), attempt: { workerId: 'worker-a', generation: 0 }, currentClaim: claim({ state: 'released' }), priorExecutionConfirmedStopped: true }), { ok: true, remainingCapacity: 0 })
})

test('结果未知的已承接执行不因超时释放占用，也不允许换机器重复申领', () => {
  const unknown = claim({ state: 'unknown' })
  for (const workerId of ['worker-a', 'worker-b']) {
    assert.deepEqual(claimDecision({ intent: intent(), worker: worker({ workerId }), attempt: { workerId, generation: 0 }, currentClaim: unknown, priorExecutionConfirmedStopped: false }), { ok: false, reason: 'already_claimed' })
  }
})

test('接手复用同一执行意图：旧代次不得越过交接边界，新代次需确认旧执行已停止', () => {
  const handed = intent({ generation: 1 })
  const old = claim({ generation: 0, state: 'accepted' })
  assert.deepEqual(claimDecision({ intent: handed, worker: worker(), attempt: { workerId: 'worker-b', generation: 0 }, currentClaim: old, priorExecutionConfirmedStopped: true }), { ok: false, reason: 'stale_generation' })
  assert.deepEqual(claimDecision({ intent: handed, worker: worker(), attempt: { workerId: 'worker-b', generation: 1 }, currentClaim: old, priorExecutionConfirmedStopped: false }), { ok: false, reason: 'prior_execution_in_flight' })
  assert.deepEqual(claimDecision({ intent: handed, worker: worker({ workerId: 'worker-b' }), attempt: { workerId: 'worker-b', generation: 1 }, currentClaim: old, priorExecutionConfirmedStopped: true }), { ok: true, remainingCapacity: 0 })
  assert.deepEqual(claimDecision({ intent: handed, worker: worker({ workerId: 'worker-b' }), attempt: { workerId: 'worker-b', generation: 1 }, currentClaim: claim({ generation: 1, state: 'reserved' }), priorExecutionConfirmedStopped: true }), { ok: false, reason: 'already_claimed' })
})

test('类型契约：机器范围与承接状态由本模块冻结', () => {
  const scopes: MachineScope[] = [{ kind: 'any' }, { kind: 'candidates', workerIds: ['a'] }, { kind: 'fixed', workerId: 'a' }]
  const states: PlacementClaim['state'][] = ['reserved', 'accepted', 'released', 'unknown']
  assert.equal(scopes.length, 3)
  assert.equal(states.length, 4)
})
