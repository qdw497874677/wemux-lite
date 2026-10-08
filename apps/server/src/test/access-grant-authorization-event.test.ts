import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import type { ProjectId, SessionId, TeamId, Timestamp } from '@wemux/domain'
import { ProjectAccessService } from '../application/project-access-service.ts'
import { SessionAccessService } from '../application/session-access-service.ts'
import { createWemuxServer } from '../server.ts'
import { seedLocalAccount } from './fixtures/administrator.ts'

const password = 'Ticket09-grant-authorization-password'

async function fixture(t: TestContext) {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: ['admin@example.test'], mail: {}, google: {} })
  t.after(() => app.close())
  const owner = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.test', password })
  const member = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.test', password })
  const teamId = randomUUID() as TeamId, projectId = randomUUID() as ProjectId, sessionId = randomUUID() as SessionId
  const at = new Date().toISOString() as Timestamp
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Grant event Team', createdAt: at })
    for (const user of [owner, member]) await tx.identity.saveMembership({ teamId, userId: user.id, role: 'member', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner.id, name: 'Grant event Project', shareScope: 'selected-members', deletedAt: null })
    await tx.resources.saveSession({ id: sessionId, projectId, ownerId: owner.id, workspaceId: 'grant-workspace' as never, title: 'Silent Session', shareScope: 'project',
      binding: { workspaceId: 'grant-workspace' as never, agent: { workerId: 'grant-worker' as never, agentKey: 'pi' as never }, modelId: null },
      runtimeState: 'idle', archivedAt: null, deletedAt: null })
  })
  // The real composition's Notifications also drives the HTTP stream in E1-6.
  const notifications = app.service.notifications
  const projects = new ProjectAccessService(app.store, notifications)
  const sessions = new SessionAccessService(app.store, projects, notifications)
  const identityQuery = { userId: member.id, teamId, projectId, sessionId }
  const seedProjectGrant = (role: 'manager' | 'viewer') => app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId, userId: member.id, role }))
  const countNotifications = () => {
    let count = 0
    t.after(notifications.onAuthorization(member.id, () => { count++ }))
    return () => count
  }
  return { app, owner, member, projectId, sessionId, projects, sessions, notifications, identityQuery, seedProjectGrant, countNotifications }
}

test('E1-1 Project Grant manager → viewer notifies the affected user', async t => {
  const f = await fixture(t)
  await f.seedProjectGrant('manager')
  const count = f.countNotifications()
  await f.projects.grant(f.owner.id, f.projectId, { userId: f.member.id, role: 'viewer' })
  assert.ok(count() >= 1, 'Project Grant downgrade must notify the affected user')
})

test('E1-2 first Project Grant notifies the affected user', async t => {
  const f = await fixture(t), count = f.countNotifications()
  assert.equal((await f.app.store.identity.getIdentityRecords(f.identityQuery)).projectGrant, null)
  await f.projects.grant(f.owner.id, f.projectId, { userId: f.member.id, role: 'viewer' })
  assert.equal(count(), 1, 'First Project Grant must notify exactly once')
})

test('E1-3 Session Grant notifies the affected user', async t => {
  const f = await fixture(t)
  await f.seedProjectGrant('viewer')
  const count = f.countNotifications()
  await f.sessions.grant(f.owner.id, f.sessionId, { userId: f.member.id })
  assert.equal(count(), 1, 'Session Grant must notify exactly once')
})

test('E1-4 grant callbacks read committed identity records immediately', async t => {
  const f = await fixture(t)
  await f.seedProjectGrant('manager')
  const reads: ReturnType<typeof f.app.store.identity.getIdentityRecords>[] = []
  t.after(f.notifications.onAuthorization(f.member.id, () => {
    // Calling this committed reader inside a transaction rejects with
    // "Use tx readers inside a transaction", so moving emit into tx fails here.
    const read = f.app.store.identity.getIdentityRecords(f.identityQuery)
    reads.push(read)
    return read.then(() => undefined)
  }))
  await f.projects.grant(f.owner.id, f.projectId, { userId: f.member.id, role: 'viewer' })
  assert.equal(reads.length, 1, 'Project Grant must emit after commit')
  assert.equal((await reads[0]!).projectGrant?.role, 'viewer')
  await f.sessions.grant(f.owner.id, f.sessionId, { userId: f.member.id })
  assert.equal(reads.length, 2, 'Session Grant must emit after commit')
  const records = await reads[1]!
  assert.equal(records.projectGrant?.role, 'viewer')
  assert.deepEqual(records.sessionGrant, { sessionId: f.sessionId, userId: f.member.id })
})

test('E1-5 Project revoke and updateShareScope each notify exactly once per user', async t => {
  const f = await fixture(t)
  await f.seedProjectGrant('manager')
  const count = f.countNotifications()
  await f.projects.updateShareScope(f.owner.id, f.projectId, { shareScope: 'team' })
  assert.equal(count(), 1, 'Membership plus Grant must not duplicate scope notification')
  await f.projects.revoke(f.owner.id, f.projectId, f.member.id)
  assert.equal(count(), 2, 'Project revoke must add exactly one notification')
})

test('E1-5 Session revoke and updateShareScope each notify exactly once per user', async t => {
  const f = await fixture(t)
  await f.seedProjectGrant('viewer')
  await f.app.store.transaction(tx => tx.identity.saveSessionGrant({ sessionId: f.sessionId, userId: f.member.id }))
  const count = f.countNotifications()
  await f.sessions.updateShareScope(f.owner.id, f.sessionId, { shareScope: 'selected-members' })
  assert.equal(count(), 1, 'Membership plus Grant must not duplicate scope notification')
  await f.sessions.revoke(f.owner.id, f.sessionId, f.member.id)
  assert.equal(count(), 2, 'Session revoke must add exactly one notification')
})

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) await delay(10)
  assert.ok(predicate(), message)
}

async function login(base: string, username: string) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ login: username, password }) })
  assert.equal(response.status, 200)
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const body = await response.json()
  return { Cookie: cookie, 'X-CSRF-Token': body.csrfToken as string, Origin: base, 'Content-Type': 'application/json' }
}

test('E1-6 silent Cookie Session stream revalidates by grant event before the 15s heartbeat', async t => {
  const f = await fixture(t)
  await f.seedProjectGrant('manager')
  assert.equal(f.app.server.listening, false)
  const base = await f.app.listen(0)
  assert.notEqual(new URL(base).port, '8004')
  assert.equal(f.app.server.listening, true)
  t.diagnostic(`server lifecycle pid=${process.pid} listeners=0→1 url=${base}`)
  const abort = new AbortController()
  let reading: Promise<void> | undefined
  t.after(async () => {
    abort.abort()
    await reading
    await f.app.close()
    assert.equal(f.app.server.listening, false)
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: Number(new URL(base).port) })
      socket.once('connect', () => { socket.destroy(); reject(new Error('Test server port still open')) })
      socket.once('error', error => {
        try { assert.equal((error as NodeJS.ErrnoException).code, 'ECONNREFUSED'); resolve() } catch (failure) { reject(failure) }
      })
    })
    t.diagnostic(`server lifecycle pid=${process.pid} listeners=1→0 url=${base} ECONNREFUSED`)
  })
  const ownerHeaders = await login(base, 'owner'), memberHeaders = await login(base, 'member')
  // No Worker, turns, journal writes or session notifications are produced in this test.
  let sessionNotifications = 0
  t.after(f.notifications.onSession(f.sessionId, () => { sessionNotifications++ }))
  const before = await f.app.service.events(f.sessionId, 1, 500, f.member.id)
  assert.deepEqual(before.events, [])
  const response = await fetch(`${base}/api/sessions/${f.sessionId}/stream`, { headers: memberHeaders, signal: abort.signal })
  assert.equal(response.status, 200)
  const frames: { text: string; at: number }[] = []
  let streamError: unknown, ended = false
  reading = (async () => {
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    let pending = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) { ended = true; break }
        pending += decoder.decode(chunk.value, { stream: true })
        let boundary: number
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          frames.push({ text: pending.slice(0, boundary), at: Date.now() })
          pending = pending.slice(boundary + 2)
        }
      }
    } catch (error) { if (!abort.signal.aborted) streamError = error }
    finally { reader.releaseLock() }
  })()
  const freshness = () => frames.filter(frame => frame.text.startsWith('event: freshness\n'))
  await waitFor(() => freshness().length === 1, 'Initial freshness must arrive')
  const idleStarted = Date.now()
  await delay(20_050)
  assert.equal(freshness().length, 1, 'A silent stream must have no second freshness before downgrade')
  assert.ok(frames.some(frame => frame.text === ': heartbeat'), 'Observe at least one real 15s heartbeat')
  assert.ok(frames.every(frame => frame.text.startsWith('event: freshness\n') || frame.text === ': heartbeat'))
  t.diagnostic(`idleMs=${Date.now() - idleStarted} freshness=${freshness().length} heartbeat=${frames.filter(frame => frame.text === ': heartbeat').length}`)
  const downgradedAt = Date.now()
  const grant = await fetch(`${base}/api/projects/${f.projectId}/grants`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ userId: f.member.id, role: 'viewer' }) })
  assert.equal(grant.status, 201)
  await grant.json()
  try {
    await waitFor(() => freshness().length >= 2, 'Grant downgrade must produce a second freshness within 2s (not heartbeat polling)')
  } finally {
    const arrivedAt = freshness()[1]?.at
    t.diagnostic(`downgradedAt=${new Date(downgradedAt).toISOString()} freshnessAt=${arrivedAt ? new Date(arrivedAt).toISOString() : 'none'} elapsedMs=${arrivedAt ? arrivedAt - downgradedAt : Date.now() - downgradedAt} sessionNotifications=${sessionNotifications}`)
    assert.equal(sessionNotifications, 0, 'No onSession interference during the observation window')
    assert.deepEqual((await f.app.service.events(f.sessionId, 1, 500, f.member.id)).events, before.events)
  }
  assert.ok(freshness()[1]!.at - downgradedAt < 2000)
  assert.equal(freshness().length, 2)
  assert.equal(streamError, undefined)
  assert.equal(ended, false, 'Viewer retains read access: downgrade must revalidate, not close')
})
