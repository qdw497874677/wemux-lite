import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityGrantClaims, CapabilitySnapshot } from '@wemux/domain'
import type { HttpConnectorDefinition } from '@wemux/connector'
import { WorkerCredentialStore } from '../src/connectors/credential-store.js'
import { HttpConnectorExecutor } from '../src/connectors/http-executor.js'
import { McpProcessSupervisor } from '../src/connectors/mcp-process-supervisor.js'
import { WorkerMcpClient } from '../src/connectors/mcp-client.js'
import { ToolExecutionGateway } from '../src/connectors/tool-execution-gateway.js'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

const timestamp = '2026-01-01T00:00:00.000Z'
const ids = { projectId: 'project-1', workspaceId: 'workspace-1', sessionId: 'session-1', turnId: 'turn-1', workerId: 'worker-1' }

function definition(overrides: Partial<HttpConnectorDefinition> = {}): HttpConnectorDefinition {
  return { id: 'connector-http' as never, projectId: ids.projectId as never, kind: 'http', name: 'HTTP fixture', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false }, config: { baseUrl: 'https://fixture.example.test', authentication: 'none', publicHeaders: {}, allowedOperations: [{ id: 'create', method: 'POST', pathTemplate: '/items', allowedQueryNames: [], allowedRequestHeaderNames: [], requestContentTypes: ['application/json'] }], allowPrivateNetwork: false }, createdAt: timestamp as never, updatedAt: timestamp as never, ...overrides }
}

async function harness(t: test.TestContext, options: { approval?: 'approve' | 'deny'; fetch?: typeof fetch } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-http-gateway-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const credentials = new WorkerCredentialStore(store)
  const supervisor = new McpProcessSupervisor()
  const mcp = new WorkerMcpClient({ supervisor })
  const connector = definition()
  const snapshot: CapabilitySnapshot = { id: 'snapshot-1', projectId: ids.projectId as never, workspaceId: ids.workspaceId as never, sessionId: ids.sessionId as never, version: 1, assets: [], allowedTools: ['http.call'], allowedConnectorIds: [connector.id], connectors: [connector], createdAt: timestamp }
  const claims: CapabilityGrantClaims = { id: 'grant-1', ...ids, actorAgentId: 'pi' as never, projectId: ids.projectId as never, workspaceId: ids.workspaceId as never, sessionId: ids.sessionId as never, turnId: ids.turnId as never, allowedTools: ['http.call'], allowedConnectorIds: [connector.id], issuedAt: timestamp, expiresAt: '2099-01-01T00:00:00.000Z' }
  await store.saveConnectorDefinition(connector)
  let calls = 0
  const fetchImpl = options.fetch ?? (async () => { calls++; return new Response(JSON.stringify({ created: true }), { status: 201, headers: { 'content-type': 'application/json' } }) }) as typeof fetch
  const http = new HttpConnectorExecutor(credentials, { fetch: fetchImpl, lookup: async () => [{ address: '8.8.8.8', family: 4 }] })
  const gateway = new ToolExecutionGateway(store, credentials, mcp, { verify: () => claims }, options.approval ? { request: async () => options.approval! } : undefined, http)
  t.after(async () => { await mcp.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  return { gateway, store, connector, snapshot, calls: () => calls, common: { token: 'token', snapshot, currentTurn: ids, connectorId: connector.id, connectorRevision: connector.revision, agentSupportsApproval: true, operationId: 'create', input: { body: { title: 'created by Pi' } }, requestId: 'request-http', toolCallId: 'tool-http' as never } }
}

test('http_call executes through ToolExecutionGateway and replays an idempotent result', async t => {
  const h = await harness(t, { approval: 'approve' })
  const first = await h.gateway.executeHttp(h.common)
  const replay = await h.gateway.executeHttp(h.common)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.deepEqual(replay, first)
  assert.equal(h.calls(), 1)
  const journal = await h.store.listConnectorJournal(ids.sessionId)
  assert.equal(journal.length, 1)
  assert.equal(journal[0]?.toolCall.action.kind, 'http')
})

test('HTTP 503 is persisted as upstream_error and write replay does not repeat the side effect', async t => {
  let attempts = 0
  const h = await harness(t, { approval: 'approve', fetch: (async () => { attempts++; return new Response(JSON.stringify({ error: 'fixture_down' }), { status: 503, headers: { 'content-type': 'application/json' } }) }) as typeof fetch })
  const result = await h.gateway.executeHttp(h.common)
  assert.equal(result.ok, false)
  if (!result.ok) { assert.equal(result.error.code, 'upstream_error'); assert.equal(result.error.retryable, false); assert.doesNotMatch(result.error.message, /fixture_down/) }
  assert.deepEqual(await h.gateway.executeHttp(h.common), result)
  assert.equal(attempts, 1)
  const journal = await h.store.listConnectorJournal(ids.sessionId)
  assert.equal(journal.length, 1)
  assert.deepEqual(journal[0]?.result, result)
})

test('HTTP 429 preserves bounded Retry-After while sent writes remain non-retryable', async t => {
  for (const [retryAfter, expected] of [['60', 60_000], ['9999999999', 86_400_000], ['not-a-date', null]] as const) {
    const h = await harness(t, { approval: 'approve', fetch: (async () => new Response('', { status: 429, headers: { 'retry-after': retryAfter } })) as typeof fetch })
    const write = await h.gateway.executeHttp(h.common)
    assert.equal(write.ok, false)
    if (!write.ok) { assert.equal(write.error.code, 'rate_limited'); assert.equal(write.error.retryable, false); assert.equal(write.error.retryAfterMs, expected) }
  }
  const read = await harness(t, { fetch: (async () => new Response('', { status: 429, headers: { 'retry-after': '60' } })) as typeof fetch })
  const config = read.connector.config
  const readConnector = definition({ config: { ...config, allowedOperations: [{ ...config.allowedOperations[0]!, method: 'GET', requestContentTypes: [] }] } })
  await read.store.saveConnectorDefinition(readConnector)
  const result = await read.gateway.executeHttp({ ...read.common, input: {}, snapshot: { ...read.snapshot, connectors: [readConnector] } })
  assert.equal(result.ok, false)
  if (!result.ok) { assert.equal(result.error.code, 'rate_limited'); assert.equal(result.error.retryable, true); assert.equal(result.error.retryAfterMs, 60_000) }
})

test('http_call fails closed without approval support or when approval is denied', async t => {
  const unsupported = await harness(t)
  const closed = await unsupported.gateway.executeHttp({ ...unsupported.common, agentSupportsApproval: false })
  assert.equal(closed.ok, false); if (!closed.ok) assert.equal(closed.error.code, 'approval_denied')
  assert.equal(unsupported.calls(), 0)
  const deniedHarness = await harness(t, { approval: 'deny' })
  const denied = await deniedHarness.gateway.executeHttp(deniedHarness.common)
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'approval_denied')
  assert.equal(deniedHarness.calls(), 0)
})

test('http_call enforces response limits and request id fingerprint conflicts', async t => {
  const limited = await harness(t, { approval: 'approve', fetch: (async () => new Response('x'.repeat(256 * 1024 + 1), { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch })
  const oversized = await limited.gateway.executeHttp(limited.common)
  assert.equal(oversized.ok, false); if (!oversized.ok) assert.equal(oversized.error.code, 'response_too_large')
  const idempotent = await harness(t, { approval: 'approve' })
  assert.equal((await idempotent.gateway.executeHttp(idempotent.common)).ok, true)
  const conflict = await idempotent.gateway.executeHttp({ ...idempotent.common, input: { body: { title: 'different' } } })
  assert.equal(conflict.ok, false); if (!conflict.ok) assert.equal(conflict.error.code, 'idempotency_conflict')
})
