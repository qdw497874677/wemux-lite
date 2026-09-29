import { createHash, randomUUID } from 'node:crypto'
import type {
  ReconcileReport,
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

  refreshDesiredSet(workerId: WorkerId): ResourceSetSnapshot {
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
          bindingId: binding.id, bindingRevision: binding.revision,
          resourceRevisionId: revision.id, resourceId: revision.resourceId, kind: revision.kind,
          contentSha256: revision.contentSha256,
          files: revision.payload.mode === 'blobs' ? revision.payload.files : [],
        }
      }).sort((left, right) => left.bindingId.localeCompare(right.bindingId))
    const fingerprint = createHash('sha256').update(JSON.stringify(desired)).digest('hex')
    if (current?.fingerprint === fingerprint) return current
    const snapshot: ResourceSetSnapshot = { workerId, revision: (current?.revision ?? 0) + 1, fingerprint, bindings: desired, createdAt: this.now() }
    this.repository.putResourceSet(snapshot, current?.revision ?? 0)
    this.notifier.send(workerId, { type: 'resource.set.notify', workerId, setRevision: snapshot.revision, fingerprint, resources: desired.map(item => ({ bindingId: item.bindingId, resourceRevisionId: item.resourceRevisionId, kind: item.kind, contentSha256: item.contentSha256 })) })
    return snapshot
  }

  private emptySet(workerId: WorkerId): ResourceSetSnapshot {
    const fingerprint = createHash('sha256').update('[]').digest('hex')
    return { workerId, revision: 0, fingerprint, bindings: [], createdAt: this.now() }
  }
}
