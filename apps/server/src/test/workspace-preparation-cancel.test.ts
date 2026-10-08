import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { createWemuxServer } from '../server.ts'
import { WorkerService } from '../application/worker-service.ts'
import { Notifications } from '../application/notifications.ts'
import { TransportV2Peer } from './transport-v2-peer.ts'
import { administratorEmail, administratorToken, instanceOperatorId, seedAdministrator, seedLocalAccount } from './fixtures/administrator.ts'
import { hashSecret } from '../application/auth.ts'

// Cancellation refusal is the effective contract, not proof of physical cancellation.
test('public generic cancel refuses every provision identity, preserving replay/delivery/terminal proof and ordinary cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preparation-refusal-'))
  const options = { databasePath: join(root, 'server.sqlite'), administratorEmails: [administratorEmail] }
  let app = createWemuxServer(options), origin = await app.listen(0), peer: TransportV2Peer | undefined
  let reports = new WorkerService(app.store, new Notifications())
  const call = async (path: string, body?: unknown, method?: string, token = administratorToken) => {
    const response = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  const expected = { status: 409, data: { error: { code: 'protected_command', message: 'protected_command: Workspace preparation cancellation is unavailable' } } }
  let tick = Date.now() + 1000
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const token = (await call('/enrollment-tokens', {})).data.token
    const worker = (await call('/workers/enroll', { token, name: 'Owned cancellation fixture' })).data
    const create = async () => (await call('/workspaces', { projectId: 'default-project', workerId: worker.workerId, name: 'Private preparation' })).data
    const report = (workspaceId: string, commandId: string, status: 'ready' | 'failed') => reports.receive(worker.workerId, { type: 'event', scope: 'workspace', report: { workspaceId, commandId, status, reason: status === 'failed' ? 'Controlled failure' : null, location: null, occurredAt: new Date(tick++).toISOString() } } as never)
    const snapshot = async (created: any) => ({ command: await app.store.commands.get(created.commandId), pending: await app.store.commands.getPendingCommand(created.commandId), workspace: await app.store.resources.getWorkspace(created.workspace.id), deliverable: (await app.store.commands.listDeliverable(worker.workerId, 1000)).map(c => c.commandId) })
    const refuse = async (created: any, label: string) => {
      const before = await snapshot(created)
      for (let i = 0; i < 2; i++) assert.deepEqual(await call(`/commands/${created.commandId}`, undefined, 'DELETE'), expected, label)
      assert.deepEqual(await snapshot(created), before, `${label}: no command/placement/proof/delivery mutation`)
    }
    // Regression first: a terminal report can arrive before the application receipt.
    // Old current-stopped-only protection returns cancelled here despite actual completed preparation.
    const earlyTerminal = await create()
    await report(earlyTerminal.workspace.id, earlyTerminal.commandId, 'ready')
    await refuse(earlyTerminal, 'terminal report before receipt')

    const ordinaryUser = await seedLocalAccount(app.store, { username: 'ordinary', email: 'ordinary@example.test', password: 'synthetic private password' })
    await app.store.transaction(tx => tx.identity.savePersonalAccessToken({ id: 'ordinary-pat' as never, userId: ordinaryUser.id, name: 'ordinary', scopes: ['read', 'write', 'execute', 'admin'], tokenHash: hashSecret('ordinary-token'), createdAt: new Date().toISOString() as never, expiresAt: '2099-01-01T00:00:00Z' as never, lastUsedAt: null, revokedAt: null }))
    for (const id of [earlyTerminal.commandId, 'unknown-command']) {
      const denied = await call(`/commands/${id}`, undefined, 'DELETE', 'ordinary-token')
      assert.equal(denied.status, 403); assert.notEqual(denied.data.error?.code, 'protected_command')
      assert.equal((await call(`/commands/${id}`, undefined, 'DELETE', 'invalid-token')).status, 401)
      const anonymous = await fetch(`${origin}/api/commands/${id}`, { method: 'DELETE' }); assert.equal(anonymous.status, 401)
    }
    const pending = await create()
    await refuse(pending, 'offline pending')
    await app.close(); app = createWemuxServer(options); origin = await app.listen(0); reports = new WorkerService(app.store, new Notifications())
    await refuse(pending, 'after restart offline pending')
    await refuse(earlyTerminal, 'after restart report-before-receipt remains protected')
    peer = new TransportV2Peer(new WebSocket(`${origin.replace('http', 'ws')}/worker/ws`, { headers: { Authorization: `Bearer ${worker.credential}` } }), worker.workerId)
    const sendFrame = peer.raw.bind(peer)
    peer.raw = frame => { if (frame.frameType !== 'transport.ack') sendFrame(frame) } // Hold only the fixture's transport ACK, leaving real Server outbox observable.
    await peer.connect({ name: 'Owned cancellation fixture' })
    await peer.wait(payload => payload.type === 'command' && payload.commandId === pending.commandId)
    assert.equal((await call(`/commands/${pending.commandId}`)).data.status, 'pending')
    // Stop network activity, inspect only the owned durable outbox. Receipt has not been sent.
    await peer.close(); peer = undefined
    const transport = new DatabaseSync(`${options.databasePath}.transport`, { readOnly: true })
    try {
      const outbox = () => transport.prepare('SELECT * FROM transport_outbox ORDER BY worker_id,delivery_epoch,seq').all()
      const before = outbox()
      assert.ok(before.some(row => JSON.parse(String(row.payload_json)).commandId === pending.commandId), 'dispatched provision is durably queued before receipt')
      await refuse(pending, 'durably dispatched before application receipt')
      assert.deepEqual(outbox(), before, 'protected request never removes/changes durable transport rows')
    } finally { transport.close() }
    await reports.receive(worker.workerId, { type: 'ack', receipt: { commandId: pending.commandId, status: 'accepted' } })
    await refuse(pending, 'accepted')
    await report(pending.workspace.id, pending.commandId, 'failed')
    await refuse(pending, 'terminal failed')
    const retry = (await call(`/workspaces/${pending.workspace.id}/reprovision`, { workerId: worker.workerId, requestId: 'retry' })).data
    assert.notEqual(retry.commandId, pending.commandId)
    await refuse(pending, 'superseded accepted attempt')
    await refuse(retry, 'replacement pending')
    assert.equal((await call(`/workspaces/${pending.workspace.id}/reprovision`, { workerId: worker.workerId, requestId: 'retry' })).data.commandId, retry.commandId)
    await reports.receive(worker.workerId, { type: 'ack', receipt: { commandId: retry.commandId, status: 'accepted' } })
    await report(retry.workspace.id, retry.commandId, 'ready')
    await refuse(retry, 'ready terminal')
    const rejected = await create()
    await reports.receive(worker.workerId, { type: 'ack', receipt: { commandId: rejected.commandId, status: 'rejected', error: { code: 'invalid-input', message: 'fixture rejected', retryable: false } } })
    await refuse(rejected, 'rejected')
    // An unrelated ordinary command is still cancellable; provisioning hardening is not a generic redesign.
    await app.store.transaction(tx => tx.commands.insertPending({ commandId: 'ordinary-stop' as never, workerId: worker.workerId, command: { kind: 'turn.stop', sessionId: 'synthetic-session' as never, turnId: 'synthetic-turn' as never }, payloadFingerprint: 'ordinary', createdAt: new Date().toISOString() as never }))
    assert.equal((await call('/commands/ordinary-stop', undefined, 'DELETE', 'ordinary-token')).status, 403)
    assert.equal((await call('/commands/ordinary-stop')).data.status, 'pending')
    await app.store.transaction(tx => tx.identity.savePersonalAccessToken({ id: 'readonly-pat' as never, userId: instanceOperatorId, name: 'readonly', scopes: ['read'], tokenHash: hashSecret('readonly-token'), createdAt: new Date().toISOString() as never, expiresAt: '2099-01-01T00:00:00Z' as never, lastUsedAt: null, revokedAt: null }))
    assert.equal((await call('/commands/ordinary-stop', undefined, 'DELETE', 'readonly-token')).status, 403)
    await seedLocalAccount(app.store, { userId: instanceOperatorId, username: 'deployer', email: administratorEmail, password: 'synthetic cookie admin password' })
    const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'deployer', password: 'synthetic cookie admin password' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const csrf = (await login.json()).csrfToken
    assert.equal((await fetch(`${origin}/api/commands/ordinary-stop`, { method: 'DELETE', headers: { Cookie: cookie, Origin: origin } })).status, 403)
    const cookieProtected = await fetch(`${origin}/api/commands/${retry.commandId}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: origin, 'x-csrf-token': csrf } })
    assert.equal(cookieProtected.status, 409); assert.equal((await cookieProtected.json()).error.code, 'protected_command')
    const cookieCancelled = await fetch(`${origin}/api/commands/ordinary-stop`, { method: 'DELETE', headers: { Cookie: cookie, Origin: origin, 'x-csrf-token': csrf } })
    assert.equal(cookieCancelled.status, 200); assert.equal((await cookieCancelled.json()).status, 'cancelled')
    await app.store.transaction(tx => tx.commands.insertPending({ commandId: 'ordinary-pat-stop' as never, workerId: worker.workerId, command: { kind: 'turn.stop', sessionId: 'synthetic-session' as never, turnId: 'synthetic-turn' as never }, payloadFingerprint: 'ordinary-pat', createdAt: new Date().toISOString() as never }))
    assert.equal((await call('/commands/ordinary-pat-stop', undefined, 'DELETE')).data.status, 'cancelled')
    assert.equal((await call('/commands/ordinary-stop', undefined, 'DELETE')).status, 409)
  } finally { await peer?.close(); await app.close(); await rm(root, { recursive: true, force: true }) }
})
