import test from 'node:test'
import assert from 'node:assert/strict'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, administratorToken, seedAdministrator } from './fixtures/administrator.ts'
import { createClusterClient, ApiError } from '@wemux/web-client'

test('Session create authorizes private live/deleted Workspace before exposing lifecycle, same-Team or cross-Team', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] }), origin = await app.listen(0)
  const call = async (path: string, body?: unknown, method?: string, token = administratorToken) => {
    const response = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const peer = await seedAdministrator(app.store, { userId: 'same-team' as never, email: 'same@example.test', username: 'same', token: 'same-token' })
    await seedAdministrator(app.store, { userId: 'other-team' as never, email: 'other@example.test', username: 'other', token: 'other-token' })
    assert.equal((await call('/teams', { name: 'Other private Team' }, 'POST', 'other-token')).status, 201)
    await app.store.transaction(tx => tx.identity.saveMembership({ userId: peer.userId, teamId: 'default-team' as never, role: 'member', joinedAt: new Date().toISOString() as never }))
    const project = (await call('/projects', { name: 'Private project' })).data
    const live = (await call('/workspaces', { projectId: project.id, name: 'Private live' })).data.workspace
    const deleted = (await call('/workspaces', { projectId: project.id, name: 'Private deleted' })).data.workspace
    const snapshot = (await call(`/workspaces/${deleted.id}`)).data
    assert.equal((await call(`/workspaces/${deleted.id}`, { requestId: 'delete', expectedRevision: snapshot.revision }, 'DELETE')).status, 200)
    for (const token of ['same-token', 'other-token']) {
      for (const workspaceId of [live.id, deleted.id, 'nonexistent-workspace']) {
        const response = await call('/sessions', { workspaceId }, 'POST', token)
        assert.equal(response.status, 404, `${token}: inaccessible lifecycle must not leak`)
        assert.deepEqual(response.data, { error: { code: 'workspace_not_found', message: 'Workspace not found' } })
      }
    }
    assert.equal((await call('/sessions', { workspaceId: deleted.id })).data.error.code, 'workspace_deleted')
    // Other actor-facing helper consumer must authorize before lifecycle or placement hints too.
    for (const token of ['same-token', 'other-token']) for (const workspaceId of [live.id, deleted.id, 'nonexistent-workspace']) {
      assert.equal((await call(`/workspaces/${workspaceId}/reprovision`, { requestId: 'retry' }, 'POST', token)).status, 404)
      assert.equal((await call(`/workspaces/${workspaceId}`, { name: 'unauthorized rename' }, 'PATCH', token)).status, 404)
    }
  } finally { await app.close() }
})

test('real shared client gets revision-bearing Workspace create/rename receipts, including immutable replay snapshots', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] }), origin = await app.listen(0)
  await seedAdministrator(app.store)
  const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${administratorToken}` } })
  const client = createClusterClient({ teamId: 'default-team', username: 'fixture', csrfToken: '', email: null, instanceAdministrator: true }, () => {}, { origin, fetcher })
  const request = async (path: string, body: unknown) => { const response = await fetcher(`${origin}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.ok); return response.json() }
  try {
    await request('/bootstrap', {})
    const body = { name: 'Replay', source: 'empty' as const, requestId: 'create' }
    const created = await client.createWorkspace('default-project', body)
    assert.match(created.workspace.revision, /^[a-f0-9]{64}$/)
    const renamed = await client.renameWorkspace(created.workspace.id, 'Renamed')
    assert.match(renamed.revision, /^[a-f0-9]{64}$/); assert.notEqual(renamed.revision, created.workspace.revision)
    const replay = await client.createWorkspace('default-project', body)
    assert.deepEqual(replay, created, 'same identity returns original state snapshot, not fabricated current revision')
    await assert.rejects(client.deleteWorkspace(replay.workspace.id, replay.workspace.revision, 'stale-delete'), error => error instanceof ApiError && error.status === 409 && error.code === 'workspace_revision_conflict')
    assert.equal((await client.deleteWorkspace(renamed.id, renamed.revision, 'delete')).workspaceId, renamed.id)
    const direct = await client.createWorkspace('default-project', { name: 'Direct create delete', source: 'empty', requestId: 'direct' })
    assert.equal((await client.deleteWorkspace(direct.workspace.id, direct.workspace.revision, 'direct-delete')).workspaceId, direct.workspace.id)
    const enrollment = await request('/enrollment-tokens', {})
    const worker = await request('/workers/enroll', { token: enrollment.token, name: 'Offline private fixture' })
    const placedBody = { name: 'Placed', source: 'empty' as const, workerId: worker.workerId, requestId: 'placed' }
    const placed = await client.createWorkspace('default-project', placedBody)
    assert.match(placed.workspace.revision, /^[a-f0-9]{64}$/)
    assert.equal(placed.workspace.revision, (await client.workspace(placed.workspace.id)).revision)
    assert.deepEqual(await client.createWorkspace('default-project', placedBody), placed)
    const updated = await client.renameWorkspace(placed.workspace.id, 'Placed renamed')
    assert.match(updated.revision, /^[a-f0-9]{64}$/)
    assert.equal(updated.revision, (await client.workspace(placed.workspace.id)).revision)
    await assert.rejects(client.deleteWorkspace(updated.id, updated.revision, 'cannot-delete-pending'), error => error instanceof ApiError && error.status === 409 && error.code === 'workspace_in_use')
  } finally { client.dispose(); await app.close() }
})
