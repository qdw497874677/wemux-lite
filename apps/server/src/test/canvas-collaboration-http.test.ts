import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ProjectId, TeamId, Timestamp, UserId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'
const at = '2026-03-25T00:00:00.000Z' as Timestamp
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
  assert.equal((await owner.call(`/projects/${projectId}/canvas/collaboration/presence`, { method: 'PUT', body: { displayName: 'Owner', activeSessionId: 'session-1', typing: true } })).status, 200)
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
  assert.equal((await outsider.call(`/projects/${projectId}/session-graph`)).status, 403)

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
