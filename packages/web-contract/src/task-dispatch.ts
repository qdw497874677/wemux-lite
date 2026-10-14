/**
 * 派发线协议：机器范围、执行意图、承接状态与申领/撤回请求的稳定外形。
 *
 * 这些 DTO 是内置看板 Adapter 与后续派发 02（共享容量策略与团队看板）共用的
 * 合同，不含存储或传输实现细节。判定语义在 @wemux/domain 的 dispatch 模块冻结，
 * 此处只负责跨进程/跨宿主传递。
 */
import type { MachineScope } from '@wemux/domain'

export type { MachineScope, PlacementClaim } from '@wemux/domain'

/** 承接状态：reserved 已预约未确认、accepted 已确认、unknown 已接受但结果未知、released 已释放。 */
export type DispatchClaimState = 'reserved' | 'accepted' | 'unknown' | 'released'

/** 承接状态对界面/上游可见的「是否仍占用该执行意图」。 */
export const holdingClaimStates = ['reserved', 'accepted', 'unknown'] as const satisfies readonly DispatchClaimState[]

export function claimHoldsIntent(state: DispatchClaimState): boolean {
  return (holdingClaimStates as readonly DispatchClaimState[]).includes(state)
}

/**
 * 等待/不可用原因：由领域判定产生并原样投给看板，界面不自行推导。
 * 与 `ClaimRejectionReason` 同名同义，另加普通派发层面的 `no_candidate`。
 */
export type DispatchWaitingReason =
  | 'intent_not_dispatchable'
  | 'scope_excluded'
  | 'worker_unauthorized'
  | 'worker_unqualified'
  | 'stale_generation'
  | 'prior_execution_in_flight'
  | 'already_claimed'
  | 'no_capacity'
  | 'no_candidate'

/** 执行意图的工作流消费语义：普通派发消费 todo，显式接手消费 in_progress。 */
export type DispatchKind = 'dispatch' | 'handoff'

export interface DispatchIntentView {
  readonly intentId: string
  readonly taskId: string
  readonly kind: DispatchKind
  /** 接替代次：首次派发 0，接手每换一代加一。 */
  readonly generation: number
  readonly machineScope: MachineScope
  /**
   * 机器范围决定落在哪台 Worker，运行身份与模型仍要显式：两项都可缺省，缺省时由
   * 申领 Worker 自身可用的执行 Agent 解析，绝不由范围隐式挑 Agent/模型。
   */
  readonly execution: { readonly agentKey?: string; readonly modelId?: string }
  /** 本次执行安排的持久入队序号；重放与重启不重排。 */
  readonly queueOrder: number
  readonly enqueuedAt: string
  /** 被接替的执行（显式接手时存在）。 */
  readonly supersedes?: { readonly claimId: string; readonly workerId: string; readonly generation: number; readonly runId: string | null }
}

/** 释放原因：只有 `reconciled_stopped` 是「已确认旧执行停止」的对账结论。 */
export type DispatchClaimReleaseReason = 'started' | 'declined' | 'failed_before_start' | 'reconciled_stopped'
export interface DispatchClaimView {
  readonly claimId: string
  readonly intentId: string
  readonly taskId: string
  readonly workerId: string
  readonly generation: number
  readonly state: DispatchClaimState
  readonly requestId: string
  readonly createdAt: string
  /** 已释放承接的释放原因；进行中的承接没有这一项。 */
  readonly releasedReason?: DispatchClaimReleaseReason
}

/** 看板/任务详情用的派发视图：有意保留 queueOrder 以便解释「谁先安排」。 */
export interface TaskDispatchView {
  readonly taskId: string
  readonly version: number
  readonly machineScope: MachineScope
  readonly intent: DispatchIntentView | null
  readonly claim: DispatchClaimView | null
  /** 无有效承接且不可立即派发时的原因；有承接时为 null。 */
  readonly waitingReason: DispatchWaitingReason | null
}

export interface SetMachineScopeRequest {
  readonly requestId: string
  readonly version: number
  readonly scope: MachineScope
}

export interface DispatchRequest {
  readonly requestId: string
  readonly version: number
  /** 显式指定承接 Worker；缺省时按候选范围申领，范围 `any` 亦然。 */
  readonly workerId?: string
}

export interface ClaimDispatchRequest {
  readonly requestId: string
  /** 申领者必须与连接身份一致；Server 用连接身份校验，不接受客户端自称。 */
  readonly workerId: string
  readonly intentId: string
  readonly generation: number
}

export interface ReleaseClaimRequest {
  readonly requestId: string
  readonly claimId: string
  /** 释放原因仅用于记录；`unknown` 表示结果未知的保留，需先对账再释放。 */
  readonly reason: 'started' | 'declined' | 'failed_before_start' | 'reconciled_stopped'
}

export type DispatchResponse = TaskDispatchView

/** 派发错误码：与 HTTP 状态映射在服务端集中定义，客户端不解析文案。 */
export const dispatchErrorCodes = {
  versionConflict: 'version_conflict',
  scopeInvalid: 'machine_scope_invalid',
  scopeUnauthorized: 'machine_scope_unauthorized',
  workerNotACandidate: 'worker_not_a_candidate',
  claimAlreadyHeld: 'claim_already_held',
  claimStaleGeneration: 'claim_stale_generation',
  claimNotHolding: 'claim_not_holding',
  claimNotFound: 'claim_not_found',
  intentNotDispatchable: 'intent_not_dispatchable',
  insufficientCapacity: 'insufficient_capacity',
  workerIdentityMismatch: 'worker_identity_mismatch',
} as const

export type DispatchErrorCode = (typeof dispatchErrorCodes)[keyof typeof dispatchErrorCodes]
