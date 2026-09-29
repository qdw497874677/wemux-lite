import { createHash, randomUUID } from 'node:crypto'
import type {
  ReconcileReport,
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

const runtimePackages: Readonly<Record<string, string>> = { pi: '@earendil-works/pi-coding-agent', opencode: 'opencode-ai', 'claude-code': '@anthropic-ai/claude-code' }

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
      if (revision.kind !== 'skill' && revision.kind !== 'agent-runtime') throw new Error('preset_resource_kind_unavailable')
      if (revision.kind === 'agent-runtime' && (entry.projectId !== null || !entry.agentKey || revision.payload.mode !== 'artifact' || runtimePackages[entry.agentKey] !== revision.payload.packageName)) throw new Error('invalid_runtime_binding')
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
        if (revision.kind !== 'skill' && revision.kind !== 'agent-runtime') throw new Error('preset_resource_kind_unavailable')
        if (revision.kind === 'agent-runtime' && (entry.projectId !== null || !entry.agentKey || revision.payload.mode !== 'artifact' || runtimePackages[entry.agentKey] !== revision.payload.packageName)) throw new Error('invalid_runtime_binding')
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
    if (notify) this.notifier.send(input.workerId, { type: 'resource.set.notify', workerId: input.workerId, setRevision: notify.revision, fingerprint: notify.fingerprint, resources: notify.bindings.map(item => ({ bindingId: item.bindingId, resourceRevisionId: item.resourceRevisionId, kind: item.kind, contentSha256: item.contentSha256 })) })
    return application
  }

  createResource(resource: Resource): Resource { return this.repository.createResource(resource) }
  updateResource(resource: Resource): Resource { return this.repository.updateResource(resource) }
  resource(id: string): Resource | null { return this.repository.resource(id) }
  resources(): readonly Resource[] { return this.repository.resources() }
  deleteResource(id: string): void { this.repository.deleteResource(id) }
  createRevision(revision: ResourceRevision): ResourceRevision { return this.repository.createRevision(revision) }
  revision(id: string): ResourceRevision | null { return this.repository.revision(id) }
  revisions(resourceId: string): readonly ResourceRevision[] { return this.repository.revisions(resourceId) }
  bindings(workerId?: WorkerId): readonly ResourceBinding[] { return this.repository.bindings(workerId) }
  bindingProjections(workerId?: WorkerId): ReadonlyArray<{ readonly binding: ResourceBinding; readonly reconcile: ReconcileReport | null }> {
    return this.repository.bindings(workerId).map(binding => ({ binding, reconcile: this.repository.latestReport(binding.id) }))
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
        }
      }).sort((left, right) => left.bindingId.localeCompare(right.bindingId))
    const fingerprint = createHash('sha256').update(JSON.stringify(desired)).digest('hex')
    if (current?.fingerprint === fingerprint) return current
    const snapshot: ResourceSetSnapshot = { workerId, revision: (current?.revision ?? 0) + 1, fingerprint, bindings: desired, createdAt: this.now() }
    this.repository.putResourceSet(snapshot, current?.revision ?? 0)
    if (notify) this.notifier.send(workerId, { type: 'resource.set.notify', workerId, setRevision: snapshot.revision, fingerprint, resources: desired.map(item => ({ bindingId: item.bindingId, resourceRevisionId: item.resourceRevisionId, kind: item.kind, contentSha256: item.contentSha256 })) })
    return snapshot
  }

  private emptySet(workerId: WorkerId): ResourceSetSnapshot {
    const fingerprint = createHash('sha256').update('[]').digest('hex')
    return { workerId, revision: 0, fingerprint, bindings: [], createdAt: this.now() }
  }
}
