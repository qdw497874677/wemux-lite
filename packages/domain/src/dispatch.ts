/**
 * 派发与申领的纯领域合同：机器范围、容量准入与「一次执行意图只有一个有效承接」。
 *
 * 这里只做不依赖存储与网络的判定，Server 的 SQLite 事务、可靠投递和 Worker 启动前
 * 准入都复用这些函数，避免第二套语义。合同属于 @wemux/domain 叶子包，供后续票据
 * （团队容量、看板、接手）与计划交接共同复用。
 *
 * 术语按 CONTEXT.md：Agent Assignment 是可变的执行意图，Agent Run 是一次执行尝试，
 * 机器范围描述某次执行意图允许落在哪些 Worker 上。
 */

/** 未配置并发上限时的默认执行容量；机器管理者可配置，首次接入不要求先填。 */
export const defaultExecutionCapacity = 1

/**
 * 机器范围：`any` 表示所有获权且符合条件的 Worker；`candidates` 是候选集合；
 * `fixed` 固定单台。任何形态都不能绕过资源权限、环境或容量准入。
 */
export type MachineScope =
  | { readonly kind: 'any' }
  | { readonly kind: 'candidates'; readonly workerIds: readonly string[] }
  | { readonly kind: 'fixed'; readonly workerId: string }

/** 规范化并去重候选；空候选、空标识、未知字段一律返回 null，不做静默降级。 */
export function normalizeMachineScope(input: unknown): MachineScope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const kind = value.kind
  if (kind === 'any') return Object.keys(value).length === 1 ? { kind: 'any' } : null
  if (kind === 'fixed') {
    if (Object.keys(value).length !== 2) return null
    const workerId = value.workerId
    return typeof workerId === 'string' && workerId.trim().length > 0 ? { kind: 'fixed', workerId } : null
  }
  if (kind === 'candidates') {
    if (Object.keys(value).length !== 2 || !Array.isArray(value.workerIds) || value.workerIds.length === 0) return null
    const ids: string[] = []
    for (const entry of value.workerIds) {
      if (typeof entry !== 'string' || entry.trim().length === 0) return null
      if (!ids.includes(entry)) ids.push(entry)
    }
    return { kind: 'candidates', workerIds: ids }
  }
  return null
}

/** 机器范围是否允许某台 Worker 承接该执行意图。 */
export function machineScopeAllows(scope: MachineScope, workerId: string): boolean {
  switch (scope.kind) {
    case 'any': return true
    case 'candidates': return scope.workerIds.includes(workerId)
    case 'fixed': return scope.workerId === workerId
  }
}

/**
 * 容量上限解析：未配置（undefined/null/0/负数/非整数）回落到默认 1，
 * 不因非法配置静默提高上限，也不把 CPU/内存指标当成容量。
 */
export function resolveExecutionCapacity(configured: number | null | undefined): number {
  return typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0 ? configured : defaultExecutionCapacity
}

/** Worker 带采样时间的执行状态快照；`qualified` 包含 Runtime/模型/Placement 就绪判定。 */
export interface WorkerExecutionState {
  readonly workerId: string
  readonly authorized: boolean
  readonly qualified: boolean
  readonly capacityLimit: number
  readonly capacityInUse: number
  readonly sampledAt: string
}

/** 剩余容量比例（0..1）；满负载或超卖为 0，CPU/内存不参与。 */
export function remainingCapacityRatio(limit: number, inUse: number): number {
  if (!Number.isFinite(limit) || !Number.isFinite(inUse) || limit <= 0) return 0
  return Math.max(0, Math.min(1, (limit - inUse) / limit))
}

/** 是否有空闲执行槽位；陈旧心跳不得凭过期数据超卖。 */
export function hasExecutionCapacity(state: Pick<WorkerExecutionState, 'capacityLimit' | 'capacityInUse'>): boolean {
  return state.capacityLimit - state.capacityInUse >= 1
}

/**
 * 一个持久执行意图：普通派发在任务进入 todo 时安排入队，显式接手在明确安排时入队；
 * `generation` 是接替代次，首次派发为 0，接手者每换一代加一。`queueOrder` 是本次
 * 安排的稳定入队序号，重放与重启不重排。
 */
export interface DispatchIntent {
  readonly intentId: string
  readonly taskId: string
  readonly generation: number
  readonly machineScope: MachineScope
  /** 任务是否符合当前工作流状态（普通派发要求 todo，接手允许 in_progress）。 */
  readonly dispatchable: boolean
  readonly queueOrder: number
  readonly enqueuedAt: string
}

/** 持久承接记录：`unknown` 表示已接受但结果未知，保留记录并先对账，不凭超时释放。 */
export interface PlacementClaim {
  readonly claimId: string
  readonly intentId: string
  readonly taskId: string
  readonly workerId: string
  readonly generation: number
  readonly state: 'reserved' | 'accepted' | 'released' | 'unknown'
  readonly requestId: string
  readonly createdAt: string
}

export type ClaimRejectionReason =
  | 'intent_not_dispatchable'
  | 'scope_excluded'
  | 'worker_unauthorized'
  | 'worker_unqualified'
  | 'stale_generation'
  | 'prior_execution_in_flight'
  | 'already_claimed'
  | 'no_capacity'

export type ClaimDecision =
  | { readonly ok: true; readonly remainingCapacity: number }
  | { readonly ok: false; readonly reason: ClaimRejectionReason }

export interface ClaimAttempt {
  readonly workerId: string
  readonly generation: number
}

export interface ClaimInput {
  readonly intent: DispatchIntent
  readonly worker: WorkerExecutionState
  readonly attempt: ClaimAttempt
  readonly currentClaim: PlacementClaim | null
  /** 接手（或未知执行）场景下是否已确认旧执行停止或完成安全对账。 */
  readonly priorExecutionConfirmedStopped: boolean
}

/**
 * 申领判定顺序冻结为：可派发、机器范围、申领者身份与授权、环境合格、代次、
 * 旧执行确认、既有承接、容量。任一步不满足都不产生承接。
 */
export function claimDecision(input: ClaimInput): ClaimDecision {
  const { intent, worker, attempt, currentClaim } = input
  if (!intent.dispatchable) return { ok: false, reason: 'intent_not_dispatchable' }
  if (!machineScopeAllows(intent.machineScope, attempt.workerId)) return { ok: false, reason: 'scope_excluded' }
  // Worker 只能以自身身份申领：Server 用连接身份构造 request，快照与请求不一致即拒绝。
  if (attempt.workerId !== worker.workerId || !worker.authorized) return { ok: false, reason: 'worker_unauthorized' }
  if (!worker.qualified) return { ok: false, reason: 'worker_unqualified' }
  if (attempt.generation < intent.generation) return { ok: false, reason: 'stale_generation' }
  if (intent.generation > 0 && !input.priorExecutionConfirmedStopped) return { ok: false, reason: 'prior_execution_in_flight' }
  if (currentClaim && currentClaim.state !== 'released' && currentClaim.generation >= attempt.generation) return { ok: false, reason: 'already_claimed' }
  const remaining = worker.capacityLimit - worker.capacityInUse
  if (remaining < 1) return { ok: false, reason: 'no_capacity' }
  return { ok: true, remainingCapacity: remaining - 1 }
}

/**
 * 候选排序：过滤不可承接的 Worker，再按剩余容量比例优先，比例相同时按更早采样
 * 时间、最后按标识稳定排序。固定机器忙碌时不暗中换机由调用方保持固定范围保证。
 */
export function rankDispatchCandidates(workers: readonly WorkerExecutionState[], scope: MachineScope): readonly WorkerExecutionState[] {
  return workers
    .filter(worker => worker.authorized && worker.qualified && hasExecutionCapacity(worker) && machineScopeAllows(scope, worker.workerId))
    .slice()
    .sort((left, right) => remainingCapacityRatio(right.capacityLimit, right.capacityInUse) - remainingCapacityRatio(left.capacityLimit, left.capacityInUse)
      || left.sampledAt.localeCompare(right.sampledAt)
      || left.workerId.localeCompare(right.workerId))
}

/** 符合条件的工作按本次执行安排的入队时间排序：先入队先安排，不套用旧 todo 时间、无特殊优先级。 */
export function orderDispatchQueue(intents: readonly DispatchIntent[]): readonly DispatchIntent[] {
  return intents.slice().sort((left, right) => left.queueOrder - right.queueOrder || left.intentId.localeCompare(right.intentId))
}
