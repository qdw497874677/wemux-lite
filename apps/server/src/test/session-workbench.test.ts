import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, CommandId, EventSeq, ModelId, SessionEventPayload, TurnId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService, now } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { AuthenticationService } from '../application/auth.js'
import { httpHandler } from '../http/handler.js'
import { SessionStreams } from '../http/sse.js'

async function fixture(path = ':memory:') {
  const store = new SqliteServerStore(path)
  const service = new ServerService(store, new Notifications())
  const { project } = await service.bootstrap()
  const { worker } = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'test' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, capabilities: [{ agentKey: 'pi' as AgentKey, displayName: 'Pi', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'detected' }] }] }))
  const { workspace } = await service.createWorkspace({ projectId: project!.id, workerId: worker.id, name: 'test' })
  await store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready', placements: workspace.placements.map(p => ({ ...p, status: 'ready' })) }))
  const create = (requestId: string) => service.createSession({ requestId, workspaceId: workspace.id, title: 'test', agentKey: 'pi', modelId: 'test' })
  const { session } = await create('first')
  let seq = 0
  const append = (...payloads: SessionEventPayload[]) => store.transaction(tx => tx.cache.applyEvents(session.id, payloads.map(payload => ({ sessionId: session.id, seq: ++seq as EventSeq, occurredAt: now(), payload }))))
  const streams = new SessionStreams(service)
  const token = 'session-workbench-bootstrap-token'
  const server = createServer(httpHandler(service, new AuthenticationService(store, token), streams))
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
    ['/runtime/approvals/approval-one', { commandId: 'approve', decision: 'approve' }, 'runtime.approval.resolve'],
  ] as const) {
    const path = `/sessions/${f.session.id}${suffix}`
    assert.equal((await f.request(path, 'POST', body)).status, 202)
    assert.equal((await f.request(path, 'POST', body)).status, 202)
    assert.equal((await f.store.commands.getPendingCommand(body.commandId as CommandId))!.command.kind, kind)
    assert.equal((await f.request(path, 'POST', { ...body, ...('name' in body ? { name: 'set_model' } : { decision: 'deny' }) })).status, 409)
  }
  assert.equal((await f.request(`/sessions/${f.session.id}/runtime/commands`, 'POST', { name: 'unknown' })).status, 400)
  assert.equal((await f.request(`/sessions/${f.session.id}/runtime/approvals/a`, 'POST', { decision: 'unknown' })).status, 400)
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
