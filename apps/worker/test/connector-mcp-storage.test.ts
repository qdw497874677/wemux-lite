import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { WorkerCredentialStore } from '../src/connectors/credential-store.js'
import type { McpConnectorDefinition } from '@wemux/connector'

const now = '2025-01-01T00:00:00.000Z' as never
function connector(revision = 1): McpConnectorDefinition {
  return { id: 'connector-local' as never, projectId: 'project-local' as never, name: 'local MCP', description: null, revision, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: true }, createdAt: now, updatedAt: now, kind: 'mcp', config: { transport: 'stdio', command: process.execPath, args: ['server.mjs'], cwd: null, publicEnvironment: {}, secretEnvironmentNames: [] } }
}

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-connector-store-'))
  const path = join(dir, 'worker.sqlite')
  const store = new SqliteWorkerStore(path)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store, path }
}

test('local MCP definition CRUD preserves immutable snapshots supplied by callers', async t => {
  const { store } = await setup(t)
  await store.saveConnectorDefinition(connector())
  assert.equal((await store.getConnectorDefinition('connector-local'))?.revision, 1)
  assert.equal((await store.listConnectorDefinitions()).length, 1)
  const original = await store.getConnectorDefinition('connector-local')
  await store.saveConnectorDefinition({ ...connector(2), name: 'updated' })
  assert.equal(original?.revision, 1)
  assert.equal((await store.getConnectorDefinition('connector-local'))?.revision, 2)
  await store.deleteConnectorDefinition('connector-local')
  assert.equal(await store.getConnectorDefinition('connector-local'), null)
})

test('credential storage uses enc:v2 and never writes plaintext secret', async t => {
  const { store, path } = await setup(t)
  const credentials = new WorkerCredentialStore(store, { key: 'connector-test-key' })
  assert.equal(credentials.available, true)
  await credentials.put({ id: 'credential-local' as never, connectorId: 'connector-local' as never, authType: 'custom_credential', secret: { apiKey: 'NEVER-IN-PLAINTEXT' } })
  const resolved = await credentials.resolve('credential-local' as never, 'connector-local' as never)
  assert.equal(resolved.secret.apiKey, 'NEVER-IN-PLAINTEXT')
  const database = await readFile(path)
  assert.equal(database.includes(Buffer.from('NEVER-IN-PLAINTEXT')), false)
  const record = await store.getConnectorCredential('credential-local')
  assert.equal(record?.ciphertext.startsWith('enc:v2:'), true)
})

test('missing encryption key disables only credential operations', async t => {
  const { store } = await setup(t)
  await store.saveConnectorDefinition(connector())
  const credentials = new WorkerCredentialStore(store, { key: '' })
  assert.equal(credentials.available, false)
  await assert.rejects(credentials.put({ id: 'credential-local' as never, connectorId: 'connector-local' as never, authType: 'api_key', secret: { apiKey: 'x' } }), error => (error as { code?: string }).code === 'credential_unavailable')
  assert.equal((await store.listConnectorDefinitions()).length, 1)
})
