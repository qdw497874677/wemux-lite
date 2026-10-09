import { stableFingerprint, summarizeAgentResult, summarizeJournal, type ConnectorDefinition, type ConnectorExecutionErrorCode, type ExecutionResult, type HttpConnectorDefinition, type McpConnectorDefinition, type OperationType, type ToolCall } from '@wemux/connector'
import type { CapabilityGrantClaims, CapabilitySnapshot, CapabilityToolName, ToolCallId } from '@wemux/domain'
import { ConnectorCredentialError, WorkerCredentialStore } from './credential-store.ts'
import { McpLimitError, WorkerMcpClient } from './mcp-client.ts'
import { HttpConnectorExecutor, type HttpCallInput } from './http-executor.ts'
import type { WorkerConnectorStore } from './store.ts'

export interface ConnectorApprovalRequest {
  readonly approvalId: string
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly requestId: string
  readonly fingerprint: string
  readonly connectorRevision: number
  readonly operationType: OperationType
}

export interface ConnectorApprovalPort {
  request(input: ConnectorApprovalRequest, signal?: AbortSignal): Promise<'approve' | 'deny'>
}

export interface CapabilityVerifier {
  verify(token: string): Promise<CapabilityGrantClaims> | CapabilityGrantClaims
  verifyBinding?(token: string, snapshot: CapabilitySnapshot, turn: ToolExecutionInput['currentTurn']): Promise<boolean> | boolean
  verifyCurrentGrant?(token: string, operation: 'mcp.list_tools' | 'mcp.call' | 'http.call'): Promise<boolean>
}

export interface ToolExecutionInput {
  readonly token: string
  readonly snapshot: CapabilitySnapshot
  readonly currentTurn: { readonly sessionId: string; readonly turnId: string; readonly projectId: string; readonly workspaceId: string; readonly workerId: string }
  readonly requestId: string
  readonly toolCallId: ToolCallId
  readonly connectorId: string
  readonly connectorRevision: number
  readonly toolName: string
  readonly input: unknown
  readonly agentSupportsApproval: boolean
  readonly channelDeliveryId?: string | null
  readonly requestedByAccountId?: string | null
  readonly signal?: AbortSignal
}

export class ToolExecutionGateway {
  private readonly store: WorkerConnectorStore
  private readonly credentials: WorkerCredentialStore
  private readonly mcp: WorkerMcpClient
  private readonly http: HttpConnectorExecutor
  private readonly verifier: CapabilityVerifier
  private readonly approval?: ConnectorApprovalPort
  private readonly active = new Map<string, Promise<ExecutionResult>>()

  constructor(
    store: WorkerConnectorStore,
    credentials: WorkerCredentialStore,
    mcp: WorkerMcpClient,
    verifier: CapabilityVerifier,
    approval?: ConnectorApprovalPort,
    http = new HttpConnectorExecutor(credentials),
  ) {
    this.store = store
    this.credentials = credentials
    this.mcp = mcp
    this.http = http
    this.verifier = verifier
    this.approval = approval
  }

  async listTools(input: Omit<ToolExecutionInput, 'requestId' | 'toolCallId' | 'toolName' | 'input' | 'connectorRevision'>): Promise<ExecutionResult> {
    const requestId = `list:${input.currentTurn.turnId}:${input.connectorId}`
    try {
      await this.authorize(input.token, input.snapshot, input.currentTurn, input.connectorId, 'mcp.list_tools')
      const connector = await this.definition(input.connectorId) as McpConnectorDefinition
      this.assertConnector(input.snapshot, input.currentTurn, connector)
      const secret = await this.resolveSecret(connector)
      const catalog = await this.mcp.listTools(input.currentTurn.sessionId, connector, secret, input.signal)
      return success(summarizeAgentResult({ connectorId: connector.id, connectorRevision: connector.revision, catalogRevision: catalog.revision, tools: catalog.tools }), requestId, connector.revision)
    } catch (error) { const result = mappedFailure(error, requestId, null); await this.auditDenial({ ...input, toolName: 'mcp.list_tools' }, 'mcp.list_tools', result); return result }
  }

  async executeHttp(input: Omit<ToolExecutionInput, 'toolName'> & { readonly operationId: string; readonly input: Omit<HttpCallInput, 'operationId'> }): Promise<ExecutionResult> {
    return this.executeInternal({ ...input, input: { ...input.input, operationId: input.operationId }, toolName: input.operationId }, 'http')
  }

  async execute(input: ToolExecutionInput): Promise<ExecutionResult> {
    return this.executeInternal(input, 'mcp')
  }

  private async executeInternal(input: ToolExecutionInput, kind: 'mcp' | 'http'): Promise<ExecutionResult> {
    if (!input.requestId || Buffer.byteLength(input.requestId) > 200) return failure('invalid_input', input.requestId || '', null, 'requestId must contain at most 200 UTF-8 bytes')
    const fingerprint = stableFingerprint({ projectId: input.currentTurn.projectId, workspaceId: input.currentTurn.workspaceId, sessionId: input.currentTurn.sessionId, turnId: input.currentTurn.turnId, toolCallId: input.toolCallId, connectorId: input.connectorId, connectorRevision: input.connectorRevision, toolName: input.toolName, input: input.input })
    const operation = kind === 'http' ? 'http.call' : 'mcp.call'
    try { await this.authorize(input.token, input.snapshot, input.currentTurn, input.connectorId, operation) }
    catch (error) { const result = mappedFailure(error, input.requestId, null); await this.auditDenial(input, operation, result); return result }
    const existing = await this.store.getConnectorExecution(input.requestId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) return failure('idempotency_conflict', input.requestId, existing.toolCall.connectorRevision, 'requestId is already bound to different input')
      if (existing.result) {
        try { this.assertConnector(input.snapshot, input.currentTurn, await this.definition(input.connectorId, kind), input.connectorRevision) }
        catch (error) { const result = mappedFailure(error, input.requestId, null); await this.auditDenial(input, operation, result); return result }
        return existing.result
      }
      const active = this.active.get(input.requestId)
      if (active) return active.then(async result => {
        try { await this.authorize(input.token, input.snapshot, input.currentTurn, input.connectorId, operation); this.assertConnector(input.snapshot, input.currentTurn, await this.definition(input.connectorId, kind), input.connectorRevision); return result }
        catch (error) { const denied = mappedFailure(error, input.requestId, null); await this.auditDenial(input, operation, denied); return denied }
      })
      return failure('connector_unavailable', input.requestId, existing.toolCall.connectorRevision, 'An earlier execution is still in progress', true)
    }
    const promise = this.run(input, fingerprint, kind)
    this.active.set(input.requestId, promise)
    try { return await promise } finally { this.active.delete(input.requestId) }
  }

  private async run(input: ToolExecutionInput, fingerprint: string, kind: 'mcp' | 'http'): Promise<ExecutionResult> {
    let connector: ConnectorDefinition | null = null
    try {
      const claims = await this.authorize(input.token, input.snapshot, input.currentTurn, input.connectorId, kind === 'http' ? 'http.call' : 'mcp.call')
      connector = await this.definition(input.connectorId, kind)
      if (connector.revision !== input.connectorRevision) return failure('revision_conflict', input.requestId, connector.revision, 'Connector revision changed', true)
      this.assertConnector(input.snapshot, input.currentTurn, connector, input.connectorRevision)
      const operationType = kind === 'http' ? httpOperation(connector as HttpConnectorDefinition, input.toolName) : 'write'
      const provisionalCall: ToolCall = { requestId: input.requestId, fingerprint, projectId: input.currentTurn.projectId as never, workspaceId: input.currentTurn.workspaceId as never, sessionId: input.currentTurn.sessionId as never, turnId: input.currentTurn.turnId as never, toolCallId: input.toolCallId, connectorId: connector.id, connectorRevision: connector.revision, action: kind === 'http' ? { kind: 'http', operationId: input.toolName } : { kind: 'mcp', toolName: input.toolName }, operationType, input: input.input, actor: { kind: 'agent', agentId: claims.actorAgentId, requestedByAccountId: (input.requestedByAccountId ?? null) as never, channelDeliveryId: input.channelDeliveryId ?? null }, createdAt: new Date().toISOString() as never }
      const started = await this.store.beginConnectorExecution({ requestId: input.requestId, fingerprint, state: 'running', toolCall: provisionalCall, result: null, journalSummary: null, createdAt: provisionalCall.createdAt, completedAt: null })
      if (started === 'exists') return failure('connector_unavailable', input.requestId, connector.revision, 'Connector execution is already running', true)
      const call: ToolCall = kind === 'mcp'
        ? await this.resolveMcpCall(input, connector as McpConnectorDefinition, provisionalCall)
        : provisionalCall
      if (requiresApproval(call.operationType, connector)) {
        if (!input.agentSupportsApproval || input.channelDeliveryId || !this.approval) return await this.persist(call, failure('approval_denied', input.requestId, connector.revision, 'Interactive approval is unavailable'))
        const decision = await this.approval.request({ approvalId: call.toolCallId, sessionId: call.sessionId, turnId: call.turnId, toolCallId: call.toolCallId, requestId: call.requestId, fingerprint, connectorRevision: call.connectorRevision, operationType: call.operationType }, input.signal)
        if (decision !== 'approve') return await this.persist(call, failure('approval_denied', input.requestId, connector.revision, 'Connector call was denied'))
      }
      await this.authorize(input.token, input.snapshot, input.currentTurn, input.connectorId, kind === 'http' ? 'http.call' : 'mcp.call')
      this.assertConnector(input.snapshot, input.currentTurn, await this.definition(input.connectorId, kind), input.connectorRevision)
      if (input.signal?.aborted) return await this.persist(call, failure('cancelled', input.requestId, connector.revision, 'Connector call was cancelled'))
      const http = kind === 'http' ? await this.http.execute(connector as HttpConnectorDefinition, input.input as HttpCallInput, input.signal) : null
      const output = http ? http.agentSummary : await this.mcp.callTool(input.currentTurn.sessionId, connector as McpConnectorDefinition, await this.resolveSecret(connector), input.toolName, input.input, input.signal)
      if (http) {
        const response = output as { status?: number; ok?: boolean }
        if (response.ok === false && typeof response.status === 'number') {
          // An upstream HTTP error is a failed Connector execution, not a
          // successful write. Do not infer that a sent write is safe to retry.
          const throttled = response.status === 429
          return await this.persist(call, failure(throttled ? 'rate_limited' : 'upstream_error', input.requestId, connector.revision, throttled ? 'Connector upstream rate limited the call' : 'Connector upstream returned an error', throttled && operationType === 'read', throttled ? http.retryAfterMs : null))
        }
      }
      const agentResult = summarizeAgentResult(output)
      if (JSON.stringify(agentResult) === '"[truncated]"' || Buffer.byteLength(JSON.stringify(agentResult)) > 256 * 1024) return await this.persist(call, failure('response_too_large', input.requestId, connector.revision, 'MCP result exceeds the Agent output limit'))
      return await this.persist(call, success(agentResult, input.requestId, connector.revision))
    } catch (error) {
      const result = mappedFailure(error, input.requestId, connector?.revision ?? null)
      await this.auditDenial(input, kind === 'http' ? 'http.call' : 'mcp.call', result)
      const record = await this.store.getConnectorExecution(input.requestId)
      return record ? this.persist(record.toolCall, result) : result
    }
  }

  private async authorize(token: string, snapshot: CapabilitySnapshot, turn: ToolExecutionInput['currentTurn'], connectorId: string, operation: CapabilityToolName) {
    let claims: CapabilityGrantClaims
    try { claims = await this.verifier.verify(token) } catch { throw new GatewayError('scope_denied', 'Invalid capability token') }
    if (this.verifier.verifyBinding && !(await this.verifier.verifyBinding(token, snapshot, turn))) throw new GatewayError('scope_denied', 'Capability lease or binding changed')
    if ((operation === 'mcp.list_tools' || operation === 'mcp.call' || operation === 'http.call') && this.verifier.verifyCurrentGrant && !(await this.verifier.verifyCurrentGrant(token, operation))) throw new GatewayError('scope_denied', 'Server grant revoked')
    if (claims.sessionId !== turn.sessionId || claims.turnId !== turn.turnId || claims.projectId !== turn.projectId || claims.workspaceId !== turn.workspaceId || snapshot.sessionId !== turn.sessionId || snapshot.projectId !== turn.projectId || snapshot.workspaceId !== turn.workspaceId || !snapshot.allowedConnectorIds.includes(connectorId) || !claims.allowedConnectorIds.includes(connectorId)) throw new GatewayError('scope_denied', 'Capability is not bound to this Turn and connector')
    if (!claims.allowedTools.includes(operation) || !snapshot.allowedTools.includes(operation)) throw new GatewayError('scope_denied', `Capability ${operation} is not allowed`)
    if (!Number.isFinite(Date.parse(claims.expiresAt)) || Date.parse(claims.expiresAt) <= Date.now()) throw new GatewayError('scope_denied', 'Capability token expired')
    return claims
  }

  private assertConnector(snapshot: CapabilitySnapshot, turn: ToolExecutionInput['currentTurn'], connector: ConnectorDefinition, revision?: number) {
    const pinned = snapshot.connectors?.find(item => item.id === connector.id)
    if (connector.projectId !== turn.projectId || (connector.allowedWorkerIds.length && !connector.allowedWorkerIds.includes(turn.workerId as never)) ||
        !pinned || pinned.projectId !== turn.projectId || pinned.kind !== connector.kind || pinned.revision !== connector.revision ||
        (revision !== undefined && pinned.revision !== revision) || !pinned.enabled ||
        (pinned.allowedWorkerIds.length && !pinned.allowedWorkerIds.includes(turn.workerId))) {
      throw new GatewayError('scope_denied', 'Connector is outside the current Project, Worker or pinned revision')
    }
  }

  private async auditDenial(input: Pick<ToolExecutionInput, 'currentTurn' | 'connectorId' | 'toolName'>, operation: string, result: ExecutionResult) {
    if (result.ok) return
    await this.store.recordConnectorDenial?.({ actor: input.currentTurn.sessionId, operation, projectId: input.currentTurn.projectId, workspaceId: input.currentTurn.workspaceId, workerId: input.currentTurn.workerId, connectorId: input.connectorId, toolName: input.toolName, reasonCode: result.error.code })
  }

  private async definition(id: string, kind: 'mcp' | 'http' = 'mcp'): Promise<ConnectorDefinition> {
    const connector = await this.store.getConnectorDefinition(id)
    if (!connector || connector.kind !== kind || !connector.enabled) throw new GatewayError('connector_unavailable', `${kind.toUpperCase()} connector is unavailable`)
    return connector
  }

  private async resolveMcpCall(input: ToolExecutionInput, connector: McpConnectorDefinition, provisionalCall: ToolCall): Promise<ToolCall> {
    const catalog = await this.mcp.listTools(input.currentTurn.sessionId, connector, await this.resolveSecret(connector), input.signal)
    const tool = catalog.tools.find(item => item.name === input.toolName)
    if (!tool) throw new GatewayError('invalid_input', 'Unknown MCP tool')
    return { ...provisionalCall, operationType: tool.operationType }
  }

  private async resolveSecret(connector: ConnectorDefinition) {
    if (!connector.credentialRef) return null
    return (await this.credentials.resolve(connector.credentialRef, connector.id)).secret
  }

  private async persist(call: ToolCall, result: ExecutionResult): Promise<ExecutionResult> {
    const journal = summarizeJournal({ requestId: call.requestId, connectorId: call.connectorId, connectorRevision: call.connectorRevision, toolName: call.action.kind === 'mcp' ? call.action.toolName : undefined, operationType: call.operationType, result: result.ok ? { ok: true } : result })
    await this.store.finishConnectorExecution(call.requestId, result, journal)
    return result
  }
}

class GatewayError extends Error {
  readonly code: ConnectorExecutionErrorCode
  readonly retryable: boolean

  constructor(code: ConnectorExecutionErrorCode, message: string, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}
function httpOperation(connector: HttpConnectorDefinition, operationId: string): OperationType {
  const operation = connector.config.allowedOperations.find(item => item.id === operationId)
  if (!operation) throw new GatewayError('invalid_input', 'Unknown HTTP operation')
  return operation.operationTypeOverride ?? (['GET', 'HEAD', 'OPTIONS'].includes(operation.method) ? 'read' : operation.method === 'DELETE' ? 'destructive' : 'write')
}
function requiresApproval(operationType: OperationType, connector: ConnectorDefinition) { return operationType !== 'read' || connector.riskDefaults.requireApprovalForRead }
function success(output: unknown, requestId: string, connectorRevision: number): ExecutionResult { return { ok: true, output, requestId, connectorRevision, completedAt: new Date().toISOString() as never } }
function failure(code: ConnectorExecutionErrorCode, requestId: string, connectorRevision: number | null, message: string, retryable = false, retryAfterMs: number | null = null): ExecutionResult { return { ok: false, error: { code, message, retryable, retryAfterMs }, requestId, connectorRevision, completedAt: new Date().toISOString() as never } }
function mappedFailure(error: unknown, requestId: string, revision: number | null): ExecutionResult {
  if (error instanceof GatewayError) return failure(error.code, requestId, revision, error.message, error.retryable)
  if (error instanceof ConnectorCredentialError) return failure(error.code, requestId, revision, error.message)
  if (error instanceof McpLimitError) return failure('response_too_large', requestId, revision, error.message)
  if (error instanceof DOMException && error.name === 'AbortError') return failure('cancelled', requestId, revision, 'Connector call was cancelled')
  const message = error instanceof Error ? error.message : 'Connector execution failed'
  if (/timed out|timeout/i.test(message)) return failure('timeout', requestId, revision, 'Connector operation timed out')
  if (/private|reserved|userinfo|protocol/i.test(message)) return failure('unsafe_destination', requestId, revision, 'Connector destination is not allowed')
  if (/capacity|shutting down/i.test(message)) return failure('connector_unavailable', requestId, revision, 'Connector is unavailable', true)
  if (/exceeds the Agent output limit/i.test(message)) return failure('response_too_large', requestId, revision, message)
  return failure('upstream_error', requestId, revision, 'Connector returned an error')
}
