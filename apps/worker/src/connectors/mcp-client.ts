import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createGuardedFetch, stableFingerprint, summarizeAgentResult, type McpConnectorDefinition, type OperationType } from '@wemux/connector'
import type { ConnectorCredentialSecret } from './credential-store.js'
import type { McpProcessSupervisor, SupervisedMcpProcess } from './mcp-process-supervisor.js'

export interface McpToolDescriptor {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations?: Readonly<Record<string, unknown>>
  readonly operationType: OperationType
}

export interface McpCatalog {
  readonly tools: readonly McpToolDescriptor[]
  readonly revision: string
}

export interface McpClientOptions {
  readonly supervisor: McpProcessSupervisor
  readonly deploymentAllowsPrivateNetwork?: boolean
  readonly fetch?: typeof fetch
  readonly lookup?: import('@wemux/connector').GuardedFetchDnsLookup
  readonly startupTimeoutMs?: number
  readonly callTimeoutMs?: number
  readonly maxCatalogTools?: number
  readonly maxCatalogBytes?: number
  readonly maxSchemaDepth?: number
}

type Connection = {
  readonly client: Client
  readonly process: SupervisedMcpProcess | null
  readonly close: () => Promise<void>
}

export class WorkerMcpClient {
  private readonly http = new Map<string, Promise<Connection>>()
  private closing = false
  private readonly startupTimeoutMs: number
  private readonly callTimeoutMs: number

  constructor(private readonly options: McpClientOptions) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000
  }

  async listTools(sessionId: string, connector: McpConnectorDefinition, secret: ConnectorCredentialSecret | null, signal?: AbortSignal): Promise<McpCatalog> {
    const connection = await this.connection(sessionId, connector, secret)
    connection.process?.touch()
    const result = await connection.client.listTools(undefined, requestOptions(signal, this.callTimeoutMs))
    const tools = result.tools.map(tool => ({
      name: clean(tool.name, 256),
      ...(tool.description ? { description: clean(tool.description, 4096) } : {}),
      inputSchema: tool.inputSchema as Record<string, unknown>,
      ...(tool.annotations ? { annotations: tool.annotations as Readonly<Record<string, unknown>> } : {}),
      operationType: inferMcpOperationType(tool.annotations, connector.riskDefaults.allowMcpReadOnlyHint),
    }))
    assertCatalogLimits(tools, this.options)
    const safe = summarizeAgentResult(tools) as readonly McpToolDescriptor[]
    return { tools: safe, revision: stableFingerprint(safe) }
  }

  async callTool(sessionId: string, connector: McpConnectorDefinition, secret: ConnectorCredentialSecret | null, toolName: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const connection = await this.connection(sessionId, connector, secret)
    connection.process?.touch()
    return connection.client.callTool({ name: toolName, arguments: input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {} }, undefined, requestOptions(signal, this.callTimeoutMs))
  }

  async releaseSession(sessionId: string) { await this.options.supervisor.releaseSession(sessionId) }

  async shutdown() {
    this.closing = true
    const connections = await Promise.allSettled([...this.http.values()])
    this.http.clear()
    await Promise.all(connections.flatMap(result => result.status === 'fulfilled' ? [result.value.close().catch(() => undefined)] : []))
    await this.options.supervisor.shutdown()
  }

  forceShutdown() {
    this.closing = true
    this.http.clear()
    this.options.supervisor.forceShutdown()
  }

  private async connection(sessionId: string, connector: McpConnectorDefinition, secret: ConnectorCredentialSecret | null): Promise<Connection> {
    if (this.closing) throw new Error('MCP client is shutting down')
    if (connector.config.transport === 'stdio') {
      return this.options.supervisor.acquire(sessionId, connector, () => this.openStdio(connector, secret), stableFingerprint(secret ?? null).slice(0, 16))
    }
    const credentialRevision = stableFingerprint(secret ?? null).slice(0, 16)
    const key = `${connector.id}\0${connector.revision}\0${credentialRevision}`
    let pending = this.http.get(key)
    if (!pending) {
      pending = this.openHttp(connector, secret).catch(error => { this.http.delete(key); throw error })
      this.http.set(key, pending)
    }
    return pending
  }

  private async openStdio(connector: McpConnectorDefinition, secret: ConnectorCredentialSecret | null): Promise<Connection & SupervisedMcpProcess> {
    if (connector.config.transport !== 'stdio') throw new Error('Expected stdio connector')
    validateStdio(connector)
    const env = { ...getDefaultEnvironment(), ...connector.config.publicEnvironment }
    for (const name of connector.config.secretEnvironmentNames) {
      const value = secret?.[name]
      if (value === undefined) throw new Error(`Connector credential does not provide required environment ${name}`)
      env[name] = value
    }
    const transport = new StdioClientTransport({ command: connector.config.command, args: [...connector.config.args], ...(connector.config.cwd ? { cwd: connector.config.cwd } : {}), env, stderr: 'pipe', maxBufferSize: 16 * 1024 * 1024 })
    let stderrTail = ''
    transport.stderr?.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-64 * 1024) })
    let expectedClose = false
    let markCrashed!: () => void
    const crashed = new Promise<void>(resolve => { markCrashed = resolve })
    const previousOnClose = transport.onclose
    transport.onclose = () => { previousOnClose?.(); if (!expectedClose) markCrashed() }
    const client = new Client({ name: 'wemux-worker', version: '0.1.0' })
    try { await withTimeout(client.connect(transport), this.startupTimeoutMs, () => transport.close()) }
    catch (error) { await transport.close().catch(() => undefined); throw error }
    let closed = false
    const close = async () => { if (closed) return; closed = true; expectedClose = true; await client.close() }
    return { client, process: null, get pid() { return transport.pid }, get stderrTail() { return redact(stderrTail) }, startedAt: Date.now(), touch: () => undefined, close, forceClose: () => { expectedClose = true; void transport.close() }, crashed }
  }

  private async openHttp(connector: McpConnectorDefinition, secret: ConnectorCredentialSecret | null): Promise<Connection> {
    if (connector.config.transport !== 'streamable_http') throw new Error('Expected HTTP connector')
    const headers = new Headers(connector.config.publicHeaders)
    if (connector.config.authentication !== 'none') {
      const authorization = secret?.authorization ?? secret?.apiKey
      if (!authorization) throw new Error('Connector credential does not provide authorization')
      headers.set('authorization', connector.config.authentication === 'api_key' && !/^\S+\s/.test(authorization) ? `Bearer ${authorization}` : authorization)
    }
    const guarded = createGuardedFetch({ fetch: this.options.fetch, lookup: this.options.lookup, deploymentAllowsPrivateNetwork: this.options.deploymentAllowsPrivateNetwork, connectorAllowsPrivateNetwork: connector.config.allowPrivateNetwork })
    const guardedFetch = async (input: any, init?: any): Promise<any> => {
      const request = input instanceof Request ? input : undefined
      const body = request && request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : undefined
      const mergedInit: RequestInit = request
        ? { method: request.method, headers: request.headers, body, signal: request.signal, ...init }
        : init ?? {}
      return await guarded(request?.url ?? input.toString(), mergedInit)
    }
    const transport = new StreamableHTTPClientTransport(new URL(connector.config.url), { requestInit: { headers }, fetch: guardedFetch })
    const client = new Client({ name: 'wemux-worker', version: '0.1.0' })
    await withTimeout(client.connect(transport), this.startupTimeoutMs, () => transport.close())
    return { client, process: null, close: () => client.close() }
  }
}

export function inferMcpOperationType(annotations: unknown, allowReadOnlyHint: boolean): OperationType {
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return 'write'
  const values = annotations as Record<string, unknown>
  if (values.destructiveHint === true) return 'destructive'
  const conflicting = values.readOnlyHint === true && (values.openWorldHint === true || values.idempotentHint === false)
  return allowReadOnlyHint && values.readOnlyHint === true && !conflicting ? 'read' : 'write'
}

function assertCatalogLimits(tools: readonly McpToolDescriptor[], limits: Pick<McpClientOptions, 'maxCatalogTools' | 'maxCatalogBytes' | 'maxSchemaDepth'>) {
  const maxTools = limits.maxCatalogTools ?? 128
  const maxBytes = limits.maxCatalogBytes ?? 1024 * 1024
  const maxDepth = limits.maxSchemaDepth ?? 16
  if (tools.length > maxTools) throw new McpLimitError(`MCP tool catalog exceeds ${maxTools} tools`)
  let total = 0
  for (const tool of tools) {
    const schema = JSON.stringify(tool.inputSchema)
    const bytes = Buffer.byteLength(schema)
    if (bytes > 64 * 1024) throw new McpLimitError('MCP tool schema exceeds 64 KiB')
    if (jsonDepth(tool.inputSchema) > maxDepth) throw new McpLimitError(`MCP tool schema exceeds depth ${maxDepth}`)
    total += Buffer.byteLength(JSON.stringify(tool))
  }
  if (total > maxBytes) throw new McpLimitError(`MCP tool catalog exceeds ${maxBytes} bytes`)
}

export class McpLimitError extends Error {}

function jsonDepth(value: unknown, depth = 0): number {
  if (!value || typeof value !== 'object') return depth
  return Math.max(depth, ...Object.values(value).map(item => jsonDepth(item, depth + 1)))
}
function clean(value: string, max: number) { return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max) }
function redact(value: string) { return value.replace(/(?:bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]') }
function validateStdio(connector: McpConnectorDefinition) {
  if (connector.config.transport !== 'stdio') return
  if (!connector.config.command || connector.config.command.includes('\0')) throw new Error('Invalid MCP command')
  if (connector.config.args.some(value => value.includes('\0') || Buffer.byteLength(value) > 4096) || connector.config.args.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 32 * 1024) throw new Error('Invalid MCP arguments')
}
function requestOptions(signal: AbortSignal | undefined, timeout: number) { return { ...(signal ? { signal } : {}), timeout, maxTotalTimeout: timeout } }
async function withTimeout<T>(promise: Promise<T>, ms: number, cancel: () => Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => { void cancel(); reject(new Error(`MCP startup timed out after ${ms}ms`)) }, ms); timer.unref() })]) }
  finally { if (timer) clearTimeout(timer) }
}
