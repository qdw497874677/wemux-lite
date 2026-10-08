import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectId, Timestamp, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, administratorToken, instanceOperatorId, seedAdministrator } from './fixtures/administrator.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import { migrationCount } from '../storage/sqlite/migrations.ts'
import { createClusterClient } from '@wemux/web-client'

const second = 'visibility-peer' as UserId
const stranger = 'visibility-stranger' as UserId

async function fixture(databasePath: string) {
  const app = createWemuxServer({ databasePath, administratorEmails: [administratorEmail] })
  const origin = await app.listen(0)
  const call = async (path: string, body?: unknown, token = administratorToken, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  await seedAdministrator(app.store)
  await seedAdministrator(app.store, { userId: second, token: 'visibility-peer-pat', email: 'visibility-peer@example.test', username: 'visibility-peer' })
  await seedAdministrator(app.store, { userId: stranger, token: 'visibility-stranger-pat', email: 'visibility-stranger@example.test', username: 'visibility-stranger' })
  await call('/bootstrap', {})
  const projectId = 'default-project' as ProjectId
  const workspaceId = (await call('/workspaces', { projectId, name: 'Personal view', source: 'empty', requestId: 'visibility-fixture' })).data.workspace.id as WorkspaceId
  const project = (await app.store.resources.getProject(projectId))!
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ userId: second, teamId: project.teamId, role: 'member', joinedAt: new Date().toISOString() as Timestamp })
    await tx.identity.saveMembership({ userId: stranger, teamId: project.teamId, role: 'member', joinedAt: new Date().toISOString() as Timestamp })
    await tx.identity.saveProjectGrant({ projectId, userId: second, role: 'viewer' })
  })
  const list = (token = administratorToken, visibility = 'visible') => call(`/workspaces?projectId=${projectId}&visibility=${visibility}`, undefined, token)
  const toggle = (token: string, hidden: boolean, expectedRevision: number, requestId: string) => call(`/workspaces/${workspaceId}/visibility`, { hidden, expectedRevision, requestId }, token, 'PUT')
  return { app, call, list, toggle, workspaceId, projectId }
}

test('personal Workspace visibility is server-filtered, CAS-protected, revocable and independent of shared state', async () => {
  const f = await fixture(':memory:')
  try {
    const before = await f.app.store.resources.getWorkspace(f.workspaceId)
    assert.equal((await f.list()).data.items.find((item: { id: string }) => item.id === f.workspaceId).visibilityRevision, 0)
    assert.equal((await f.list('visibility-peer-pat')).data.items.length, 1)
    assert.equal((await f.list('visibility-stranger-pat')).data.items.length, 0)
    assert.equal((await f.call('/workspaces?visibility=unknown')).status, 400)
    assert.equal((await f.toggle('visibility-stranger-pat', true, 0, 'stranger')).status, 404)
    assert.equal((await f.toggle('visibility-peer-pat', false, 0, 'already-visible')).status, 200)
    assert.equal((await f.app.store.resources.getWorkspaceVisibility(second, f.workspaceId)), null, 'no-op does not create a visibility row')
    assert.equal((await f.toggle('visibility-peer-pat', true, 0, 'hide')).status, 200)
    assert.equal((await f.list('visibility-peer-pat')).data.items.length, 0)
    assert.equal((await f.call(`/workspaces/${f.workspaceId}`, undefined, 'visibility-peer-pat')).status, 200, 'personal hiding does not revoke resource access')
    assert.equal((await f.list('visibility-peer-pat', 'hidden')).data.items[0].visibilityRevision, 1)
    const all = await f.list('visibility-peer-pat', 'all')
    assert.equal(all.data.items.length, 1)
    assert.equal(all.data.items[0].visibilityHidden, true, 'both groups are classified from one server snapshot')
    assert.equal((await f.list()).data.items.length, 1, 'other authorized accounts still see Workspace')
    assert.deepEqual(await f.app.store.resources.getWorkspace(f.workspaceId), before, 'shared Workspace and placements are untouched')
    assert.deepEqual((await f.toggle('visibility-peer-pat', true, 0, 'hide')).data, { workspaceId: f.workspaceId, hidden: true, revision: 1 })
    assert.equal((await f.toggle('visibility-peer-pat', false, 0, 'stale')).data.error.code, 'workspace_visibility_conflict')
    assert.equal((await f.toggle('visibility-peer-pat', false, 1, 'hide')).data.error.code, 'request_id_conflict')
    // A late report changes the real state, not personal visibility or its CAS generation.
    await f.app.store.transaction(async tx => {
      const workspace = (await tx.resources.getWorkspace(f.workspaceId))!
      await tx.resources.saveWorkspace({ ...workspace, placements: [{ workerId: 'late-worker' as WorkerId, status: 'failed', failureReason: 'late report', location: null }] })
    })
    const hidden = (await f.list('visibility-peer-pat', 'hidden')).data.items[0]
    assert.equal(hidden.placements[0].status, 'unhealthy', 'live Worker health is projected even for hidden views')
    assert.equal((await f.app.store.resources.getWorkspace(f.workspaceId))?.placements[0].status, 'failed')
    assert.equal(hidden.visibilityRevision, 1)
    assert.equal((await f.toggle('visibility-peer-pat', false, 1, 'restore')).status, 200)
    assert.equal((await f.list('visibility-peer-pat', 'hidden')).data.items.length, 0)
    assert.equal((await f.list('visibility-peer-pat')).data.items[0].visibilityRevision, 2)
    assert.equal((await f.list('visibility-peer-pat', 'all')).data.items[0].visibilityHidden, false)
    assert.equal((await f.toggle('visibility-peer-pat', true, 1, 'aba')).status, 409)
    assert.equal((await f.toggle('visibility-peer-pat', true, 2, 'hide-again')).status, 200)
    await f.app.store.transaction(async tx => tx.identity.removeProjectGrant(f.projectId, second))
    assert.equal((await f.list('visibility-peer-pat', 'hidden')).data.items.length, 0)
    assert.equal((await f.call(`/workspaces/${f.workspaceId}`, undefined, 'visibility-peer-pat')).status, 404, 'revoked grant is not overridden by a hidden row')
    assert.equal((await f.toggle('visibility-peer-pat', false, 3, 'revoked')).status, 404)
    assert.equal((await f.toggle('visibility-peer-pat', true, 2, 'hide-again')).status, 404, 'replay checks present authorization')
    assert.equal((await f.list()).data.items[0].id, f.workspaceId)
    assert.equal((await f.toggle(administratorToken, true, 0, 'owner-hide')).status, 200)
    assert.equal((await f.list()).data.items.length, 0)
  } finally { await f.app.close() }
})

test('shared browser client hides and restores Workspace through real HTTP', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] }), origin = await app.listen(0)
  await seedAdministrator(app.store)
  const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${administratorToken}` } })
  const client = createClusterClient({ teamId: 'default-team', username: 'fixture', csrfToken: '', email: null, instanceAdministrator: true }, () => {}, { origin, fetcher })
  try {
    const response = await fetcher(`${origin}/api/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 200)
    const created = await client.createWorkspace('default-project', { name: 'Shared client', source: 'empty', requestId: 'shared-client' })
    const workspaceId = created.workspace.id
    const visible = await client.workspaces('default-project')
    assert.equal(visible.find(workspace => workspace.id === workspaceId)?.visibilityRevision, 0)
    assert.deepEqual(await client.setWorkspaceVisibility(workspaceId, { hidden: true, expectedRevision: 0, requestId: 'client-hide' }), { workspaceId, hidden: true, revision: 1 })
    assert.equal((await client.workspaces('default-project')).some(workspace => workspace.id === workspaceId), false)
    assert.equal((await client.workspaces('default-project', 'hidden')).find(workspace => workspace.id === workspaceId)?.visibilityRevision, 1)
    assert.equal((await client.workspaces('default-project', 'all')).find(workspace => workspace.id === workspaceId)?.visibilityHidden, true)
    assert.deepEqual(await client.setWorkspaceVisibility(workspaceId, { hidden: false, expectedRevision: 1, requestId: 'client-restore' }), { workspaceId, hidden: false, revision: 2 })
    assert.equal((await client.workspaces('default-project')).find(workspace => workspace.id === workspaceId)?.visibilityRevision, 2)
  } finally { client.dispose(); await app.close() }
})

test('visibility migration upgrades existing Workspace records without rewriting shared history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-visibility-upgrade-')), path = join(root, 'server.sqlite')
  const f = await fixture(path)
  try {
    await f.app.close()
    const db = new DatabaseSync(path)
    const before = db.prepare("SELECT data FROM records WHERE kind='workspace' AND id=?").get(f.workspaceId)?.data
    assert.ok(before)
    db.exec('DROP TABLE workspace_account_visibility')
    db.prepare('DELETE FROM schema_migrations WHERE version=?').run(migrationCount)
    db.close()
    const upgraded = new SqliteServerStore(path)
    try {
      assert.equal((await upgraded.resources.getWorkspace(f.workspaceId))?.id, f.workspaceId)
      assert.equal(await upgraded.resources.getWorkspaceVisibility(second, f.workspaceId), null)
    } finally { upgraded.close() }
    const after = new DatabaseSync(path)
    try {
      assert.equal(after.prepare("SELECT data FROM records WHERE kind='workspace' AND id=?").get(f.workspaceId)?.data, before)
      assert.ok(after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_account_visibility'").get())
    } finally { after.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('visibility row and idempotency receipt roll back together when the transaction fails', async () => {
  const f = await fixture(':memory:')
  try {
    const key = JSON.stringify([second, 'workspace-visibility', f.workspaceId, 'failed-transaction'])
    await assert.rejects(f.app.store.transaction(async tx => {
      await tx.resources.saveWorkspaceVisibility(second, { workspaceId: f.workspaceId, hidden: true, revision: 1 })
      await tx.resources.saveCreateRequest(key, { fingerprint: 'test', result: { hidden: true, revision: 1 } })
      throw new Error('injected transaction failure')
    }), /injected transaction failure/)
    assert.equal(await f.app.store.resources.getWorkspaceVisibility(second, f.workspaceId), null)
    assert.equal(await f.app.store.resources.getCreateRequest(key), null)
    assert.equal((await f.toggle('visibility-peer-pat', true, 0, 'retry-after-rollback')).status, 200)
  } finally { await f.app.close() }
})

test('personal visibility survives SQLite restart and hides no underlying placement or files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-visibility-')), path = join(root, 'server.sqlite')
  const f = await fixture(path)
  try {
    assert.equal((await f.toggle('visibility-peer-pat', true, 0, 'persistent-hide')).status, 200)
    await f.app.close()
    const store = new SqliteServerStore(path)
    try {
      assert.deepEqual(await store.resources.getWorkspaceVisibility(second, f.workspaceId), { workspaceId: f.workspaceId, hidden: true, revision: 1 })
      assert.equal((await store.resources.getWorkspace(f.workspaceId))?.deletedAt, null)
      assert.equal((await store.resources.getWorkspaceVisibility(instanceOperatorId, f.workspaceId)), null)
    } finally { store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
