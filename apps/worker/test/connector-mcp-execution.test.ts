import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { WorkerCredentialStore } from '../src/connectors/credential-store.js'
import { WorkerMcpClient } from '../src/connectors/mcp-client.js'
import { McpProcessSupervisor } from '../src/connectors/mcp-process-supervisor.js'
import { ToolExecutionGateway } from '../src/connectors/tool-execution-gateway.js'
import type { CapabilityGrantClaims, CapabilitySnapshot } from '@wemux/domain'
import type { McpConnectorDefinition } from '@wemux/connector'

const fixture = fileURLToPath(new URL('fixtures/mcp-fixture-server.mjs', import.meta.url))
const timestamp = '2025-01-01T00:00:00.000Z'
const ids = { projectId: 'project-1', workspaceId: 'workspace-1', sessionId: 'session-1', turnId: 'turn-1', workerId: 'worker-1' }

function definition(overrides: Partial<McpConnectorDefinition> = {}): McpConnectorDefinition {
  return { id: 'connector-1' as never, projectId: ids.projectId as never, name: 'fixture', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: true }, createdAt: timestamp as never, updatedAt: timestamp as never, kind: 'mcp', config: { transport: 'stdio', command: process.execPath, args: [fixture], cwd: null, publicEnvironment: {}, secretEnvironmentNames: [] }, ...overrides }
}
function auth(connectorIds = ['connector-1']) {
  const snapshot: CapabilitySnapshot = { id: 'snapshot-1', projectId: ids.projectId as never, workspaceId: ids.workspaceId as never, sessionId: ids.sessionId as never, version: 1, assets: [], allowedTools: ['mcp.call' as never], allowedConnectorIds: connectorIds, createdAt: timestamp }
  const claims: CapabilityGrantClaims = { id: 'grant-1', ...ids, actorAgentId: ids.sessionId as never, sessionId: ids.sessionId as never, turnId: ids.turnId as never, projectId: ids.projectId as never, workspaceId: ids.workspaceId as never, allowedTools: snapshot.allowedTools, allowedConnectorIds: connectorIds, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }
  return { snapshot, claims }
}
async function harness(t: test.TestContext, connector = definition(), options: { key?: string; approval?: 'approve' | 'deny'; agentSupportsApproval?: boolean; maxCatalogTools?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-mcp-test-'))
  const store = new SqliteWorkerStore(join(dir, 'worker.sqlite'))
  const supervisor = new McpProcessSupervisor({ idleTimeoutMs: 40, shutdownGraceMs: 100, shutdownForceMs: 100 })
  const mcp = new WorkerMcpClient({ supervisor, startupTimeoutMs: 2_000, callTimeoutMs: 500, maxCatalogTools: options.maxCatalogTools })
  const credentials = new WorkerCredentialStore(store, { key: options.key })
  const { snapshot, claims } = auth()
  await store.saveConnectorDefinition(connector)
  const gateway = new ToolExecutionGateway(store, credentials, mcp, { verify: token => { assert.equal(token, 'token'); return claims } }, options.approval ? { request: async () => options.approval! } : undefined)
  t.after(async () => { await mcp.shutdown(); store.close(); await rm(dir, { recursive: true, force: true }) })
  const common = { token: 'token', snapshot, currentTurn: ids, connectorId: connector.id, agentSupportsApproval: options.agentSupportsApproval ?? true }
  return { store, supervisor, mcp, credentials, gateway, common }
}

async function startHttpFixture(t: test.TestContext) {
  const child = spawn(process.execPath, [fixture, '--http'], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => { let text = ''; child.stdout.on('data', chunk => { text += chunk; const value = Number(text.trim()); if (value) resolve(value) }); child.once('error', reject); child.once('exit', code => reject(new Error(`fixture exited ${code}`))) })
  t.after(() => { child.kill('SIGTERM') })
  return { child, port }
}

test('stdio MCP lists and calls tools, then replays an idempotent terminal result', async t => {
  const h = await harness(t, definition(), { approval: 'approve' })
  const listed = await h.gateway.listTools(h.common)
  assert.equal(listed.ok, true)
  const input = { ...h.common, requestId: 'request-1', toolCallId: 'tool-call-1' as never, connectorRevision: 1, toolName: 'echo', input: { value: 'hello' } }
  const first = await h.gateway.execute(input)
  const replay = await h.gateway.execute(input)
  assert.equal(first.ok, true)
  assert.deepEqual(replay, first)
  assert.equal(h.supervisor.activePids().length, 1)
})

test('streamable_http MCP uses guarded fetch and calls a fixture without external network', async t => {
  const { port } = await startHttpFixture(t)
  const connector = definition({ config: { transport: 'streamable_http', url: `http://fixture.test:${port}/mcp`, publicHeaders: {}, authentication: 'none', allowPrivateNetwork: true } })
  const storeDir = await mkdtemp(join(tmpdir(), 'wemux-mcp-http-'))
  const store = new SqliteWorkerStore(join(storeDir, 'worker.sqlite'))
  const supervisor = new McpProcessSupervisor()
  const localFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request?.url ?? String(input)); url.hostname = '127.0.0.1'
    const body = request && request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : undefined
    return await fetch(url, request ? { method: request.method, headers: request.headers, body, signal: request.signal, ...init } : init)
  }
  const mcp = new WorkerMcpClient({ supervisor, fetch: localFetch, lookup: async () => [{ address: '8.8.8.8', family: 4 }], startupTimeoutMs: 500, callTimeoutMs: 500 })
  const credentials = new WorkerCredentialStore(store)
  const { snapshot, claims } = auth()
  await store.saveConnectorDefinition(connector)
  const gateway = new ToolExecutionGateway(store, credentials, mcp, { verify: () => claims }, { request: async () => 'approve' })
  t.after(async () => { await mcp.shutdown(); store.close(); await rm(storeDir, { recursive: true, force: true }) })
  const result = await gateway.execute({ token: 'token', snapshot, currentTurn: ids, connectorId: connector.id, agentSupportsApproval: true, requestId: 'http-1', toolCallId: 'call-http' as never, connectorRevision: 1, toolName: 'echo', input: { value: 'http' } })
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('scope denial and idempotency fingerprint conflict use contract error codes', async t => {
  const h = await harness(t, definition(), { approval: 'approve' })
  const denied = await h.gateway.listTools({ ...h.common, snapshot: { ...h.common.snapshot, allowedConnectorIds: [] } })
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'scope_denied')
  const base = { ...h.common, requestId: 'same', toolCallId: 'call-1' as never, connectorRevision: 1, toolName: 'echo', input: { value: 'a' } }
  assert.equal((await h.gateway.execute(base)).ok, true)
  const conflict = await h.gateway.execute({ ...base, input: { value: 'b' } })
  assert.equal(conflict.ok, false); if (!conflict.ok) assert.equal(conflict.error.code, 'idempotency_conflict')
})

test('write-risk MCP annotations fail closed without approval support and denial persists', async t => {
  const connector = definition({ riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false } })
  const h = await harness(t, connector)
  const input = { ...h.common, agentSupportsApproval: false, requestId: 'deny-1', toolCallId: 'call-1' as never, connectorRevision: 1, toolName: 'echo', input: {} }
  const result = await h.gateway.execute(input)
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'approval_denied')
  const journal = await h.store.listConnectorJournal(ids.sessionId)
  assert.equal(journal.length, 1)
})

test('credential capability degrades unavailable and journal never contains plaintext secret', async t => {
  const connector = definition({ credentialRef: 'credential-1' as never, credentialAvailability: 'available', config: { transport: 'stdio', command: process.execPath, args: [fixture], cwd: null, publicEnvironment: {}, secretEnvironmentNames: ['TEST_SECRET'] } })
  const unavailable = await harness(t, connector, { approval: 'approve' })
  const failed = await unavailable.gateway.execute({ ...unavailable.common, requestId: 'cred-off', toolCallId: 'call-off' as never, connectorRevision: 1, toolName: 'echo', input: {} })
  assert.equal(failed.ok, false); if (!failed.ok) assert.equal(failed.error.code, 'credential_unavailable')

  const enabled = await harness(t, connector, { key: 'test-only-connector-key', approval: 'approve' })
  await enabled.credentials.put({ id: 'credential-1' as never, connectorId: connector.id, authType: 'custom_credential', secret: { TEST_SECRET: 'TOP-SECRET-123' } })
  const result = await enabled.gateway.execute({ ...enabled.common, requestId: 'cred-on', toolCallId: 'call-on' as never, connectorRevision: 1, toolName: 'echo', input: { value: 'ok' } })
  assert.equal(result.ok, true)
  const journal = await enabled.store.listConnectorJournal(ids.sessionId)
  assert.equal(JSON.stringify(journal).includes('TOP-SECRET-123'), false)
})

test('startup timeout, cancellation, catalog overflow, crash cleanup, and shutdown leave no active child', async t => {
  const slow = definition({ config: { transport: 'stdio', command: process.execPath, args: [fixture], cwd: null, publicEnvironment: { MCP_FIXTURE_STARTUP_DELAY_MS: '3000' }, secretEnvironmentNames: [] } })
  const timeoutHarness = await harness(t, slow, { approval: 'approve' })
  const timeout = await timeoutHarness.gateway.listTools(timeoutHarness.common)
  assert.equal(timeout.ok, false); if (!timeout.ok) assert.equal(timeout.error.code, 'timeout')

  const oversized = definition({ config: { transport: 'stdio', command: process.execPath, args: [fixture], cwd: null, publicEnvironment: { MCP_FIXTURE_MODE: 'oversized' }, secretEnvironmentNames: [] } })
  const limitHarness = await harness(t, oversized, { approval: 'approve', maxCatalogTools: 2 })
  const limited = await limitHarness.gateway.listTools(limitHarness.common)
  assert.equal(limited.ok, false); if (!limited.ok) assert.equal(limited.error.code, 'response_too_large')

  const huge = definition({ config: { transport: 'stdio', command: process.execPath, args: [fixture], cwd: null, publicEnvironment: { MCP_FIXTURE_MODE: 'huge-result' }, secretEnvironmentNames: [] } })
  const hugeHarness = await harness(t, huge, { approval: 'approve' })
  const tooLarge = await hugeHarness.gateway.execute({ ...hugeHarness.common, requestId: 'huge-1', toolCallId: 'huge-call' as never, connectorRevision: 1, toolName: 'echo', input: {} })
  assert.equal(tooLarge.ok, false); if (!tooLarge.ok) assert.equal(tooLarge.error.code, 'response_too_large')

  const normal = await harness(t, definition(), { approval: 'approve' })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  const cancelled = await normal.gateway.execute({ ...normal.common, requestId: 'cancel-1', toolCallId: 'cancel-call' as never, connectorRevision: 1, toolName: 'echo', input: { delayMs: 1000 }, signal: controller.signal })
  assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.equal(cancelled.error.code, 'cancelled')
  await normal.mcp.shutdown()
  assert.deepEqual(normal.supervisor.activePids(), [])

  const crash = definition({ config: { transport: 'stdio', command: process.execPath, args: [fixture], cwd: null, publicEnvironment: { MCP_FIXTURE_MODE: 'crash' }, secretEnvironmentNames: [] } })
  const crashHarness = await harness(t, crash, { approval: 'approve' })
  const crashed = await crashHarness.gateway.execute({ ...crashHarness.common, requestId: 'crash-1', toolCallId: 'crash-call' as never, connectorRevision: 1, toolName: 'echo', input: {} })
  assert.equal(crashed.ok, false)
  await crashHarness.mcp.shutdown()
  assert.deepEqual(crashHarness.supervisor.activePids(), [])
})
