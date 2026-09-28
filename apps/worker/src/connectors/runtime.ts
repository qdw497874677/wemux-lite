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
type Pending = ConnectorApprovalRequest & { readonly id: string; readonly createdAt: string; resolve(decision: 'approve' | 'deny'): void; readonly timer: NodeJS.Timeout }
export type ConnectorApprovalEvent = { readonly kind: 'requested'; readonly approval: Omit<Pending, 'resolve' | 'timer'> } | { readonly kind: 'resolved'; readonly approvalId: string; readonly decision: 'approve' | 'deny' }

export class WorkerConnectorRuntime {
  readonly store: WorkerConnectorStore
  readonly credentials: WorkerCredentialStore
  readonly supervisor: McpProcessSupervisor
  readonly mcp: WorkerMcpClient
  readonly gateway: ToolExecutionGateway
  readonly http: HttpConnectorExecutor
  private readonly turns = new Map<string, ActiveTurn>()
  private readonly pending = new Map<string, Pending>()

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
    this.turns.set(token, { token, snapshot, claims, workerId })
    return { token, snapshot, release: async () => { this.turns.delete(token); await this.mcp.releaseSession(turn.sessionId) } }
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
  listApprovals() { return [...this.pending.values()].map(({ resolve: _resolve, timer: _timer, ...item }) => item) }
  resolveApproval(id: string, decision: 'approve' | 'deny') { const pending = this.pending.get(id); if (!pending) return false; pending.resolve(decision); return true }

  async shutdown() {
    for (const pending of this.pending.values()) pending.resolve('deny')
    this.turns.clear()
    await this.mcp.shutdown()
  }
  forceShutdown() { for (const pending of this.pending.values()) pending.resolve('deny'); this.turns.clear(); this.mcp.forceShutdown() }

  private requestApproval(input: ConnectorApprovalRequest, signal?: AbortSignal, onApproval?: (event: ConnectorApprovalEvent) => void | Promise<void>): Promise<'approve' | 'deny'> {
    const id = input.approvalId
    return new Promise(resolve => {
      const finish = (decision: 'approve' | 'deny') => { const pending = this.pending.get(id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(id); signal?.removeEventListener('abort', abort); void onApproval?.({ kind: 'resolved', approvalId: id, decision }); resolve(decision) }
      const abort = () => finish('deny')
      const timer = setTimeout(() => finish('deny'), 5 * 60_000); timer.unref()
      const pending = { ...input, id, createdAt: new Date().toISOString(), timer, resolve: finish }
      this.pending.set(id, pending)
      signal?.addEventListener('abort', abort, { once: true })
      const { resolve: _resolve, timer: _timer, ...approval } = pending
      void onApproval?.({ kind: 'requested', approval })
    })
  }
}

function intersect<T>(left: readonly T[], right: readonly T[]) { const allowed = new Set(right); return left.filter(value => allowed.has(value)) }
function httpInput(value: unknown) { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, never> : {} }
function safeMessage(error: unknown): string { const value = error instanceof Error ? error.message : 'Connector test failed'; return value.replace(/(?:Basic|Bearer)\s+\S+/gi, '[redacted]').slice(0, 512) }
function validateDefinition(definition: McpConnectorDefinition) {
  if (definition.kind !== 'mcp' || !definition.id || !definition.name || !Number.isSafeInteger(definition.revision) || definition.revision < 1) throw new Error('Invalid MCP connector definition')
  if (definition.config.transport === 'streamable_http') new URL(definition.config.url)
}
