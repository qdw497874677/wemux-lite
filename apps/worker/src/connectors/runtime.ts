import { randomBytes } from 'node:crypto'
import type { CapabilityGrantClaims, CapabilitySnapshot, Turn } from '@wemux/domain'
import type { McpConnectorDefinition } from '@wemux/connector'
import { WorkerCredentialStore } from './credential-store.js'
import { WorkerMcpClient } from './mcp-client.js'
import { McpProcessSupervisor } from './mcp-process-supervisor.js'
import { ToolExecutionGateway, type ConnectorApprovalPort, type ConnectorApprovalRequest } from './tool-execution-gateway.js'
import type { WorkerConnectorStore } from './store.js'

interface ActiveTurn { readonly token: string; readonly snapshot: CapabilitySnapshot; readonly claims: CapabilityGrantClaims; readonly workerId: string }
type Pending = ConnectorApprovalRequest & { readonly id: string; readonly createdAt: string; resolve(decision: 'approve' | 'deny'): void; readonly timer: NodeJS.Timeout }

export class WorkerConnectorRuntime {
  readonly credentials: WorkerCredentialStore
  readonly supervisor: McpProcessSupervisor
  readonly mcp: WorkerMcpClient
  readonly gateway: ToolExecutionGateway
  private readonly turns = new Map<string, ActiveTurn>()
  private readonly pending = new Map<string, Pending>()

  constructor(readonly store: WorkerConnectorStore, options: { readonly fetch?: typeof fetch; readonly lookup?: import('@wemux/connector').GuardedFetchDnsLookup; readonly supervisor?: McpProcessSupervisor } = {}) {
    this.credentials = WorkerCredentialStore.fromEnvironment(store)
    this.supervisor = options.supervisor ?? new McpProcessSupervisor()
    this.mcp = new WorkerMcpClient({ supervisor: this.supervisor, fetch: options.fetch, lookup: options.lookup, deploymentAllowsPrivateNetwork: process.env.WEMUX_CONNECTOR_ALLOW_PRIVATE_NETWORK === 'true' })
    const approval: ConnectorApprovalPort = { request: input => this.requestApproval(input) }
    this.gateway = new ToolExecutionGateway(store, this.credentials, this.mcp, { verify: token => {
      const active = this.turns.get(token)
      if (!active) throw new Error('Unknown capability token')
      return active.claims
    } }, approval)
  }

  async registerTurn(turn: Turn, workerId: string): Promise<{ token: string; snapshot: CapabilitySnapshot; release(): Promise<void> }> {
    const connectors = (await this.store.listConnectorDefinitions()).filter(definition => definition.kind === 'mcp' && definition.enabled && (!definition.allowedWorkerIds.length || definition.allowedWorkerIds.includes(workerId as never)))
    const existing = turn.capabilitySnapshot
    const snapshot: CapabilitySnapshot = existing ? { ...existing, allowedConnectorIds: intersect(existing.allowedConnectorIds ?? [], connectors.map(item => item.id)) } : {
      id: `local-${turn.id}`, projectId: 'local' as never, workspaceId: 'local' as never, sessionId: turn.sessionId, version: 1, assets: [], allowedTools: ['mcp.list_tools', 'mcp.call'], allowedConnectorIds: connectors.map(item => item.id), createdAt: new Date().toISOString(),
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
  listApprovals() { return [...this.pending.values()].map(({ resolve: _resolve, timer: _timer, ...item }) => item) }
  resolveApproval(id: string, decision: 'approve' | 'deny') { const pending = this.pending.get(id); if (!pending) return false; pending.resolve(decision); return true }

  async shutdown() {
    for (const pending of this.pending.values()) pending.resolve('deny')
    this.turns.clear()
    await this.mcp.shutdown()
  }
  forceShutdown() { for (const pending of this.pending.values()) pending.resolve('deny'); this.turns.clear(); this.mcp.forceShutdown() }

  private requestApproval(input: ConnectorApprovalRequest): Promise<'approve' | 'deny'> {
    const id = `${input.requestId}:${input.toolCallId}`
    return new Promise(resolve => {
      const finish = (decision: 'approve' | 'deny') => { const pending = this.pending.get(id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(id); resolve(decision) }
      const timer = setTimeout(() => finish('deny'), 5 * 60_000); timer.unref()
      this.pending.set(id, { ...input, id, createdAt: new Date().toISOString(), timer, resolve: finish })
    })
  }
}

function intersect<T>(left: readonly T[], right: readonly T[]) { const allowed = new Set(right); return left.filter(value => allowed.has(value)) }
function validateDefinition(definition: McpConnectorDefinition) {
  if (definition.kind !== 'mcp' || !definition.id || !definition.name || !Number.isSafeInteger(definition.revision) || definition.revision < 1) throw new Error('Invalid MCP connector definition')
  if (definition.config.transport === 'streamable_http') new URL(definition.config.url)
}
