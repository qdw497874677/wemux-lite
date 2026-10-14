import type { AgentCapability, AgentModelCapability } from './agent.js'
import type { WorkerId } from './ids.js'
import type { ModelProviderResourceDefinition, ReconcileReport, ResourceBindingStatus, ResourceReconcilePhase } from './resource.js'
import type { AgentKey, ModelId, Timestamp } from './values.js'

/**
 * 双宿主管理面的资源四态投影。
 *
 * 「已配置 / 已认证 / 已分发 / 可执行」是四条独立轴：配置是 Server 的权威声明，认证与可执行
 * 只来自 Worker 的真实探测，分发是 Worker 的安装回执。任何一条轴都不得用另一条的结论补齐，
 * 探测缺失时如实返回 unknown / unavailable，而不是假定成功。
 */
export type ResourceInventoryClass = 'worker' | 'agent' | 'model' | 'skill' | 'preset' | 'provider'

/** 已配置：Server 端是否已有该资源的权威声明（注册记录、资源与已发布修订、绑定）。 */
export type ConfigurationState = 'configured' | 'unconfigured'
/** 已认证：凭据是否可用。静态内容为 not-required；没有真实探测时为 unknown。 */
export type AuthenticationState = 'authenticated' | 'unauthenticated' | 'unknown' | 'not-required'
/** 已分发：目标 Worker 是否已安装该资源。 */
export type DistributionState = 'distributed' | 'pending' | 'failed' | 'not-distributed'
/** 可执行：运行时真实探测是否表明本机现在可以运行。 */
export type ExecutionState = 'executable' | 'unavailable' | 'unknown' | 'not-applicable'

export type InventoryWorkerConnectionState = 'online' | 'offline' | 'revoked'

export interface ResourceStateAxis<State extends string> {
  readonly state: State
  readonly detail: string
  /** 该状态所依据的真实探测/回执时间；没有探测依据时为 null，界面不得显示为实时。 */
  readonly observedAt: Timestamp | null
}

export interface ConfigurationAxis extends ResourceStateAxis<ConfigurationState> {
  /** 已发布修订版本号；尚无修订时为 null。 */
  readonly revision: number | null
}

export interface DistributionAxis extends ResourceStateAxis<DistributionState> {
  /** 分发所依据的期望态版本；未生成期望态时为 null。 */
  readonly setRevision: number | null
}

/** 单个目标 Worker 上的分发与可执行事实，用于管理面下钻。 */
export interface ResourceInventoryTarget {
  readonly workerId: WorkerId
  readonly workerName: string
  readonly connectionState: InventoryWorkerConnectionState
  readonly distribution: DistributionAxis
  readonly execution: ResourceStateAxis<ExecutionState>
}

export interface ResourceInventoryEntry {
  readonly class: ResourceInventoryClass
  readonly id: string
  readonly name: string
  readonly description: string
  /** Worker 自身条目为其节点 id；其余条目为已分发/已探测的目标 Worker。 */
  readonly workerId: WorkerId | null
  readonly workerName: string | null
  readonly connectionState: InventoryWorkerConnectionState | null
  readonly agentKey: AgentKey | null
  readonly modelId: ModelId | null
  /** 真实探测到的版本；无探测证据时为 null。 */
  readonly version: string | null
  readonly configuration: ConfigurationAxis
  readonly authentication: ResourceStateAxis<AuthenticationState>
  readonly distribution: DistributionAxis
  readonly execution: ResourceStateAxis<ExecutionState>
  readonly targets: readonly ResourceInventoryTarget[]
}

export interface ResourceInventory {
  readonly generatedAt: Timestamp
  readonly workers: readonly ResourceInventoryEntry[]
  readonly agents: readonly ResourceInventoryEntry[]
  readonly models: readonly ResourceInventoryEntry[]
  readonly skills: readonly ResourceInventoryEntry[]
  readonly presets: readonly ResourceInventoryEntry[]
  readonly providers: readonly ResourceInventoryEntry[]
}

export function inventoryAxis<State extends string>(state: State, detail: string, observedAt: Timestamp | null = null): ResourceStateAxis<State> {
  return { state, detail, observedAt }
}

const phaseLabels: Readonly<Record<ResourceReconcilePhase, string>> = {
  queued: '排队中',
  downloading: '下载中',
  verifying: '校验中',
  installing: '安装中',
  'restart-required': '等待安全重启',
  'credential-required': '需要本地凭据',
  ready: '就绪',
  gc: '回收中',
}

export const phaseLabel = (phase: ResourceReconcilePhase): string => phaseLabels[phase]

/** 认证只认 Worker 的认证探测结果；探测缺失一律 unknown，绝不从可用性反推已认证。 */
export function agentAuthenticationAxis(capability: AgentCapability | null): ResourceStateAxis<AuthenticationState> {
  const authorization = capability?.authorization
  if (!authorization) return inventoryAxis('unknown', 'Worker 未上报认证探测结果')
  if (authorization.state === 'authorized') return inventoryAxis('authenticated', `已认证${authorization.accountLabel ? `（${authorization.accountLabel}）` : ''}`)
  if (authorization.state === 'unauthorized') return inventoryAxis('unauthenticated', authorization.instructions ?? '本机未认证，需要先登录 Agent')
  return inventoryAxis('unknown', authorization.instructions ?? '认证状态未知（探测不可用）')
}

/** 可执行只认在线 Worker 且带真实版本探测的能力快照。 */
export function agentExecutionAxis(capability: AgentCapability | null, connection: InventoryWorkerConnectionState): ResourceStateAxis<ExecutionState> {
  if (connection === 'revoked') return inventoryAxis('unavailable', 'Worker 已撤权，无法确认可执行')
  if (connection !== 'online') return inventoryAxis('unknown', `Worker ${connection === 'offline' ? '离线' : '状态未知'}，运行时探测结果可能过期`)
  if (!capability) return inventoryAxis('unavailable', 'Worker 未探测到该 Agent')
  if (capability.mode !== 'execution') return inventoryAxis('unavailable', '该 Agent 仅支持探测，不能执行会话')
  if (capability.availability.status !== 'available') return inventoryAxis('unavailable', capability.availability.reason)
  if (capability.version === null) return inventoryAxis('unavailable', '可用性探测通过，但没有版本探测结果，不能声称可执行')
  return inventoryAxis('executable', `已探测到版本 ${capability.version}`)
}

/** 分发以 Worker 的安装回执为准；没有回执时只能读到 Server 侧绑定状态并明说未确认。 */
export function bindingDistributionAxis(status: ResourceBindingStatus, report: ReconcileReport | null): DistributionAxis {
  const axis = (state: DistributionState, detail: string, setRevision: number | null = null, observedAt: Timestamp | null = null): DistributionAxis => ({ state, detail, observedAt, setRevision })
  if (!report) {
    if (status === 'installed') return axis('distributed', '绑定状态为已安装，尚未收到 Worker 安装回执')
    if (status === 'failed') return axis('failed', '绑定状态为安装失败，尚未收到 Worker 失败原因')
    if (status === 'pending-gc' || status === "gc'd") return axis('not-distributed', '已从期望态移除并回收')
    return axis('pending', '尚未收到 Worker 安装回执')
  }
  const observedAt = report.occurredAt
  if (report.result === 'pending-gc') return axis('not-distributed', report.message ?? '已从期望态移除并回收', report.resourceSetRevision, observedAt)
  if (report.result === 'version-mismatch') return axis('failed', `版本不匹配：${report.message ?? report.errorCode ?? '完整性标识不一致'}`, report.resourceSetRevision, observedAt)
  if (report.result === 'failed') return axis('failed', report.message ?? report.errorCode ?? 'Worker 上报安装失败', report.resourceSetRevision, observedAt)
  if (report.phase === 'ready') return axis('distributed', report.message ?? 'Worker 已确认安装并就绪', report.resourceSetRevision, observedAt)
  if (report.phase === null) return axis('pending', report.message ?? 'Worker 已收到期望态，尚未完成安装', report.resourceSetRevision, observedAt)
  return axis('pending', report.message ?? `正在安装（${phaseLabels[report.phase]}）`, report.resourceSetRevision, observedAt)
}

/** 静态内容不需要凭据。 */
export function staticContentAuthenticationAxis(): ResourceStateAxis<AuthenticationState> {
  return inventoryAxis('not-required', '静态内容，不需要凭据')
}

/**
 * Provider 凭据只在 Worker 本地解析。已配置/未配置由 Worker 的凭据探测回执决定，
 * 管理面只会看到声明过的变量名，永远不含凭据取值。
 */
export function providerAuthenticationAxis(report: ReconcileReport | null, locator: ModelProviderResourceDefinition['credential']): ResourceStateAxis<AuthenticationState> {
  if (!report) return inventoryAxis('unknown', '尚未分发到 Worker，本地凭据未探测')
  if (report.phase === 'credential-required') {
    if (report.errorCode) return inventoryAxis('unauthenticated', report.message ?? `需要在 Worker 本地配置凭据：${locator.variableNames.join('、')}`, report.occurredAt)
    return inventoryAxis('authenticated', report.message ?? '本地凭据已配置；尚未验证模型探测或 Agent 注入', report.occurredAt)
  }
  return inventoryAxis('unknown', `最近一次回执为${report.phase === null ? '安装结果' : phaseLabels[report.phase]}，未包含凭据探测结果`, report.occurredAt)
}

export function modelInventoryIdentity(workerId: WorkerId, agentKey: AgentKey, modelId: ModelId): string {
  return `${workerId}:${agentKey}:${modelId}`
}

export function agentInventoryIdentity(workerId: WorkerId, agentKey: AgentKey): string {
  return `${workerId}:${agentKey}`
}

export type { AgentModelCapability }
