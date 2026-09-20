import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ProjectId, TeamId, Timestamp } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'
const at = '2026-03-22T00:00:00.000Z' as Timestamp
function browser(base: string) {
  let cookie = '', csrf = ''
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json', Origin: base, Host: new URL(base).host, 'Content-Type': 'application/json' }
    if (cookie) headers.Cookie = cookie
    if (csrf) headers['X-CSRF-Token'] = csrf
    const response = await fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
    const setCookie = response.headers.getSetCookie().find(value => value.startsWith('wemux_login_session='))
    if (setCookie) cookie = setCookie.split(';')[0]!
    const data = response.status === 204 ? null : await response.json() as any
    if (typeof data?.csrfToken === 'string') csrf = data.csrfToken
    return { status: response.status, data }
  }
  return { call }
}

test('Project list and detail expose only resources authorized for the signed-in user', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const owner = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const viewer = await seedLocalAccount(app.store, { username: 'viewer', email: 'viewer@example.com', password })
  const outsider = await seedLocalAccount(app.store, { username: 'outsider', email: 'outsider@example.com', password })
  const teamId = randomUUID() as TeamId, otherTeamId = randomUUID() as TeamId
  const privateId = randomUUID() as ProjectId, selectedId = randomUUID() as ProjectId, teamIdProject = randomUUID() as ProjectId, foreignId = randomUUID() as ProjectId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Alpha', createdAt: at }); await tx.identity.saveTeam({ id: otherTeamId, name: 'Beta', createdAt: at })
    await tx.identity.saveMembership({ teamId, userId: owner.id, role: 'owner', joinedAt: at }); await tx.identity.saveMembership({ teamId, userId: viewer.id, role: 'member', joinedAt: at })
    for (const project of [
      { id: privateId, teamId, ownerId: owner.id, name: 'Private', shareScope: 'owner-only' as const, deletedAt: null },
      { id: selectedId, teamId, ownerId: owner.id, name: 'Selected', shareScope: 'selected-members' as const, deletedAt: null },
      { id: teamIdProject, teamId, ownerId: owner.id, name: 'Team shared', shareScope: 'team' as const, deletedAt: null },
      { id: foreignId, teamId: otherTeamId, ownerId: outsider.id, name: 'Foreign', shareScope: 'team' as const, deletedAt: null },
    ]) await tx.resources.saveProject(project)
    await tx.identity.saveProjectGrant({ projectId: selectedId, userId: viewer.id, role: 'viewer' })
  })
  const base = await app.listen(0); t.after(() => app.close())
  const client = browser(base); const viewerLogin = await client.call('/auth/login', { method: 'POST', body: { login: 'viewer', password } }); assert.equal(viewerLogin.status, 200, JSON.stringify(viewerLogin.data))
  const list = await client.call(`/projects?teamId=${teamId}`)
  assert.equal(list.status, 200, JSON.stringify(list.data)); assert.deepEqual(list.data.items.map((value: any) => value.name).sort(), ['Selected', 'Team shared'])
  assert.equal((await client.call(`/projects/${privateId}?teamId=${teamId}`)).status, 404)
  assert.equal((await client.call(`/projects/${selectedId}?teamId=${teamId}`)).status, 200)
  assert.equal((await client.call(`/projects/${foreignId}?teamId=${otherTeamId}`)).status, 404)
})

test('owner manages Project sharing and grants; viewer cannot self-elevate and cross-Team grants are rejected', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const owner = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const member = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
  const foreign = await seedLocalAccount(app.store, { username: 'foreign', email: 'foreign@example.com', password })
  const teamId = randomUUID() as TeamId, otherTeamId = randomUUID() as TeamId, projectId = randomUUID() as ProjectId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Alpha', createdAt: at }); await tx.identity.saveTeam({ id: otherTeamId, name: 'Beta', createdAt: at })
    await tx.identity.saveMembership({ teamId, userId: owner.id, role: 'owner', joinedAt: at }); await tx.identity.saveMembership({ teamId, userId: member.id, role: 'member', joinedAt: at }); await tx.identity.saveMembership({ teamId: otherTeamId, userId: foreign.id, role: 'member', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner.id, name: 'Shared', shareScope: 'owner-only', deletedAt: null })
  })
  const base = await app.listen(0); t.after(() => app.close())
  const ownerClient = browser(base); const ownerLogin = await ownerClient.call('/auth/login', { method: 'POST', body: { login: 'owner', password } }); assert.equal(ownerLogin.status, 200, JSON.stringify(ownerLogin.data))
  const updatedAccess = await ownerClient.call(`/projects/${projectId}/access`, { method: 'PATCH', body: { shareScope: 'selected-members' } }); assert.equal(updatedAccess.status, 200, JSON.stringify(updatedAccess.data))
  assert.equal((await ownerClient.call(`/projects/${projectId}/grants`, { method: 'POST', body: { userId: member.id, role: 'viewer' } })).status, 201)
  const memberClient = browser(base); await memberClient.call('/auth/login', { method: 'POST', body: { login: 'member', password } })
  const elevate = await memberClient.call(`/projects/${projectId}/grants`, { method: 'POST', body: { userId: member.id, role: 'manager' } })
  assert.equal(elevate.status, 403)
  const foreignGrant = await ownerClient.call(`/projects/${projectId}/grants`, { method: 'POST', body: { userId: foreign.id, role: 'viewer' } })
  assert.equal(foreignGrant.status, 409); assert.equal(foreignGrant.data.error.code, 'project_grant_cross_team')
})
