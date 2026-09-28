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
