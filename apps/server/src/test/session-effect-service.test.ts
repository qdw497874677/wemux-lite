import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId, UserId } from '@wemux/domain'
import type { FileRequestPayload, TerminalRequestPayload, WorkerToServer } from '@wemux/wire-protocol'
import { SessionFileService } from '../application/session-file-service.ts'
import { SessionTerminalService } from '../application/session-terminal-service.ts'
import { ServerService } from '../application/server-service.ts'
import { WorkerService } from '../application/worker-service.ts'
import { Notifications } from '../application/notifications.ts'
import { ProjectAccessService } from '../application/project-access-service.ts'
import { SessionAccessService } from '../application/session-access-service.ts'
import { adminRouteFixture } from './fixtures/admin-route-fixture.ts'
import { effectResponse } from './fixtures/session-effect-fixture.ts'

async function serviceFixture() {
  const f = await adminRouteFixture()
  const notifications = new Notifications(), workers = new WorkerService(f.app.store, notifications)
  const effects: (FileRequestPayload | TerminalRequestPayload)[] = []
  const gateway = { async send(workerId: Parameters<WorkerService['receive']>[0], payload: FileRequestPayload | TerminalRequestPayload) {
    // A new transaction here would reject if the authorization transaction leaked into gateway I/O.
    await f.app.store.transaction(async tx => { assert.ok(await tx.resources.getSession(f.sessionId as SessionId)) })
    effects.push(payload)
    await workers.receive(workerId, effectResponse(payload) as WorkerToServer)
  } }
  const files = new SessionFileService(f.app.service, workers, gateway, 20)
  const terminals = new SessionTerminalService(f.app.service, workers, gateway, 20)
  const id = f.sessionId as SessionId, owner = f.accounts.owner.id as UserId, member = f.accounts.member.id as UserId
  const calls = (actor?: UserId) => [
    () => files.write(id, 'fixture.txt', 'YQ==', actor),
    () => terminals.request(id, { operation: 'create', cols: 80, rows: 24 }, actor),
    () => terminals.request(id, { operation: 'write', terminalId: 'synthetic-terminal', data: 'input' }, actor),
    () => terminals.request(id, { operation: 'resize', terminalId: 'synthetic-terminal', cols: 90, rows: 30 }, actor),
    () => terminals.request(id, { operation: 'dispose', terminalId: 'synthetic-terminal' }, actor),
  ]
  const access = new SessionAccessService(f.app.store, new ProjectAccessService(f.app.store))
  return { ...f, notifications, workers, gateway, files, terminals, effects, id, owner, member, calls, access }
}

// Detailed transport/outbox and target-file assertions live in terminal-write-closed.test.ts.
async function policyRejected(f: Awaited<ReturnType<typeof serviceFixture>>, call: () => Promise<unknown>) {
  const before = await f.snapshot(), forks = await f.app.store.resources.listSessionForks(f.project.id), effects = f.effects.length
  await assert.rejects(call, { status: 403, code: 'write_channel_closed', message: '平台当前未开放文件和终端写入通道。' })
  assert.deepEqual(await f.snapshot(), before)
  assert.deepEqual(await f.app.store.resources.listSessionForks(f.project.id), forks)
  assert.equal(f.effects.length, effects)
}

test('application effects refuse all new writes before actor and resource lookup, including trusted compositions', async t => {
  const f = await serviceFixture(); t.after(() => f.close())
  for (const call of f.calls()) await policyRejected(f, call)
  assert.equal(f.effects.length, 0)
  for (const call of f.calls(f.owner)) await policyRejected(f, call)
  assert.equal(f.effects.length, 0)
  const trusted = new ServerService(f.app.store, f.notifications)
  await policyRejected(f, () => new SessionFileService(trusted, f.workers, f.gateway).write(f.id, 'fixture.txt', 'YQ=='))
  await policyRejected(f, () => new SessionTerminalService(trusted, f.workers, f.gateway).request(f.id, { operation: 'dispose', terminalId: 'synthetic-terminal' }))
})

test('application policy closure does not expose role or Session grant revocation', async t => {
  const f = await serviceFixture(); t.after(() => f.close())
  await f.access.updateShareScope(f.owner, f.id, { shareScope: 'selected-members' })
  await f.access.grant(f.owner, f.id, { userId: f.member })
  await f.access.require(f.member, f.id, 'control') // A successful earlier route check is not admission.
  // Queue revocation ahead of all five application checks using the real transaction FIFO.
  const revoke = f.app.store.transaction(tx => tx.identity.removeSessionGrant(f.id, f.member))
  const denied = f.calls(f.member).map(call => assert.rejects(call, { status: 403, code: 'write_channel_closed' }))
  await Promise.all([revoke, ...denied])
  assert.equal(f.effects.length, 0)
  await f.access.grant(f.owner, f.id, { userId: f.member })
  for (const call of f.calls(f.member)) await policyRejected(f, call)
  await f.access.require(f.member, f.id, 'control')
  assert.equal((await f.request(`/projects/${f.project.id}/grants`, { body: { userId: f.member, role: 'viewer' } })).status, 201)
  const before = f.effects.length
  for (const call of f.calls(f.member)) await policyRejected(f, call)
  assert.equal(f.effects.length, before)
  await f.access.updateShareScope(f.owner, f.id, { shareScope: 'owner-only' })
  for (const call of f.calls(f.member)) await policyRejected(f, call)
  assert.equal(f.effects.length, before)
})

test('application write closure precedes deleted Task and Session visibility checks', async t => {
  const f = await serviceFixture(); t.after(() => f.close())
  await f.app.store.transaction(async tx => { const task = (await tx.tasks.get(f.task.id))!; await tx.tasks.save({ ...task, deletedAt: new Date().toISOString() }) })
  await f.access.updateShareScope(f.owner, f.id, { shareScope: 'owner-only' })
  for (const call of f.calls(f.member)) await policyRejected(f, call)
  for (const call of f.calls(f.owner)) await policyRejected(f, call)
  assert.equal(f.effects.length, 0)
})

test('policy refusal happens before gateway I/O even after later revocation', async t => {
  const f = await serviceFixture(); t.after(() => f.close())
  let dispatched = 0
  const gateway = { async send(workerId: Parameters<WorkerService['receive']>[0], payload: FileRequestPayload | TerminalRequestPayload) {
    dispatched++
    // Revocation after entry to send is deliberately outside this hardening contract.
    await f.access.updateShareScope(f.owner, f.id, { shareScope: 'owner-only' })
    await f.gateway.send(workerId, payload)
  } }
  await policyRejected(f, () => new SessionFileService(f.app.service, f.workers, gateway).write(f.id, 'fixture.txt', 'YQ==', f.member))
  assert.equal(dispatched, 0)
  await f.access.updateShareScope(f.owner, f.id, { shareScope: 'owner-only' })
  await policyRejected(f, () => f.files.write(f.id, 'fixture.txt', 'YQ==', f.member))
  assert.equal(f.effects.length, 0)
})

test('policy-closed writes never reach gateway timeout or Worker response failure mapping', async t => {
  const f = await serviceFixture(); t.after(() => f.close())
  const silent = { async send() {} }
  await policyRejected(f, () => new SessionFileService(f.app.service, f.workers, silent, 5).write(f.id, 'fixture.txt', 'YQ==', f.owner))
  await policyRejected(f, () => new SessionTerminalService(f.app.service, f.workers, silent, 5).request(f.id, { operation: 'create', cols: 80, rows: 24 }, f.owner))
  const failed = { async send(workerId: Parameters<WorkerService['receive']>[0], payload: FileRequestPayload | TerminalRequestPayload) {
    await f.workers.receive(workerId, { type: payload.type === 'fs.request' ? 'fs.response' : 'terminal.response', requestId: payload.requestId, ok: false, error: 'unavailable' } as WorkerToServer)
  } }
  await policyRejected(f, () => new SessionFileService(f.app.service, f.workers, failed).write(f.id, 'fixture.txt', 'YQ==', f.owner))
  await policyRejected(f, () => new SessionTerminalService(f.app.service, f.workers, failed).request(f.id, { operation: 'create', cols: 80, rows: 24 }, f.owner))
})
