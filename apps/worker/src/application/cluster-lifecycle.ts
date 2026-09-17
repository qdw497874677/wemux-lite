import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentAdapter } from './ports/agent-adapter.js'
import type { LocalState } from './ports/local-state.js'
import type { WorkerStore } from './ports/worker-store.js'
import type { SessionStore } from '@wemux/agent-interchange'
import type { CommandId } from '@wemux/domain'
import type { CommandReceipt, WorkerCommand } from '@wemux/wire-protocol'
import type { WorkerIdentity } from '../domain/worker-identity.js'
import { enroll, toSocketUrl } from '../transport/enrollment.js'
import { WebSocketTransport } from '../transport/websocket.js'
import { WorkerRuntime } from './runtime.js'
import { LocalWorkbenchError } from './local-workbench.js'
import { LocalProvisioner } from '../workspaces/local-provisioner.js'
import { runtimeAdaptersFor } from './runtime-adapters.js'
import { agentsForHome } from '../agents/detection.js'
import { agentSelections, readAgentSettings, removeAgentSelection, runtimeKey } from '../config/agent-settings.js'
import { useAgent } from '../runtimes/management.js'
import { CapabilityGateway } from '../capabilities/gateway.js'
import { FilesystemAgentLaunchContextProvider } from './agent-launch-context-provider.js'
import { serverUrl, type WorkerTransport } from '../config.js'
import { defaultProbe, preflightServer, probeCli } from '../transport/tailscale.js'
import { openTunnels, type TunnelPool } from '../transport/tailscale-tunnel.js'
import { orderEndpoints, parsePreference, resolveAutoPreference } from '../transport/endpoints.js'

export type WorkerConnectionState = {
  readonly phase: 'offline' | 'connecting' | 'online' | 'degraded'
  readonly retryAt: string | null
  readonly failure: string | null
}

export interface ClusterLifecycleOptions {
  readonly home: string
  readonly name: string
  readonly enrollmentPath: string
  readonly socketPath: string
  readonly transport?: WorkerTransport
  readonly prefer?: string
}

export class ClusterLifecycle {
  private runtime: WorkerRuntime | null = null
  private transport: WebSocketTransport | null = null
  private gateway: CapabilityGateway | null = null
  private tunnelPool: TunnelPool | null = null
  private transitions: Promise<unknown> = Promise.resolve()
  private state: WorkerConnectionState = { phase: 'offline', retryAt: null, failure: null }

  constructor(
    private readonly store: WorkerStore & LocalState & SessionStore,
    private agents: readonly AgentAdapter[],
    private readonly options: ClusterLifecycleOptions,
  ) {}

  connection() { return this.state }

  private transition<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transitions.then(operation)
    this.transitions = next.catch(() => {})
    return next
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
    const runtime = new WorkerRuntime(this.store, new LocalProvisioner(join(this.options.home, 'workspaces')), this.agents, { send: () => {} }, `local-${installation.installationId}` as import('@wemux/domain').WorkerId, installation.name, undefined, undefined, runtimeAdaptersFor(this.agents, { pi: selected.pi?.executable, claude: selected['claude-code']?.executable }))
    try {
      await runtime.initialize()
      this.runtime = runtime
    } catch (error) {
      await runtime.shutdown()
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
      const candidates = (identity.serverUrls ?? [identity.serverUrl]).map(url => toSocketUrl(url, this.options.socketPath).href)
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
      const gateway = new CapabilityGateway(urls[0])
      this.gateway = gateway
      const capabilityEndpoint = await gateway.listen()
      let runtime!: WorkerRuntime
      const transport = new WebSocketTransport({ url: urls[0], urls, credential }, message => runtime.receive(message), async () => {
        if (this.transport !== transport) return
        this.state = { phase: 'online', retryAt: null, failure: null }
        await runtime.connected()
      }, error => {
        if (this.transport === transport) this.state = { phase: 'degraded', retryAt: null, failure: error instanceof Error ? error.message : String(error) }
      })
      // Only replace the runtime once connection resources are ready. The failure
      // path restores a local runtime before allowing subsequent local commands.
      const previous = this.runtime
      this.runtime = null
      if (previous) await previous.shutdown()
      runtime = new WorkerRuntime(this.store, new LocalProvisioner(join(this.options.home, 'workspaces')), this.agents, transport, identity.workerId, identity.name ?? this.options.name, new FilesystemAgentLaunchContextProvider(this.options.home, capabilityEndpoint), undefined, runtimeAdaptersFor(this.agents, { pi: selected.pi?.executable, claude: selected['claude-code']?.executable }))
      this.runtime = runtime
      this.transport = transport
      await runtime.initialize()
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
    const pool = this.tunnelPool
    this.tunnelPool = null
    try { if (runtime) await runtime.shutdown() }
    finally {
      try { if (gateway) await gateway.close() }
      finally { if (pool) await pool.close() }
    }
  }
}
