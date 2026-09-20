import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ProjectId, TeamId, Timestamp, WorkspaceId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple', at = '2026-03-22T00:00:00.000Z' as Timestamp
function browser(base: string) {
  let cookie = '', csrf = ''
  return { call: async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json', Origin: base, 'Content-Type': 'application/json' }
    if (cookie) headers.Cookie = cookie; if (csrf) headers['X-CSRF-Token'] = csrf
    const response = await fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
    const value = response.headers.getSetCookie().find(item => item.startsWith('wemux_login_session=')); if (value) cookie = value.split(';')[0]!
    const data = response.status === 204 ? null : await response.json() as any; if (data?.csrfToken) csrf = data.csrfToken
    return { status: response.status, data }
  } }
}

test('Project role gates child resource discovery and Task writes', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const owner = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const teamViewer = await seedLocalAccount(app.store, { username: 'team-viewer', email: 'team-viewer@example.com', password })
  const viewer = await seedLocalAccount(app.store, { username: 'viewer', email: 'viewer@example.com', password })
  const contributor = await seedLocalAccount(app.store, { username: 'contributor', email: 'contributor@example.com', password })
  const teamId = randomUUID() as TeamId, projectId = randomUUID() as ProjectId, workspaceId = randomUUID() as WorkspaceId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Alpha', createdAt: at })
    for (const user of [owner, teamViewer, viewer, contributor]) await tx.identity.saveMembership({ teamId, userId: user.id, role: user.id === owner.id ? 'owner' : 'member', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner.id, name: 'Shared', shareScope: 'selected-members', deletedAt: null })
    await tx.identity.saveProjectGrant({ projectId, userId: viewer.id, role: 'viewer' }); await tx.identity.saveProjectGrant({ projectId, userId: contributor.id, role: 'contributor' })
    await tx.resources.saveWorkspace({ id: workspaceId, projectId, name: 'Visible workspace', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [], deletedAt: null })
  })
  const base = await app.listen(0); t.after(() => app.close())
  const teamViewerClient = browser(base); await teamViewerClient.call('/auth/login', { method: 'POST', body: { login: 'team-viewer', password } })
  await app.store.transaction(tx => tx.resources.saveProject({ id: projectId, teamId, ownerId: owner.id, name: 'Shared', shareScope: 'team', deletedAt: null }))
  assert.equal((await teamViewerClient.call(`/projects/${projectId}/tasks?teamId=${teamId}`)).status, 200)
  assert.equal((await teamViewerClient.call(`/projects/${projectId}/tasks?teamId=${teamId}`, { method: 'POST', body: { title: 'Team denied' } })).status, 403)
  await app.store.transaction(tx => tx.resources.saveProject({ id: projectId, teamId, ownerId: owner.id, name: 'Shared', shareScope: 'selected-members', deletedAt: null }))
  const viewerClient = browser(base); await viewerClient.call('/auth/login', { method: 'POST', body: { login: 'viewer', password } })
  const workspaces = await viewerClient.call(`/workspaces?projectId=${projectId}&teamId=${teamId}`)
  assert.equal(workspaces.status, 200, JSON.stringify(workspaces.data)); assert.deepEqual(workspaces.data.items.map((item: any) => item.id), [workspaceId])
  const viewerRead = await viewerClient.call(`/projects/${projectId}/tasks?teamId=${teamId}`)
  assert.equal(viewerRead.status, 200, JSON.stringify(viewerRead.data))
  const viewerWrite = await viewerClient.call(`/projects/${projectId}/tasks?teamId=${teamId}`, { method: 'POST', body: { title: 'Denied' } })
  assert.equal(viewerWrite.status, 403)
  const contributorClient = browser(base); await contributorClient.call('/auth/login', { method: 'POST', body: { login: 'contributor', password } })
  const created = await contributorClient.call(`/projects/${projectId}/tasks?teamId=${teamId}`, { method: 'POST', body: { title: 'Allowed' } })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  assert.equal((await contributorClient.call(`/projects/${projectId}/tasks?teamId=${teamId}`)).status, 200)
})
