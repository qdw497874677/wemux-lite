import { createHash } from 'node:crypto'
import { createGuardedFetch, summarizeAgentResult, summarizeJournal, type HttpConnectorDefinition, type HttpOperationDefinition } from '@wemux/connector'
import type { WorkerCredentialStore } from './credential-store.ts'

export interface HttpCallInput {
  readonly operationId: string
  readonly pathParameters?: Readonly<Record<string, string>>
  readonly query?: Readonly<Record<string, string | readonly string[]>>
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
}
export interface HttpCallResult { readonly output: unknown; readonly agentSummary: unknown; readonly journalSummary: unknown }

export class HttpConnectorExecutor {
  private readonly credentials: WorkerCredentialStore
  private readonly guarded: typeof fetch
  constructor(credentials: WorkerCredentialStore, options: { readonly fetch?: typeof fetch; readonly lookup?: import('@wemux/connector').GuardedFetchDnsLookup; readonly deploymentAllowsPrivateNetwork?: boolean; readonly timeoutMs?: number } = {}) {
    this.credentials = credentials
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.guarded = createGuardedFetch({ fetch: options.fetch, lookup: options.lookup, deploymentAllowsPrivateNetwork: options.deploymentAllowsPrivateNetwork ?? process.env.WEMUX_CONNECTOR_ALLOW_PRIVATE_NETWORK === 'true', connectorAllowsPrivateNetwork: () => this.privateAllowed, additionalSensitiveHeaders: ['authorization', 'x-api-key'], maxRedirects: 5 })
  }
  private readonly timeoutMs: number
  private privateAllowed = false

  async execute(connector: HttpConnectorDefinition, input: HttpCallInput, signal?: AbortSignal): Promise<HttpCallResult> {
    const operation = connector.config.allowedOperations.find(value => value.id === input.operationId)
    if (!operation) throw new Error('HTTP operation is not allowed')
    const path = renderPath(operation, input.pathParameters ?? {})
    const url = combineUrl(connector.config.baseUrl, path)
    applyQuery(url, operation, input.query ?? {})
    const headers = buildHeaders(connector, operation, input.headers ?? {})
    const body = encodeBody(operation, headers, input.body)
    await this.injectAuthentication(connector, headers)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('HTTP Connector timed out')), this.timeoutMs)
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    this.privateAllowed = connector.config.allowPrivateNetwork
    try {
      const response = await this.guarded(url, { method: operation.method, headers, body, signal: controller.signal, redirect: 'follow' })
      const output = await readBounded(response, 256 * 1024)
      const safe = { status: response.status, ok: response.ok, contentType: response.headers.get('content-type'), body: output }
      return { output: safe, agentSummary: summarizeAgentResult(safe), journalSummary: summarizeJournal({ connectorId: connector.id, connectorRevision: connector.revision, operationId: operation.id, method: operation.method, targetOrigin: url.origin, status: response.status, ok: response.ok }) }
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.privateAllowed = false
    }
  }

  async test(connector: HttpConnectorDefinition, signal?: AbortSignal): Promise<HttpCallResult> {
    const operation = connector.config.allowedOperations.find(value => ['GET','HEAD','OPTIONS'].includes(value.method)) ?? connector.config.allowedOperations[0]
    if (!operation) throw new Error('HTTP Connector has no allowed operation')
    const params = Object.fromEntries([...operation.pathTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => [match[1]!, 'test']))
    return this.execute(connector, { operationId: operation.id, pathParameters: params }, signal)
  }

  private async injectAuthentication(connector: HttpConnectorDefinition, headers: Headers): Promise<void> {
    if (connector.config.authentication === 'none') return
    if (!connector.credentialRef) throw new Error('Connector credential is not configured')
    const resolved = await this.credentials.resolve(connector.credentialRef, connector.id)
    const value = Object.values(resolved.secret)[0]
    if (!value) throw new Error('Connector credential is invalid')
    headers.set('authorization', connector.config.authentication === 'api_key' && !/^\S+\s/.test(value) ? `Bearer ${value}` : value)
  }
}

function combineUrl(base: string, path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//') || /[?#]/.test(path)) throw new Error('HTTP operation path must be an absolute relative path')
  const baseUrl = new URL(base)
  const root = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`
  const url = new URL(`.${path}`, new URL(root, baseUrl))
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(root)) throw new Error('HTTP operation path escapes the Connector base URL')
  return url
}
function renderPath(operation: HttpOperationDefinition, values: Readonly<Record<string, string>>): string {
  const used = new Set<string>()
  const path = operation.pathTemplate.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name: string) => { const value = values[name]; if (value === undefined) throw new Error(`Missing path parameter: ${name}`); used.add(name); return encodeURIComponent(value) })
  if (Object.keys(values).some(name => !used.has(name))) throw new Error('Unknown path parameter')
  return path
}
function applyQuery(url: URL, operation: HttpOperationDefinition, query: Readonly<Record<string, string | readonly string[]>>): void {
  const allowed = new Set(operation.allowedQueryNames)
  for (const [name, raw] of Object.entries(query)) { if (!allowed.has(name)) throw new Error(`Query parameter is not allowed: ${name}`); for (const value of Array.isArray(raw) ? raw : [raw]) url.searchParams.append(name, value) }
}
function buildHeaders(connector: HttpConnectorDefinition, operation: HttpOperationDefinition, input: Readonly<Record<string, string>>): Headers {
  const headers = new Headers(connector.config.publicHeaders), allowed = new Set(operation.allowedRequestHeaderNames.map(value => value.toLowerCase()))
  for (const [name, value] of Object.entries(input)) { const lower = name.toLowerCase(); if (!allowed.has(lower) || ['authorization','cookie','proxy-authorization','host','content-length'].includes(lower)) throw new Error(`Request header is not allowed: ${name}`); headers.set(lower, value) }
  return headers
}
function encodeBody(operation: HttpOperationDefinition, headers: Headers, body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined
  if (['GET','HEAD','OPTIONS'].includes(operation.method)) throw new Error('HTTP method does not allow a request body')
  const contentType = headers.get('content-type')?.split(';')[0]?.trim() ?? operation.requestContentTypes[0]
  if (!contentType || !operation.requestContentTypes.includes(contentType as never)) throw new Error('Request content type is not allowed')
  headers.set('content-type', contentType)
  if (contentType === 'application/json') return JSON.stringify(body)
  if (contentType === 'text/plain') { if (typeof body !== 'string') throw new Error('text/plain body must be a string'); return body }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Form body must be an object')
  return new URLSearchParams(Object.entries(body as Record<string,string>).map(([key,value]) => [key, String(value)])).toString()
}
async function readBounded(response: Response, maximum: number): Promise<unknown> {
  if (!response.body) return null
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = []
  try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maximum) { await reader.cancel(); throw new Error('HTTP response exceeds the Agent output limit') } chunks.push(value) } } finally { reader.releaseLock() }
  const buffer = Buffer.concat(chunks.map(value => Buffer.from(value))), text = buffer.toString('utf8')
  const contentType = response.headers.get('content-type') ?? ''
  if (/application\/json|\+json/.test(contentType)) { try { return JSON.parse(text) } catch { return text } }
  return text
}
export const httpCallFingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
