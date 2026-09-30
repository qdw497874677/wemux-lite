import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertModelProviderConfig, type AgentKey, type ModelId, type ProjectId, type ReconcileReport, type ResourceBindingSnapshot, type ResourceReconcilePhase, type ResourceSetSnapshot, type Timestamp, type WorkerId } from '@wemux/domain'
import type { ResourceBlobFetchPayload, ServerResourcePayload, WorkerPayload } from '@wemux/wire-protocol'
import { ResourceStateStore } from './resource-state-store.ts'
import { SkillMaterializer } from './skill-materializer.ts'
import { RuntimeMaterializer } from './runtime-materializer.ts'
import { stageAgentRuntime } from '../runtimes/management.ts'
import type { RuntimeProcess } from '../runtimes/management.ts'
import type { WorkerProviderCredentialStore } from '../providers/credential-store.ts'

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
  readonly environment?: NodeJS.ProcessEnv
  readonly providerCredentials?: Pick<WorkerProviderCredentialStore, 'resolve'>
}

export class ResourceReconciler {
  private readonly workerId: WorkerId
  private readonly transport: ResourceTransport
  private readonly state: ResourceStateStore
  private readonly materializer: SkillMaterializer
  private readonly runtimes: RuntimeMaterializer
  private readonly environment: NodeJS.ProcessEnv
  private readonly providerCredentials?: Pick<WorkerProviderCredentialStore, 'resolve'>
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
    this.environment = options.environment ?? process.env
    this.providerCredentials = options.providerCredentials
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

  /** Select only a fresh, exact binding. This returns no Secret and is not a model-availability probe. */
  async providerForLaunch(projectId: ProjectId, agentKey: AgentKey, modelId: ModelId | null): Promise<{ resourceId: string; resourceRevisionId: string; bindingId: string; providerKey: string; modelId: string } | null> {
    if (!modelId) return null
    const divider = modelId.indexOf('::')
    if (divider < 1 || divider === modelId.length - 2) return null
    const providerKey = modelId.slice(0, divider)
    const selectedModel = modelId.slice(divider + 2)
    if (this.closed || !this.snapshotFresh) throw new Error('provider_snapshot_unavailable')
    const desired = this.state.desired()
    if (!desired) throw new Error('provider_snapshot_unavailable')
    const epoch = this.connectionEpoch
    const matches = desired.bindings.filter(binding => binding.kind === 'model-provider' && (binding.projectId === null || binding.projectId === projectId) && (binding.agentKey === null || binding.agentKey === agentKey) && binding.provider?.config.providerKey === providerKey && binding.provider.config.modelIds.includes(selectedModel))
    if (!matches.length) return null
    const priority = Math.max(...matches.map(binding => Number(binding.projectId !== null) * 2 + Number(binding.agentKey !== null)))
    const candidates = matches.filter(binding => Number(binding.projectId !== null) * 2 + Number(binding.agentKey !== null) === priority)
    if (candidates.length !== 1) throw new Error('provider_binding_conflict')
    const binding = candidates[0]!
    const provider = binding.provider!
    if (provider.mode !== 'inline-config' || provider.contentSha256 !== binding.contentSha256 || binding.files.length || binding.artifact || createHash('sha256').update(JSON.stringify(provider.config)).digest('hex') !== binding.contentSha256) throw new Error('provider_binding_invalid')
    try { assertModelProviderConfig(provider.config) } catch { throw new Error('provider_binding_invalid') }
    if (!provider.config.agentKeys.includes(agentKey)) throw new Error('provider_binding_invalid')
    const locator = provider.config.credential
    if (locator.kind === 'environment') {
      if (!locator.variableNames.every(name => typeof this.environment[name] === 'string' && Boolean(this.environment[name]?.trim()))) throw new Error('provider_credential_unavailable')
    } else {
      if (!this.providerCredentials) throw new Error('provider_credential_unavailable')
      try { await this.providerCredentials.resolve(locator.credentialRef, locator.variableNames) }
      catch { throw new Error('provider_credential_unavailable') }
    }
    // A revocation, reconnect or new desired set during async decryption invalidates selection.
    if (this.closed || !this.snapshotFresh || this.connectionEpoch !== epoch || this.announcedRevision > desired.revision || this.state.desired()?.revision !== desired.revision || this.state.desired()?.fingerprint !== desired.fingerprint || !this.state.desired()?.bindings.some(current => current.bindingId === binding.bindingId && current.bindingRevision === binding.bindingRevision && current.resourceRevisionId === binding.resourceRevisionId && current.contentSha256 === binding.contentSha256)) throw new Error('provider_snapshot_unavailable')
    return { resourceId: binding.resourceId, resourceRevisionId: binding.resourceRevisionId, bindingId: binding.bindingId, providerKey, modelId: selectedModel }
  }

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
    if (binding.kind === 'model-provider') {
      const provider = binding.provider
      try {
        if (!provider || provider.mode !== 'inline-config' || provider.contentSha256 !== binding.contentSha256 || createHash('sha256').update(JSON.stringify(provider.config)).digest('hex') !== binding.contentSha256 || binding.files.length || binding.artifact) throw new Error('invalid_provider_config')
        assertModelProviderConfig(provider.config)
        if (binding.agentKey && !provider.config.agentKeys.includes(binding.agentKey)) throw new Error('invalid_provider_binding')
      } catch {
        await this.report(snapshot, binding, 'failed', null, 'invalid_provider_config', '模型供应商配置无效')
        return
      }
      const locator = provider.config.credential
      const names = locator.variableNames
      let configured = false
      if (locator.kind === 'environment') configured = names.every(name => typeof this.environment[name] === 'string' && Boolean(this.environment[name]?.trim()))
      else if (this.providerCredentials) {
        try {
          // Only check whether the local owner can resolve the declared fields;
          // never persist, transmit or report the resolved values.
          await this.providerCredentials.resolve(locator.credentialRef, names)
          configured = true
        } catch { /* Missing key, stale fields, revoked or tampered credentials fail closed. */ }
      }
      if (configured) await this.report(snapshot, binding, 'installed', 'credential-required', null, '本地模型凭据已配置；尚未验证模型探测或 Agent 注入')
      else await this.report(snapshot, binding, 'installed', 'credential-required', 'credential_required', '需要在 Worker 本地配置模型凭据')
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
