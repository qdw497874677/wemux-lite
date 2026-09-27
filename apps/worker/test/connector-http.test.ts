import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HttpConnectorDefinition } from '@wemux/connector'
import { WorkerCredentialStore } from '../src/connectors/credential-store.js'
import { HttpConnectorExecutor } from '../src/connectors/http-executor.js'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

const timestamp = '2026-01-01T00:00:00.000Z' as never
function definition(overrides: Partial<HttpConnectorDefinition> = {}): HttpConnectorDefinition {
  return { id: 'connector-http' as never, projectId: 'project-1' as never, name: 'HTTP', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: 'credential-http' as never, credentialAvailability: 'available', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false }, createdAt: timestamp, updatedAt: timestamp, kind: 'http', config: { baseUrl: 'https://api.example.test/v1', authentication: 'api_key', publicHeaders: { accept: 'application/json' }, allowedOperations: [{ id: 'lookup', method: 'POST', pathTemplate: '/items/{id}', allowedQueryNames: ['view'], allowedRequestHeaderNames: ['x-trace'], requestContentTypes: ['application/json'] }], allowPrivateNetwork: false }, ...overrides }
}
async function harness(t: test.TestContext, fetch: typeof globalThis.fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-http-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  t.after(() => store.close())
  const credentials = new WorkerCredentialStore(store, { key: 'http-test-key' })
  await credentials.put({ id: 'credential-http' as never, connectorId: 'connector-http', authType: 'api_key', secret: { value: 'PRIVATE-TOKEN' } })
  return new HttpConnectorExecutor(credentials, { fetch, lookup: async hostname => [{ address: hostname === '127.0.0.1' ? '127.0.0.1' : '8.8.8.8', family: 4 }] })
}

test('HTTP connector enforces operation allowlists and injects authentication last', async t => {
  let observed: Request | null = null
  const executor = await harness(t, (async (input, init) => { observed = new Request(input, init); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }) }) as typeof fetch)
  const result = await executor.execute(definition(), { operationId: 'lookup', pathParameters: { id: '../one' }, query: { view: 'short' }, headers: { 'x-trace': 'trace' }, body: { hello: 'world' } })
  assert.equal(observed!.url, 'https://api.example.test/v1/items/..%2Fone?view=short')
  assert.equal(observed!.headers.get('authorization'), 'Bearer PRIVATE-TOKEN')
  assert.deepEqual(result.output, { status: 200, ok: true, contentType: 'application/json', body: { ok: true } })
  assert.doesNotMatch(JSON.stringify(result.agentSummary), /PRIVATE-TOKEN/)
  assert.doesNotMatch(JSON.stringify(result.journalSummary), /PRIVATE-TOKEN/)
  await assert.rejects(executor.execute(definition(), { operationId: 'lookup', pathParameters: { id: '1' }, headers: { authorization: 'attacker' }, body: {} }), /not allowed/)
  await assert.rejects(executor.execute(definition(), { operationId: 'lookup', pathParameters: { id: '1' }, query: { hidden: 'x' }, body: {} }), /not allowed/)
})

test('HTTP connector blocks redirects to private destinations and stops oversized streams', async t => {
  let requests = 0
  const executor = await harness(t, (async input => { requests++; if (requests === 1) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); return new Response('never') }) as typeof fetch)
  await assert.rejects(executor.execute(definition({ config: { ...definition().config, authentication: 'none' }, credentialRef: null, credentialAvailability: 'not_required' }), { operationId: 'lookup', pathParameters: { id: '1' }, body: {} }), /private|loopback|blocked/i)

  const large = await harness(t, (async () => new Response(new Uint8Array(300_000), { status: 200 })) as typeof fetch)
  await assert.rejects(large.execute(definition(), { operationId: 'lookup', pathParameters: { id: '1' }, body: {} }), /exceeds/)
})
