import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { AgentKey, CredentialId, EventSeq, ModelId, SessionId, Timestamp, UserId } from '@wemux/domain'
import { createWemuxServer } from '../server.ts'
import { hashSecret } from '../application/auth.ts'
import { Notifications } from '../application/notifications.ts'
import { TerminalStreams } from '../http/terminal-sse.ts'
import { administratorEmail, administratorToken, instanceOperatorId, seedOperator } from './fixtures/administrator.ts'

const reader = 'terminal-reader' as UserId
const readerToken = 'terminal-reader-pat'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (!predicate()) { assert.ok(Date.now() < deadline, 'condition timed out'); await delay(10) }
}

async function fixture(t: TestContext, cookie = false) {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  await seedOperator(app.store, app.service)
  const base = await app.listen(0)
  t.after(() => app.close())
  const enrollment = await app.service.createEnrollment({})
  const enrolled = await app.service.enroll({ token: enrollment.token, name: 'terminal-revocation-worker' })
  await app.store.transaction(tx => tx.resources.saveWorker({ ...enrolled.worker, capabilities: [{ agentKey: 'pi' as AgentKey, displayName: 'Pi', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'detected' }] }] }))
  const project = await app.service.createProject({ name: 'terminal-revocation' })
  const { workspace } = await app.service.createWorkspace({ projectId: project.id, workerId: enrolled.worker.id, name: 'workspace' })
  await app.store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready', workerId: enrolled.worker.id, location: { workspaceId: workspace.id, workerId: enrolled.worker.id, rootPath: '/tmp/workspace', checkouts: [] }, placements: workspace.placements.map(placement => ({ ...placement, status: 'ready' as const, location: { workspaceId: workspace.id, workerId: enrolled.worker.id, rootPath: '/tmp/workspace', checkouts: [] } })) }))
  const { session } = await app.service.createSession({ requestId: 'terminal-revocation-session', workspaceId: workspace.id, title: 'Terminal', agentKey: 'pi', modelId: 'test' })
  const at = new Date().toISOString() as Timestamp
  await app.store.transaction(async tx => {
    await tx.identity.saveUser({ id: reader, username: 'terminal-reader', email: null, createdAt: at, status: 'active', authVersion: 0 })
    await tx.identity.saveMembership({ teamId: project.teamId, userId: reader, role: 'member', joinedAt: at })
    await tx.identity.saveProjectGrant({ projectId: project.id, userId: reader, role: 'manager' })
    await tx.identity.savePersonalAccessToken({ id: 'terminal-reader-token' as CredentialId, userId: reader, name: 'terminal reader', tokenHash: hashSecret(readerToken), scopes: ['read', 'write'], authVersion: 0, createdAt: at, expiresAt: '2099-01-01T00:00:00.000Z' as Timestamp, revokedAt: null, lastUsedAt: null })
    await tx.resources.saveProject({ ...project, shareScope: 'selected-members' })
    await tx.resources.saveSession({ ...session, shareScope: 'selected-members' })
    await tx.identity.saveSessionGrant({ sessionId: session.id, userId: reader })
    if (cookie) await tx.identity.saveLoginSession({ id: 'terminal-login', userId: reader, tokenHash: hashSecret('terminal-cookie'), csrfTokenHash: hashSecret('csrf'), authenticationMethod: 'password', authVersion: 0, client: null, authenticatedAt: at, createdAt: at, lastSeenAt: at, idleExpiresAt: '2098-01-01T00:00:00.000Z' as Timestamp, absoluteExpiresAt: '2099-01-01T00:00:00.000Z' as Timestamp, revokedAt: null })
  })
  const request = (path: string, method: string, body?: unknown, token = administratorToken) => fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const streamPath = `/sessions/${session.id}/terminal/stream`
  const open = () => cookie
    ? fetch(`${base}/api${streamPath}`, { headers: { cookie: 'wemux_login_session=terminal-cookie' } })
    : request(streamPath, 'GET', undefined, readerToken)
  const response = await open()
  assert.equal(response.status, 200)
  const stream = response.body!.getReader()
  let text = '', closed = false
  const consumed = (async () => {
    try { for (;;) { const part = await stream.read(); if (part.done) break; text += new TextDecoder().decode(part.value) } }
    finally { closed = true }
  })()
  t.after(async () => { await stream.cancel(); await consumed })
  await until(() => text.includes('event: ready'))
  const output = (data: string) => app.service.notifications.terminal({ type: 'terminal.output', sessionId: session.id, terminalId: 'fixture-terminal', data })
  output('before-revocation')
  await until(() => text.includes('before-revocation'))
  return { app, project, session, enrolled, request, open, streamPath, output, text: () => text, closed: () => closed }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
const revocations: [string, (f: Fixture) => Promise<void>][] = [
  ['Session read permission', async f => { assert.equal((await f.request(`/sessions/${f.session.id}/access`, 'PATCH', { shareScope: 'owner-only' })).status, 200) }],
  ['Project membership', async f => { assert.equal((await f.request(`/projects/${f.project.id}/grants/${reader}`, 'DELETE')).status, 204) }],
  ['Team membership', async f => { assert.equal((await f.request(`/teams/${f.project.teamId}/members/${reader}`, 'DELETE')).status, 204) }],
  ['Session Grant', async f => { assert.equal((await f.request(`/sessions/${f.session.id}/grants/${reader}`, 'DELETE')).status, 204) }],
  ['Session deletion', async f => {
    await f.app.store.transaction(async tx => {
      const worker = await tx.resources.getWorker(f.enrolled.worker.id)
      assert.ok(worker)
      await tx.resources.saveWorker({ ...worker, connectionState: 'online' })
      await tx.cache.recordWorkerHead(f.session.id, 0 as EventSeq)
    })
    await f.app.service.delete('sessions', f.session.id, instanceOperatorId)
  }],
  ['Task deletion fixture without notification', async f => {
    // Public Task deletion forbids associated Sessions. Construct the lifecycle
    // state directly to exercise the stream guard, not an unsupported HTTP API.
    assert.ok(f.session.taskId)
    await f.app.store.transaction(async tx => {
      const task = await tx.tasks.get(f.session.taskId!)
      assert.ok(task)
      await tx.tasks.save({ ...task, deletedAt: new Date().toISOString() })
    })
  }],
  ['Worker revocation', async f => { await f.app.service.revokeWorker(f.enrolled.worker.id, () => {}, instanceOperatorId) }],
  ['PAT revocation without notification', async f => {
    await f.app.store.transaction(async tx => {
      const token = await tx.identity.findPersonalAccessToken(hashSecret(readerToken))
      assert.ok(token)
      await tx.identity.savePersonalAccessToken({ ...token, revokedAt: new Date().toISOString() as Timestamp })
    })
  }],
  ['actor generation invalidation', async f => {
    await f.app.store.transaction(async tx => {
      const user = await tx.identity.getUser(reader)
      assert.ok(user)
      await tx.identity.saveUser({ ...user, authVersion: 1 })
    })
    f.app.service.notifications.authorization(reader)
  }],
]

for (const [name, revoke] of revocations) {
  test(`terminal stream closes after ${name}, emits zero later frames and reauthenticates reconnect`, async t => {
    const f = await fixture(t)
    const before = f.text()
    await revoke(f)
    f.output('must-not-be-delivered')
    await until(f.closed)
    f.output('also-must-not-be-delivered')
    assert.equal(f.text(), before)
    const reconnect = await f.request(f.streamPath, 'GET', undefined, readerToken)
    assert.ok([401, 403, 404].includes(reconnect.status), `reconnect status ${reconnect.status}`)
    await reconnect.arrayBuffer()
  })
}

test('terminal Cookie revocation re-resolves the credential and closes the existing stream', async t => {
  const f = await fixture(t, true)
  const before = f.text()
  await f.app.store.transaction(tx => tx.identity.revokeLoginSession('terminal-login', new Date().toISOString() as Timestamp))
  f.output('revoked-cookie-output')
  await until(f.closed)
  assert.equal(f.text(), before)
  const reconnect = await f.open()
  assert.equal(reconnect.status, 401)
  await reconnect.arrayBuffer()
})

test('terminal idle stream closes via one-second fallback after an unnotified revocation', async t => {
  const f = await fixture(t)
  await revocations.find(([name]) => name === 'Task deletion fixture without notification')![1](f)
  const start = Date.now()
  await until(f.closed)
  assert.ok(Date.now() - start < 2000, 'one-second polling plus scheduling tolerance')
})

test('terminal read remains valid after manager becomes viewer while terminal writes are denied', async t => {
  const f = await fixture(t)
  assert.equal((await f.request(`/projects/${f.project.id}/grants`, 'POST', { userId: reader, role: 'viewer' })).status, 201)
  f.app.service.notifications.authorization(reader)
  f.output('still-readable')
  await until(() => f.text().includes('still-readable'))
  await delay(1100)
  f.output('still-readable-after-poll')
  await until(() => f.text().includes('still-readable-after-poll'))
  assert.equal(f.closed(), false)
  for (const suffix of ['', '/fixture-terminal/write', '/fixture-terminal/resize', '/fixture-terminal/dispose']) {
    const response = await f.request(`/sessions/${f.session.id}/terminal${suffix}`, 'POST', { cols: 80, rows: 24, data: 'forbidden' }, readerToken)
    assert.equal(response.status, 403)
    await response.arrayBuffer()
  }
})

class ResponseFixture extends EventEmitter {
  frames: string[] = []
  ended = false
  failure: Error | undefined
  writeHead() { return this }
  flushHeaders() {}
  write(frame: string) { this.frames.push(frame); return true }
  end() { this.ended = true; this.emit('close') }
  destroy(error?: Error) { this.failure = error; this.end(); return this }
}

test('terminal authorization is single-flight, invalidates in-flight batches and cleans up listeners and timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const notifications = new Notifications()
  const subscriptions = ['onTerminal', 'onAuthorization', 'onSession', 'onProject'] as const
  let active = 0
  for (const name of subscriptions) {
    const original = notifications[name].bind(notifications)
    t.mock.method(notifications, name, (...args: Parameters<typeof original>) => {
      active++
      const unsubscribe = (original as (...values: Parameters<typeof original>) => () => void)(...args)
      return () => { active--; unsubscribe() }
    })
  }
  const streams = new TerminalStreams(notifications), response = new ResponseFixture()
  let calls = 0, release!: () => void
  streams.open(response as unknown as ServerResponse, 'session' as SessionId, reader, 'project', async () => {
    calls++
    if (calls === 1) await new Promise<void>(resolve => { release = resolve })
    else throw new Error('revoked')
  })
  notifications.terminal({ type: 'terminal.output', sessionId: 'session' as SessionId, terminalId: 'terminal', data: 'secret' })
  notifications.authorization(reader)
  t.mock.timers.tick(1000)
  assert.equal(calls, 1)
  release()
  await until(() => response.ended)
  assert.equal(calls, 2)
  assert.deepEqual(response.frames, [])
  assert.equal(active, 0)
  t.mock.timers.tick(10_000)
  notifications.authorization(reader)
  assert.equal(calls, 2)
  streams.close()
})

for (const shutdown of ['client', 'server'] as const) {
  test(`terminal ${shutdown} close stops the polling timer and notification callbacks`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const notifications = new Notifications(), streams = new TerminalStreams(notifications), response = new ResponseFixture()
    let calls = 0
    streams.open(response as unknown as ServerResponse, 'session' as SessionId, reader, 'project', async () => { calls++ })
    await until(() => response.frames.length === 1)
    if (shutdown === 'client') response.destroy(); else streams.close()
    t.mock.timers.tick(30_000)
    notifications.authorization(reader)
    notifications.session('session' as SessionId)
    notifications.terminal({ type: 'terminal.output', sessionId: 'session' as SessionId, terminalId: 'terminal', data: 'after-close' })
    assert.equal(calls, 1)
    assert.equal(response.frames.length, 1)
    streams.close()
  })
}

test('terminal pending authorization buffer is bounded and closes with an explicit overflow reason', () => {
  const notifications = new Notifications(), streams = new TerminalStreams(notifications), response = new ResponseFixture()
  streams.open(response as unknown as ServerResponse, 'session' as SessionId, reader, 'project', () => new Promise(() => {}))
  notifications.terminal({ type: 'terminal.output', sessionId: 'session' as SessionId, terminalId: 'terminal', data: 'x'.repeat(1024 * 1024) })
  assert.equal(response.ended, true)
  assert.match(response.failure!.message, /authorization buffer exceeded/)
  assert.deepEqual(response.frames, [])
  streams.close()
})
