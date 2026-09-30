import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentAdapter } from './ports/agent-adapter.js'
import type { LocalState } from './ports/local-state.js'
import type { WorkerStore } from './ports/worker-store.js'
import type { SessionStore } from '@wemux/agent-interchange'
import type { AgentKey, CommandId, Timestamp } from '@wemux/domain'
import { WorkerTransportStore } from '../transport/transport-store.js'
import type { CommandReceipt, WorkerCommand } from '@wemux/wire-protocol'
import type { WorkerIdentity } from '../domain/worker-identity.js'
import { enroll, toSocketUrl } from '../transport/enrollment.js'
import { WebSocketTransport } from '../transport/websocket.js'
import type { StateChange } from '../transport/types.js'
import { WorkerRuntime } from './runtime.js'
import { LocalWorkbenchError } from './local-workbench.js'
import { LocalProvisioner } from '../workspaces/local-provisioner.js'
import { runtimeAdaptersFor } from './runtime-adapters.js'
import type { RuntimeSessionAdapter } from './ports/runtime-session.js'
import { agentsForHome } from '../agents/detection.js'
import { agentSelections, readAgentSettings, removeAgentSelection, runtimeKey } from '../config/agent-settings.js'
import { installAgent, useAgent } from '../runtimes/management.js'
import { CapabilityGateway } from '../capabilities/gateway.js'
import { FilesystemAgentLaunchContextProvider } from './agent-launch-context-provider.js'
import { serverUrl, type WorkerTransport } from '../config.js'
import { defaultProbe, preflightServer, probeCli } from '../transport/tailscale.js'
import { openTunnels, type TunnelPool } from '../transport/tailscale-tunnel.js'
import { orderEndpoints, parsePreference, resolveAutoPreference } from '../transport/endpoints.js'
import { loadNodePty } from '../terminal/terminal-manager.js'
import { WorkerConnectorRuntime } from '../connectors/runtime.js'
import type { McpConnectorDefinition } from '@wemux/connector'
import { ResourceReconciler } from '../resources/resource-reconciler.ts'
import { WorkerProviderCredentialStore } from '../providers/credential-store.ts'
import type { ProviderCredentialRepository } from '../providers/credential-store.ts'
import type { WorkerConnectorStore } from '../connectors/store.js'

export type WorkerConnectionState = {
  readonly phase: 'offline' | 'connecting' | 'online' | 'degraded'
  readonly retryAt: string | null
  readonly failure: string | null
}

/**
 * start 的候选地址选择：显式 --server/--servers/WEMUX_SERVER_URLS 覆盖 identity 里持久化的地址，
 * 便于在不重新注册的前提下改走另一条链路。
 */
export function clusterCandidateUrls(identityUrls: readonly string[], override: readonly string[] | undefined, socketPath: string): string[] {
  const source = override && override.length > 0 ? override : identityUrls
  return source.map(url => toSocketUrl(url, socketPath).href)
}

export interface ClusterLifecycleOptions {
  readonly home: string
  readonly name: string
  readonly enrollmentPath: string
  readonly socketPath: string
  readonly transport?: WorkerTransport
  readonly prefer?: string
  /** 显式候选地址（--server/--servers/WEMUX_SERVER_URLS）。给了就覆盖 identity 里持久化的地址，
   *  便于在不重新注册的前提下改走另一条链路。 */
  readonly servers?: readonly string[]
  /** 测试或嵌入宿主可注入 runtime；生产默认按已检测 Agent 构建。 */
  readonly runtimeAdapters?: ReadonlyMap<AgentKey, RuntimeSessionAdapter>
  readonly onStateChange?: (change: StateChange) => void
  /** 不改状态但需要让使用者看到的通报，例如丢弃服务器永久拒绝的消息。 */
  readonly onNotice?: (message: string) => void
}

export class ClusterLifecycle {
  private runtime: WorkerRuntime | null = null
  private transport: WebSocketTransport | null = null
  private gateway: CapabilityGateway | null = null
  private tunnelPool: TunnelPool | null = null
  private resources: ResourceReconciler | null = null
  private readonly connectors: WorkerConnectorRuntime
  private transitions: Promise<unknown> = Promise.resolve()
  private state: WorkerConnectionState = { phase: 'offline', retryAt: null, failure: null }
  private installation: { key: string; phase: 'installing' | 'ready' | 'failed'; message: string } | null = null

  constructor(
    private readonly store: WorkerStore & LocalState & SessionStore & ProviderCredentialRepository & WorkerConnectorStore,
    private agents: readonly AgentAdapter[],
    private readonly options: ClusterLifecycleOptions,
  ) { this.connectors = new WorkerConnectorRuntime(store, { onApproval: event => this.publishConnectorApproval(event) }) }

  connection() { return this.state }

  private transition<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transitions.then(operation)
    this.transitions = next.catch(() => {})
    return next
  }

  listConnectors() { return this.connectors.listDefinitions() }
  saveConnector(definition: McpConnectorDefinition) { return this.transition(async () => {
    const existing = (await this.connectors.listDefinitions()).find(item => item.id === definition.id)
    if (existing && (existing.projectId !== 'local' || existing.kind !== 'mcp')) throw new LocalWorkbenchError('连接器标识已由集群占用')
    if (existing ? definition.revision !== existing.revision + 1 || definition.createdAt !== existing.createdAt : definition.revision !== 1) throw new LocalWorkbenchError('连接器版本冲突，请刷新后重试')
    const availability = definition.credentialRef === null ? 'not_required' : existing?.credentialRef === definition.credentialRef && existing.credentialAvailability === 'available' ? 'available' : 'unconfigured'
    return this.connectors.saveDefinition({ ...definition, credentialAvailability: availability })
  }) }
  deleteConnector(id: string) { return this.transition(async () => {
    const definition = (await this.connectors.listDefinitions()).find(item => item.id === id)
    if (!definition || definition.kind !== 'mcp' || definition.projectId !== 'local') throw new LocalWorkbenchError('本地连接器不存在')
    return this.connectors.deleteDefinition(id)
  }) }
  putConnectorCredential(input: Parameters<WorkerConnectorRuntime['credentials']['put']>[0]) { return this.transition(async () => {
    const definition = (await this.connectors.listDefinitions()).find(item => item.id === input.connectorId)
    if (!definition || definition.kind !== 'mcp' || definition.projectId !== 'local' || definition.credentialRef !== input.id) throw new LocalWorkbenchError('凭据标识必须匹配本地连接器')
    const record = await this.connectors.credentials.put(input)
    await this.connectors.saveDefinition({ ...definition, revision: definition.revision + 1, updatedAt: new Date().toISOString() as typeof definition.updatedAt, credentialAvailability: 'available' })
    return record
  }) }
  connectorCredentialAvailable() { return this.connectors.credentials.available }
  listConnectorApprovals() { return this.connectors.listApprovals() }
  resolveConnectorApproval(id: string, decision: 'approve' | 'deny') { return this.connectors.resolveApproval(id, decision) }

  private async publishConnectorApproval(event: import('../connectors/runtime.js').ConnectorApprovalEvent) {
    if (event.kind !== 'requested') return
    const approval = event.approval
    await this.store.transaction(tx => tx.appendJournal(approval.sessionId as never, [{ occurredAt: approval.createdAt as Timestamp, payload: { kind: 'approval.requested', turnId: approval.turnId as never, approvalId: approval.approvalId as never, action: { kind: 'connector', requestId: approval.requestId, toolCallId: approval.toolCallId, connectorRevision: approval.connectorRevision, operationType: approval.operationType }, reason: '连接器写操作需要批准' } }]))
  }

  async agentSettings() {
    const settings = await readAgentSettings(this.options.home)
    const capabilities = await Promise.all((await agentsForHome(this.options.home)).map(agent => agent.detect()))
    return { selections: agentSelections(settings).map(selection => ({ ...selection, selected: settings[selection.key as keyof typeof settings] !== undefined })), capabilities }
  }

  selectAgent(key: string, executable: string) {
    return this.transition(async () => {
      const selected = await useAgent(this.options.home, runtimeKey(key), executable)
      await this.reloadAgentsInternal()
      return { selected, ...(await this.agentSettings()) }
    })
  }

  resetAgent(key: string) {
    return this.transition(async () => {
      await removeAgentSelection(this.options.home, runtimeKey(key))
      await this.reloadAgentsInternal()
      return this.agentSettings()
    })
  }

  agentInstallation() { return this.installation }
  beginAgentInstallation(key: string, install: typeof installAgent = installAgent) {
    if (!['pi', 'claude-code', 'opencode'].includes(key)) throw new LocalWorkbenchError('此 Agent 不支持托管安装')
    const selected = runtimeKey(key)
    if (this.installation?.phase === 'installing') throw new LocalWorkbenchError('已有 Agent 安装正在进行')
    this.installation = { key: selected, phase: 'installing', message: '正在下载并校验固定版本的官方 npm 包，请等待。' }
    void install(this.options.home, selected, true).then(
      result => { this.installation = { key: selected, phase: 'ready', message: result.message } },
      () => { this.installation = { key: selected, phase: 'failed', message: '托管安装失败；原有选择已保留。请检查 Worker 日志和网络后重试。' } },
    )
    return this.installation
  }

  reloadAgents() { return this.transition(() => this.reloadAgentsInternal()) }

  private async reloadAgentsInternal() {
    const wasConnected = Boolean(this.transport)
    await this.stopRuntime()
    this.agents = await agentsForHome(this.options.home)
    if (wasConnected) await this.connectInternal()
    else await this.initializeLocalRuntimeInternal()
    return this.store.capabilities()
  }

  async discover(input: string) {
    try {
      const base = serverUrl(input)
      base.protocol = ['https:', 'wss:'].includes(base.protocol) ? 'https:' : 'http:'
      const response = await fetch(new URL('/api/health', base), { redirect: 'error', signal: AbortSignal.timeout(5000) })
      let name: string | undefined
      try { const body = await response.json() as { name?: unknown }; if (typeof body.name === 'string') name = body.name } catch {}
      return { serverUrl: base.origin, ok: response.ok, status: response.status, name }
    } catch (error) {
      return { serverUrl: input, ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  enroll(input: { serverUrl: string; token: string; name?: string }) {
    return this.transition(() => this.enrollInternal(input))
  }

  private async enrollInternal(input: { serverUrl: string; token: string; name?: string }) {
    if (this.store.identity()) throw new Error('Worker 已加入集群；请先退出当前集群')
    const registered = await enroll({ server: input.serverUrl, token: input.token, name: input.name?.trim() || this.options.name, enrollmentPath: this.options.enrollmentPath, socketPath: this.options.socketPath })
    const credentialPath = join(this.options.home, 'credential')
    await writeFile(credentialPath, registered.credential, { mode: 0o600 })
    await chmod(credentialPath, 0o600)
    this.store.saveIdentity(registered.identity)
    return registered.identity
  }

  executeLocal(commandId: CommandId, command: WorkerCommand): Promise<CommandReceipt> {
    return this.transition(async () => {
      if (!this.runtime) throw new Error('Worker runtime is not ready')
      return this.runtime.executeLocal(commandId, command)
    })
  }

  initializeLocalRuntime() { return this.transition(() => this.initializeLocalRuntimeInternal()) }

  private async initializeLocalRuntimeInternal() {
    if (this.runtime) return
    const installation = this.store.localInstallation()
    if (!installation) throw new Error('Worker local installation is not initialized')
    const selected = await readAgentSettings(this.options.home)
    const workerId = `local-${installation.installationId}` as import('@wemux/domain').WorkerId
    const gateway = this.gateway ?? new CapabilityGateway(null, this.connectors)
    const endpoint = await gateway.listen()
    this.gateway = gateway
    const runtime = new WorkerRuntime(this.store, new LocalProvisioner(join(this.options.home, 'workspaces')), this.agents, { send: () => {} }, workerId, installation.name, new FilesystemAgentLaunchContextProvider(this.options.home, endpoint, turn => this.connectors.registerTurn(turn, workerId)), undefined, this.options.runtimeAdapters ?? runtimeAdaptersFor(this.agents, { pi: selected.pi?.executable, opencode: selected.opencode?.executable, claude: selected['claude-code']?.executable }), null, this.connectors)
    try {
      await runtime.initialize()
      this.runtime = runtime
    } catch (error) {
      try { await runtime.shutdown() }
      finally {
        await gateway.close()
        if (this.gateway === gateway) this.gateway = null
      }
      throw error
    }
  }

  connect() { return this.transition(() => this.connectInternal()) }

  private async connectInternal() {
    if (this.transport) return
    this.state = { phase: 'connecting', retryAt: null, failure: null }
    try {
      const identity = this.requireIdentity()
      if (this.options.transport === 'nc') {
        const cli = await probeCli(defaultProbe)
        if (!cli.available) throw new Error(`WEMUX_TRANSPORT=nc 需要本机 tailscale CLI（${cli.error}）`)
      }
      const candidates = clusterCandidateUrls(identity.serverUrls ?? [identity.serverUrl], this.options.servers, this.options.socketPath)
      const auto = this.options.prefer == null ? await resolveAutoPreference(defaultProbe, candidates) : null
      const ordered = orderEndpoints(candidates, this.options.prefer == null ? auto!.prefer : parsePreference(this.options.prefer))
      const usable: string[] = []
      const deferred: string[] = []
      for (const endpoint of ordered) {
        const report = await preflightServer(defaultProbe, endpoint.url)
        ;(report.verdict === 'error' ? deferred : usable).push(endpoint.url)
      }
      const originals = usable.concat(deferred)
      const pool = this.options.transport === 'nc' ? await openTunnels(originals) : null
      const urls = pool?.localUrls ?? originals
      this.tunnelPool = pool
      const credential = await readFile(join(this.options.home, identity.credentialRef), 'utf8')
      const selected = await readAgentSettings(this.options.home)
      const gateway = this.gateway ?? new CapabilityGateway(urls[0], this.connectors)
      this.gateway = gateway
      const capabilityEndpoint = await gateway.listen()
      let runtime!: WorkerRuntime
      let resources!: ResourceReconciler
      const transportStore = new WorkerTransportStore(join(this.options.home, 'transport.sqlite'))
      const transport = new WebSocketTransport({
        url: urls[0],
        authToken: credential,
        workerId: identity.workerId,
        workerVersion: '0.1.0',
        name: identity.name ?? this.options.name,
        platform: process.platform,
        architecture: process.arch,
        store: transportStore,
        onMessage: message => {
          if (message.type === 'resource.set.notify' || message.type === 'resource.set.pull' || message.type === 'resource.blob.fetch') resources.receive(message)
          else void runtime.receive(message)
        },
        onConnected: () => {
          if (this.transport !== transport) return
          this.state = { phase: 'online', retryAt: null, failure: null }
          void resources.connected().catch(error => this.options.onNotice?.(`资源收敛失败：${error instanceof Error ? error.message : String(error)}`))
          void runtime.connected()
        },
        onNotice: message => this.options.onNotice?.(message),
        onStateChange: change => {
          if (this.transport !== transport) return
          if (change.current !== 'open') resources?.disconnected()
          if (change.current === 'connecting') this.state = { phase: 'connecting', retryAt: null, failure: null }
          if (change.current === 'backoff') this.state = { phase: 'degraded', retryAt: change.retryInMs == null ? null : new Date(Date.now() + change.retryInMs).toISOString(), failure: change.reason }
          if (change.current === 'needs-attention') {
            this.state = { phase: 'degraded', retryAt: null, failure: change.reason }
            // 终态失败：释放这条连接，让重新注册后的 resume()/connect() 能重新建立，
            // 而不是留一个再也不会重连的 transport 把后续连接请求静默挡掉。
            this.transport = null
            transport.stop()
          }
          this.options.onStateChange?.(change)
        },
      })
      // Only replace the runtime once connection resources are ready. The failure
      // path restores a local runtime before allowing subsequent local commands.
      // connect 会以新 runtime 接管同一个持久化 store。先同步强杀旧 provider，
      // 再给旧 runtime 一个有上限的收尾窗口，尽量避免两个 runtime 并发写状态；
      // 即使旧 close() 本身挂死，也不能永久阻塞新连接建立。
      const previous = this.runtime
      this.runtime = null
      if (previous) {
        previous.abort()
        await Promise.race([
          previous.shutdown().catch(() => undefined),
          new Promise<void>(resolve => setTimeout(resolve, 1000)),
        ])
      }
      resources = new ResourceReconciler({ workerId: identity.workerId, home: this.options.home, databasePath: join(this.options.home, 'resources.sqlite'), transport, concurrency: Number(process.env.WEMUX_RESOURCE_CONCURRENCY ?? '2'), providerCredentials: WorkerProviderCredentialStore.fromEnvironment(this.store) })
      runtime = new WorkerRuntime(this.store, new LocalProvisioner(join(this.options.home, 'workspaces')), this.agents, transport, identity.workerId, identity.name ?? this.options.name, new FilesystemAgentLaunchContextProvider(this.options.home, capabilityEndpoint, turn => this.connectors.registerTurn(turn, identity.workerId), (projectId, agentKey) => resources!.skillsForLaunch(projectId, agentKey), async turn => {
        const session = await this.store.sessions.get(turn.sessionId)
        const workspace = session ? await this.store.workspaces.get(session.binding.workspaceId) : null
        return session && workspace ? { projectId: workspace.projectId, agentKey: session.binding.agent.agentKey } : null
      }), undefined, this.options.runtimeAdapters ?? runtimeAdaptersFor(this.agents, { pi: selected.pi?.executable, opencode: selected.opencode?.executable, claude: selected['claude-code']?.executable }), await loadNodePty(), this.connectors)
      this.runtime = runtime
      this.resources = resources
      await runtime.initialize()
      this.transport = transport
      transport.start()
    } catch (error) {
      this.state = { phase: 'degraded', retryAt: null, failure: error instanceof Error ? error.message : String(error) }
      await this.stopRuntime()
      await this.initializeLocalRuntimeInternal()
      throw error
    }
  }

  pause() {
    return this.transition(async () => {
      await this.stopRuntime()
      this.state = { phase: 'offline', retryAt: null, failure: null }
      await this.initializeLocalRuntimeInternal()
    })
  }

  resume() { return this.connect() }

  leave() {
    return this.transition(async () => {
      const identity = this.requireIdentity()
      let warning: string | null = null
      try { await this.revokeServerEnrollment(identity) }
      catch { warning = '本地已退出集群；远端凭据撤销未确认，请在 Server 核实并撤销旧凭据' }
      await this.stopRuntime()
      this.store.clearIdentity()
      try { await rm(join(this.options.home, identity.credentialRef), { force: true }) }
      finally {
        this.state = { phase: 'offline', retryAt: null, failure: warning }
        await this.initializeLocalRuntimeInternal()
      }
      // The existing HTTP host discards return values; surface partial success rather
      // than returning 204 and silently implying that remote revocation succeeded.
      if (warning) throw new LocalWorkbenchError(warning)
    })
  }

  private async revokeServerEnrollment(identity: WorkerIdentity) {
    const credential = await readFile(join(this.options.home, identity.credentialRef), 'utf8')
    const base = serverUrl(identity.serverUrl)
    base.protocol = ['https:', 'wss:'].includes(base.protocol) ? 'https:' : 'http:'
    const endpoint = new URL(`/api/workers/${encodeURIComponent(identity.workerId)}/enrollment`, base.origin)
    const response = await fetch(endpoint, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${credential}` } })
    if (!response.ok && response.status !== 404) throw new Error(`server rejected worker leave (${response.status})`)
  }

  close() {
    return this.transition(async () => {
      await this.stopRuntime()
      await this.connectors.shutdown()
      this.state = { phase: 'offline', retryAt: null, failure: null }
    })
  }

  private requireIdentity(): WorkerIdentity {
    const identity = this.store.identity()
    if (!identity) throw new Error('Worker 尚未加入集群')
    return identity
  }

  private async stopRuntime() {
    const transport = this.transport
    this.transport = null
    transport?.stop()
    const runtime = this.runtime
    this.runtime = null
    const gateway = this.gateway
    this.gateway = null
    const resources = this.resources
    this.resources = null
    const pool = this.tunnelPool
    this.tunnelPool = null
    try {
      if (runtime) {
        // shutdown 可能因挂死的 agent turn 永不 resolve；3s 后同步 abort 强杀子进程兜底，
        // 再给 1s 让 shutdown 收尾，仍不结束则放弃等待（资源已强制释放）。
        const abortTimer = setTimeout(() => { try { runtime.abort() } catch {} }, 3000)
        try {
          await Promise.race([runtime.shutdown(), new Promise(resolve => setTimeout(resolve, 4000))])
        } finally { clearTimeout(abortTimer) }
      }
    } finally {
      try { if (resources) await resources.close() }
      finally {
        try { if (gateway) await gateway.close() }
        finally { if (pool) await pool.close() }
      }
    }
  }
}
