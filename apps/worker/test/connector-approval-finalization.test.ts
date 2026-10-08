import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Turn } from '@wemux/domain'
import { WorkerConnectorRuntime, type ConnectorApprovalEvent } from '../src/connectors/runtime.js'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
const drain = () => new Promise<void>(resolve => setImmediate(resolve))
async function fixture(t: TestContext, publish: (event: ConnectorApprovalEvent) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-approval-finalization-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  let externalCalls = 0
  const runtime = new WorkerConnectorRuntime(store, { onApproval: publish, lookup: async () => [{ address: '8.8.8.8', family: 4 }], fetch: async () => { externalCalls++; throw new Error('External call forbidden') } })
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const now = new Date().toISOString() as never
  await store.saveConnectorDefinition({ id: 'http' as never, projectId: 'local' as never, kind: 'http', name: 'Fixture', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false }, config: { baseUrl: 'https://fixture.example.test', authentication: 'none', publicHeaders: {}, allowedOperations: [{ id: 'write', method: 'POST', pathTemplate: '/items', allowedQueryNames: [], allowedRequestHeaderNames: [], requestContentTypes: ['application/json'] }], allowPrivateNetwork: false }, createdAt: now, updatedAt: now })
  const registration = await runtime.registerTurn({ id: 'turn', sessionId: 'session' } as Turn, 'worker')
  const call = (id: string, signal?: AbortSignal) => runtime.handle('http.call', registration.token, { connectorId: 'http', connectorRevision: 1, operationId: 'write', requestId: id, toolCallId: id, input: { body: {} } }, signal)
  return { store, runtime, registration, call, externalCalls: () => externalCalls }
}

for (const trigger of ['abort', 'timeout']) for (const cleanup of ['release', 'shutdown']) for (const held of ['requested', 'expired']) {
  test(`${cleanup} drains ${trigger} finalization while ${held} publication is held`, { timeout: 5000 }, async t => {
    const reached = deferred(), gate = deferred(), requested = deferred()
    const events: ConnectorApprovalEvent[] = []
    // Register before fixture cleanup so failures cannot strand its shutdown.
    t.after(() => gate.resolve())
    const f = await fixture(t, async event => { events.push(event); if (event.kind === 'requested') requested.resolve(); if (event.kind === held) { reached.resolve(); await gate.promise } })
    if (trigger === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] })
    const abort = new AbortController()
    const result = f.call('call', abort.signal)
    await requested.promise
    if (trigger === 'timeout') t.mock.timers.tick(5 * 60_000)
    else abort.abort()
    await reached.promise
    assert.deepEqual(f.runtime.listApprovals(), [])
    const other = await f.runtime.registerTurn({ id: 'other-turn', sessionId: 'other-session' } as Turn, 'worker')
    await other.release() // An unrelated Turn does not wait for this finalizer.
    let settled = false
    const finish = (cleanup === 'release' ? f.registration.release() : f.runtime.shutdown()).then(() => { settled = true })
    let repeatedSettled = false
    const repeated = (cleanup === 'release' ? f.registration.release() : f.runtime.shutdown()).then(() => { repeatedSettled = true })
    await drain()
    assert.equal(repeatedSettled, false, 'repeated cleanup must join outstanding publication')
    assert.equal(settled, false, 'cleanup must await a finalizer no longer in the actionable pending map')
    gate.resolve(); await finish; await repeated
    const response = await result
    assert.ok(response && 'ok' in response.body && !response.body.ok)
    assert.equal(response.body.error.code, 'approval_denied')
    assert.deepEqual(events.map(event => event.kind), ['requested', 'expired'])
    assert.equal(f.externalCalls(), 0)
  })
}

test('shutdown rejects registration that was already awaiting definition discovery', async t => {
  const gate = deferred(), reached = deferred()
  t.after(() => gate.resolve())
  const f = await fixture(t, async () => {})
  const list = f.store.listConnectorDefinitions.bind(f.store)
  t.mock.method(f.store, 'listConnectorDefinitions', async () => { const definitions = await list(); reached.resolve(); await gate.promise; return definitions })
  const registration = f.runtime.registerTurn({ id: 'late-turn', sessionId: 'late-session' } as Turn, 'worker')
  const rejected = assert.rejects(registration, /shut.*down/i)
  await reached.promise
  await f.runtime.shutdown()
  gate.resolve(); await rejected
  assert.deepEqual(f.runtime.listApprovals(), [])
})

test('shutdown fences already-authorized preparation and concurrent Turn registration before waiting', { timeout: 5000 }, async t => {
  const requested = deferred(), expiring = deferred(), publication = deferred(), prepared = deferred(), preparation = deferred()
  const events: ConnectorApprovalEvent[] = []
  t.after(() => { publication.resolve(); preparation.resolve() })
  const f = await fixture(t, async event => { events.push(event); if (event.kind === 'requested') requested.resolve(); else { expiring.resolve(); await publication.promise } })
  const first = f.call('first')
  await requested.promise
  const begin = f.store.beginConnectorExecution.bind(f.store)
  t.mock.method(f.store, 'beginConnectorExecution', async (record: Parameters<typeof begin>[0]) => { const state = await begin(record); prepared.resolve(); await preparation.promise; return state })
  const second = f.call('second')
  await prepared.promise
  const shutdown = f.runtime.shutdown()
  await expiring.promise
  preparation.resolve(); await drain()
  assert.deepEqual(f.runtime.listApprovals(), [], 'preparing call must not create an orphan during graceful shutdown')
  const response = await second
  assert.ok(response && 'ok' in response.body && !response.body.ok)
  assert.equal(response.body.error.code, 'approval_denied')
  await assert.rejects(f.runtime.registerTurn({ id: 'new-turn', sessionId: 'new-session' } as Turn, 'worker'), /shut.*down/i)
  assert.deepEqual(events.map(event => event.kind), ['requested', 'expired'])
  publication.resolve(); await shutdown; await first
  assert.equal(f.externalCalls(), 0)
})
