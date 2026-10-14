import { createHash, randomUUID } from 'node:crypto'
import { agentRegistryOrigin, agentRuntimeCatalog, managedAgentCatalogEntries, normalizeManagedAgentKey, type ManagedAgentKey } from '@wemux/domain'
import type {
  ReconcileReport,
  AgentKey,
  ProjectId,
  NodeResourcePreset,
  NodeResourcePresetApplication,
  NodeResourcePresetEntry,
  Resource,
  ResourceBinding,
  ResourceBindingStatus,
  ResourceRevision,
  ResourceSetSnapshot,
  Timestamp,
  UserId,
  WorkerId,
} from '@wemux/domain'
import type { ResourceSetNotifyPayload } from '@wemux/wire-protocol'
import type { SqliteResourceRepository } from '../storage/sqlite-resource-repository.ts'
import type { ResourceBlobStore, StoredResourceBlob } from '../storage/resource-blob-store.ts'

export interface ResourceNotifier {
  send(workerId: WorkerId, payload: ResourceSetNotifyPayload): void
}

// 官方运行时包名从共享固定版本目录派生，避免出现第二份清单而与 Worker 漂移。
const runtimePackages: Readonly<Record<string, string>> = Object.fromEntries(managedAgentCatalogEntries().map(entry => [entry.key, entry.packageName]))

export interface ManagedAgentInstallInput {
  readonly workerId: WorkerId
  readonly agentKey: string
  readonly createdBy: UserId
}

export interface ManagedAgentInstallResult {
  readonly agentKey: ManagedAgentKey
  readonly packageName: string
  readonly packageVersion: string
  readonly resourceId: string
  readonly resourceRevisionId: string
  readonly binding: ResourceBinding
}

export interface CreateResourceBindingInput {
  readonly id?: string
  readonly workerId: WorkerId
  readonly resourceRevisionId: string
  readonly agentKey?: import('@wemux/domain').AgentKey | null
  readonly projectId?: import('@wemux/domain').ProjectId | null
  readonly createdBy: UserId
  readonly createdAt?: Timestamp
}

export class ResourceService {
  readonly repository: SqliteResourceRepository
  readonly notifier: ResourceNotifier
  readonly now: () => Timestamp
  readonly blobs: ResourceBlobStore | null

  constructor(repository: SqliteResourceRepository, notifier: ResourceNotifier, now: () => Timestamp = () => new Date().toISOString() as Timestamp, blobs: ResourceBlobStore | null = null) {
    this.repository = repository
    this.notifier = notifier
    this.now = now
    this.blobs = blobs
  }

  presets(): readonly NodeResourcePreset[] { return this.repository.presets() }
  presetApplications(workerId?: WorkerId): ReadonlyArray<{ application: NodeResourcePresetApplication; items: ReturnType<ResourceService['bindingProjections']> }> {
    return this.repository.presetApplications(workerId).map(application => ({ application, items: application.bindingIds.map(id => {
      const binding = this.repository.binding(id)
      if (!binding) throw new Error('preset_binding_missing')
      return { binding, reconcile: this.repository.latestReport(id) }
    }) }))
  }

  createPreset(input: { id?: string; name: string; description: string; expectedRevision: number; entries: readonly NodeResourcePresetEntry[]; autoApply?: { enabled: boolean }; createdBy: UserId }): NodeResourcePreset {
    if (input.autoApply !== undefined && (typeof input.autoApply !== 'object' || input.autoApply === null || input.autoApply.enabled !== false)) throw new Error('preset_auto_apply_unavailable')
    if (input.id !== undefined && (typeof input.id !== 'string' || !input.id || input.id.length > 200)) throw new Error('invalid_preset')
    if (typeof input.name !== 'string' || typeof input.description !== 'string' || !input.name.trim() || input.name.length > 200 || input.description.length > 2000 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !Array.isArray(input.entries) || !input.entries.length || input.entries.length > 32) throw new Error('invalid_preset')
    const keys = new Set<string>()
    const revisionIds = new Set<string>()
    for (const entry of input.entries) {
      if (!entry || typeof entry.resourceId !== 'string' || !entry.resourceId || typeof entry.resourceRevisionId !== 'string' || !entry.resourceRevisionId || typeof entry.required !== 'boolean' || (entry.agentKey !== null && typeof entry.agentKey !== 'string') || (entry.projectId !== null && typeof entry.projectId !== 'string')) throw new Error('invalid_preset_entry')
      const revision = this.repository.revision(entry.resourceRevisionId)
      if (!revision || revision.state !== 'published' || revision.resourceId !== entry.resourceId) throw new Error('preset_revision_not_published')
      if (revision.kind !== 'skill' && revision.kind !== 'agent-runtime' && revision.kind !== 'model-provider') throw new Error('preset_resource_kind_unavailable')
      if (revision.kind === 'agent-runtime' && (entry.projectId !== null || !entry.agentKey || revision.payload.mode !== 'artifact' || runtimePackages[entry.agentKey] !== revision.payload.packageName)) throw new Error('invalid_runtime_binding')
      if (revision.kind === 'model-provider' && (revision.payload.mode !== 'inline-config' || !entry.agentKey || !revision.payload.config.agentKeys.includes(entry.agentKey))) throw new Error('invalid_provider_binding')
      const key = `${entry.resourceId}:${entry.agentKey ?? ''}:${entry.projectId ?? ''}`
      if (keys.has(key) || revisionIds.has(entry.resourceRevisionId)) throw new Error('duplicate_preset_entry')
      keys.add(key)
      revisionIds.add(entry.resourceRevisionId)
    }
    return this.repository.createPreset({ id: input.id ?? randomUUID(), name: input.name.trim(), description: input.description.trim(), revision: input.expectedRevision + 1, scope: { kind: 'instance' }, entries: input.entries.map(entry => ({ resourceId: entry.resourceId, resourceRevisionId: entry.resourceRevisionId, agentKey: entry.agentKey, projectId: entry.projectId, required: entry.required })), autoApply: { enabled: false }, createdBy: input.createdBy, createdAt: this.now() }, input.expectedRevision)
  }

  async applyPreset(input: { presetId: string; presetRevision: number; workerId: WorkerId; requestId: string; expectedSetRevision: number; createdBy: UserId }): Promise<NodeResourcePresetApplication> {
    if (typeof input.presetId !== 'string' || !input.presetId || typeof input.workerId !== 'string' || !input.workerId || typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 200 || !Number.isSafeInteger(input.presetRevision) || input.presetRevision < 1 || !Number.isSafeInteger(input.expectedSetRevision) || input.expectedSetRevision < 0) throw new Error('invalid_preset_application')
    const fingerprint = createHash('sha256').update(JSON.stringify([input.presetId, input.presetRevision, input.workerId, input.expectedSetRevision, input.createdBy])).digest('hex')
    const { application, notify } = await this.repository.transaction(() => {
      const existing = this.repository.presetApplication(input.requestId)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('preset_application_request_conflict')
        return { application: existing, notify: null }
      }
      const preset = this.repository.preset(input.presetId, input.presetRevision)
      if (!preset) throw new Error('preset_not_found')
      if (this.desiredSet(input.workerId).revision !== input.expectedSetRevision) throw new Error('resource_set_revision_conflict')
      const activeBindings = this.repository.bindings(input.workerId).filter(item => item.status !== 'pending-gc' && item.status !== "gc'd")
      const active = new Set(activeBindings.map(item => `${item.resourceId}:${item.agentKey ?? ''}:${item.projectId ?? ''}`))
      const activeRevisions = new Set(activeBindings.map(item => item.resourceRevisionId))
      for (const entry of preset.entries) {
        const revision = this.repository.revision(entry.resourceRevisionId)
        if (!revision || revision.state !== 'published' || revision.resourceId !== entry.resourceId) throw new Error('preset_revision_not_published')
        if (revision.kind !== 'skill' && revision.kind !== 'agent-runtime' && revision.kind !== 'model-provider') throw new Error('preset_resource_kind_unavailable')
        if (revision.kind === 'agent-runtime' && (entry.projectId !== null || !entry.agentKey || revision.payload.mode !== 'artifact' || runtimePackages[entry.agentKey] !== revision.payload.packageName)) throw new Error('invalid_runtime_binding')
        if (revision.kind === 'model-provider' && (revision.payload.mode !== 'inline-config' || !entry.agentKey || !revision.payload.config.agentKeys.includes(entry.agentKey))) throw new Error('invalid_provider_binding')
        if (active.has(`${entry.resourceId}:${entry.agentKey ?? ''}:${entry.projectId ?? ''}`) || activeRevisions.has(entry.resourceRevisionId)) throw new Error('preset_binding_conflict')
      }
      const at = this.now()
      const bindings = preset.entries.map(entry => {
        const revision = this.repository.revision(entry.resourceRevisionId)!
        const binding: ResourceBinding = { id: randomUUID(), workerId: input.workerId, resourceId: revision.resourceId, resourceRevisionId: revision.id, kind: revision.kind, agentKey: entry.agentKey, projectId: entry.projectId, status: 'assigned', revision: 1, createdBy: input.createdBy, createdAt: at, updatedAt: at }
        this.repository.createBinding(binding)
        return binding
      })
      const application: NodeResourcePresetApplication = { id: randomUUID(), presetId: preset.id, presetRevision: preset.revision, workerId: input.workerId, bindingIds: bindings.map(binding => binding.id), requestId: input.requestId, fingerprint, createdBy: input.createdBy, createdAt: at }
      this.repository.createPresetApplication(application)
      const snapshot = this.refreshDesiredSet(input.workerId, false)
      return { application, notify: snapshot }
    })
    // Never send a desired-state notification for a transaction that rolled back.
    if (notify) this.sendSet(input.workerId, notify)
    return application
  }

  /** 期望态通知的唯一出口；只有在事务提交后才调用。 */
  private sendSet(workerId: WorkerId, snapshot: ResourceSetSnapshot): void {
    this.notifier.send(workerId, {
      type: 'resource.set.notify',
      workerId,
      setRevision: snapshot.revision,
      fingerprint: snapshot.fingerprint,
      resources: snapshot.bindings.map(item => ({ bindingId: item.bindingId, resourceRevisionId: item.resourceRevisionId, kind: item.kind, contentSha256: item.contentSha256 })),
    })
  }

  /**
   * 管理员显式确认后，把固定版本目录中的官方运行时下发给指定 Worker。
   * 同一个 Worker × Agent 重复调用是幂等的：资源、修订、绑定都用确定性 id，
   * 只重建期望态，因此失败后重试不会产生第二份修订或第二个绑定。
   */
  async installManagedAgent(input: ManagedAgentInstallInput): Promise<ManagedAgentInstallResult> {
    const key = normalizeManagedAgentKey(input.agentKey)
    if (!key) throw new Error('invalid_managed_agent_key')
    const spec = agentRuntimeCatalog[key]
    const resourceId = `managed-agent-runtime-${key}`
    const resourceRevisionId = `${resourceId}-v${spec.version}`
    const bindingId = `managed-agent-binding-${input.workerId}-${key}`
    const name = `托管 Agent 运行时（${key}）`
    const contentSha256 = createHash('sha256').update(JSON.stringify({ kind: 'agent-runtime', key, packageName: spec.name, packageVersion: spec.version, packageIntegrity: spec.integrity })).digest('hex')
    const at = this.now()
    const snapshot = await this.repository.transaction(() => {
      if (!this.repository.resource(resourceId)) {
        this.repository.createResource({ id: resourceId, kind: 'agent-runtime', name, description: `${spec.name}@${spec.version}`, definition: {}, createdBy: input.createdBy, createdAt: at, updatedAt: at })
      }
      if (!this.repository.revision(resourceRevisionId)) {
        this.repository.createRevision({
          id: resourceRevisionId, resourceId, kind: 'agent-runtime', version: 1, state: 'published',
          manifest: {
            schemaVersion: 1, name, description: `${spec.name}@${spec.version}`,
            compatibility: { workerProtocol: '2', platforms: ['linux', 'darwin'], architectures: ['x64', 'arm64'], agentKeys: [key as AgentKey] },
            bytes: 0, fileCount: 0, sha256: contentSha256, materializerVersion: 1, restartPolicy: 'worker',
          },
          payload: { mode: 'artifact', packageName: spec.name, packageVersion: spec.version, registryOrigin: agentRegistryOrigin, packageIntegrity: spec.integrity },
          supplyChain: { mode: 'registry-package', packageName: spec.name, packageVersion: spec.version, registryOrigin: agentRegistryOrigin, packageIntegrity: spec.integrity },
          contentSha256, createdBy: input.createdBy, createdAt: at,
        })
      }
      const existing = this.repository.binding(bindingId)
      if (existing && (existing.status === 'pending-gc' || existing.status === "gc'd")) throw new Error('managed_agent_binding_retired')
      if (existing && (existing.resourceRevisionId !== resourceRevisionId || existing.workerId !== input.workerId || existing.agentKey !== key)) throw new Error('managed_agent_binding_conflict')
      if (!existing) {
        this.repository.createBinding({ id: bindingId, workerId: input.workerId, resourceRevisionId, resourceId, kind: 'agent-runtime', agentKey: key as AgentKey, projectId: null, status: 'assigned', revision: 1, createdBy: input.createdBy, createdAt: at, updatedAt: at })
      }
      // assigned/failed 会被刷新回 notified，因此这里是失败后的重试入口。
      return this.refreshDesiredSet(input.workerId, false)
    })
    this.sendSet(input.workerId, snapshot)
    const binding = this.repository.binding(bindingId)
    if (!binding) throw new Error('managed_agent_binding_missing')
    return { agentKey: key, packageName: spec.name, packageVersion: spec.version, resourceId, resourceRevisionId, binding }
  }

  createResource(resource: Resource): Resource { return this.repository.createResource(resource) }
  updateResource(resource: Resource): Resource { return this.repository.updateResource(resource) }
  resource(id: string): Resource | null { return this.repository.resource(id) }
  resources(): readonly Resource[] { return this.repository.resources() }
  deleteResource(id: string): void { this.repository.deleteResource(id) }
  createRevision(revision: ResourceRevision): ResourceRevision { return this.repository.createRevision(revision) }
  /** Publish the new non-secret Provider definition and immutable revision together. */
  publishProviderRevision(resourceId: string, input: { readonly expectedVersion: number; readonly revision: ResourceRevision }): Promise<ResourceRevision> {
    return this.repository.transaction(() => {
      const current = this.repository.resource(resourceId)
      if (!current || current.kind !== 'model-provider') throw new Error('provider_resource_not_found')
      const versions = this.repository.revisions(resourceId)
      const latest = versions.reduce((highest, item) => Math.max(highest, item.version), 0)
      if (latest !== input.expectedVersion || input.revision.version !== latest + 1) throw new Error('provider_version_conflict')
      const next = input.revision
      if (next.resourceId !== resourceId || next.kind !== 'model-provider' || next.payload.mode !== 'inline-config' || next.state !== 'published') throw new Error('invalid_provider_revision')
      // The repository validates the actual content digest and strict shapes;
      // a failed revision rolls back the resource update in this transaction.
      this.repository.updateResource({ ...current, definition: next.payload.config, updatedAt: this.now() })
      return this.repository.createRevision(next)
    })
  }
  revision(id: string): ResourceRevision | null { return this.repository.revision(id) }
  revisions(resourceId: string): readonly ResourceRevision[] { return this.repository.revisions(resourceId) }
  bindings(workerId?: WorkerId): readonly ResourceBinding[] { return this.repository.bindings(workerId) }
  bindingProjections(workerId?: WorkerId): ReadonlyArray<{ readonly binding: ResourceBinding; readonly reconcile: ReconcileReport | null }> {
    return this.repository.bindings(workerId).map(binding => ({ binding, reconcile: this.repository.latestReport(binding.id) }))
  }

  /** Non-secret, project-scoped discovery only. Not a readiness or auth claim. */
  providerCandidates(workerId: WorkerId, projectId: ProjectId, agentKey: AgentKey): ReadonlyArray<{ readonly modelId: string; readonly resourceId: string; readonly bindingId: string; readonly status: 'not-verified' }> {
    const candidates = new Map<string, { modelId: string; resourceId: string; bindingId: string; status: 'not-verified'; priority: number }[]>()
    for (const binding of this.desiredSet(workerId).bindings) {
      if (binding.kind !== 'model-provider' || (binding.projectId !== null && binding.projectId !== projectId) || (binding.agentKey !== null && binding.agentKey !== agentKey) || !binding.provider?.config.agentKeys.includes(agentKey)) continue
      for (const model of binding.provider.config.modelIds) {
        const modelId = `${binding.provider.config.providerKey}::${model}`
        const priority = Number(binding.projectId !== null) * 2 + Number(binding.agentKey !== null)
        candidates.set(modelId, [...candidates.get(modelId) ?? [], { modelId, resourceId: binding.resourceId, bindingId: binding.bindingId, status: 'not-verified', priority }])
      }
    }
    // Do not offer an ambiguous highest-priority selection: the Worker rejects it.
    return [...candidates.values()].flatMap(items => {
      const top = Math.max(...items.map(item => item.priority))
      const best = items.filter(item => item.priority === top)
      return best.length === 1 ? [{ modelId: best[0]!.modelId, resourceId: best[0]!.resourceId, bindingId: best[0]!.bindingId, status: best[0]!.status }] : []
    }).sort((a, b) => a.modelId.localeCompare(b.modelId))
  }
  async putBlob(content: Uint8Array, expectedSha256: string): Promise<StoredResourceBlob> {
    if (!this.blobs) throw new Error('resource_blob_store_unavailable')
    return this.blobs.put(content, expectedSha256)
  }
  desiredSet(workerId: WorkerId): ResourceSetSnapshot { return this.repository.resourceSet(workerId) ?? this.emptySet(workerId) }

  createBinding(input: CreateResourceBindingInput): ResourceBinding {
    const revision = this.repository.revision(input.resourceRevisionId)
    if (!revision) throw new Error('resource_revision_not_found')
    if (revision.kind === 'agent-runtime' && (input.projectId != null || !input.agentKey || revision.payload.mode !== 'artifact' || runtimePackages[input.agentKey] !== revision.payload.packageName)) throw new Error('invalid_runtime_binding')
    if (revision.kind === 'model-provider' && (revision.payload.mode !== 'inline-config' || !input.agentKey || !revision.payload.config.agentKeys.includes(input.agentKey))) throw new Error('invalid_provider_binding')
    const at = input.createdAt ?? this.now()
    const binding: ResourceBinding = {
      id: input.id ?? randomUUID(), workerId: input.workerId, resourceRevisionId: revision.id,
      resourceId: revision.resourceId, kind: revision.kind, agentKey: input.agentKey ?? null,
      projectId: input.projectId ?? null, status: 'assigned', revision: 1,
      createdBy: input.createdBy, createdAt: at, updatedAt: at,
    }
    this.repository.createBinding(binding)
    this.refreshDesiredSet(input.workerId)
    return this.repository.binding(binding.id)!
  }

  transitionBinding(id: string, status: ResourceBindingStatus, expectedRevision: number): ResourceBinding {
    const previous = this.repository.binding(id)
    if (!previous) throw new Error('resource_binding_not_found')
    const binding = this.repository.transitionBinding(id, status, expectedRevision, this.now())
    if (status === 'pending-gc' || status === "gc'd") this.refreshDesiredSet(binding.workerId)
    return binding
  }

  reconcile(report: ReconcileReport): ResourceBinding {
    const binding = this.repository.binding(report.bindingId)
    if (!binding || binding.workerId !== report.workerId || binding.resourceRevisionId !== report.resourceRevisionId || binding.resourceId !== report.resourceId || binding.kind !== report.kind) throw new Error('resource_report_binding_mismatch')
    const set = this.repository.resourceSet(report.workerId)
    if (!set || report.resourceSetRevision > set.revision || report.bindingRevision > binding.revision) throw new Error('resource_report_set_revision_invalid')
    // 移除报告引用上一份期望态；仅当前 binding 仍待回收时接收，不得覆盖已完成的回收。
    const removed = report.result === 'pending-gc' && binding.status === 'pending-gc' && !set.bindings.some(item => item.bindingId === binding.id)
    // 离线期间的旧安装报告可以重放，但不得覆盖当前期望态或实际状态。
    if (!removed && (report.resourceSetRevision < set.revision || report.bindingRevision < binding.revision)) return binding
    if (!removed && !set.bindings.some(item => item.bindingId === report.bindingId && item.resourceRevisionId === report.resourceRevisionId)) return binding
    const revision = this.repository.revision(report.resourceRevisionId)
    if (!revision || report.integrity !== revision.contentSha256) throw new Error('resource_report_integrity_mismatch')
    this.repository.recordReport(report)
    if (report.result === 'installed' && report.phase !== 'ready') return binding
    const target: ResourceBindingStatus = report.result === 'version-mismatch' ? 'failed' : report.result
    if (binding.status === target) return binding
    return this.repository.transitionBinding(binding.id, target, binding.revision, report.occurredAt)
  }

  refreshDesiredSet(workerId: WorkerId, notify = true): ResourceSetSnapshot {
    const current = this.repository.resourceSet(workerId)
    // 先确认分配状态，再生成包含最终 binding revision 的完整期望态。
    for (const binding of this.repository.bindings(workerId)) {
      if (binding.status === 'assigned' || binding.status === 'failed') this.repository.transitionBinding(binding.id, 'notified', binding.revision, this.now())
    }
    const desired = this.repository.bindings(workerId).filter(binding => binding.status !== 'pending-gc' && binding.status !== "gc'd")
      .map(binding => {
        const revision = this.repository.revision(binding.resourceRevisionId)
        if (!revision) throw new Error('resource_revision_not_found')
        return {
          bindingId: binding.id, bindingRevision: binding.revision, agentKey: binding.agentKey, projectId: binding.projectId,
          resourceRevisionId: revision.id, resourceId: revision.resourceId, kind: revision.kind,
          contentSha256: revision.contentSha256,
          files: revision.payload.mode === 'blobs' ? revision.payload.files : [],
          ...(revision.payload.mode === 'artifact' ? { artifact: revision.payload } : {}),
          ...(revision.payload.mode === 'inline-config' ? { provider: revision.payload } : {}),
        }
      }).sort((left, right) => left.bindingId.localeCompare(right.bindingId))
    const fingerprint = createHash('sha256').update(JSON.stringify(desired)).digest('hex')
    if (current?.fingerprint === fingerprint) return current
    const snapshot: ResourceSetSnapshot = { workerId, revision: (current?.revision ?? 0) + 1, fingerprint, bindings: desired, createdAt: this.now() }
    this.repository.putResourceSet(snapshot, current?.revision ?? 0)
    if (notify) this.sendSet(workerId, snapshot)
    return snapshot
  }

  private emptySet(workerId: WorkerId): ResourceSetSnapshot {
    const fingerprint = createHash('sha256').update('[]').digest('hex')
    return { workerId, revision: 0, fingerprint, bindings: [], createdAt: this.now() }
  }
}
