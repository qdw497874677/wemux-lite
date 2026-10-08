import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilitySnapshot, Turn } from '@wemux/domain'
import type { HttpConnectorDefinition, McpConnectorDefinition } from '@wemux/connector'
import { WorkerConnectorRuntime } from '../src/connectors/runtime.js'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

const timestamp = '2026-01-01T00:00:00.000Z' as never
function http(): HttpConnectorDefinition { return { id: 'http-1' as never, projectId: 'project-1' as never, kind: 'http', name: 'HTTP', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: 'credential-http' as never, credentialAvailability: 'unconfigured', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false }, config: { baseUrl: 'https://fixture.example.test', authentication: 'api_key', publicHeaders: {}, allowedOperations: [{ id: 'create', method: 'POST', pathTemplate: '/items', allowedQueryNames: [], allowedRequestHeaderNames: [], requestContentTypes: ['application/json'] }], allowPrivateNetwork: false }, createdAt: timestamp, updatedAt: timestamp } }
function mcp(): McpConnectorDefinition { return { id: 'mcp-1' as never, projectId: 'project-1' as never, kind: 'mcp', name: 'MCP', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: true }, config: { transport: 'stdio', command: process.execPath, args: ['--version'], cwd: null, publicEnvironment: {}, secretEnvironmentNames: [] }, createdAt: timestamp, updatedAt: timestamp } }

test('cluster Connector definition writes serialize behind an active Worker transaction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-connector-write-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const transaction = store.transaction(async () => { await gate })
  const definition = http()
  const saving = store.saveClusterConnectorDefinition(definition)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(await Promise.race([saving.then(() => 'saved'), Promise.resolve('waiting')]), 'waiting')
  release()
  await transaction
  assert.equal(await saving, 'applied')
  assert.equal((await store.getConnectorDefinition(definition.id))?.id, definition.id)
})

test('turn registration retains HTTP and MCP definitions in the non-secret snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-turn-connectors-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const runtime = new WorkerConnectorRuntime(store)
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const httpDefinition = http(), mcpDefinition = mcp()
  await store.saveConnectorDefinition(httpDefinition)
  await store.saveConnectorDefinition(mcpDefinition)
  const snapshot: CapabilitySnapshot = { id: 'snapshot-1', projectId: 'project-1' as never, workspaceId: 'workspace-1' as never, sessionId: 'session-1' as never, version: 1, assets: [], allowedTools: ['mcp.call', 'http.call'], allowedConnectorIds: [httpDefinition.id, mcpDefinition.id], connectors: [httpDefinition, mcpDefinition], createdAt: timestamp }
  const turn = { id: 'turn-1', sessionId: snapshot.sessionId, commandId: 'command-1', message: { messageId: 'message-1', content: 'call connector' }, state: 'queued', requestedAt: timestamp, startedAt: null, finishedAt: null, capabilitySnapshot: snapshot, capabilityToken: 'token' } as Turn
  const registered = await runtime.registerTurn(turn, 'worker-1')
  assert.deepEqual(new Set(registered.snapshot.allowedConnectorIds), new Set([httpDefinition.id, mcpDefinition.id]))
  assert.deepEqual(new Set(registered.snapshot.connectors?.map(item => item.kind)), new Set(['http', 'mcp']))
  assert.equal(JSON.stringify(registered.snapshot).includes('PRIVATE-TOKEN'), false)
  assert.equal(registered.snapshot.connectors?.find(item => item.kind === 'http')?.credentialAvailability, 'unconfigured')
  await registered.release()
})

for (const mode of ['pending', 'timeout', 'cancelled', 'shutdown', 'already-aborted', 'release-during-preparation']) test(`Turn release and cancellation fail closed for Connector approval: ${mode}`, { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-approval-release-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const approvalEvents: import('../src/connectors/runtime.js').ConnectorApprovalEvent[] = []
  let notify!: () => void, nativeCalls = 0, requestEvents = 0
  const requested = new Promise<void>(resolve => { notify = resolve })
  let prepared!: () => void, resumePreparation!: () => void
  const preparationReached = new Promise<void>(resolve => { prepared = resolve })
  const preparationGate = new Promise<void>(resolve => { resumePreparation = resolve })
  if (mode === 'release-during-preparation') {
    const begin = store.beginConnectorExecution.bind(store)
    t.mock.method(store, 'beginConnectorExecution', async (record: Parameters<typeof begin>[0]) => {
      const state = await begin(record)
      prepared() // The gateway has already authorized this Turn and persisted execution.
      await preparationGate
      return state
    })
  }
  t.after(() => resumePreparation())
  const runtime = new WorkerConnectorRuntime(store, {
    onApproval: event => { approvalEvents.push(event); if (event.kind === 'requested') { requestEvents++; notify() } },
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async () => { nativeCalls++; return new Response('{}') },
  })
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const definition = http()
  await store.saveConnectorDefinition({ ...definition, credentialRef: null, credentialAvailability: 'not_required', config: { ...definition.config, authentication: 'none' } })
  const turn = { id: 'release-turn', sessionId: 'release-session' } as Turn
  const registration = await runtime.registerTurn(turn, 'worker')
  const unrelated = await runtime.registerTurn({ id: 'other-turn', sessionId: 'other-session' } as Turn, 'worker')
  const abort = new AbortController()
  if (mode === 'already-aborted') abort.abort()
  if (mode === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] })
  const result = runtime.handle('http.call', registration.token, { connectorId: definition.id, connectorRevision: 1, operationId: 'create', requestId: 'release-request', toolCallId: 'release-call', input: { body: {} } }, abort.signal)
  if (mode === 'already-aborted') {
    await result // Keep the Turn registered: cancellation alone must settle the call.
    assert.deepEqual(runtime.listApprovals(), [])
  }
  if (['pending', 'timeout', 'cancelled', 'shutdown'].includes(mode)) {
    await requested
    await unrelated.release(); assert.equal(runtime.listApprovals().length, 1)
    if (mode === 'cancelled') abort.abort()
    if (mode === 'shutdown') await runtime.shutdown()
    if (mode === 'timeout') {
      t.mock.timers.tick(5 * 60_000)
      assert.deepEqual(runtime.listApprovals(), [], 'timeout consumes the request without a human decision')
    }
  }
  if (mode === 'release-during-preparation') await preparationReached
  await registration.release()
  resumePreparation()
  // Drain through requestApproval before checking pending state. A missing guard
  // must fail promptly rather than wait for the five-minute approval timer.
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(runtime.listApprovals(), [], 'release must not leave a five-minute orphan approval')
  const response = await result
  assert.equal(response?.status, 200); assert.equal(nativeCalls, 0)
  assert.ok(response && 'ok' in response.body && !response.body.ok)
  assert.equal(response.body.error.code, 'approval_denied')
  if (mode === 'release-during-preparation' || mode === 'already-aborted') assert.equal(requestEvents, 0)
  else {
    assert.deepEqual(approvalEvents.map(event => event.kind), ['requested', 'expired'])
    const expired = approvalEvents[1]!
    assert.equal(expired.kind, 'expired')
    if (expired.kind === 'expired') {
      assert.equal(expired.sessionId, turn.sessionId); assert.equal(expired.turnId, turn.id)
      assert.equal(expired.approvalId, 'release-call')
      assert.equal(expired.reason, mode === 'pending' ? 'turn_released' : mode)
    }
  }
  assert.equal(runtime.resolveApproval({ sessionId: turn.sessionId, turnId: turn.id, approvalId: 'release-call', decision: 'approve' }), false)
})

test('connector pending consumption requires exact Session and Turn and active capability', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-connector-identity-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const approvals: import('../src/connectors/tool-execution-gateway.js').ConnectorApprovalRequest[] = []
  let notify!: () => void
  const requested = new Promise<void>(resolve => { notify = resolve })
  let nativeCalls = 0
  const runtime = new WorkerConnectorRuntime(store, { onApproval: event => { if (event.kind === 'requested') { approvals.push(event.approval); notify() } }, lookup: async () => [{ address: '8.8.8.8', family: 4 }], fetch: async () => { nativeCalls++; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) } })
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const definition = http()
  await store.saveConnectorDefinition({ ...definition, credentialRef: null, credentialAvailability: 'not_required', config: { ...definition.config, authentication: 'none' } })
  const turn = { id: 'turn-identity', sessionId: 'session-identity' } as Turn
  const registered = await runtime.registerTurn(turn, 'worker')
  const result = runtime.handle('http.call', registered.token, { connectorId: definition.id, connectorRevision: 1, operationId: 'create', requestId: 'request', toolCallId: 'call', input: { body: {} } })
  await requested
  const identity = { sessionId: turn.sessionId, turnId: turn.id, approvalId: approvals[0].approvalId, decision: 'approve' as const }
  assert.throws(() => runtime.resolveApproval({ ...identity, sessionId: 'other-session' }), /identity mismatch/)
  assert.throws(() => runtime.resolveApproval({ ...identity, turnId: 'other-turn' }), /identity mismatch/)
  assert.equal(runtime.listApprovals().length, 1); assert.equal(nativeCalls, 0)
  assert.equal(runtime.resolveApproval(identity), true)
  assert.equal(runtime.resolveApproval(identity), false)
  await result; assert.equal(nativeCalls, 1)
  await registered.release()
})
