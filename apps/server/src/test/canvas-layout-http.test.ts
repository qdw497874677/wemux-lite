import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ProjectId, TeamId, Timestamp } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { seedLocalAccount } from './fixtures/administrator.js'

const at = '2026-02-26T00:00:00.000Z' as Timestamp
const password = 'Ticket22-layout-password'

function browser(base: string) {
  let cookie = '', csrf = ''
  const headers = () => ({ Accept: 'application/json', Origin: base, Host: new URL(base).host, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) })
  return {
    call: async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const response = await fetch(`${base}/api${path}`, { method: init.method, headers: headers(), body: init.body === undefined ? undefined : JSON.stringify(init.body) })
      const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0]!
      const data = response.status === 204 ? null : await response.json()
      if (data?.csrfToken) csrf = data.csrfToken
      return { status: response.status, data }
    },
  }
}

const layout = (revision: string, scope: 'personal' | 'project') => ({
  scope,
  graphRevision: revision,
  nodePositions: { session: { x: 24, y: 48 } },
  collapsedGroups: ['workspace:one'],
  viewport: { x: 1, y: 2, zoom: 0.9 },
})

test('personal layouts persist per user, project defaults require manager, and stale revisions fail closed', async t => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'wemux-canvas-layout-')), 'server.sqlite')
  let app = createWemuxServer({ databasePath, administratorEmails: ['admin@example.com'], capabilitySecret: 'canvas-layout-http-test-secret-32-bytes' })
  const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const viewerUser = await seedLocalAccount(app.store, { username: 'viewer', email: 'viewer@example.com', password })
  const teamId = randomUUID() as TeamId, projectId = randomUUID() as ProjectId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Layout Team', createdAt: at })
    await tx.identity.saveMembership({ teamId, userId: ownerUser.id, role: 'owner', joinedAt: at })
    await tx.identity.saveMembership({ teamId, userId: viewerUser.id, role: 'member', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: ownerUser.id, name: 'Layout Project', shareScope: 'selected-members', deletedAt: null })
    await tx.identity.saveProjectGrant({ projectId, userId: viewerUser.id, role: 'viewer' })
  })
  let base = await app.listen(0)
  const owner = browser(base), viewer = browser(base)
  assert.equal((await owner.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })).status, 200)
  assert.equal((await viewer.call('/auth/login', { method: 'POST', body: { login: 'viewer', password } })).status, 200)
  const ownerRead = await owner.call(`/projects/${projectId}/canvas-layout?scope=personal`)
  const viewerRead = await viewer.call(`/projects/${projectId}/canvas-layout?scope=personal`)
  assert.equal(ownerRead.status, 200); assert.equal(viewerRead.status, 200); assert.equal(ownerRead.data.layout, null)
  const revision = ownerRead.data.graphRevision as string
  assert.equal((await owner.call(`/projects/${projectId}/canvas-layout`, { method: 'PUT', body: { scope: 'personal', graphRevision: revision, layout: layout(revision, 'personal') } })).status, 200)
  assert.equal((await viewer.call(`/projects/${projectId}/canvas-layout?scope=personal`)).data.layout, null)
  assert.equal((await viewer.call(`/projects/${projectId}/canvas-layout`, { method: 'PUT', body: { scope: 'project', graphRevision: revision, layout: layout(revision, 'project') } })).status, 403)
  assert.equal((await owner.call(`/projects/${projectId}/canvas-layout`, { method: 'PUT', body: { scope: 'project', graphRevision: revision, layout: layout(revision, 'project') } })).status, 200)
  const duplicateProjectSave = await owner.call(`/projects/${projectId}/canvas-layout`, { method: 'PUT', body: { scope: 'project', graphRevision: revision, layout: layout(revision, 'project') } })
  assert.equal(duplicateProjectSave.status, 200); assert.equal(duplicateProjectSave.data.written, false)
  const stale = await owner.call(`/projects/${projectId}/canvas-layout`, { method: 'PUT', body: { scope: 'personal', graphRevision: 'g-stale', layout: layout('g-stale', 'personal') } })
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'stale_revision')

  await app.close()
  app = createWemuxServer({ databasePath, administratorEmails: ['admin@example.com'], capabilitySecret: 'canvas-layout-http-test-secret-32-bytes' })
  t.after(() => app.close())
  base = await app.listen(0)
  const restoredOwner = browser(base), restoredViewer = browser(base)
  await restoredOwner.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })
  await restoredViewer.call('/auth/login', { method: 'POST', body: { login: 'viewer', password } })
  assert.deepEqual((await restoredOwner.call(`/projects/${projectId}/canvas-layout?scope=personal`)).data.layout, layout(revision, 'personal'))
  assert.deepEqual((await restoredViewer.call(`/projects/${projectId}/canvas-layout?scope=project`)).data.layout, layout(revision, 'project'))
})
