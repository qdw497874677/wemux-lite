import { machineScopeAllows, resolveExecutionCapacity, type WorkerExecutionState } from '@wemux/domain'
import type { ServerStoreTx } from './ports/server-store.ts'
import type { DispatchIntentRecord } from './ports/server-store-types.ts'

/**
 * 把持久事实翻译成领域判定所需的 Worker 执行状态。容量只统计「仍占用执行意图」的承接
 * （reserved/accepted/unknown）；`unknown` 因为结果未知而继续占位，不能凭超时释放。
 * 本文件是 Server 侧对 @wemux/domain/dispatch 的唯一适配层，避免出现第二套准入语义。
 */

/** 承接状态中占用执行槽位的集合。 */
const holdingStates = ['reserved', 'accepted', 'unknown'] as const

/** 该 Worker 当前占用的执行槽位数；`exclude` 用于排除正在评估的这一次承接。 */
export async function workerCapacityInUse(tx: ServerStoreTx, workerId: string, excludeClaimId?: string): Promise<number> {
  const claims = await tx.tasks.dispatchClaimsByWorker(workerId)
  return claims.filter(claim => (holdingStates as readonly string[]).includes(claim.state) && claim.claimId !== excludeClaimId).length
}

/**
 * Worker 的执行状态：`authorized` 覆盖存在、同队、未撤销；`qualified` 覆盖执行模式 Agent
 * 与（可选）指定模型可用。陈旧心跳不参与准入，只在选机排序时作为次级依据。
 */
export async function workerExecutionState(tx: ServerStoreTx, workerId: string, execution: DispatchIntentRecord['execution']): Promise<WorkerExecutionState> {
  const worker = await tx.resources.getWorker(workerId as never)
  const capabilities = worker?.capabilities ?? []
  const executionAgents = capabilities.filter(capability => capability.mode === 'execution')
  const matching = execution.agentKey ? executionAgents.filter(capability => capability.agentKey === execution.agentKey) : executionAgents
  const qualified = matching.some(capability => capability.availability.status === 'available'
    && (!execution.modelId || capability.models.some(model => model.modelId === execution.modelId)))
  return {
    workerId,
    authorized: Boolean(worker) && worker!.connectionState !== 'revoked',
    qualified,
    capacityLimit: resolveExecutionCapacity(worker?.executionCapacityLimit),
    capacityInUse: await workerCapacityInUse(tx, workerId),
    sampledAt: worker?.lastSeenAt ?? '',
  }
}

/**
 * 执行意图的派发可消费性：普通派发在 todo 上成立，显式接手在 in_progress 上成立。
 * 旧执行是否已停止是另一条独立判定（prior_execution_in_flight），不在这里把原因混成一个。
 */
export function intentDispatchable(intent: DispatchIntentRecord, taskStatus: string): boolean {
  if (intent.state === 'cancelled') return false
  return intent.kind === 'handoff' ? taskStatus === 'in_progress' : taskStatus === 'todo'
}
/** 本意图是否接替一次已有执行：只有接手要等旧执行的对账结论。 */
export function supersedesPriorExecution(intent: DispatchIntentRecord): boolean {
  return intent.kind === 'handoff' && Boolean(intent.supersedes?.claimId)
}

/** 机器范围是否仍然允许该 Worker；排队期间改范围后启动前必须重跑，不得沿用旧结论。 */
export function scopeStillAllows(intent: DispatchIntentRecord, workerId: string): boolean {
  return machineScopeAllows(intent.machineScope, workerId)
}
