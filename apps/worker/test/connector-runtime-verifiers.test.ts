import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Turn } from '@wemux/domain'
import { WorkerConnectorRuntime } from '../src/connectors/runtime.js'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

for (const missing of ['both', 'binding', 'grant'] as const) test(`cluster token cannot execute without ${missing} verifier`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-verifier-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  let outbound = 0, mcpCalls = 0, grantChecks = 0
  const options = {
    fetch: (async () => { outbound++; return new Response('{}') }) as typeof fetch,
    lookup: async () => [{ address: '8.8.8.8', family: 4 as const }],
    ...(missing === 'binding' || missing === 'both' ? {} : { verifyBinding: async () => ({ projectId: 'local', workspaceId: 'local' }) }),
    ...(missing === 'grant' || missing === 'both' ? {} : { verifyServerGrant: async () => { grantChecks++; return true } }),
  }
  const runtime = new WorkerConnectorRuntime(store, options)
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const now = new Date().toISOString() as never
  await store.saveConnectorDefinition({ id: 'http' as never, projectId: 'local' as never, kind: 'http', name: 'HTTP', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false }, config: { baseUrl: 'https://fixture.example.test', authentication: 'none', publicHeaders: {}, allowedOperations: [{ id: 'read', method: 'GET', pathTemplate: '/items', allowedQueryNames: [], allowedRequestHeaderNames: [], requestContentTypes: [] }], allowPrivateNetwork: false }, createdAt: now, updatedAt: now })
  await store.saveConnectorDefinition({ id: 'mcp' as never, projectId: 'local' as never, kind: 'mcp', name: 'MCP', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: true }, config: { transport: 'stdio', command: process.execPath, args: ['--version'], cwd: null, publicEnvironment: {}, secretEnvironmentNames: [] }, createdAt: now, updatedAt: now })
  t.mock.method(runtime.mcp, 'listTools', async () => { mcpCalls++; throw new Error('MCP external execution forbidden') })
  const token = 'server-issued-capability-token'
  // Missing authority must reject before the registration's credential-availability
  // update; a local-looking Project and Worker cannot launder a cluster token.
  const definitionBefore = await store.getConnectorDefinition('http')
  await assert.rejects(runtime.registerTurn({ id: 'turn', sessionId: 'session', capabilityToken: token, capabilitySnapshot: {
    id: 'snapshot', sessionId: 'session', projectId: 'local', workspaceId: 'local', version: 1,
    assets: [], allowedTools: ['http.call'], allowedConnectorIds: ['http'], connectors: [{ ...definitionBefore!, credentialAvailability: 'available' }], createdAt: now,
  } } as Turn, 'local-worker', 'cluster'), /connector_cluster_grant_unverified/)
  assert.deepEqual(await store.getConnectorDefinition('http'), definitionBefore)
  assert.equal(outbound, 0)
  assert.equal(mcpCalls, 0)
  assert.equal(grantChecks, 0)
  assert.deepEqual(await store.listConnectorDenials(), [])
  if (missing === 'both') {
    await assert.rejects(runtime.registerTurn({ id: 'local-turn', sessionId: 'local-session' } as Turn, 'local-worker', 'local'), /local_origin_unverified/)
    assert.equal(outbound, 0)
  }
})

test('forged cluster Turn with local-looking names cannot become local or bypass a mismatched Server identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-forged-local-names-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  let checks = 0
  const runtime = new WorkerConnectorRuntime(store, {
    verifyBinding: async () => ({ projectId: 'local', workspaceId: 'local' }),
    verifyLocalOrigin: async () => false,
    verifyServerGrant: async (_token, operation, _local, expected) => {
      checks++
      assert.equal(operation, 'connector.identity')
      assert.deepEqual(expected, { sessionId: 'local-session', turnId: 'local-turn', projectId: 'local', workspaceId: 'local' })
      return false // Server authenticated a different Turn identity.
    },
  })
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const turn = { id: 'local-turn', sessionId: 'local-session', capabilityToken: 'forged', capabilitySnapshot: { id: 'snapshot', projectId: 'local', workspaceId: 'local', sessionId: 'local-session', version: 1, assets: [], allowedTools: ['http.call'], allowedConnectorIds: [], connectors: [], createdAt: new Date().toISOString() } } as Turn
  await assert.rejects(runtime.registerTurn(turn, 'local-worker', 'local'), /local Turn cannot supply a capability token/)
  await assert.rejects(runtime.registerTurn(turn, 'local-worker', 'cluster'), /connector_cluster_grant_unverified/)
  assert.equal(checks, 1)
  assert.deepEqual(await store.listConnectorDefinitions(), [])
})

test('locally minted token with explicit local registration remains independently usable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-local-verifier-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const runtime = new WorkerConnectorRuntime(store, { verifyBinding: async () => ({ projectId: 'local', workspaceId: 'local' }), verifyLocalOrigin: async () => true })
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const registered = await runtime.registerTurn({ id: 'local-turn', sessionId: 'local-session' } as Turn, 'local-worker', 'local')
  assert.ok(registered.token)
  assert.equal(registered.snapshot.projectId, 'local')
  await registered.release()
  await assert.rejects(runtime.registerTurn({ id: 'bad', sessionId: 'local-session', capabilityToken: 'supplied' } as Turn, 'local-worker', 'local'), /local.*token/i)
})

// A supplied cluster snapshot with a missing token must not be relabelled local,
// even when the caller explicitly asserts local provenance.
test('tokenless cluster snapshot cannot mint a local Connector capability', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-untrusted-snapshot-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  let outbound = 0
  const runtime = new WorkerConnectorRuntime(store, {
    verifyBinding: async () => ({ projectId: 'local', workspaceId: 'local' }),
    verifyLocalOrigin: async () => false,
    fetch: async () => { outbound++; return new Response('{}') },
  })
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const turn = { id: 'cluster-turn', sessionId: 'cluster-session', capabilityToken: null, capabilitySnapshot: {
    id: 'cluster-snapshot', projectId: 'local', workspaceId: 'local', sessionId: 'cluster-session',
    version: 1, assets: [], allowedTools: ['http.call'], allowedConnectorIds: [], connectors: [], createdAt: new Date().toISOString(),
  } } as Turn
  await assert.rejects(runtime.registerTurn(turn, 'local-worker', 'local'), /local Turn cannot supply a capability snapshot/)
  await assert.rejects(runtime.registerTurn({ ...turn, capabilitySnapshot: null } as Turn, 'local-worker', 'local'), /local_origin_unverified/)
  await assert.rejects(runtime.registerTurn(turn, 'local-worker', 'cluster'), /cluster Turn requires an explicit origin and Server capability token/)
  await assert.rejects(runtime.registerTurn(turn, 'local-worker', undefined as never), /explicit origin/)
  assert.equal(outbound, 0)
})
