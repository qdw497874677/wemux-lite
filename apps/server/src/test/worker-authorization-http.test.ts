import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import type { ProjectId, TeamId, Timestamp, WorkerId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'
const at = '2026-03-22T00:00:00.000Z' as Timestamp
function browser(base: string) {
  let cookie = '', csrf = ''
  return { call: async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json', Origin: base, Host: new URL(base).host, 'Content-Type': 'application/json' }
    if (cookie) headers.Cookie = cookie
    if (csrf) headers['X-CSRF-Token'] = csrf
    const response = await fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
    const setCookie = response.headers.getSetCookie().find(value => value.startsWith('wemux_login_session='))
    if (setCookie) cookie = setCookie.split(';')[0]!
    const data = response.status === 204 ? null : await response.json() as any
    if (typeof data?.csrfToken === 'string') csrf = data.csrfToken
    return { status: response.status, data }
  } }
}

async function fixture(t: TestContext) {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const owner = await seedLocalAccount(app.store, { username: 'owner', email: administratorEmail, password })
  const member = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
  const foreign = await seedLocalAccount(app.store, { username: 'foreign', email: 'foreign@example.com', password })
  const teamId = randomUUID() as TeamId, foreignTeamId = randomUUID() as TeamId, workerId = randomUUID() as WorkerId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Alpha', createdAt: at })
    await tx.identity.saveTeam({ id: foreignTeamId, name: 'Beta', createdAt: at })
    await tx.identity.saveMembership({ teamId, userId: owner.id, role: 'owner', joinedAt: at })
    await tx.identity.saveMembership({ teamId, userId: member.id, role: 'member', joinedAt: at })
    await tx.identity.saveMembership({ teamId: foreignTeamId, userId: foreign.id, role: 'owner', joinedAt: at })
    await tx.resources.saveWorker({ id: workerId, teamId, ownerId: owner.id, name: 'Private Worker', shareScope: 'owner-only', connectionState: 'online', version: '1.0.0', platform: 'linux', capabilities: [], lastSeenAt: at })
  })
  const base = await app.listen(0)
  t.after(() => app.close())
  return { base, owner, member, foreign, workerId }
}

test('Worker owner separates use and manage grants without crossing Team boundaries', async t => {
  const { base, member, foreign, workerId } = await fixture(t)
  const ownerClient = browser(base), memberClient = browser(base), foreignClient = browser(base)
  assert.equal((await ownerClient.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })).status, 200)
  assert.equal((await memberClient.call('/auth/login', { method: 'POST', body: { login: 'member', password } })).status, 200)
  assert.equal((await foreignClient.call('/auth/login', { method: 'POST', body: { login: 'foreign', password } })).status, 200)

  assert.deepEqual((await memberClient.call('/workers')).data, { items: [] })
  assert.equal((await ownerClient.call(`/workers/${workerId}/grants`, { method: 'POST', body: { userId: member.id, role: 'use' } })).status, 201)
  assert.deepEqual((await memberClient.call('/workers')).data.items.map((item: any) => item.id), [workerId])
  assert.equal((await memberClient.call(`/workers/${workerId}`)).status, 200)
  assert.equal((await memberClient.call(`/workers/${workerId}/grants`, { method: 'POST', body: { userId: member.id, role: 'manage' } })).status, 403)

  const crossTeam = await ownerClient.call(`/workers/${workerId}/grants`, { method: 'POST', body: { userId: foreign.id, role: 'use' } })
  assert.equal(crossTeam.status, 409)
  assert.equal(crossTeam.data.error.code, 'worker_grant_cross_team')
  assert.deepEqual((await foreignClient.call('/workers')).data, { items: [] })
  assert.equal((await foreignClient.call(`/workers/${workerId}`)).status, 404)
})

test('Project contributor also needs Worker use before creating a Workspace placement', async t => {
  const { base, member, workerId } = await fixture(t)
  const projectId = randomUUID() as ProjectId
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  t.after(() => app.close())
  const projectOwner = await seedLocalAccount(app.store, { username: 'project-owner', email: administratorEmail, password })
  const contributor = await seedLocalAccount(app.store, { username: 'project-contributor', email: 'project-contributor@example.com', password })
  const teamId = randomUUID() as TeamId, isolatedWorkerId = randomUUID() as WorkerId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Execution Team', createdAt: at })
    await tx.identity.saveMembership({ teamId, userId: projectOwner.id, role: 'owner', joinedAt: at })
    await tx.identity.saveMembership({ teamId, userId: contributor.id, role: 'member', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: projectOwner.id, name: 'Execution Project', shareScope: 'selected-members', deletedAt: null })
    await tx.identity.saveProjectGrant({ projectId, userId: contributor.id, role: 'contributor' })
    await tx.resources.saveWorker({ id: isolatedWorkerId, teamId, ownerId: projectOwner.id, name: 'Execution Worker', shareScope: 'owner-only', connectionState: 'online', version: '1.0.0', platform: 'linux', capabilities: [], lastSeenAt: at })
  })
  const executionBase = await app.listen(0), client = browser(executionBase), ownerClient = browser(executionBase)
  await client.call('/auth/login', { method: 'POST', body: { login: 'project-contributor', password } })
  await ownerClient.call('/auth/login', { method: 'POST', body: { login: 'project-owner', password } })
  const input = { projectId, workerId: isolatedWorkerId, name: 'Authorized placement', source: 'empty' }
  assert.equal((await client.call('/workspaces', { method: 'POST', body: input })).status, 404)
  assert.equal((await ownerClient.call(`/workers/${isolatedWorkerId}/grants`, { method: 'POST', body: { userId: contributor.id, role: 'use' } })).status, 201)
  const created = await client.call('/workspaces', { method: 'POST', body: input })
  assert.equal(created.status, 201)
  const workspaceId = created.data.workspace.id as string
  await app.store.transaction(async tx => {
    const worker = (await tx.resources.getWorker(isolatedWorkerId))!
    await tx.resources.saveWorker({ ...worker, capabilities: [{ agentKey: 'test', displayName: 'Test', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model', displayName: 'Model', source: 'configured' }] }] as never })
    const workspace = (await tx.resources.getWorkspace(workspaceId as never))!
    const placements = workspace.placements.map(placement => ({ ...placement, status: 'ready' as const, failureReason: null }))
    await tx.resources.saveWorkspace({ ...workspace, placements, status: 'ready', failureReason: null })
  })
  assert.equal((await app.store.resources.getWorkspace(workspaceId as never))?.placements[0]?.status, 'ready')
  const task = await client.call(`/projects/${projectId}/tasks`, { method: 'POST', body: { title: 'Permission intersection' } })
  assert.equal(task.status, 201)
  const assignment = { workspaceId, workerId: isolatedWorkerId, agentKey: 'test', modelId: 'model' }
  assert.equal((await client.call(`/projects/${projectId}/tasks/${task.data.id}/assignment`, { method: 'PUT', body: { version: 1, assignee: assignment } })).status, 200)

  assert.equal((await ownerClient.call(`/workers/${isolatedWorkerId}/grants/${contributor.id}`, { method: 'DELETE' })).status, 204)
  const deniedSession = await client.call('/sessions', { method: 'POST', body: { requestId: 'revoked-session', workspaceId, workerId: isolatedWorkerId, title: 'Denied', agentKey: 'test', modelId: 'model' } })
  assert.equal(deniedSession.status, 404, JSON.stringify(deniedSession.data))
  const deniedRun = await client.call(`/projects/${projectId}/tasks/${task.data.id}/launch`, { method: 'POST', body: { requestId: 'revoked-run', mode: 'new', reuseSessionId: null, prompt: 'Run', assignment } })
  assert.equal(deniedRun.status, 404, JSON.stringify(deniedRun.data))

  assert.equal((await ownerClient.call(`/workers/${isolatedWorkerId}/grants`, { method: 'POST', body: { userId: contributor.id, role: 'use' } })).status, 201)
  const authorizedSession = await client.call('/sessions', { method: 'POST', body: { requestId: 'authorized-session', workspaceId, workerId: isolatedWorkerId, title: 'Allowed', agentKey: 'test', modelId: 'model' } })
  assert.equal(authorizedSession.status, 201, JSON.stringify(authorizedSession.data))
  const authorizedRun = await client.call(`/projects/${projectId}/tasks/${task.data.id}/launch`, { method: 'POST', body: { requestId: 'authorized-run', mode: 'new', reuseSessionId: null, prompt: 'Run', assignment } })
  assert.equal(authorizedRun.status, 200, JSON.stringify(authorizedRun.data))
  void base; void member; void workerId
})

test('team sharing grants use without management and owner-only revocation removes visibility', async t => {
  const { base, member, workerId } = await fixture(t)
  const ownerClient = browser(base), memberClient = browser(base)
  await ownerClient.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })
  await memberClient.call('/auth/login', { method: 'POST', body: { login: 'member', password } })

  assert.equal((await ownerClient.call(`/workers/${workerId}/access`, { method: 'PATCH', body: { shareScope: 'team' } })).status, 200)
  assert.deepEqual((await memberClient.call('/workers')).data.items.map((item: any) => item.id), [workerId])
  assert.equal((await memberClient.call(`/workers/${workerId}/grants`, { method: 'POST', body: { userId: member.id, role: 'manage' } })).status, 403)

  assert.equal((await ownerClient.call(`/workers/${workerId}/access`, { method: 'PATCH', body: { shareScope: 'owner-only' } })).status, 200)
  assert.deepEqual((await memberClient.call('/workers')).data, { items: [] })
})
