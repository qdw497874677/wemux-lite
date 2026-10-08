import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WorkerService } from '../application/worker-service.ts'
import { SessionAccessService } from '../application/session-access-service.ts'
import { ProjectAccessService } from '../application/project-access-service.ts'
import type { WorkerCommand } from '@wemux/wire-protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, CommandId, EventSeq, ModelId, SessionEventPayload, TurnId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService, now, canonicalCommand } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { AuthenticationService } from '../application/auth.js'
import { httpHandler } from '../http/handler.js'
import { SessionStreams } from '../http/sse.js'
import { seedOperator, administratorDirectory, instanceOperatorId } from './fixtures/administrator.js'

async function fixture(path = ':memory:') {
  const store = new SqliteServerStore(path)
  const service = new ServerService(store, new Notifications())
  const { project, token } = await seedOperator(store, service)
  const { worker } = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'test' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, capabilities: [{ agentKey: 'pi' as AgentKey, displayName: 'Pi', version: null, mode: 'execution', availability: { status: 'available' }, modelSwap: true, models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'detected' }, { modelId: 'test-next' as ModelId, displayName: 'Test Next', source: 'detected' }] }] }))
  const { workspace } = await service.createWorkspace({ projectId: project!.id, workerId: worker.id, name: 'test' })
  await store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready', placements: workspace.placements.map(p => ({ ...p, status: 'ready' })) }))
  const create = (requestId: string) => service.createSession({ requestId, workspaceId: workspace.id, title: 'test', agentKey: 'pi', modelId: 'test' })
  const { session } = await create('first')
  let seq = 0
  const append = (...payloads: SessionEventPayload[]) => store.transaction(tx => tx.cache.applyEvents(session.id, payloads.map(payload => ({ sessionId: session.id, seq: ++seq as EventSeq, occurredAt: now(), payload }))))
  const streams = new SessionStreams(service)
  const server = createServer(httpHandler({ service, auth: new AuthenticationService(store, administratorDirectory(store)), streams }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { store, service, session, create, append, request, async close() { streams.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close() } }
}

test('queued cancellation uses submission identity, rejects other Sessions and is idempotent', async t => {
  const f = await fixture(); t.after(() => f.close())
  const queued = await f.service.enqueue(f.session.id, { commandId: 'submit', messageId: 'message', content: 'hello' })
  const path = `/sessions/${f.session.id}/messages/${queued.commandId}/cancel`
  assert.equal((await f.request(path, 'POST', { commandId: 'cancel' })).status, 202)
  assert.equal((await f.request(path, 'POST', { commandId: 'cancel' })).status, 202)
  assert.deepEqual((await f.store.commands.getPendingCommand('cancel' as CommandId))!.command, { kind: 'session.cancel-queued', sessionId: f.session.id, submissionCommandId: 'submit' })
  assert.equal((await f.store.commands.get(queued.commandId))!.status, 'pending', 'must issue Worker cancellation, not cancel the Server outbox')
  const other = (await f.create('other')).session
  assert.equal((await f.request(`/sessions/${other.id}/messages/submit/cancel`, 'POST', {})).status, 404)
  assert.equal((await f.request(`/sessions/${f.session.id}/messages/message/cancel`, 'POST', {})).status, 404)
  const another = await f.service.enqueue(f.session.id, { content: 'another' })
  assert.equal((await f.request(`/sessions/${f.session.id}/messages/${another.commandId}/cancel`, 'POST', { commandId: 'cancel' })).status, 409)
  assert.equal((await f.service.listCommands({})).filter(c => c.commandId === 'cancel').length, 1)
})

test('execution view merges paginated journal and unsettled deliveries without resurrecting consumed messages; stop retry retains target', async t => {
  const f = await fixture(); t.after(() => f.close())
  const a = await f.service.enqueue(f.session.id, { commandId: 'a', content: 'first' })
  const b = await f.service.enqueue(f.session.id, { commandId: 'b', content: 'second' })
  const c = await f.service.enqueue(f.session.id, { commandId: 'c', content: 'in transit' })
  const turnId = 'turn-one' as TurnId
  await f.append({ kind: 'message.queued', ...a, content: 'first', position: 0 }, { kind: 'message.queued', ...b, content: 'second', position: 1 }, { kind: 'turn.started', turnId, messageId: a.messageId })
  await f.append(...Array.from({ length: 501 }, (): SessionEventPayload => ({ kind: 'assistant.text.delta', turnId, text: 'x' })))
  const view = await (await f.request(`/sessions/${f.session.id}`)).json()
  assert.equal(view.activeTurnId, turnId)
  assert.deepEqual(view.queuedMessages, [{ commandId: 'b', messageId: 'b', content: 'second', position: 1 }, { commandId: 'c', messageId: 'c', content: 'in transit', position: null }])
  assert.ok(view.freshness)
  const stop = `/sessions/${f.session.id}/turn/stop`
  assert.equal((await f.request(stop, 'POST', { commandId: 'wrong-turn', turnId: 'other' })).status, 409)
  assert.equal((await f.request(stop, 'POST', { commandId: 'stop' })).status, 202)
  await f.append({ kind: 'turn.finished', turnId, outcome: 'cancelled', failure: null }, { kind: 'message.cancelled', commandId: 'cancel-b' as CommandId, messageId: b.messageId })
  assert.equal((await f.request(stop, 'POST', { commandId: 'stop' })).status, 202)
  assert.equal((await f.request(stop, 'POST', {})).status, 409)
  await f.append({ kind: 'turn.started', turnId: 'turn-two' as TurnId, messageId: c.messageId })
  assert.equal((await f.request(stop, 'POST', { commandId: 'stop' })).status, 202)
  assert.deepEqual((await f.store.commands.getPendingCommand('stop' as CommandId))!.command, { kind: 'turn.stop', sessionId: f.session.id, turnId })
  assert.equal((await f.request(stop, 'POST', { commandId: 'stop', turnId: 'turn-two' })).status, 409)
  assert.deepEqual((await f.service.sessionView(f.session.id)).queuedMessages, [])
})

test('runtime operations and approval resolution share command idempotency and validation', async t => {
  const f = await fixture(); t.after(() => f.close())
  for (const [suffix, body, kind] of [
    ['/runtime/commands', { commandId: 'compact', name: 'compact' }, 'runtime.command'],
    ['/runtime/approvals/approval-one', { commandId: 'approve', decision: 'approve', turnId: 'approval-turn' }, 'runtime.approval.resolve'],
  ] as const) {
    const path = `/sessions/${f.session.id}${suffix}`
    assert.equal((await f.request(path, 'POST', body)).status, 202)
    assert.equal((await f.request(path, 'POST', body)).status, 202)
    assert.equal((await f.store.commands.getPendingCommand(body.commandId as CommandId))!.command.kind, kind)
    assert.equal((await f.request(path, 'POST', { ...body, ...('name' in body ? { name: 'set_thinking_level' } : { decision: 'deny' }) })).status, 409)
  }
  const swap = await f.request(`/sessions/${f.session.id}/runtime/commands`, 'POST', { commandId: 'model-swap', name: 'set_model', arguments: { modelId: 'test-next' } })
  assert.equal(swap.status, 202, await swap.text())
  assert.equal((await f.service.getSession(f.session.id)).binding.modelId, 'test')
  assert.deepEqual((await f.store.commands.getPendingCommand('model-swap' as CommandId))!.command, { kind: 'runtime.command', sessionId: f.session.id, operationId: 'model-swap', name: 'set_model', arguments: { modelId: 'test-next' } })
  assert.equal((await f.request(`/sessions/${f.session.id}/runtime/commands`, 'POST', { name: 'unknown' })).status, 400)
  assert.equal((await f.request(`/sessions/${f.session.id}/runtime/approvals/a`, 'POST', { decision: 'unknown' })).status, 400)
})

test('model admission is immutable across retries and does not speculate about Worker execution', async t => {
  const f = await fixture(); t.after(() => f.close())
  const path = `/sessions/${f.session.id}/runtime/commands`
  const body = { commandId: 'model-replay', name: 'set_model', arguments: { modelId: 'test-next' } }
  assert.equal((await f.request(path, 'POST', body)).status, 202)
  assert.equal((await f.request(path, 'POST', body)).status, 202, 'retry must preserve the original wire command')
  assert.equal((await f.service.getSession(f.session.id)).binding.modelId, 'test', 'admission is not a confirmed model change')
  assert.equal((await f.request(path, 'POST', { ...body, arguments: { modelId: 'test' } })).status, 409)
  assert.equal((await f.service.listCommands({})).filter(c => c.commandId === body.commandId).length, 1)
  await f.store.transaction(async tx => {
    const s = (await tx.resources.getSession(f.session.id))!
    await tx.resources.saveSession({ ...s, runtimeState: 'running', binding: { ...s.binding, modelId: 'test-next' as ModelId } })
    const w = (await tx.resources.getWorker(s.binding.agent.workerId))!
    await tx.resources.saveWorker({ ...w, capabilities: [] })
  })
  assert.equal((await f.request(path, 'POST', body)).status, 202, 'receipt replay is independent of changed capability/runtime projection')
  const rejected = await f.request(path, 'POST', { ...body, commandId: 'new-model' })
  assert.equal(rejected.status, 409, 'new intent rechecks current capability')
  assert.equal((await rejected.json()).error.code, 'model_not_admitted')
  assert.equal(await f.store.commands.get('new-model' as CommandId), null, 'definitive rejection creates no command')
})

async function retainedModelFixture(t: TestContext, { target = 'test', confirmed = null, cancelled = false, rejectedPredecessor = false }: { target?: string; confirmed?: string | null; cancelled?: boolean; rejectedPredecessor?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'retained-model-')), path = join(dir, 'server.db')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const f = await fixture(path), id = f.session.id
  const body = { commandId: 'legacy-model', name: 'set_model', arguments: { modelId: target } }
  const command: WorkerCommand = { kind: 'runtime.command', sessionId: id, operationId: body.commandId as TurnId, name: 'set_model', arguments: { ...body.arguments, previousModelId: 'test' } }
  await f.store.transaction(async tx => {
    await tx.commands.insertPending({ commandId: body.commandId as CommandId, workerId: f.session.binding.agent.workerId, command, payloadFingerprint: createHash('sha256').update(canonicalCommand(command)).digest('hex'), createdAt: now() })
    await tx.resources.saveSession({ ...f.session, binding: { ...f.session.binding, modelId: target as ModelId } })
  })
  if (cancelled) await f.service.cancelCommand(body.commandId as CommandId)
  if (rejectedPredecessor) {
    const next: WorkerCommand = { ...command, operationId: 'legacy-successor' as TurnId, arguments: { modelId: 'later', previousModelId: target } }
    await f.store.transaction(async tx => {
      await tx.commands.insertPending({ commandId: 'legacy-successor' as CommandId, workerId: f.session.binding.agent.workerId, command: next, payloadFingerprint: createHash('sha256').update(canonicalCommand(next)).digest('hex'), createdAt: now() })
      await tx.commands.recordReceipt({ commandId: body.commandId as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'old rejection', retryable: false } }, now())
      // Preimage receipt handler restored A, although the successor captured speculative B.
      await tx.resources.saveSession({ ...f.session, binding: { ...f.session.binding, modelId: 'test' as ModelId } })
    })
  }
  if (confirmed) {
    await new WorkerService(f.store, new Notifications()).receive(f.session.binding.agent.workerId, { type: 'sync', kind: 'batch', sessionId: id, throughSeq: 1 as EventSeq, hasMore: false, events: [{ sessionId: id, seq: 1 as EventSeq, occurredAt: now(), payload: { kind: 'model.changed', previousModelId: target as ModelId, modelId: confirmed as ModelId } }] })
  }
  const wire = await f.store.commands.getPendingCommand(body.commandId as CommandId)
  await f.close()
  const db = new DatabaseSync(path)
  // Exercise the full compatibility upgrade, including migration36's partial
  // reconciliation followed by the command-chain repair.
  try { db.exec('DROP TRIGGER command_rejection_no_dispatch; DROP TABLE command_rejections'); db.exec('DROP INDEX IF EXISTS attention_failed_runs_order; DROP INDEX IF EXISTS attention_dead_letters_order; DROP INDEX IF EXISTS attention_human_reviews_order'); db.prepare('DELETE FROM schema_migrations WHERE version>=?').run(36) } finally { db.close() }
  const reopened = new SqliteServerStore(path)
  const access = new SessionAccessService(reopened, new ProjectAccessService(reopened))
  const service = new ServerService(reopened, new Notifications(), undefined, undefined, undefined, access)
  t.after(() => reopened.close())
  return { store: reopened, service, id, body, wire, workerId: f.session.binding.agent.workerId }
}

test('retained legacy model command replays original wire after upgrade and still rejects changed intent or authority', async t => {
  const f = await retainedModelFixture(t)
  assert.deepEqual(await f.service.invokeRuntimeCommand(f.id, f.body, instanceOperatorId), { commandId: f.body.commandId })
  assert.deepEqual(await f.store.commands.getPendingCommand(f.body.commandId as CommandId), f.wire)
  await assert.rejects(f.service.invokeRuntimeCommand(f.id, { ...f.body, arguments: { modelId: 'test-next' } }, instanceOperatorId), /Conflicting commandId/)
  await assert.rejects(f.service.invokeRuntimeCommand(f.id, { ...f.body, operationId: 'other' }, instanceOperatorId), /Conflicting commandId/)
  await assert.rejects(f.service.invokeRuntimeCommand(f.id, { ...f.body, commandId: 'injected', arguments: { modelId: 'test', previousModelId: 'forged' } }, instanceOperatorId), /reserved/)
  await f.store.transaction(async tx => tx.resources.saveSession({ ...(await tx.resources.getSession(f.id))!, ownerId: 'other' as typeof instanceOperatorId, shareScope: 'owner-only' }))
  await assert.rejects(f.service.invokeRuntimeCommand(f.id, f.body, instanceOperatorId), /Session not found/)
  assert.deepEqual(await f.store.commands.getPendingCommand(f.body.commandId as CommandId), f.wire)
})

for (const confirmed of [null, 'test-next', 'later']) test(`retained optimistic selection is reconciled at upgrade without undoing confirmed ${confirmed}`, async t => {
  const f = await retainedModelFixture(t, { target: 'test-next', confirmed })
  assert.equal((await f.store.resources.getSession(f.id))!.binding.modelId, confirmed ?? 'test')
  const workers = new WorkerService(f.store, new Notifications())
  await workers.receive(f.workerId, { type: 'ack', receipt: { commandId: f.body.commandId as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'model unavailable', retryable: false } } })
  assert.equal((await f.store.resources.getSession(f.id))!.binding.modelId, confirmed ?? 'test')
  assert.equal((await f.store.commands.get(f.body.commandId as CommandId))!.status, 'rejected')
  assert.deepEqual(await f.store.commands.getPendingCommand(f.body.commandId as CommandId), f.wire)
})

for (const confirmed of [null, 'later']) test(`cancelled legacy command reconciles before delayed rejection with confirmation ${confirmed}`, async t => {
  const f = await retainedModelFixture(t, { target: 'test-next', cancelled: true, confirmed })
  assert.equal((await f.store.resources.getSession(f.id))!.binding.modelId, confirmed ?? 'test')
  await new WorkerService(f.store, new Notifications()).receive(f.workerId, { type: 'ack', receipt: { commandId: f.body.commandId as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'late rejection', retryable: false } } })
  assert.equal((await f.store.resources.getSession(f.id))!.binding.modelId, confirmed ?? 'test')
  assert.deepEqual(await f.store.commands.getPendingCommand(f.body.commandId as CommandId), f.wire)
})

test('rejected legacy predecessor cannot make pending successor previousModelId authoritative', async t => {
  const f = await retainedModelFixture(t, { target: 'test-next', rejectedPredecessor: true })
  assert.equal((await f.store.resources.getSession(f.id))!.binding.modelId, 'test')
  const successor = await f.store.commands.getPendingCommand('legacy-successor' as CommandId)
  assert.deepEqual(successor?.command.kind === 'runtime.command' && successor.command.arguments, { modelId: 'later', previousModelId: 'test-next' })
})

test('late legacy rejection never rolls back a post-upgrade confirmed model, including duplicate receipt', async t => {
  const f = await retainedModelFixture(t, { target: 'test-next' })
  const workers = new WorkerService(f.store, new Notifications())
  await workers.receive(f.workerId, { type: 'sync', kind: 'batch', sessionId: f.id, throughSeq: 1 as EventSeq, hasMore: false, events: [{ sessionId: f.id, seq: 1 as EventSeq, occurredAt: now(), payload: { kind: 'model.changed', previousModelId: 'test' as ModelId, modelId: 'test-next' as ModelId } }] })
  for (let n = 0; n < 2; n++) {
    await workers.receive(f.workerId, { type: 'ack', receipt: { commandId: f.body.commandId as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'model unavailable', retryable: false } } })
    assert.equal((await f.store.resources.getSession(f.id))!.binding.modelId, 'test-next')
  }
})

test('model rejection fences a delayed earlier dispatch after capability restoration and database reopen', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'model-fence-')), database = join(directory, 'server.sqlite')
  const f = await fixture(database); t.after(async () => { await f.close(); rmSync(directory, { recursive: true, force: true }) })
  const path = `/sessions/${f.session.id}/runtime/commands`
  const body = { commandId: 'delayed-model', name: 'set_model', arguments: { modelId: 'test-next' } }
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  // A has not entered admission yet (e.g. buffered by a proxy); B overtakes it.
  const earlierDispatch = held.then(() => f.request(path, 'POST', body))
  const worker = (await f.store.resources.getWorker(f.session.binding.agent.workerId))!
  await f.store.transaction(tx => tx.resources.saveWorker({ ...worker, capabilities: [] }))
  const rejection = await f.request(path, 'POST', body)
  assert.equal(rejection.status, 409); assert.equal((await rejection.json()).error.code, 'model_not_admitted')
  await f.store.transaction(tx => tx.resources.saveWorker(worker))
  release()
  const late = await earlierDispatch
  assert.equal(late.status, 409, 'released model identity can never be admitted later')
  assert.equal((await late.json()).error.code, 'model_not_admitted')
  assert.equal(await f.store.commands.get(body.commandId as CommandId), null)
  const fence = await f.store.commands.getRejection(body.commandId as CommandId)
  assert.ok(fence)
  await assert.rejects(f.store.transaction(tx => tx.commands.insertPending({ commandId: body.commandId as CommandId, workerId: worker.id, command: { kind: 'turn.stop', sessionId: f.session.id, turnId: 'late' as TurnId }, payloadFingerprint: 'different', createdAt: now() })), /Conflicting commandId/)
  const db = new (await import('node:sqlite')).DatabaseSync(database)
  try {
    assert.throws(() => db.prepare('DELETE FROM command_rejections WHERE id=?').run(body.commandId), /immutable/)
    assert.throws(() => db.prepare('UPDATE command_rejections SET data=data WHERE id=?').run(body.commandId), /immutable/)
  } finally { db.close() }
  const other = new SqliteServerStore(database)
  try {
    const service = new ServerService(other, new Notifications())
    assert.deepEqual(await other.commands.getRejection(body.commandId as CommandId), fence)
    await assert.rejects(service.invokeRuntimeCommand(f.session.id, body), e => e instanceof Error && 'code' in e && e.code === 'model_not_admitted')
    await assert.rejects(service.invokeRuntimeCommand(f.session.id, { ...body, arguments: { modelId: 'test' } }), /Conflicting commandId/)
    await assert.rejects(service.stopTurn(f.session.id, { commandId: body.commandId, turnId: 't' }), /Conflicting commandId|Turn is not active/)
  } finally { other.close() }
  assert.equal((await f.request(path, 'POST', { ...body, commandId: 'fresh-selection' })).status, 202, 'new explicit identity may select the restored model')
})

test('model change during an active Turn is admitted for the next Turn only', async t => {
  const f = await fixture(); t.after(() => f.close())
  await f.store.transaction(async tx => tx.resources.saveSession({ ...(await tx.resources.getSession(f.session.id))!, runtimeState: 'running' }))
  const response = await f.request(`/sessions/${f.session.id}/runtime/commands`, 'POST', { commandId: 'next-turn-model', name: 'set_model', arguments: { modelId: 'test-next' } })
  assert.equal(response.status, 202, await response.text())
  assert.equal((await f.service.getSession(f.session.id)).binding.modelId, 'test')
})

test('rename/archive/unarchive persist independently of deletion and default lists remain compatible', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wemux-session-workbench-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'server.sqlite')
  const f = await fixture(path)
  try {
    const url = `/sessions/${f.session.id}`
    await f.append({ kind: 'session.runtime.changed', state: 'idle', reason: null })
    const beforeCommands = await f.service.listCommands({})
    assert.equal((await f.request(url, 'PATCH', { title: 'Renamed' })).status, 200)
    const archived = await (await f.request(url, 'PATCH', { archived: true })).json()
    assert.equal(archived.title, 'Renamed'); assert.ok(archived.archivedAt); assert.equal(archived.deletedAt, null)
    assert.equal((await (await f.request(url, 'PATCH', { archived: true })).json()).archivedAt, archived.archivedAt)
    for (const [query, length] of [['', 1], ['?archived=true', 1], ['?archived=false', 0]] as const) assert.equal((await (await f.request(`/sessions${query}`)).json()).items.length, length)
    assert.equal((await f.request('/sessions?archived=invalid')).status, 400)
    assert.equal((await f.request(url, 'PATCH', { archived: 'true' })).status, 400)
    assert.equal((await f.service.events(f.session.id, 1, 100)).events.length, 1)
    assert.deepEqual(await f.service.listCommands({}), beforeCommands)
    const reopened = new SqliteServerStore(path)
    try {
      const service = new ServerService(reopened, new Notifications())
      assert.equal((await service.getSession(f.session.id)).archivedAt, archived.archivedAt)
      assert.equal((await service.getSession(f.session.id)).title, 'Renamed')
      await service.update('sessions', f.session.id, { archived: false })
    } finally { reopened.close() }
    const restored = await (await f.request(url)).json()
    assert.equal(restored.archivedAt, null); assert.equal(restored.title, 'Renamed')
    assert.equal((await (await f.request('/sessions?archived=false')).json()).items.length, 1)
  } finally { await f.close() }
})

test('direct approval HTTP requires explicit Turn and preserves it across receipt retries', async t => {
  const f = await fixture(); t.after(() => f.close())
  const path = `/sessions/${f.session.id}/runtime/approvals/identity`
  for (const turnId of [undefined, null, '', 17]) {
    const response = await f.request(path, 'POST', { commandId: 'explicit-turn', decision: 'approve', turnId })
    assert.equal(response.status, 400)
    assert.equal(await f.store.commands.getPendingCommand('explicit-turn' as CommandId), null)
  }
  const body = { commandId: 'explicit-turn', decision: 'approve', turnId: 'original-turn' }
  assert.equal((await f.request(path, 'POST', body)).status, 202)
  assert.deepEqual((await f.store.commands.getPendingCommand(body.commandId as CommandId))!.command, { kind: 'runtime.approval.resolve', sessionId: f.session.id, turnId: body.turnId, approvalId: 'identity', decision: 'approve' })
  assert.equal((await f.request(path, 'POST', body)).status, 202)
  assert.equal((await f.request(path, 'POST', { ...body, turnId: 'new-turn' })).status, 409)
})
