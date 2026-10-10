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
  // A local-looking Project and Worker must not launder a supplied cluster token.
  const registration = await runtime.registerTurn({ id: 'turn', sessionId: 'session', capabilityToken: token } as Turn, 'local-worker')
  const result = await runtime.handle('http.call', token, { connectorId: 'http', connectorRevision: 1, operationId: 'read', requestId: 'req', toolCallId: 'call', input: {} })
  assert.equal((result?.body as { error?: { code?: string } }).error?.code, 'scope_denied', JSON.stringify(result))
  const mcpResult = await runtime.handle('mcp.list_tools', token, { connectorId: 'mcp' })
  assert.equal((mcpResult?.body as { error?: { code?: string } }).error?.code, 'scope_denied')
  assert.equal(outbound, 0)
  assert.equal(mcpCalls, 0)
  assert.equal(grantChecks, 0, 'missing verifier must deny before checking a different grant')
  assert.deepEqual((await store.listConnectorDenials()).map(item => item.reasonCode), ['scope_denied', 'scope_denied'])
  await registration.release()
  if (missing === 'both') {
    const local = await runtime.registerTurn({ id: 'local-turn', sessionId: 'local-session' } as Turn, 'local-worker', 'local')
    const localResult = await runtime.handle('http.call', local.token, { connectorId: 'http', connectorRevision: 1, operationId: 'read', requestId: 'local-req', toolCallId: 'local-call', input: {} })
    assert.equal((localResult?.body as { ok?: boolean }).ok, true)
    assert.equal(outbound, 1, 'independently minted local capability can execute without Server verifiers')
    await local.release()
  }
})

test('locally minted token with explicit local registration remains independently usable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-local-verifier-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const runtime = new WorkerConnectorRuntime(store)
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const registered = await runtime.registerTurn({ id: 'local-turn', sessionId: 'local-session' } as Turn, 'local-worker', 'local')
  assert.ok(registered.token)
  assert.equal(registered.snapshot.projectId, 'local')
  await registered.release()
  await assert.rejects(runtime.registerTurn({ id: 'bad', sessionId: 'local-session', capabilityToken: 'supplied' } as Turn, 'local-worker', 'local'), /local.*token/i)
})
