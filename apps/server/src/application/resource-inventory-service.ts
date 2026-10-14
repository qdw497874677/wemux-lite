import {
  agentAuthenticationAxis,
  agentExecutionAxis,
  bindingDistributionAxis,
  knownAgentKeys,
  modelInventoryIdentity,
  providerAuthenticationAxis,
  staticContentAuthenticationAxis,
  agentInventoryIdentity,
} from '@wemux/domain'
import type {
  AgentCapability,
  AgentKey,
  AuthenticationState,
  ConfigurationAxis,
  ConfigurationState,
  DistributionAxis,
  DistributionState,
  ExecutionState,
  InventoryWorkerConnectionState,
  ModelId,
  ModelProviderResourceDefinition,
  ReconcileReport,
  Resource,
  ResourceBinding,
  ResourceInventory,
  ResourceInventoryEntry,
  ResourceInventoryTarget,
  ResourceRevision,
  ResourceStateAxis,
  Timestamp,
  WorkerId,
} from '@wemux/domain'
import type { Worker } from '@wemux/server-domain'
import type { ResourceService } from './resource-service.js'

interface Projection {
  readonly binding: ResourceBinding
  readonly reconcile: ReconcileReport | null
}

const configuration = (state: ConfigurationState, detail: string, revision: number | null = null, observedAt: Timestamp | null = null): ConfigurationAxis => ({ state, detail, revision, observedAt })
const distribution = (state: DistributionState, detail: string, setRevision: number | null = null, observedAt: Timestamp | null = null): DistributionAxis => ({ state, detail, setRevision, observedAt })
const execution = (state: ExecutionState, detail: string, observedAt: Timestamp | null = null): ResourceStateAxis<ExecutionState> => ({ state, detail, observedAt })
const authentication = (state: AuthenticationState, detail: string, observedAt: Timestamp | null = null): ResourceStateAxis<AuthenticationState> => ({ state, detail, observedAt })

const connectionOf = (worker: Worker): InventoryWorkerConnectionState => worker.connectionState

/**
 * 把 Server 侧权威声明（资源、已发布修订、预设、绑定）与 Worker 侧真实探测（能力快照、
 * 安装回执）投影成管理面的四态视图。任何一条轴缺失证据时都向下取 unknown / unavailable，
 * 不允许用另一条轴的结论补齐。
 */
export class ResourceInventoryService {
  readonly resources: ResourceService
  readonly workers: () => Promise<readonly Worker[]>
  readonly now: () => Timestamp

  constructor(resources: ResourceService, workers: () => Promise<readonly Worker[]>, now: () => Timestamp = () => new Date().toISOString() as Timestamp) {
    this.resources = resources
    this.workers = workers
    this.now = now
  }

  async inventory(): Promise<ResourceInventory> {
    const workers = await this.workers()
    const projections = this.resources.bindingProjections()
    const revisions = new Map<string, readonly ResourceRevision[]>()
    const latestRevision = (resourceId: string): ResourceRevision | null => {
      if (!revisions.has(resourceId)) revisions.set(resourceId, this.resources.revisions(resourceId))
      return (revisions.get(resourceId) ?? []).reduce<ResourceRevision | null>((newest, candidate) => !newest || candidate.version > newest.version ? candidate : newest, null)
    }
    const desiredRevision = (workerId: WorkerId): number | null => this.resources.desiredSet(workerId).revision

    const workerEntries = workers.map(worker => this.workerEntry(worker, projections))
    const agentEntries = workers.flatMap(worker => knownAgentKeys.map(agentKey => this.agentEntry(worker, agentKey, projections)))
    const modelEntries = workers.flatMap(worker => this.modelEntries(worker, projections))
    const skillEntries = this.resources.resources().filter(resource => resource.kind === 'skill').map(resource => this.skillEntry(resource, workers, projections, latestRevision, desiredRevision))
    const presetEntries = this.presetEntries(workers)
    const providerEntries = this.resources.resources().filter(resource => resource.kind === 'model-provider').map(resource => this.providerEntry(resource, workers, projections, latestRevision, desiredRevision))

    return {
      generatedAt: this.now(),
      workers: workerEntries,
      agents: agentEntries,
      models: modelEntries,
      skills: skillEntries,
      presets: presetEntries,
      providers: providerEntries,
    }
  }

  private workerEntry(worker: Worker, all: readonly Projection[]): ResourceInventoryEntry {
    const own = all.filter(item => item.binding.workerId === worker.id)
    const agents = knownAgentKeys.map(agentKey => agentExecutionAxis(this.capabilityOf(worker, agentKey), connectionOf(worker)))
    const executable = agents.filter(axis => axis.state === 'executable')
    const connection = connectionOf(worker)
    const workerExecution = connection === 'revoked'
      ? execution('unavailable', 'Worker 已撤权，无法确认可执行')
      : executable.length > 0
        ? execution('executable', `${executable.length} 个 Agent 报告可执行`, worker.lastSeenAt)
        : agents.every(axis => axis.state === 'unknown')
          ? execution('unknown', agents[0]?.detail ?? `Worker ${connection === 'offline' ? '离线' : '状态未知'}，运行时探测结果可能过期`)
          : execution('unavailable', agents.find(axis => axis.state === 'unavailable')?.detail ?? '没有 Agent 报告可执行', worker.lastSeenAt)
    return {
      class: 'worker',
      id: worker.id,
      name: worker.name,
      description: `${worker.platform ?? '未知平台'}｜Worker ${worker.version ?? '未知版本'}`,
      workerId: worker.id,
      workerName: worker.name,
      connectionState: connection,
      agentKey: null,
      modelId: null,
      version: worker.version,
      configuration: configuration('configured', '已注册到集群', null, worker.lastSeenAt),
      authentication: connection === 'online'
        ? authentication('authenticated', '已通过 Worker 凭据认证', worker.lastSeenAt)
        : connection === 'offline'
          ? authentication('unknown', 'Worker 离线，认证状态取自最近一次连接')
          : authentication('unauthenticated', 'Worker 凭据已撤权'),
      distribution: this.aggregateDistribution(own, this.resources.desiredSet(worker.id).revision, '没有分发给该 Worker 的资源'),
      execution: workerExecution,
      targets: [],
    }
  }

  private agentEntry(worker: Worker, agentKey: AgentKey, all: readonly Projection[]): ResourceInventoryEntry {
    const capability = this.capabilityOf(worker, agentKey)
    const own = all.filter(item => item.binding.workerId === worker.id && item.binding.kind === 'agent-runtime' && item.binding.agentKey === agentKey)
    const managed = own.find(item => item.binding.status !== 'pending-gc' && item.binding.status !== "gc'd") ?? own[0] ?? null
    const managedRevision = managed ? this.resources.revision(managed.binding.resourceRevisionId) : null
    return {
      class: 'agent',
      id: agentInventoryIdentity(worker.id, agentKey),
      name: capability?.displayName ?? agentKey,
      description: `Agent ${agentKey}`,
      workerId: worker.id,
      workerName: worker.name,
      connectionState: connectionOf(worker),
      agentKey,
      modelId: null,
      version: capability?.version ?? null,
      configuration: managed
        ? configuration('configured', managedRevision ? `集群托管修订 v${managedRevision.version}` : '集群已下发托管安装', managedRevision?.version ?? null, managed.binding.updatedAt)
        : capability?.mode === 'execution'
          ? configuration('configured', '本机已配置所选路径')
          : configuration('unconfigured', '集群未分发托管安装，本机也没有选择路径'),
      authentication: agentAuthenticationAxis(capability),
      distribution: this.aggregateDistribution(own, this.resources.desiredSet(worker.id).revision, '集群未向该 Worker 分发托管安装'),
      execution: agentExecutionAxis(capability, connectionOf(worker)),
      targets: [],
    }
  }

  private modelEntries(worker: Worker, all: readonly Projection[]): readonly ResourceInventoryEntry[] {
    const connection = connectionOf(worker)
    const desired = this.resources.desiredSet(worker.id)
    const entries = new Map<string, ResourceInventoryEntry>()
    for (const agentKey of knownAgentKeys) {
      const capability = this.capabilityOf(worker, agentKey)
      const agentExecution = agentExecutionAxis(capability, connection)
      const agentAuthentication = agentAuthenticationAxis(capability)
      for (const model of capability?.models ?? []) {
        const id = modelInventoryIdentity(worker.id, agentKey, model.modelId)
        entries.set(id, this.modelEntry({ worker, agentKey, modelId: model.modelId, displayName: model.displayName, source: model.source, connection, agentExecution, agentAuthentication, declaredBy: null }))
      }
    }
    // 集群 Provider 声明的模型由 Server 权威声明，但可执行性没有真实模型探测，不能推断为可用。
    for (const snapshot of desired.bindings) {
      if (snapshot.kind !== 'model-provider' || !snapshot.provider) continue
      const projection = all.find(item => item.binding.id === snapshot.bindingId) ?? null
      for (const model of snapshot.provider.config.modelIds) {
        const modelId = `${snapshot.provider.config.providerKey}::${model}` as ModelId
        for (const target of snapshot.provider.config.agentKeys) {
          const id = modelInventoryIdentity(worker.id, target, modelId)
          if (entries.has(id)) continue
          entries.set(id, this.modelEntry({
            worker,
            agentKey: target,
            modelId,
            displayName: model,
            source: 'configured',
            connection,
            agentExecution: agentExecutionAxis(this.capabilityOf(worker, target), connection),
            agentAuthentication: agentAuthenticationAxis(this.capabilityOf(worker, target)),
            declaredBy: { bindingId: snapshot.bindingId, setRevision: desired.revision, status: projection?.binding.status ?? 'assigned', report: projection?.reconcile ?? null },
          }))
        }
      }
    }
    return [...entries.values()].sort((left, right) => left.id.localeCompare(right.id))
  }

  private modelEntry(input: {
    readonly worker: Worker
    readonly agentKey: AgentKey
    readonly modelId: ModelId
    readonly displayName: string
    readonly source: 'detected' | 'configured'
    readonly connection: InventoryWorkerConnectionState
    readonly agentExecution: ResourceStateAxis<ExecutionState>
    readonly agentAuthentication: ResourceStateAxis<AuthenticationState>
    readonly declaredBy: { readonly bindingId: string; readonly setRevision: number | null; readonly status: ResourceBinding['status']; readonly report: ReconcileReport | null } | null
  }): ResourceInventoryEntry {
    const declared = input.declaredBy
    return {
      class: 'model',
      id: modelInventoryIdentity(input.worker.id, input.agentKey, input.modelId),
      name: input.displayName,
      description: declared ? `${input.agentKey}｜集群 Provider 声明` : `${input.agentKey}｜${input.source === 'detected' ? '运行时探测' : '运行时配置'}`,
      workerId: input.worker.id,
      workerName: input.worker.name,
      connectionState: input.connection,
      agentKey: input.agentKey,
      modelId: input.modelId,
      version: null,
      configuration: declared
        ? configuration('configured', '集群 Provider 声明', declared.setRevision, null)
        : configuration('configured', input.source === 'detected' ? 'Agent 运行时探测到' : 'Agent 运行时配置'),
      authentication: declared
        ? authentication(input.agentAuthentication.state, input.agentAuthentication.detail, input.agentAuthentication.observedAt)
        : input.agentAuthentication,
      distribution: declared
        ? bindingDistributionAxis(declared.status, declared.report)
        : distribution('not-distributed', '模型由 Agent 运行时自带或本机配置，不经过集群分发', this.resources.desiredSet(input.worker.id).revision),
      execution: declared
        ? input.agentExecution.state === 'executable'
          ? execution('unknown', '集群声明的模型没有真实模型探测结果，不能声称可执行')
          : execution(input.agentExecution.state, input.agentExecution.detail, input.agentExecution.observedAt)
        : input.agentExecution,
      targets: [],
    }
  }

  private skillEntry(resource: Resource, workers: readonly Worker[], all: readonly Projection[], latestRevision: (resourceId: string) => ResourceRevision | null, desiredRevision: (workerId: WorkerId) => number | null): ResourceInventoryEntry {
    const own = all.filter(item => item.binding.resourceId === resource.id)
    const revision = latestRevision(resource.id)
    return {
      class: 'skill',
      id: resource.id,
      name: resource.name,
      description: resource.description,
      workerId: null,
      workerName: null,
      connectionState: null,
      agentKey: null,
      modelId: null,
      version: revision ? String(revision.version) : null,
      configuration: revision
        ? configuration('configured', `已发布修订 v${revision.version}`, revision.version, revision.createdAt)
        : configuration('unconfigured', '没有已发布修订'),
      authentication: staticContentAuthenticationAxis(),
      distribution: this.aggregateDistribution(own, null, '尚未分发给任何 Worker'),
      execution: execution('not-applicable', '技能是静态内容，可执行性由目标 Agent 决定'),
      targets: this.targets(own, workers, desiredRevision),
    }
  }

  private presetEntries(workers: readonly Worker[]): readonly ResourceInventoryEntry[] {
    const applications = this.resources.presetApplications()
    return this.resources.presets().map(preset => {
      const own = applications.filter(item => item.application.presetId === preset.id).flatMap(item => item.items)
      return {
        class: 'preset' as const,
        id: preset.id,
        name: preset.name,
        description: preset.description,
        workerId: null,
        workerName: null,
        connectionState: null,
        agentKey: null,
        modelId: null,
        version: String(preset.revision),
        configuration: configuration('configured', `实例级预设 v${preset.revision}｜${preset.entries.length} 个条目`, preset.revision, preset.createdAt),
        authentication: staticContentAuthenticationAxis(),
        distribution: this.aggregateDistribution(own, null, '还没有应用到任何 Worker'),
        execution: execution('not-applicable', '预设是分发模板，不直接执行；请查看其条目'),
        targets: this.targets(own, workers, workerId => this.resources.desiredSet(workerId).revision),
      }
    })
  }

  private providerEntry(resource: Resource, workers: readonly Worker[], all: readonly Projection[], latestRevision: (resourceId: string) => ResourceRevision | null, desiredRevision: (workerId: WorkerId) => number | null): ResourceInventoryEntry {
    const own = all.filter(item => item.binding.resourceId === resource.id)
    const revision = latestRevision(resource.id)
    const definition = resource.kind === 'model-provider' ? resource.definition : null
    const latestReport = own.map(item => item.reconcile).filter((report): report is ReconcileReport => report !== null).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)).at(-1) ?? null
    return {
      class: 'provider',
      id: resource.id,
      name: resource.name,
      description: resource.description,
      workerId: null,
      workerName: null,
      connectionState: null,
      agentKey: null,
      modelId: null,
      version: revision ? String(revision.version) : null,
      configuration: revision
        ? configuration('configured', `已发布修订 v${revision.version}｜${definition ? this.providerCredentialSummary(definition.credential) : '缺少凭据定位'}`, revision.version, revision.createdAt)
        : configuration('unconfigured', '没有已发布修订'),
      authentication: definition ? providerAuthenticationAxis(latestReport, definition.credential) : authentication('unknown', 'Provider 定义不可用'),
      distribution: this.aggregateDistribution(own, null, '尚未分发到任何 Worker'),
      execution: execution('not-applicable', 'Provider 是配置，不直接执行；可执行性由其模型条目体现'),
      targets: this.targets(own, workers, desiredRevision),
    }
  }

  private aggregateDistribution(projections: readonly Projection[], setRevision: number | null, emptyDetail: string): DistributionAxis {
    if (projections.length === 0) return distribution('not-distributed', emptyDetail, setRevision)
    const axes = projections.map(item => bindingDistributionAxis(item.binding.status, item.reconcile))
    const observedAt = axes.map(axis => axis.observedAt).filter((value): value is Timestamp => value !== null).sort().at(-1) ?? null
    const failed = axes.find(axis => axis.state === 'failed')
    if (failed) return distribution('failed', failed.detail, setRevision, observedAt)
    const done = axes.filter(axis => axis.state === 'distributed').length
    if (done === axes.length) return distribution('distributed', axes[0]!.detail, setRevision, observedAt)
    const pending = axes.find(axis => axis.state !== 'distributed')!
    return distribution('pending', done === 0 ? pending.detail : `${done}/${axes.length} 个目标已确认安装｜${pending.detail}`, setRevision, observedAt)
  }

  private targets(projections: readonly Projection[], workers: readonly Worker[], desiredRevision: (workerId: WorkerId) => number | null): readonly ResourceInventoryTarget[] {
    return workers.flatMap(worker => {
      const own = projections.filter(item => item.binding.workerId === worker.id)
      if (own.length === 0) return []
      const agents = knownAgentKeys.map(agentKey => agentExecutionAxis(this.capabilityOf(worker, agentKey), connectionOf(worker)))
      const distributionAxis = this.aggregateDistribution(own, desiredRevision(worker.id), '该 Worker 上没有该资源')
      return [{
        workerId: worker.id,
        workerName: worker.name,
        connectionState: connectionOf(worker),
        distribution: distributionAxis,
        execution: agents.find(axis => axis.state === 'executable') ?? agents.find(axis => axis.state === 'unavailable') ?? agents[0]!,
      }]
    })
  }

  private providerCredentialSummary(credential: ModelProviderResourceDefinition['credential']): string {
    return credential.kind === 'environment'
      ? `凭据来源：环境变量 ${credential.variableNames.join('、')}`
      : `凭据来源：Worker 本地凭据 ${credential.credentialRef}`
  }

  private capabilityOf(worker: Worker, agentKey: AgentKey): AgentCapability | null {
    return worker.capabilities.find(capability => capability.agentKey === agentKey) ?? null
  }
}
