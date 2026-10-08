import { randomBytes } from 'node:crypto'
import type { CapabilityGrantClaims, CapabilitySnapshot, Turn } from '@wemux/domain'
import type { ConnectorDefinition, HttpConnectorDefinition, McpConnectorDefinition } from '@wemux/connector'
import type { ConnectorRevisionReport } from '@wemux/wire-protocol'
import { HttpConnectorExecutor } from './http-executor.ts'
import { WorkerCredentialStore } from './credential-store.ts'
import { WorkerMcpClient } from './mcp-client.ts'
import { McpProcessSupervisor } from './mcp-process-supervisor.ts'
import { ToolExecutionGateway, type ConnectorApprovalPort, type ConnectorApprovalRequest } from './tool-execution-gateway.ts'
import type { WorkerConnectorStore } from './store.js'

interface ActiveTurn { readonly token: string; readonly snapshot: CapabilitySnapshot; readonly claims: CapabilityGrantClaims; readonly workerId: string }
type ExpiryReason = 'timeout' | 'cancelled' | 'turn_released' | 'shutdown'
type Pending = ConnectorApprovalRequest & { readonly id: string; readonly createdAt: string; resolve(decision: 'approve' | 'deny'): void; expire(reason: ExpiryReason): Promise<void>; readonly timer: NodeJS.Timeout }
export type ConnectorApprovalEvent = { readonly kind: 'requested'; readonly approval: Omit<Pending, 'resolve' | 'expire' | 'timer'> } | { readonly kind: 'expired'; readonly sessionId: string; readonly turnId: string; readonly approvalId: string; readonly reason: ExpiryReason; readonly occurredAt: string }

export class WorkerConnectorRuntime {
  readonly store: WorkerConnectorStore
  readonly credentials: WorkerCredentialStore
  readonly supervisor: McpProcessSupervisor
  readonly mcp: WorkerMcpClient
  readonly gateway: ToolExecutionGateway
  readonly http: HttpConnectorExecutor
  private readonly turns = new Map<string, ActiveTurn>()
  private readonly pending = new Map<string, Pending>()
  private readonly finalizing = new Map<string, { sessionId: string; turnId: string; done: Promise<void> }>()
  private closing = false
  private shutdownPromise: Promise<void> | null = null

  constructor(store: WorkerConnectorStore, options: { readonly fetch?: typeof fetch; readonly lookup?: import('@wemux/connector').GuardedFetchDnsLookup; readonly supervisor?: McpProcessSupervisor; readonly onApproval?: (event: ConnectorApprovalEvent) => void | Promise<void> } = {}) {
    this.store = store
    this.credentials = WorkerCredentialStore.fromEnvironment(store)
    this.supervisor = options.supervisor ?? new McpProcessSupervisor()
    this.mcp = new WorkerMcpClient({ supervisor: this.supervisor, fetch: options.fetch, lookup: options.lookup, deploymentAllowsPrivateNetwork: process.env.WEMUX_CONNECTOR_ALLOW_PRIVATE_NETWORK === 'true' })
    this.http = new HttpConnectorExecutor(this.credentials, { fetch: options.fetch, lookup: options.lookup, deploymentAllowsPrivateNetwork: process.env.WEMUX_CONNECTOR_ALLOW_PRIVATE_NETWORK === 'true' })
    const approval: ConnectorApprovalPort = { request: (input, signal) => this.requestApproval(input, signal, options.onApproval) }
    this.gateway = new ToolExecutionGateway(store, this.credentials, this.mcp, { verify: token => {
      const active = this.turns.get(token)
      if (!active) throw new Error('Unknown capability token')
      return active.claims
    } }, approval, this.http)
  }

  async registerTurn(turn: Turn, workerId: string): Promise<{ token: string; snapshot: CapabilitySnapshot; release(): Promise<void> }> {
    if (this.closing) throw new Error('Connector runtime is shutting down')
    const installed = (await this.store.listConnectorDefinitions()).filter(definition => definition.enabled && (!definition.allowedWorkerIds.length || definition.allowedWorkerIds.includes(workerId as never)))
    const existing = turn.capabilitySnapshot
    const pinned = existing?.connectors ?? installed
    for (const definition of pinned) {
      const local = installed.find(item => item.id === definition.id && item.revision === definition.revision)
      if (local) await this.store.saveConnectorDefinition({ ...local, credentialAvailability: definition.credentialAvailability })
    }
    const connectorIds = intersect(existing?.allowedConnectorIds ?? installed.map(item => item.id), installed.map(item => item.id))
    const connectors = pinned.filter(item => connectorIds.includes(item.id as never))
    const snapshot: CapabilitySnapshot = existing ? { ...existing, allowedConnectorIds: connectorIds, connectors } : {
      id: `local-${turn.id}`, projectId: 'local' as never, workspaceId: 'local' as never, sessionId: turn.sessionId, version: 1, assets: [], allowedTools: ['mcp.list_tools', 'mcp.call', 'http.call'], allowedConnectorIds: connectorIds, connectors, createdAt: new Date().toISOString(),
    }
    const token = turn.capabilityToken ?? randomBytes(32).toString('base64url')
    const claims: CapabilityGrantClaims = { id: `worker-${turn.id}`, sessionId: turn.sessionId, turnId: turn.id, actorAgentId: turn.sessionId, projectId: snapshot.projectId, workspaceId: snapshot.workspaceId, allowedTools: snapshot.allowedTools, allowedConnectorIds: snapshot.allowedConnectorIds, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }
    if (this.closing) throw new Error('Connector runtime is shutting down')
    this.turns.set(token, { token, snapshot, claims, workerId })
    return { token, snapshot, release: async () => {
      this.turns.delete(token)
      await Promise.all([...this.pending.values()].filter(pending => pending.sessionId === turn.sessionId && pending.turnId === turn.id).map(pending => pending.expire('turn_released')))
      await Promise.all([...this.finalizing.values()].filter(item => item.sessionId === turn.sessionId && item.turnId === turn.id).map(item => item.done))
      await this.mcp.releaseSession(turn.sessionId)
    } }
  }

  async handle(operation: string, token: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const active = this.turns.get(token)
    if (!active) return { status: 401, body: { error: 'Invalid capability token' } }
    const common = { token, snapshot: active.snapshot, currentTurn: { sessionId: active.claims.sessionId, turnId: active.claims.turnId, projectId: active.claims.projectId, workspaceId: active.claims.workspaceId, workerId: active.workerId }, connectorId: String(input.connectorId ?? ''), agentSupportsApproval: true, signal }
    if (operation === 'mcp.list_tools') return { status: 200, body: await this.gateway.listTools(common) }
    if (operation === 'mcp.call') return { status: 200, body: await this.gateway.execute({ ...common, requestId: String(input.requestId ?? ''), toolCallId: String(input.toolCallId ?? '') as never, connectorRevision: Number(input.connectorRevision), toolName: String(input.toolName ?? ''), input: input.arguments ?? {} }) }
    if (operation === 'http.call') return { status: 200, body: await this.gateway.executeHttp({ ...common, requestId: String(input.requestId ?? ''), toolCallId: String(input.toolCallId ?? '') as never, connectorRevision: Number(input.connectorRevision), operationId: String(input.operationId ?? ''), input: httpInput(input.input) }) }
    return null
  }

  listDefinitions() { return this.store.listConnectorDefinitions() }
  async saveDefinition(definition: McpConnectorDefinition) {
    validateDefinition(definition)
    const existing = await this.store.getConnectorDefinition(definition.id)
    if (existing && definition.revision <= existing.revision) throw new Error('Connector revision must increase')
    await this.store.saveConnectorDefinition(definition)
    return definition
  }
  deleteDefinition(id: string) { return this.store.deleteConnectorDefinition(id) }
  async syncClusterDefinition(definition: ConnectorDefinition, workerId: string): Promise<{ status: ConnectorRevisionReport['status']; credentialAvailability: ConnectorRevisionReport['credentialAvailability']; message: string }> {
    if (definition.allowedWorkerIds.length && !definition.allowedWorkerIds.includes(workerId as never)) return { status: 'revoked', credentialAvailability: 'unconfigured', message: 'Connector is outside this Worker scope' }
    const state = await this.store.saveClusterConnectorDefinition(definition)
    const credentialAvailability = await this.credentialAvailability(definition)
    return { status: definition.enabled ? (credentialAvailability === 'unavailable' || credentialAvailability === 'invalid' ? 'unavailable' : 'applied') : 'revoked', credentialAvailability, message: state === 'stale' ? 'Newer Connector revision is already installed' : 'Connector revision synchronized' }
  }
  async testClusterDefinition(connectorId: string, revision: number): Promise<{ status: ConnectorRevisionReport['status']; credentialAvailability: ConnectorRevisionReport['credentialAvailability']; message: string }> {
    const definition = await this.store.getConnectorDefinition(connectorId)
    if (!definition || definition.revision !== revision || !definition.enabled) return { status: 'test_failed', credentialAvailability: 'unconfigured', message: 'Connector revision is unavailable' }
    const availability = await this.credentialAvailability(definition)
    if (availability !== 'not_required' && availability !== 'available') return { status: 'test_failed', credentialAvailability: availability, message: 'Connector credential is unavailable' }
    try {
      if (definition.kind !== 'http') throw new Error('Only HTTP Connector test is supported by this command')
      await this.http.test(definition)
      return { status: 'test_succeeded', credentialAvailability: availability, message: 'Connection test succeeded' }
    } catch (error) { return { status: 'test_failed', credentialAvailability: await this.credentialAvailability(definition), message: safeMessage(error) } }
  }
  private async credentialAvailability(definition: ConnectorDefinition): Promise<ConnectorRevisionReport['credentialAvailability']> {
    if (definition.kind === 'http' && definition.config.authentication === 'none') return 'not_required'
    if (definition.kind === 'mcp' && definition.config.transport === 'streamable_http' && definition.config.authentication === 'none') return 'not_required'
    if (!definition.credentialRef) return 'unconfigured'
    if (!this.credentials.available) return 'unavailable'
    try { await this.credentials.resolve(definition.credentialRef, definition.id); return 'available' } catch { return 'invalid' }
  }
  listApprovals() { return [...this.pending.values()].map(({ resolve: _resolve, expire: _expire, timer: _timer, ...item }) => item) }
  hasPendingApproval(sessionId: string, turnId: string) { return [...this.pending.values()].some(item => item.sessionId === sessionId && item.turnId === turnId) }
  resolveApproval(identity: { sessionId: string; turnId: string; approvalId: string; decision: 'approve' | 'deny' }) {
    const pending = this.pending.get(approvalKey(identity))
    if (!pending) {
      if ([...this.pending.values()].some(item => item.approvalId === identity.approvalId)) throw new Error('Connector approval identity mismatch')
      return false
    }
    if (![...this.turns.values()].some(turn => turn.claims.sessionId === identity.sessionId && turn.claims.turnId === identity.turnId)) throw new Error('Connector approval Turn is no longer active')
    pending.resolve(identity.decision)
    return true
  }

  shutdown(): Promise<void> {
    this.closing = true
    this.turns.clear() // Fence preparation before the first publication await.
    this.shutdownPromise ??= (async () => {
      await Promise.all([...this.pending.values()].map(pending => pending.expire('shutdown')))
      await Promise.all([...this.finalizing.values()].map(item => item.done))
      await this.mcp.shutdown()
    })()
    return this.shutdownPromise
  }
  forceShutdown() { this.closing = true; this.turns.clear(); for (const pending of this.pending.values()) void pending.expire('shutdown'); this.mcp.forceShutdown() }

  private requestApproval(input: ConnectorApprovalRequest, signal?: AbortSignal, onApproval?: (event: ConnectorApprovalEvent) => void | Promise<void>): Promise<'approve' | 'deny'> {
    // Preparation may have awaited storage or discovery while the Turn ended.
    if (signal?.aborted || ![...this.turns.values()].some(turn => turn.claims.sessionId === input.sessionId && turn.claims.turnId === input.turnId)) return Promise.resolve('deny')
    const id = input.approvalId
    const key = approvalKey(input)
    if (this.pending.has(key) || this.finalizing.has(key)) throw new Error('Connector approval is already pending')
    return new Promise((resolve, reject) => {
      // Persist request before any terminal event, even when cancellation races publication.
      const published = Promise.resolve().then(() => onApproval?.({ kind: 'requested', approval }))
      const finish = (decision: 'approve' | 'deny', reason?: ExpiryReason): Promise<void> => {
        const existing = this.finalizing.get(key)
        if (existing) return existing.done
        const pending = this.pending.get(key)
        if (!pending) return Promise.resolve()
        clearTimeout(pending.timer); this.pending.delete(key); signal?.removeEventListener('abort', abort)
        // Install the tracked promise before invoking asynchronous publication.
        // Non-actionable approvals must remain drainable by release/shutdown.
        const done = Promise.resolve().then(async () => {
          try {
            await published
            // Human decisions are journaled by WorkerRuntime with the authenticated actor.
            if (reason) await onApproval?.({ kind: 'expired', sessionId: input.sessionId, turnId: input.turnId, approvalId: id, reason, occurredAt: new Date().toISOString() })
            resolve(decision)
          } catch (error) { reject(error) }
          finally { this.finalizing.delete(key) }
        })
        this.finalizing.set(key, { sessionId: input.sessionId, turnId: input.turnId, done })
        return done
      }
      const abort = () => { void finish('deny', 'cancelled') }
      const timer = setTimeout(() => { void finish('deny', 'timeout') }, 5 * 60_000); timer.unref()
      const pending: Pending = { ...input, id, createdAt: new Date().toISOString(), timer, resolve: decision => { void finish(decision) }, expire: reason => finish('deny', reason) }
      const { resolve: _resolve, expire: _expire, timer: _timer, ...approval } = pending
      this.pending.set(key, pending)
      signal?.addEventListener('abort', abort, { once: true })
      void published.catch(error => { void finish('deny'); reject(error) })
    })
  }
}

function approvalKey(identity: { sessionId: string; turnId: string; approvalId: string }) { return JSON.stringify([identity.sessionId, identity.turnId, identity.approvalId]) }
function intersect<T>(left: readonly T[], right: readonly T[]) { const allowed = new Set(right); return left.filter(value => allowed.has(value)) }
function httpInput(value: unknown) { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, never> : {} }
function safeMessage(error: unknown): string { const value = error instanceof Error ? error.message : 'Connector test failed'; return value.replace(/(?:Basic|Bearer)\s+\S+/gi, '[redacted]').slice(0, 512) }
function validateDefinition(definition: McpConnectorDefinition) {
  if (definition.kind !== 'mcp' || !definition.id || !definition.name || !Number.isSafeInteger(definition.revision) || definition.revision < 1) throw new Error('Invalid MCP connector definition')
  if (definition.config.transport === 'streamable_http') new URL(definition.config.url)
}
