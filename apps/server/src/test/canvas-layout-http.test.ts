import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ProjectId, SessionId, TeamId, Timestamp } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { SqliteCanvasLayoutRepository } from '../storage/sqlite/canvas-layout-repository.ts'
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
      return { status: response.status, data, cacheControl: response.headers.get('cache-control') }
    },
  }
}

const layout = (revision: string, scope: 'personal' | 'project') => ({
  scope,
  graphRevision: revision,
  nodePositions: {},
  collapsedGroups: [],
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


test('layout reads and writes project current visibility, preserve other viewers state and clear revoked identities', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: ['admin@example.com'] })
  t.after(() => app.close())
  const ownerUser = await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const viewerUser = await seedLocalAccount(app.store, { username: 'viewer', email: 'viewer@example.com', password })
  const teamId = randomUUID() as TeamId, projectId = randomUUID() as ProjectId
  const visibleId = 'layout-visible' as SessionId, hiddenId = 'layout-hidden' as SessionId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Layout Team', createdAt: at })
    for (const user of [ownerUser, viewerUser]) await tx.identity.saveMembership({ teamId, userId: user.id, role: 'member', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: ownerUser.id, name: 'Layout Project', shareScope: 'team', deletedAt: null })
    await tx.identity.saveProjectGrant({ projectId, userId: viewerUser.id, role: 'manager' })
    for (const [id, scope, workspace] of [[visibleId, 'project', 'visible-workspace'], [hiddenId, 'selected-members', 'hidden-workspace']] as const) {
      await tx.resources.saveSession({ id, projectId, ownerId: ownerUser.id, workspaceId: workspace as never, title: id,
        shareScope: scope, binding: { workspaceId: workspace as never, agent: { workerId: 'worker' as never, agentKey: 'pi' as never }, modelId: null },
        runtimeState: 'idle', archivedAt: null, deletedAt: null })
    }
  })
  const base = await app.listen(0), owner = browser(base), viewer = browser(base)
  await owner.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })
  await viewer.call('/auth/login', { method: 'POST', body: { login: 'viewer', password } })
  const route = `/projects/${projectId}/canvas-layout`
  const graphRoute = `/projects/${projectId}/session-graph`
  const ownerGraph = await owner.call(graphRoute), viewerGraph = await viewer.call(graphRoute)
  assert.equal(ownerGraph.status, 200); assert.equal(viewerGraph.status, 200)
  assert.equal(ownerGraph.data.graph.nodes.length, 2); assert.equal(viewerGraph.data.graph.nodes.length, 1)
  assert.equal(ownerGraph.cacheControl, 'no-store'); assert.equal(viewerGraph.cacheControl, 'no-store')
  const ownerRevision = (await owner.call(`${route}?scope=personal`)).data.graphRevision
  const viewerRevision = (await viewer.call(`${route}?scope=personal`)).data.graphRevision
  assert.equal(ownerRevision, ownerGraph.data.graph.revision)
  assert.equal(viewerRevision, viewerGraph.data.graph.revision)
  const outsiderUser = await seedLocalAccount(app.store, { username: 'outsider', email: 'outsider@example.com', password })
  const outsider = browser(base)
  await outsider.call('/auth/login', { method: 'POST', body: { login: outsiderUser.username, password } })
  const forbidden = await outsider.call(graphRoute)
  assert.equal(forbidden.status, 404)
  for (const id of [visibleId, hiddenId, projectId]) assert.equal(JSON.stringify(forbidden.data).includes(id), false)
  assert.equal((await browser(base).call(graphRoute)).status, 401)
  const shared = { ...layout(ownerRevision, 'project'), nodePositions: { [visibleId]: { x: 10, y: 20 }, [hiddenId]: { x: 30, y: 40 } }, collapsedGroups: ['workspace:visible-workspace', 'workspace:hidden-workspace'] }
  assert.equal((await owner.call(route, { method: 'PUT', body: { scope: 'project', graphRevision: ownerRevision, layout: shared } })).status, 200)
  const projected = await viewer.call(`${route}?scope=project`)
  assert.equal(projected.status, 200)
  assert.deepEqual(projected.data.layout.nodePositions, { [visibleId]: { x: 10, y: 20 } })
  assert.deepEqual(projected.data.layout.collapsedGroups, ['workspace:visible-workspace'])
  assert.equal(projected.data.layout.graphRevision, viewerRevision)
  assert.equal(JSON.stringify(projected.data).includes(hiddenId), false)
  assert.equal(JSON.stringify(projected.data).includes('hidden-workspace'), false)
  // 可见投影更新不可破坏其他成员不可见的既有布局；输入中的隐藏/未知身份被裁剪。
  const candidate = { ...layout(viewerRevision, 'project'), nodePositions: { [visibleId]: { x: 99, y: 88, extra: hiddenId }, [hiddenId]: { x: -1, y: -1 }, 'unknown-session': { x: 1, y: 1 } }, collapsedGroups: ['workspace:hidden-workspace', 'unknown-session'], extra: hiddenId, viewport: { x: 1, y: 2, zoom: 1, extra: hiddenId } }
  const saved = await viewer.call(route, { method: 'PUT', body: { scope: 'project', graphRevision: viewerRevision, layout: candidate } })
  assert.equal(saved.status, 200)
  assert.equal(JSON.stringify(saved.data).includes(hiddenId), false)
  const ownerRead = (await owner.call(`${route}?scope=project`)).data.layout
  assert.deepEqual(ownerRead.nodePositions, { [visibleId]: { x: 99, y: 88 }, [hiddenId]: { x: 30, y: 40 } })
  assert.deepEqual(ownerRead.collapsedGroups, ['workspace:hidden-workspace'])
  assert.equal(JSON.stringify(ownerRead).includes('unknown-session'), false)
  assert.equal('extra' in ownerRead, false)
  const personal = { ...candidate, scope: 'personal' }
  assert.equal((await viewer.call(route, { method: 'PUT', body: { scope: 'personal', graphRevision: viewerRevision, layout: personal } })).status, 200)
  const repository = new SqliteCanvasLayoutRepository(app.store)
  const rawPersonal = (await repository.get(projectId, 'personal', viewerUser.id))!.layout
  assert.equal(JSON.stringify(rawPersonal).includes(hiddenId), false)
  assert.equal(JSON.stringify(rawPersonal).includes('unknown-session'), false)
  const rawShared = (await repository.get(projectId, 'project', viewerUser.id))!.layout
  assert.deepEqual(rawShared.nodePositions[hiddenId], { x: 30, y: 40 })
  assert.equal(JSON.stringify(rawShared).includes('unknown-session'), false)
  assert.equal('extra' in rawShared, false)
  const personalRead = (await viewer.call(`${route}?scope=personal`)).data
  assert.equal(JSON.stringify(personalRead).includes(hiddenId), false)
  await app.store.transaction(tx => tx.identity.saveSessionGrant({ sessionId: hiddenId, userId: viewerUser.id }))
  const granted = (await viewer.call(graphRoute)).data.graph
  assert.equal(granted.nodes.length, 2)
  assert.equal((await viewer.call(`${route}?scope=project`)).data.layout.nodePositions[hiddenId].x, 30)
  await app.store.transaction(tx => tx.identity.removeSessionGrant(hiddenId, viewerUser.id))
  for (const path of [graphRoute, `${route}?scope=personal`, `${route}?scope=project`]) {
    const fresh = await viewer.call(path)
    assert.equal(fresh.status, 200)
    assert.equal(fresh.cacheControl, 'no-store')
    assert.equal(JSON.stringify(fresh.data).includes(hiddenId), false)
    assert.equal(fresh.data.graph?.revision ?? fresh.data.graphRevision, viewerRevision)
  }
  const stale = await viewer.call(route, { method: 'PUT', body: { scope: 'project', graphRevision: granted.revision, layout: { ...shared, graphRevision: granted.revision } } })
  assert.equal(stale.status, 409)
  assert.equal(JSON.stringify(stale.data).includes(hiddenId), false)
})
