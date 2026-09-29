import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentKey, ProjectId, ReconcileReport, ResourceBindingSnapshot, ResourceReconcilePhase, ResourceSetSnapshot, Timestamp, WorkerId } from '@wemux/domain'
import type { ResourceBlobFetchPayload, ServerResourcePayload, WorkerPayload } from '@wemux/wire-protocol'
import { ResourceStateStore } from './resource-state-store.ts'
import { SkillMaterializer } from './skill-materializer.ts'
import { RuntimeMaterializer } from './runtime-materializer.ts'
import { stageAgentRuntime } from '../runtimes/management.ts'
import type { RuntimeProcess } from '../runtimes/management.ts'

interface ResourceTransport { send(payload: WorkerPayload): Promise<void> | void }

const requestTimeoutMs = 15_000
interface PendingRequest<T> { resolve(value: T): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly limit: number

  constructor(limit: number) { this.limit = Math.max(1, limit) }

  async use<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiters.push(resolve))
    this.active += 1
    try { return await operation() }
    finally {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

export interface ResourceReconcilerOptions {
  readonly workerId: WorkerId
  readonly home: string
  readonly databasePath: string
  readonly transport: ResourceTransport
  readonly concurrency?: number
  readonly now?: () => Timestamp
  readonly runtimeProcess?: RuntimeProcess
  readonly stageRuntime?: typeof stageAgentRuntime
}

export class ResourceReconciler {
  private readonly workerId: WorkerId
  private readonly transport: ResourceTransport
  private readonly state: ResourceStateStore
  private readonly materializer: SkillMaterializer
  private readonly runtimes: RuntimeMaterializer
  private readonly now: () => Timestamp
  private readonly semaphore: Semaphore
  private readonly pulls = new Map<string, PendingRequest<ResourceSetSnapshot>>()
  private readonly blobs = new Map<string, PendingRequest<Uint8Array> & { readonly sha256: string }>()
  private readonly flights = new Map<string, Promise<void>>()
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private snapshotFresh = false
  private connectionEpoch = 0
  private announcedRevision = 0

  constructor(options: ResourceReconcilerOptions) {
    this.workerId = options.workerId
    this.transport = options.transport
    this.state = new ResourceStateStore(options.databasePath)
    this.now = options.now ?? (() => new Date().toISOString() as Timestamp)
    this.materializer = new SkillMaterializer(options.home, this.state, this.now)
    this.runtimes = new RuntimeMaterializer(options.home, this.state, this.now, options.runtimeProcess, options.stageRuntime)
    this.semaphore = new Semaphore(options.concurrency ?? 2)
  }

  receive(payload: ServerResourcePayload): boolean {
    if (payload.type === 'resource.set.notify') {
      if (payload.workerId !== this.workerId) return true
      const current = this.state.desired()
      if (!current || current.revision < payload.setRevision || current.revision === payload.setRevision && current.fingerprint !== payload.fingerprint) {
        this.announcedRevision = Math.max(this.announcedRevision, payload.setRevision)
        this.snapshotFresh = false
        this.connectionEpoch += 1
        void this.schedule(() => this.pullAndReconcile())
      }
      return true
    }
    if (payload.type === 'resource.set.pull') {
      const pending = this.pulls.get(payload.requestId)
      if (pending) { this.pulls.delete(payload.requestId); clearTimeout(pending.timer); pending.resolve(payload.resourceSet) }
      return true
    }
    const pending = this.blobs.get(payload.requestId)
    if (!pending) return true
    this.blobs.delete(payload.requestId)
    clearTimeout(pending.timer)
    if (payload.sha256 !== pending.sha256) pending.reject(new Error('resource_blob_hash_mismatch'))
    else if (payload.action === 'not-found') pending.reject(new Error('resource_blob_not_found'))
    else {
      const content = Buffer.from(payload.base64Content, 'base64')
      if (content.byteLength !== payload.size) pending.reject(new Error('resource_blob_size_mismatch'))
      else pending.resolve(content)
    }
    return true
  }

  connected(): Promise<void> {
    this.disconnected()
    return this.schedule(async () => {
      const desired = this.state.desired()
      if (desired) await this.reconcileInternal(desired)
      await this.pullAndReconcile()
    })
  }

  disconnected(): void { this.snapshotFresh = false; this.connectionEpoch += 1 }

  reconcile(snapshot: ResourceSetSnapshot): Promise<void> {
    return this.schedule(async () => {
      const epoch = this.connectionEpoch
      await this.reconcileInternal(snapshot)
      if (!this.closed && this.connectionEpoch === epoch && snapshot.revision >= this.announcedRevision && this.state.desired()?.revision === snapshot.revision) this.snapshotFresh = true
    })
  }

  async resolveSkillPath(resourceId: string): Promise<string | null> { return this.materializer.resolveSkillPath(resourceId) }

  /** Freeze authorized installed Skill bytes at launch; later binding changes cannot mutate this Invocation. */
  async skillsForLaunch(projectId: ProjectId, agentKey: AgentKey): Promise<readonly { resourceId: string; revisionId: string; content: Uint8Array }[]> {
    if (this.closed || !this.snapshotFresh) return []
    const desired = this.state.desired()
    if (!desired) return []
    const selected: { resourceId: string; revisionId: string; content: Uint8Array }[] = []
    for (const binding of desired.bindings) {
      if (binding.kind !== 'skill') continue
      const installed = this.state.installed(binding.resourceId)
      if (!installed || installed.bindingId !== binding.bindingId || installed.resourceRevisionId !== binding.resourceRevisionId || installed.integrity !== binding.contentSha256) continue
      if (binding.projectId !== null && binding.projectId !== projectId || binding.agentKey !== null && binding.agentKey !== agentKey) continue
      const path = await this.materializer.resolveSkillPath(binding.resourceId)
      if (!path) continue
      const entry = binding.files.find(file => file.path === 'SKILL.md')
      if (!entry) continue
      const content = await readFile(join(path, 'SKILL.md')).catch(() => null)
      if (!content || createHash('sha256').update(content).digest('hex') !== entry.sha256) continue
      if (this.closed || !this.snapshotFresh) return []
      if (!this.state.desired()?.bindings.some(current => current.bindingId === binding.bindingId && current.bindingRevision === binding.bindingRevision && current.resourceRevisionId === binding.resourceRevisionId)) continue
      selected.push({ resourceId: binding.resourceId, revisionId: binding.resourceRevisionId, content })
    }
    if (this.closed || !this.snapshotFresh || this.state.desired()?.revision !== desired.revision) return []
    return selected
  }

  async close(): Promise<void> {
    this.closed = true
    this.snapshotFresh = false
    for (const pending of [...this.pulls.values(), ...this.blobs.values()]) {
      clearTimeout(pending.timer)
      pending.reject(new Error('resource_reconciler_closed'))
    }
    this.pulls.clear()
    this.blobs.clear()
    await this.tail.catch(() => undefined)
    this.state.close()
  }

  private schedule(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve()
    const next = this.tail.then(operation)
    this.tail = next.catch(() => undefined)
    return next
  }

  private async pullAndReconcile(): Promise<void> {
    const requestId = randomUUID()
    const epoch = this.connectionEpoch
    const snapshot = this.pending(this.pulls, requestId)
    try {
      await this.transport.send({ type: 'resource.set.pull', action: 'request', requestId, workerId: this.workerId, knownSetRevision: this.state.desired()?.revision ?? null })
      await this.reconcileInternal(await snapshot)
      if (!this.closed && this.connectionEpoch === epoch && (this.state.desired()?.revision ?? -1) >= this.announcedRevision) this.snapshotFresh = true
    } finally { this.release(this.pulls, requestId) }
  }

  private async reconcileInternal(snapshot: ResourceSetSnapshot): Promise<void> {
    if (snapshot.workerId !== this.workerId) throw new Error('resource_set_worker_mismatch')
    const previous = this.state.desired()
    const saved = this.state.saveDesired(snapshot)
    if (saved === 'stale') return

    const desiredIds = new Set(snapshot.bindings.map(binding => binding.resourceId))
    if (previous) for (const binding of previous.bindings) {
      if (desiredIds.has(binding.resourceId)) continue
      await this.report(previous, binding, 'pending-gc', 'gc', null, '资源已移出期望态，等待安全回收')
    }

    // Runtime npm install is serialized across resource IDs sharing one Agent key.
    const runtimes = snapshot.bindings.filter(binding => binding.kind === 'agent-runtime')
    for (const binding of runtimes) await this.singleFlight(`runtime:${binding.agentKey}`, () => this.semaphore.use(() => this.reconcileBinding(snapshot, binding)))
    await Promise.all(snapshot.bindings.filter(binding => binding.kind !== 'agent-runtime').map(binding => this.singleFlight(binding.resourceId, async () => {
      await this.semaphore.use(() => this.reconcileBinding(snapshot, binding))
    })))
  }

  private singleFlight(key: string, operation: () => Promise<void>): Promise<void> {
    const existing = this.flights.get(key)
    if (existing) return existing
    const running = operation().finally(() => { if (this.flights.get(key) === running) this.flights.delete(key) })
    this.flights.set(key, running)
    return running
  }

  private async reconcileBinding(snapshot: ResourceSetSnapshot, binding: ResourceBindingSnapshot): Promise<void> {
    if (binding.kind === 'agent-runtime') {
      await this.reconcileRuntime(snapshot, binding)
      return
    }
    if (binding.kind !== 'skill') {
      await this.report(snapshot, binding, 'failed', null, 'unsupported_resource_kind', `尚不支持物化 ${binding.kind}`)
      return
    }
    const installed = this.state.installed(binding.resourceId)
    if (installed?.resourceRevisionId === binding.resourceRevisionId && installed.integrity !== binding.contentSha256) {
      await this.report(snapshot, binding, 'version-mismatch', null, 'resource_revision_integrity_conflict', '相同 revision 的完整性标识不同')
      return
    }
    if (await this.materializer.verify(binding)) {
      if (installed && installed.bindingId !== binding.bindingId) this.state.saveInstalled({ ...installed, bindingId: binding.bindingId })
      await this.report(snapshot, binding, 'installed', 'ready', null, null)
      return
    }
    try {
      await this.report(snapshot, binding, 'installed', 'queued', null, null)
      await this.report(snapshot, binding, 'installed', 'downloading', null, null)
      await this.report(snapshot, binding, 'installed', 'verifying', null, null)
      await this.report(snapshot, binding, 'installed', 'installing', null, null)
      await this.materializer.materialize(binding, { fetch: sha256 => this.fetchBlob(sha256) })
      await this.report(snapshot, binding, 'installed', 'ready', null, null)
    } catch (error) {
      await this.report(snapshot, binding, 'failed', null, error instanceof Error ? error.message : 'resource_materialization_failed', '资源物化失败，已保留当前激活版本')
    }
  }

  private async reconcileRuntime(snapshot: ResourceSetSnapshot, binding: ResourceBindingSnapshot): Promise<void> {
    const installed = this.state.installed(binding.resourceId)
    if (installed?.resourceRevisionId === binding.resourceRevisionId && installed.integrity !== binding.contentSha256) {
      await this.report(snapshot, binding, 'version-mismatch', null, 'resource_revision_integrity_conflict', '相同 revision 的完整性标识不同')
      return
    }
    try {
      if (installed?.activation === 'failed' && installed.resourceRevisionId === binding.resourceRevisionId) {
        await this.report(snapshot, binding, 'failed', null, 'runtime_activation_failed', 'Agent 启动探测失败，已回退到原有选择；发布新 revision 后可重试')
        return
      }
      if (await this.runtimes.verify(binding)) {
        if (installed && installed.bindingId !== binding.bindingId) this.state.saveInstalled({ ...installed, bindingId: binding.bindingId })
      } else {
        await this.report(snapshot, binding, 'installed', 'queued', null, null)
        await this.report(snapshot, binding, 'installed', 'downloading', null, null)
        await this.report(snapshot, binding, 'installed', 'verifying', null, null)
        await this.report(snapshot, binding, 'installed', 'installing', null, null)
        await this.runtimes.materialize(binding)
      }
      const current = this.state.installed(binding.resourceId)
      if (current?.activation === 'ready') await this.report(snapshot, binding, 'installed', 'ready', null, null)
      else if (current?.activation === 'credential-required') await this.report(snapshot, binding, 'installed', 'credential-required', null, 'Agent 已安装，但模型凭证或配置不可用')
      else if (current?.activation === 'failed') await this.report(snapshot, binding, 'failed', null, 'runtime_activation_failed', 'Agent 启动探测失败，已回退到原有选择')
      else await this.report(snapshot, binding, 'installed', 'restart-required', null, 'Agent 已安装并通过版本探测，等待安全重启')
    } catch (error) {
      await this.report(snapshot, binding, 'failed', null, error instanceof Error ? error.message : 'runtime_materialization_failed', 'Agent 安装或探测失败，已保留当前激活版本')
    }
  }

  private async fetchBlob(sha256: string): Promise<Uint8Array> {
    const requestId = randomUUID()
    const result = this.pending(this.blobs, requestId, { sha256 })
    try {
      const request: Extract<ResourceBlobFetchPayload, { readonly action: 'request' }> = { type: 'resource.blob.fetch', action: 'request', requestId, sha256 }
      await this.transport.send(request)
      return await result
    } finally { this.release(this.blobs, requestId) }
  }

  private pending<T, Extra extends object>(map: Map<string, PendingRequest<T> & Extra>, id: string, extra: Extra): Promise<T>
  private pending<T>(map: Map<string, PendingRequest<T>>, id: string): Promise<T>
  private pending<T, Extra extends object>(map: Map<string, PendingRequest<T> & Extra>, id: string, extra?: Extra): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        map.delete(id)
        reject(new Error('resource_request_timeout'))
      }, requestTimeoutMs)
      map.set(id, { ...extra, resolve, reject, timer } as PendingRequest<T> & Extra)
    })
  }

  private release<T>(map: Map<string, PendingRequest<T>>, id: string): void {
    const pending = map.get(id)
    if (pending) { clearTimeout(pending.timer); map.delete(id) }
  }

  private async report(snapshot: ResourceSetSnapshot, binding: ResourceBindingSnapshot, result: ReconcileReport['result'], phase: ResourceReconcilePhase | null, errorCode: string | null, message: string | null): Promise<void> {
    const report: ReconcileReport = {
      requestId: randomUUID(), workerId: this.workerId, resourceSetRevision: snapshot.revision,
      bindingId: binding.bindingId, bindingRevision: binding.bindingRevision,
      resourceRevisionId: binding.resourceRevisionId, resourceId: binding.resourceId, kind: binding.kind,
      integrity: binding.contentSha256, result, phase, progressBytes: null, errorCode, message,
      activeRevision: null, previousRevision: null, occurredAt: this.now(),
    }
    await this.transport.send({ type: 'resource.reconcile.report', report })
  }
}
