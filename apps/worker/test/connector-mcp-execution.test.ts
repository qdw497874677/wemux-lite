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
import { WorkerConnectorRuntime } from '../src/connectors/runtime.js'
import { stableFingerprint } from '@wemux/connector'
import type { Turn } from '@wemux/domain'
import type { CapabilityGrantClaims, CapabilitySnapshot } from '@wemux/domain'
import type { McpConnectorDefinition } from '@wemux/connector'

const fixture = fileURLToPath(new URL('fixtures/mcp-fixture-server.mjs', import.meta.url))
const timestamp = '2025-01-01T00:00:00.000Z'
const ids = { projectId: 'project-1', workspaceId: 'workspace-1', sessionId: 'session-1', turnId: 'turn-1', workerId: 'worker-1' }

function definition(overrides: Partial<McpConnectorDefinition> = {}): McpConnectorDefinition {
  return { id: 'connector-1' as never, projectId: ids.projectId as never, name: 'fixture', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: true }, createdAt: timestamp as never, updatedAt: timestamp as never, kind: 'mcp', config: { transport: 'stdio', command: process.execPath, args: [fixture], cwd: null, publicEnvironment: {}, secretEnvironmentNames: [] }, ...overrides }
}
function auth(connectorIds = ['connector-1']) {
  const snapshot: CapabilitySnapshot = { id: 'snapshot-1', projectId: ids.projectId as never, workspaceId: ids.workspaceId as never, sessionId: ids.sessionId as never, version: 1, assets: [], allowedTools: ['mcp.call', 'mcp.list_tools'], allowedConnectorIds: connectorIds, connectors: connectorIds.map(id => definition({ id: id as never })), createdAt: timestamp }
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
  const gateway = new ToolExecutionGateway(store, credentials, mcp, { verify: token => { assert.equal(token, 'token'); return claims }, verifyBinding: () => true, verifyCurrentGrant: async () => true }, options.approval ? { request: async () => options.approval! } : undefined)
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

test('two discoveries in one Turn each need a fresh resolvable approval identity', { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-mcp-approval-'))
  const store = new SqliteWorkerStore(join(dir, 'worker.sqlite'))
  const approvals: import('../src/connectors/tool-execution-gateway.js').ConnectorApprovalRequest[] = []
  let notify: (() => void) | undefined
  const runtime = new WorkerConnectorRuntime(store, { onApproval: event => { if (event.kind === 'requested') { approvals.push(event.approval); notify?.() } } })
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(dir, { recursive: true, force: true }) })
  await store.saveConnectorDefinition(definition())
  const registered = await runtime.registerTurn({ id: ids.turnId, sessionId: ids.sessionId } as Turn, ids.workerId)
  const discover = async (index: number) => {
    const published = new Promise<void>(resolve => { notify = resolve })
    const result = runtime.handle('mcp.list_tools', registered.token, { connectorId: 'connector-1' })
    await published
    const approval = approvals[index]!
    assert.equal(approval.operationType, 'write')
    assert.equal(approval.approvalId, approval.toolCallId)
    assert.equal(approval.approvalId, approval.requestId)
    assert.equal(approval.connectorRevision, 1)
    assert.equal(runtime.resolveApproval({ sessionId: ids.sessionId, turnId: ids.turnId, approvalId: approval.approvalId, decision: 'approve' }), true)
    const completed = await result
    assert.equal((completed?.body as { ok: boolean }).ok, true, JSON.stringify(completed?.body))
    return approval
  }
  const first = await discover(0)
  const second = await discover(1)
  assert.notEqual(first.approvalId, second.approvalId)
  assert.notEqual(first.fingerprint, second.fingerprint)
  assert.equal(runtime.resolveApproval({ sessionId: ids.sessionId, turnId: ids.turnId, approvalId: first.approvalId, decision: 'approve' }), false)
  await registered.release()
})

test('discovery approval binds attempt, connector revision and Turn; changed revision or binding cannot discover', async t => {
  const h = await harness(t)
  let bound = true
  let current = true
  let calls = 0
  let discovery = 0
  const original = h.mcp.listTools.bind(h.mcp)
  h.mcp.listTools = async (...args) => { discovery++; return original(...args) }
  const requests: import('../src/connectors/tool-execution-gateway.js').ConnectorApprovalRequest[] = []
  const gateway = new ToolExecutionGateway(h.store, h.credentials, h.mcp, {
    verify: () => auth().claims, verifyBinding: () => bound, verifyCurrentGrant: async () => current,
  }, { request: async request => {
    requests.push(request)
    assert.equal(request.fingerprint, stableFingerprint({ projectId: ids.projectId, workspaceId: ids.workspaceId, sessionId: ids.sessionId, turnId: ids.turnId, workerId: ids.workerId, connectorId: 'connector-1', connectorRevision: request.connectorRevision, operation: 'mcp.list_tools', attempt: request.requestId }))
    if (++calls === 1) {
      await h.store.saveConnectorDefinition(definition({ revision: 2 }))
    } else if (calls === 2) bound = false
    else current = false
    return 'approve'
  } })
  const changed = await gateway.listTools(h.common)
  assert.equal(changed.ok, false); if (!changed.ok) assert.equal(changed.error.code, 'scope_denied')
  assert.equal(discovery, 0)
  await h.store.saveConnectorDefinition(definition())
  const moved = await gateway.listTools(h.common)
  assert.equal(moved.ok, false); if (!moved.ok) assert.equal(moved.error.code, 'scope_denied')
  bound = true
  const revoked = await gateway.listTools(h.common)
  assert.equal(revoked.ok, false); if (!revoked.ok) assert.equal(revoked.error.code, 'scope_denied')
  assert.equal(discovery, 0)
  assert.deepEqual(h.supervisor.activePids(), [])
  assert.equal(new Set(requests.map(request => request.approvalId)).size, 3)
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
  const gateway = new ToolExecutionGateway(store, credentials, mcp, { verify: () => claims, verifyBinding: () => true, verifyCurrentGrant: async () => true }, { request: async () => 'approve' })
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

test('MCP call denied before discovery never starts a connector, and a revoked grant cannot replay a cached result', async t => {
  const h = await harness(t, definition(), { approval: 'deny' })
  const listTools = h.mcp.listTools.bind(h.mcp)
  let discoveryAttempts = 0
  h.mcp.listTools = async (...args) => { discoveryAttempts++; return listTools(...args) }
  const input = { ...h.common, requestId: 'preflight-deny', toolCallId: 'preflight-call' as never, connectorRevision: 1, toolName: 'echo', input: {} }
  const denied = await h.gateway.execute(input)
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'approval_denied')
  assert.deepEqual(h.supervisor.activePids(), [])
  const deniedCatalog = await h.gateway.listTools(h.common)
  assert.equal(deniedCatalog.ok, false); if (!deniedCatalog.ok) assert.equal(deniedCatalog.error.code, 'approval_denied')
  assert.deepEqual(h.supervisor.activePids(), [])
  const unavailable = await h.gateway.execute({ ...input, requestId: 'unsupported', toolCallId: 'unsupported-call' as never, toolName: 'unknown', agentSupportsApproval: false })
  assert.equal(unavailable.ok, false); if (!unavailable.ok) assert.equal(unavailable.error.code, 'approval_denied')
  const channel = await h.gateway.execute({ ...input, requestId: 'channel', toolCallId: 'channel-call' as never, channelDeliveryId: 'delivery-1' })
  assert.equal(channel.ok, false); if (!channel.ok) assert.equal(channel.error.code, 'approval_denied')
  const unavailableCatalog = await h.gateway.listTools({ ...h.common, agentSupportsApproval: false })
  assert.equal(unavailableCatalog.ok, false); if (!unavailableCatalog.ok) assert.equal(unavailableCatalog.error.code, 'approval_denied')
  assert.deepEqual(h.supervisor.activePids(), [])
  assert.equal(discoveryAttempts, 0)

  let current = true
  const guarded = new ToolExecutionGateway(h.store, h.credentials, h.mcp, { verify: () => auth().claims, verifyBinding: () => true, verifyCurrentGrant: async () => current }, { request: async () => 'approve' })
  const allowed = { ...input, requestId: 'cached', toolCallId: 'cached-call' as never }
  assert.equal((await guarded.execute(allowed)).ok, true)
  current = false
  const replay = await guarded.execute(allowed)
  assert.equal(replay.ok, false); if (!replay.ok) assert.equal(replay.error.code, 'scope_denied')
  const before = h.supervisor.activePids().length
  const revoked = await guarded.execute({ ...allowed, requestId: 'revoked', toolCallId: 'revoked-call' as never })
  assert.equal(revoked.ok, false); if (!revoked.ok) assert.equal(revoked.error.code, 'scope_denied')
  assert.equal(h.supervisor.activePids().length, before)
})

test('MCP grant revoked during approval is checked before discovery starts a process', async t => {
  const h = await harness(t)
  const { claims } = auth()
  let live = true
  const gateway = new ToolExecutionGateway(h.store, h.credentials, h.mcp, { verify: () => claims, verifyBinding: () => true, verifyCurrentGrant: async () => live }, { request: async () => { live = false; return 'approve' } })
  const result = await gateway.execute({ ...h.common, requestId: 'revoked-in-wait', toolCallId: 'revoked-in-wait-call' as never, connectorRevision: 1, toolName: 'echo', input: {} })
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'scope_denied')
  assert.deepEqual(h.supervisor.activePids(), [])
  live = true
  const listed = await gateway.listTools(h.common)
  assert.equal(listed.ok, false); if (!listed.ok) assert.equal(listed.error.code, 'scope_denied')
  assert.deepEqual(h.supervisor.activePids(), [])
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
