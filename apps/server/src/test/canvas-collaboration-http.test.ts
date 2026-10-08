import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ProjectId, SessionId, TeamId, Timestamp, UserId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { seedLocalAccount } from './fixtures/administrator.js'
import { adminRouteFixture } from './fixtures/admin-route-fixture.ts'
import { SessionAccessService, type SessionAccessCapability } from '../application/session-access-service.ts'
import { CanvasCollaborationService } from '../application/canvas-collaboration-service.ts'

const password = 'correct horse battery staple'
const at = '2026-03-25T00:00:00.000Z' as Timestamp
function createBarrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function browser(base: string) {
  let cookie = '', csrf = ''
  const headers = (): Record<string, string> => ({ Accept: 'application/json', Origin: base, Host: new URL(base).host, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) })
  return {
    call: async (path: string, init: { method?: string; body?: unknown } = {}) => { const response = await fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers: headers(), ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }); const setCookie = response.headers.getSetCookie().find(value => value.startsWith('wemux_login_session=')); if (setCookie) cookie = setCookie.split(';')[0]!; const data = response.status === 204 ? null : await response.json() as any; if (typeof data?.csrfToken === 'string') csrf = data.csrfToken; return { status: response.status, data } },
    stream: (path: string, extra: Record<string, string> = {}, signal?: AbortSignal) => fetch(`${base}${path}`, { headers: { ...headers(), Accept: 'text/event-stream', ...extra }, signal }),
    createPat: async () => { const response = await fetch(`${base}/auth/personal-access-tokens`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'canvas-read', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) }); return { status: response.status, data: await response.json() as any } },
  }
}

test('canvas collaboration publishes low-sensitivity presence and an authorized SSE snapshot', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: ['admin@example.com'], capabilitySecret: 'canvas-collaboration-test-secret-32-bytes' })
  const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const editorUser = await seedLocalAccount(app.store, { username: 'editor', email: 'editor@example.com', password })
  const teamId = randomUUID() as TeamId, projectId = randomUUID() as ProjectId
  await app.store.transaction(async tx => { await tx.identity.saveTeam({ id: teamId, name: 'Canvas Team', createdAt: at }); await tx.identity.saveMembership({ teamId, userId: ownerUser.id, role: 'owner', joinedAt: at }); await tx.identity.saveMembership({ teamId, userId: editorUser.id, role: 'member', joinedAt: at }); await tx.resources.saveProject({ id: projectId, teamId, ownerId: ownerUser.id, name: 'Canvas Project', shareScope: 'selected-members', deletedAt: null }); await tx.identity.saveProjectGrant({ projectId, userId: editorUser.id, role: 'contributor' }) })
  const base = await app.listen(0); t.after(() => app.close())
  const owner = browser(base), editor = browser(base)
  assert.equal((await owner.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })).status, 200)
  assert.equal((await editor.call('/auth/login', { method: 'POST', body: { login: 'editor', password } })).status, 200)
  assert.equal((await owner.call(`/projects/${projectId}/canvas/collaboration/presence`, { method: 'PUT', body: { displayName: 'Owner', typing: true } })).status, 200)
  const snapshot = await editor.call(`/projects/${projectId}/canvas/collaboration`)
  assert.equal(snapshot.status, 200); assert.equal(snapshot.data.presence[0].userId, ownerUser.id); assert.equal(snapshot.data.presence[0].typing, true); assert.equal('locks' in snapshot.data, false); assert.equal('viewport' in snapshot.data, false)
  const pat = await editor.createPat(); assert.equal(pat.status, 201)
  const patSnapshot = await fetch(`${base}/api/projects/${projectId}/canvas/collaboration`, { headers: { Authorization: `Bearer ${pat.data.token}` } })
  assert.equal(patSnapshot.status, 200)

  const controller = new AbortController(); t.after(() => controller.abort())
  const stream = await editor.stream(`/projects/${projectId}/canvas/collaboration/events`, {}, controller.signal)
  assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = stream.body!.getReader(), decoder = new TextDecoder(); let first = ''
  while (!first.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) break; first += decoder.decode(chunk.value, { stream: true }) }
  assert.match(first, /event: snapshot/); assert.match(first, new RegExp(ownerUser.id))
  await reader.cancel()
  controller.abort()

  const missingCursor = new AbortController(); t.after(() => missingCursor.abort())
  const recovered = await editor.stream(`/projects/${projectId}/canvas/collaboration/events`, { 'Last-Event-ID': '999' }, missingCursor.signal)
  const recoveredReader = recovered.body!.getReader(); let recoveredFirst = ''
  while (!recoveredFirst.includes('\n\n')) { const chunk = await recoveredReader.read(); if (chunk.done) break; recoveredFirst += decoder.decode(chunk.value, { stream: true }) }
  assert.match(recoveredFirst, /event: snapshot/)
  await recoveredReader.cancel(); missingCursor.abort()

  const invalid = await editor.stream(`/projects/${projectId}/canvas/collaboration/events`, { 'Last-Event-ID': 'bad' })
  assert.equal(invalid.status, 400)
})

test('project graph and canvas collaboration reject the same cross-team actor', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: ['admin@example.com'], capabilitySecret: 'canvas-revocation-test-secret-32-bytes' })
  const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const editorUser = await seedLocalAccount(app.store, { username: 'editor', email: 'editor@example.com', password })
  const outsiderUser = await seedLocalAccount(app.store, { username: 'outsider', email: 'outsider@example.com', password })
  const teamId = randomUUID() as TeamId, otherTeamId = randomUUID() as TeamId, projectId = randomUUID() as ProjectId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Canvas Team', createdAt: at }); await tx.identity.saveTeam({ id: otherTeamId, name: 'Other Team', createdAt: at })
    await tx.identity.saveMembership({ teamId, userId: ownerUser.id, role: 'owner', joinedAt: at }); await tx.identity.saveMembership({ teamId, userId: editorUser.id, role: 'member', joinedAt: at }); await tx.identity.saveMembership({ teamId: otherTeamId, userId: outsiderUser.id, role: 'owner', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: ownerUser.id, name: 'Canvas Project', shareScope: 'selected-members', deletedAt: null }); await tx.identity.saveProjectGrant({ projectId, userId: editorUser.id, role: 'viewer' })
  })
  const base = await app.listen(0); t.after(() => app.close())
  const owner = browser(base), editor = browser(base), outsider = browser(base)
  assert.equal((await owner.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })).status, 200)
  assert.equal((await editor.call('/auth/login', { method: 'POST', body: { login: 'editor', password } })).status, 200)
  assert.equal((await outsider.call('/auth/login', { method: 'POST', body: { login: 'outsider', password } })).status, 200)
  assert.equal((await outsider.call(`/projects/${projectId}/canvas/collaboration`)).status, 404)
  // A private Project must not reveal whether it has a graph at all.
  assert.equal((await outsider.call(`/projects/${projectId}/session-graph`)).status, 404)

  const controller = new AbortController(); t.after(() => controller.abort())
  const stream = await editor.stream(`/projects/${projectId}/canvas/collaboration/events`, {}, controller.signal)
  const reader = stream.body!.getReader(), decoder = new TextDecoder(); let initial = ''
  while (!initial.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) break; initial += decoder.decode(chunk.value, { stream: true }) }
  assert.match(initial, /event: snapshot/)
  await app.store.transaction(tx => tx.identity.removeProjectGrant(projectId, editorUser.id as UserId))
  app.service.notifications.authorization(editorUser.id)
  let revoked = ''
  while (!revoked.includes('event: authorization')) { const chunk = await reader.read(); if (chunk.done) break; revoked += decoder.decode(chunk.value, { stream: true }) }
  assert.match(revoked, /event: authorization/); assert.match(revoked, /revoked/)
  assert.equal((await editor.call(`/projects/${projectId}/canvas/collaboration`)).status, 404)
  await reader.cancel(); controller.abort()
})

// This collaboration transport is SSE, not the Worker/Session WebSocket channel.
test('SQLite HTTP and live SSE isolate private Session presence across sharing, revocation, deletion and reconnect', { timeout: 30_000 }, async t => {
  const f = await adminRouteFixture()
  t.after(() => f.close())
  const path = `/projects/${f.project.id}/canvas/collaboration`
  const member = { token: f.accounts.member.token }
  const publish = (activeSessionId: string | null, displayName = 'Private owner') => f.request(`${path}/presence`, { method: 'PUT', body: { displayName, activeSessionId, typing: true } })
  const scope = async (shareScope: string) => assert.equal((await f.request(`/sessions/${f.sessionId}/access`, { method: 'PATCH', body: { shareScope } })).status, 200)
  const open = async (token: string, after = '0') => {
    const controller = new AbortController()
    t.after(() => controller.abort())
    const response = await fetch(`${f.origin}/api${path}/events`, { headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': after }, signal: controller.signal })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    let buffer = ''
    return { async next() {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read()
        assert.equal(chunk.done, false, 'SSE closed before expected event')
        buffer += decoder.decode(chunk.value, { stream: true })
      }
      const end = buffer.indexOf('\n\n'), raw = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      assert.equal(raw.includes('\nid:'), false, 'no global replay cursor')
      const type = raw.match(/event: (.+)/)?.[1]
      return { type, data: JSON.parse(raw.match(/data: (.+)/)?.[1] ?? '{}'), raw }
    }, close() { controller.abort() } }
  }

  await scope('owner-only')
  assert.equal((await f.request(`/sessions/${f.sessionId}`, member)).status, 404)
  const before = (await f.request(path, member)).data
  assert.equal((await publish(f.sessionId)).status, 200)
  assert.deepEqual((await f.request(path, member)).data, before, 'no roster, presence count or revision leak')
  const ownerView = (await f.request(path)).data
  assert.equal(ownerView.presence[0].activeSessionId, f.sessionId)
  assert.equal((await f.request(`${path}/presence`, { ...member, method: 'PUT', body: { activeSessionId: f.sessionId } })).status, 404)
  assert.equal((await publish('nonexistent-session')).status, 404)
  const otherProject = (await f.request('/projects', { body: { name: 'Other presence project', teamId: 'default-team' } })).data
  assert.equal((await f.request(`/projects/${otherProject.id}/canvas/collaboration/presence`, { method: 'PUT', body: { activeSessionId: f.sessionId } })).status, 404)
  assert.deepEqual((await f.request(`/projects/${otherProject.id}/canvas/collaboration`)).data.presence, [])

  const denied = await open(f.accounts.member.token)
  const initial = await denied.next()
  assert.equal(initial.type, 'snapshot'); assert.deepEqual(initial.data, before)
  const authorized = await open(f.accounts.owner.token)
  assert.equal((await authorized.next()).data.presence[0].activeSessionId, f.sessionId)
  assert.equal((await publish(f.sessionId, 'Secret typing change')).status, 200)
  const ownerEvent = await authorized.next()
  assert.equal(ownerEvent.type, 'presence.updated'); assert.equal(ownerEvent.data.payload.activeSessionId, f.sessionId)
  // An authorized project-level marker proves processing passed the hidden update
  // without relying on a timing-only assertion that no event was received.
  assert.equal((await f.request(`${path}/presence`, { ...member, method: 'PUT', body: { displayName: 'Public marker' } })).status, 200)
  const marker = await denied.next()
  assert.equal(marker.type, 'presence.updated'); assert.equal(marker.data.actorId, f.accounts.member.id)
  assert.equal(marker.data.id, 1, 'hidden events must not consume the viewer counter')
  assert.equal(marker.raw.includes(f.sessionId), false)

  const reconnect = await open(f.accounts.member.token, '1')
  const recovered = await reconnect.next()
  assert.equal(recovered.type, 'snapshot'); assert.equal(recovered.raw.includes(f.sessionId), false)
  assert.deepEqual(recovered.data.presence.map((value: { userId: string }) => value.userId), [f.accounts.member.id])
  reconnect.close()

  await scope('selected-members')
  assert.equal((await f.request(`/projects/${f.project.id}/grants`, { body: { userId: f.accounts.member.id, role: 'viewer' } })).status, 201)
  assert.equal((await f.request(`/sessions/${f.sessionId}/grants`, { body: { userId: f.accounts.member.id } })).status, 201)
  assert.equal((await f.request(`/sessions/${f.sessionId}`, member)).status, 200)
  assert.equal((await publish(f.sessionId, 'Shared presence')).status, 200)
  // Closing the second member connection can remove their own project presence.
  let shared = await denied.next()
  if (shared.type === 'presence.left') shared = await denied.next()
  assert.equal(shared.type, 'presence.updated'); assert.equal(shared.data.payload.activeSessionId, f.sessionId)
  assert.equal((await f.request(`/sessions/${f.sessionId}/grants/${f.accounts.member.id}`, { method: 'DELETE' })).status, 204)
  let revoked = await denied.next()
  // A queued presence update from before revocation may already be on this
  // connection; it must not be mistaken for the post-revocation projection.
  if (revoked.type === 'presence.updated') {
    assert.equal(revoked.data.payload.activeSessionId, f.sessionId)
    revoked = await denied.next()
  }
  assert.equal(revoked.type, 'presence.left'); assert.equal(revoked.data.payload.userId, f.accounts.owner.id)
  assert.equal(revoked.raw.includes(f.sessionId), false)
  assert.deepEqual((await f.request(path, member)).data.presence, [])

  assert.equal((await publish(f.sessionId, 'Hidden after revocation')).status, 200)
  assert.equal((await publish(null, 'Project presence')).status, 200)
  const projectPresence = await denied.next()
  assert.equal(projectPresence.type, 'presence.updated'); assert.equal(projectPresence.data.payload.activeSessionId, null)
  assert.equal(projectPresence.raw.includes('Hidden after revocation'), false)

  // Reauthorize then delete the underlying row projection while streams are live.
  await scope('project')
  assert.equal((await publish(f.sessionId, 'Before deletion')).status, 200)
  assert.equal((await denied.next()).data.payload.activeSessionId, f.sessionId)
  await f.app.store.transaction(async tx => {
    const session = (await tx.resources.getSession(f.sessionId as never))!
    await tx.resources.saveSession({ ...session, deletedAt: at })
  })
  f.app.service.notifications.session(f.sessionId as never)
  const deleted = await denied.next()
  assert.equal(deleted.type, 'presence.left'); assert.equal(deleted.raw.includes(f.sessionId), false)
  assert.deepEqual((await f.request(path)).data.presence, [])
  assert.deepEqual((await f.request(path, member)).data.presence, [])
  assert.equal((await publish(f.sessionId)).status, 404)
  const deletedReconnect = await open(f.accounts.member.token, '2')
  assert.deepEqual((await deletedReconnect.next()).data.presence, [])
  deletedReconnect.close(); denied.close(); authorized.close()
})

for (const transport of ['REST', 'opening SSE', 'live SSE'] as const) {
  const barriers = transport === 'REST' ? ['lookup'] : ['lookup', 'delivery']
  const cases = barriers.flatMap(barrier => ['authorization', 'session deletion'].map(invalidation => ({ barrier, invalidation })))
  for (const { barrier, invalidation } of cases) {
    test(`${transport} discards in-flight A after ${invalidation} at ${barrier} barrier`, { timeout: 30_000 }, async t => {
      const f = await adminRouteFixture()
      t.after(() => f.close())
      const path = `/projects/${f.project.id}/canvas/collaboration`
      const member = { token: f.accounts.member.token }
      const sessionB = 'barrier-session-B' as SessionId
      await f.app.store.transaction(async tx => {
        const original = (await tx.resources.getSession(f.sessionId as SessionId))!
        await tx.resources.saveSession({ ...original, id: sessionB })
        if (transport === 'live SSE') await tx.resources.saveSession({ ...original, shareScope: 'owner-only' })
      })
      const publishA = (activeSessionId: string | null, displayName: string) => f.request(`${path}/presence`, { method: 'PUT', body: { activeSessionId, displayName } })
      assert.equal((await publishA(f.sessionId, 'Secret A')).status, 200)
      assert.equal((await f.request(`${path}/presence`, { ...member, method: 'PUT', body: { activeSessionId: sessionB, displayName: 'Readable B' } })).status, 200)
      const controller = new AbortController()
      t.after(() => controller.abort())
      const open = () => fetch(`${f.origin}/api${path}/events`, { headers: { Authorization: `Bearer ${member.token}`, 'Last-Event-ID': '456' }, signal: controller.signal })
      const streamReader = (response: Response) => {
        assert.equal(response.status, 200)
        const reader = response.body!.getReader(), decoder = new TextDecoder()
        let buffer = ''
        return async () => {
          while (!buffer.includes('\n\n')) {
            const chunk = await reader.read()
            assert.equal(chunk.done, false)
            buffer += decoder.decode(chunk.value, { stream: true })
          }
          const end = buffer.indexOf('\n\n'), raw = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          assert.equal(raw.includes('\nid:'), false)
          return { raw, type: raw.match(/event: (.+)/)?.[1], data: JSON.parse(raw.match(/data: (.+)/)?.[1] ?? '{}') }
        }
      }
      let next: ReturnType<typeof streamReader> | undefined
      if (transport === 'live SSE') {
        next = streamReader(await open())
        const first = await next()
        assert.equal(first.type, 'snapshot')
        assert.deepEqual(first.data.presence.map((value: { activeSessionId: string }) => value.activeSessionId), [sessionB])
        // Make A readable without a wakeup, so the publish below starts exactly
        // one controlled refresh with A accepted before B is held.
        await f.app.store.transaction(async tx => {
          const original = (await tx.resources.getSession(f.sessionId as SessionId))!
          await tx.resources.saveSession({ ...original, shareScope: 'project' })
        })
      }
      const reachedB = createBarrier(), releaseB = createBarrier()
      t.after(() => releaseB.resolve())
      const require = SessionAccessService.prototype.require
      let held = false, acceptedA = false
      t.mock.method(SessionAccessService.prototype, 'require', async function(this: SessionAccessService, actor: UserId, id: SessionId, capability?: SessionAccessCapability) {
        const result = await require.call(this, actor, id, capability)
        if (actor === f.accounts.member.id && id === f.sessionId) acceptedA = true
        if (barrier === 'lookup' && actor === f.accounts.member.id && id === sessionB && !held) {
          held = true
          assert.equal(acceptedA, true, 'A was accepted before holding B')
          reachedB.resolve()
          await releaseB.promise
        }
        return result
      })
      if (barrier === 'delivery') {
        const snapshot = CanvasCollaborationService.prototype.snapshot
        t.mock.method(CanvasCollaborationService.prototype, 'snapshot', async function(this: CanvasCollaborationService, actor: UserId, projectId: ProjectId) {
          const result = await snapshot.call(this, actor, projectId)
          if (actor === f.accounts.member.id && !held) {
            held = true
            assert.equal(acceptedA, true)
            assert.ok(result.presence.some(value => value.activeSessionId === f.sessionId))
            // Hold a fully authorized result after service validation. Only a
            // preregistered SSE generation guard can prevent its stale delivery.
            reachedB.resolve()
            await releaseB.promise
          }
          return result
        })
      }
      const pendingRest = transport === 'REST' ? f.request(path, member) : undefined
      const pendingOpen = transport === 'opening SSE' ? open() : undefined
      if (transport === 'live SSE') assert.equal((await publishA(f.sessionId, 'Secret A changed')).status, 200)
      await reachedB.promise
      if (invalidation === 'authorization') {
        assert.equal((await f.request(`/sessions/${f.sessionId}/access`, { method: 'PATCH', body: { shareScope: 'owner-only' } })).status, 200)
      } else {
        await f.app.store.transaction(async tx => {
          const original = (await tx.resources.getSession(f.sessionId as SessionId))!
          await tx.resources.saveSession({ ...original, deletedAt: at })
        })
        f.app.service.notifications.session(f.sessionId as SessionId)
      }
      releaseB.resolve()
      if (pendingRest) {
        const result = await pendingRest
        assert.equal(result.status, 200)
        assert.equal(result.data.revision, 0)
        assert.deepEqual(result.data.presence.map((value: { activeSessionId: string }) => value.activeSessionId), [sessionB])
        assert.equal(JSON.stringify(result.data).includes('Secret A'), false)
      } else if (pendingOpen) {
        next = streamReader(await pendingOpen)
        const result = await next()
        assert.equal(result.type, 'snapshot')
        assert.equal(result.data.revision, 0)
        assert.deepEqual(result.data.presence.map((value: { activeSessionId: string }) => value.activeSessionId), [sessionB])
        assert.equal(result.raw.includes('Secret A'), false)
      }
      if (next) {
        // A visible marker drains the stream without a timing-only absence test.
        assert.equal((await publishA(null, 'Public marker')).status, 200)
        const marker = await next()
        assert.equal(marker.type, 'presence.updated')
        assert.equal(marker.data.payload.activeSessionId, null)
        assert.equal(marker.data.payload.displayName, 'Public marker')
        assert.equal(marker.data.id, 1, 'discarded snapshots do not consume viewer-local IDs')
        assert.equal(marker.raw.includes(f.sessionId), false)
      }
      controller.abort()
    })
  }
}

test('repeated forbidden REST and opening SSE reads do not retain empty presence rooms', { timeout: 30_000 }, async t => {
  const f = await adminRouteFixture()
  t.after(() => f.close())
  let collaboration: CanvasCollaborationService | undefined
  const subscribe = CanvasCollaborationService.prototype.subscribe
  t.mock.method(CanvasCollaborationService.prototype, 'subscribe', function(this: CanvasCollaborationService, projectId: ProjectId, listener: () => void) {
    collaboration = this
    return subscribe.call(this, projectId, listener)
  })
  // Distinct nonexistent project IDs exercise the same authorization denial as
  // inaccessible projects without seeding a room for each rejected request.
  for (let i = 0; i < 12; i++) {
    const path = `/projects/forbidden-presence-${i}/canvas/collaboration`
    assert.equal((await f.request(path, { token: f.accounts.member.token })).status, 404)
    assert.ok(collaboration)
    assert.equal(collaboration['rooms'].size, 0, 'denied REST snapshots clean up their room')
    const response = await fetch(`${f.origin}/api${path}/events`, { headers: { Authorization: `Bearer ${f.accounts.member.token}`, Accept: 'text/event-stream' } })
    assert.equal(response.status, 404)
    await response.json()
    assert.equal(collaboration['rooms'].size, 0, 'both opening SSE and snapshot subscriptions release the denied room')
  }
})
