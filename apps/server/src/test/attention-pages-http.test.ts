import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ProjectId, Timestamp } from '@wemux/domain'
import type { AttentionPagesResult } from '@wemux/server-domain'
import { hashSecret } from '../application/auth.ts'
import { createWemuxServer } from '../server.ts'
import { SqliteAttentionSource } from '../storage/sqlite/attention-source.ts'
import { ProjectionService } from '../application/projection-service.ts'
import { administratorEmail, seedAdministrator, seedLocalAccount } from './fixtures/administrator.ts'
import { seedAttentionPages } from './fixtures/attention-pages.ts'

test('attention pages HTTP authenticates, preserves read GET permissions, and pages real SQL by actor and Project', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'attention-pages-'))
  const databasePath = join(directory, 'server.sqlite')
  const app = createWemuxServer({ databasePath, administratorEmails: [administratorEmail] })
  try {
    const admin = await seedAdministrator(app.store)
    const reader = await seedLocalAccount(app.store, { username: 'reader', email: 'reader@example.test', password: 'attention-reader-test-password' })
    const { project } = await app.service.ensureDefaultEnvironment(admin.userId)
    await app.store.transaction(async tx => {
      await tx.resources.saveProject({ ...project, id: 'visible' as ProjectId, ownerId: reader.id })
      await tx.resources.saveProject({ ...project, id: 'other' as ProjectId, ownerId: reader.id })
      await tx.resources.saveProject({ ...project, id: 'hidden' as ProjectId })
      const pat = await tx.identity.findPersonalAccessToken(hashSecret(admin.token))
      assert.ok(pat)
      await tx.identity.savePersonalAccessToken({ ...pat, scopes: ['read'] })
    })
    const db = new DatabaseSync(databasePath)
    try { seedAttentionPages(db, reader.id, admin.userId) } finally { db.close() }
    const base = await app.listen(0)
    // Any accidental call to the existing aggregation path must fail this test.
    for (const name of ['listRuns', 'listTasks', 'listDeadLetters'] as const) t.mock.method(SqliteAttentionSource.prototype, name, () => { throw new Error('legacy scan') })
    t.mock.method(ProjectionService.prototype, 'approvals', () => { throw new Error('approval scan') })
    t.mock.method(ProjectionService.prototype, 'allowedProjectIds', () => { throw new Error('legacy authorization scan') })
    const runCalls = t.mock.method(SqliteAttentionSource.prototype, 'listRunsPage')
    const deadCalls = t.mock.method(SqliteAttentionSource.prototype, 'listDeadLettersPage')
    assert.equal((await fetch(`${base}/api/attention/pages?kind=run_problem`)).status, 401)
    assert.equal((await fetch(`${base}/api/attention/pages?kind=channel_dead_letter`)).status, 401)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'reader', password: 'attention-reader-test-password' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const readerHeaders = { cookie } // Safe GET does not need CSRF, even with a browser cookie.
    const adminHeaders = { authorization: `Bearer ${admin.token}` } // Read-only PAT, not write/admin scope.
    const get = (query: string, headers = readerHeaders as Record<string, string>) => fetch(`${base}/api/attention/pages${query}`, { headers })
    for (const query of ['', '?kind=', '?kind=bogus', '?kind=run_problem&limit=', '?kind=run_problem&limit=0', '?kind=run_problem&limit=101', '?kind=run_problem&limit=1.5', '?kind=run_problem&limit=-1', '?kind=run_problem&limit=abc', '?kind=run_problem&cursor=', '?kind=run_problem&cursor=bad']) {
      assert.equal((await get(query)).status, 400, query)
    }
    for (const kind of ['task_assignment']) assert.equal((await get(`?kind=${kind}`)).status, 422)
    assert.equal((await get('?kind=channel_dead_letter&isAdministrator=true')).status, 403)
    assert.equal(runCalls.mock.callCount() + deadCalls.mock.callCount(), 0)
    const hidden = await get('?kind=run_problem&projectId=hidden')
    assert.equal(hidden.status, 200)
    assert.deepEqual((await hidden.json() as AttentionPagesResult).items, [])
    assert.equal(runCalls.mock.callCount(), 0)
    const defaultPage = await get('?kind=run_problem&projectId=visible')
    assert.equal(defaultPage.status, 200)
    assert.equal((await defaultPage.json() as AttentionPagesResult).items.length, 50)
    const firstResponse = await get('?kind=run_problem&projectId=visible&limit=100&actorId=someone-else')
    assert.equal(firstResponse.status, 200)
    const first = await firstResponse.json() as AttentionPagesResult
    assert.equal(first.items.length, 100)
    assert.ok(first.nextCursor)
    const secondResponse = await get(`?kind=run_problem&projectId=visible&limit=100&cursor=${first.nextCursor}`)
    assert.equal(secondResponse.status, 200)
    const second = await secondResponse.json() as AttentionPagesResult
    assert.equal(second.items.length, 10)
    assert.equal(second.nextCursor, null)
    assert.deepEqual([...first.items, ...second.items].map(item => item.sourceId), Array.from({ length: 110 }, (_, i) => `run-${String(i).padStart(3, '0')}`))
    assert.ok(first.items.every(item => item.href === `/next/projects/visible?task=visible&run=${item.sourceId}`))
    assert.deepEqual(Object.keys(first).sort(), ['generatedAt', 'items', 'nextCursor'])
    assert.ok(Number.isFinite(Date.parse(first.generatedAt)))
    const crossUser = await get(`?kind=run_problem&projectId=visible&cursor=${first.nextCursor}`, adminHeaders)
    assert.equal(crossUser.status, 200)
    assert.deepEqual((await crossUser.json() as AttentionPagesResult).items, [])
    // Give the administrator explicit project access; instance admin alone did not grant it.
    await app.store.transaction(async tx => {
      await tx.identity.saveMembership({ userId: reader.id, teamId: project.teamId, role: 'member', joinedAt: new Date().toISOString() as Timestamp })
      await tx.resources.saveProject({ ...project, id: 'visible' as ProjectId, ownerId: reader.id, shareScope: 'team' })
    })
    const otherCreator = await get('?kind=run_problem&projectId=visible&limit=100', adminHeaders)
    assert.equal(otherCreator.status, 200)
    const otherPage = await otherCreator.json() as AttentionPagesResult
    assert.equal(otherPage.items.length, 100)
    assert.ok(otherPage.items.every(item => item.sourceId.startsWith('other-')))
    await app.store.transaction(async tx => {
      await tx.identity.saveProjectGrant({ projectId: 'visible' as ProjectId, userId: admin.userId, role: 'manager' })
    })
    const adminDead = await get('?kind=channel_dead_letter&projectId=visible&limit=100', adminHeaders)
    assert.equal(adminDead.status, 200)
    const deadPage = await adminDead.json() as AttentionPagesResult
    assert.equal(deadPage.items.length, 100)
    assert.ok(deadPage.items.every(item => item.projectId === 'visible' && item.href === `/projects/visible/channels?delivery=${encodeURIComponent(item.sourceId)}`))
    const deadIds = deadPage.items.map(item => item.sourceId)
    let deadCursor = deadPage.nextCursor
    while (deadCursor) {
      const response = await get(`?kind=channel_dead_letter&projectId=visible&limit=100&cursor=${deadCursor}`, adminHeaders)
      assert.equal(response.status, 200)
      const page = await response.json() as AttentionPagesResult
      assert.ok(page.items.length <= 100)
      assert.notEqual(page.nextCursor, deadCursor)
      deadIds.push(...page.items.map(item => item.sourceId))
      deadCursor = page.nextCursor
    }
    assert.equal(deadIds.length, 220)
    assert.equal(new Set(deadIds).size, 220)
    assert.deepEqual(deadIds, ['other', 'run'].flatMap(prefix => Array.from({ length: 110 }, (_, i) => `${prefix}-${String(i).padStart(3, '0')}`)))
    assert.equal((await get(`?kind=channel_dead_letter&cursor=${first.nextCursor}`, adminHeaders)).status, 400)
    assert.equal((await get(`?kind=run_problem&cursor=${deadPage.nextCursor}`, adminHeaders)).status, 400)
    const beforeSource = runCalls.mock.callCount() + deadCalls.mock.callCount()
    // Fresh HTTP identity checks still precede the new set-based visibility reader.
    await app.store.transaction(async tx => {
      await tx.identity.saveUser({ ...reader, status: 'disabled' })
      const adminUser = await tx.identity.getUser(admin.userId)
      assert.ok(adminUser)
      await tx.identity.saveUser({ ...adminUser, authVersion: (adminUser.authVersion ?? 0) + 1 })
    })
    assert.equal((await get('?kind=run_problem&projectId=visible')).status, 401)
    assert.equal((await get('?kind=channel_dead_letter&projectId=visible', adminHeaders)).status, 401)
    assert.equal(runCalls.mock.callCount() + deadCalls.mock.callCount(), beforeSource)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('both Attention HTTP APIs hide private Channel Session identities before items, counts and cursors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attention-channel-authority-'))
  const databasePath = join(directory, 'server.sqlite')
  const app = createWemuxServer({ databasePath, administratorEmails: [administratorEmail] })
  try {
    const admin = await seedAdministrator(app.store)
    const owner = await seedLocalAccount(app.store, { username: 'channel-owner', email: 'channel-owner@example.test', password: 'channel-owner-test-password' })
    const { project } = await app.service.ensureDefaultEnvironment(admin.userId)
    const sessionId = 'private-channel-session' as import('@wemux/domain').SessionId
    const at = '2026-04-03T00:00:00.000Z' as Timestamp
    const session = { id: sessionId, projectId: project.id, ownerId: owner.id, shareScope: 'selected-members', deletedAt: null }
    await app.store.transaction(async tx => {
      await tx.resources.saveProject({ ...project, ownerId: owner.id, shareScope: 'team' })
      await tx.identity.saveMembership({ userId: owner.id, teamId: project.teamId, role: 'member', joinedAt: at })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId: admin.userId, role: 'viewer' })
    })
    await app.store.putRecord('session', sessionId, session)
    const ids = [1, 2].map(seq => `private-channel:private-binding:${sessionId}:${seq}:private-turn-${seq}`)
    const db = new DatabaseSync(databasePath)
    try {
      const insert = (id: string, lineage: string) => db.prepare(`INSERT INTO channel_outbound_deliveries
        (id,channel_id,binding_id,project_id,session_id,journal_identity,status,attempt,created_at,updated_at,data)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'private-channel', 'private-binding', project.id, lineage, id.split(':').slice(2).join(':'), 'dead_letter', 4, at, at,
        JSON.stringify({ id, channelId: 'private-channel', bindingId: 'private-binding', projectId: project.id, sessionId: lineage, lastError: 'private delivery error' }))
      for (const id of ids) insert(id, sessionId)
      // Unknown/legacy lineage cannot be authorized by guessing from the composite ID.
      insert(`legacy-channel:legacy-binding:${sessionId}:3:legacy-turn`, '')
      insert('missing-channel:missing-binding:missing-session:4:missing-turn', 'missing-session')
    } finally { db.close() }
    const base = await app.listen(0)
    const headers = { authorization: `Bearer ${admin.token}` }
    const get = async (route: string, cursor?: string) => {
      const response = await fetch(`${base}/api/attention${route}?kind=channel_dead_letter&projectId=${project.id}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers })
      assert.equal(response.status, 200, await response.clone().text())
      return response
    }
    const hidden = async (cursor?: string) => {
      const page = await (await get('/pages', cursor)).json() as AttentionPagesResult
      assert.deepEqual(page.items, [])
      assert.equal(page.nextCursor, null)
      const grouped = await (await get('', cursor)).json() as import('@wemux/server-domain').AttentionResult
      assert.equal(grouped.total, 0)
      assert.ok(grouped.groups.every(group => group.count === 0 && group.items.length === 0))
      for (const body of [page, grouped]) {
        assert.doesNotMatch(JSON.stringify(body), /private-channel|private-binding|private-channel-session|private-turn|legacy-channel|missing-session|private delivery error/)
      }
    }
    await hidden() // Instance admin and Project viewer, no Session grant.
    await app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: admin.userId, role: 'manager' }))
    await hidden() // Project manager is not private Session read authority.
    await app.store.transaction(tx => tx.identity.saveSessionGrant({ sessionId, userId: admin.userId }))
    const first = await (await get('/pages')).json() as AttentionPagesResult
    assert.equal(first.items[0]?.sourceId, ids[0])
    assert.equal(first.items[0]?.title, `投递 ${ids[0]}`)
    assert.equal(first.items[0]?.href, `/projects/${project.id}/channels?delivery=${encodeURIComponent(ids[0]!)}`)
    assert.ok(first.nextCursor)
    assert.equal(JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString())[3], ids[0])
    const second = await (await get('/pages', first.nextCursor)).json() as AttentionPagesResult
    assert.deepEqual(second.items.map(item => item.sourceId), [ids[1]])
    assert.equal(second.nextCursor, null, 'legacy and missing Sessions do not create lookahead cursors')
    const grouped = await (await get('')).json() as import('@wemux/server-domain').AttentionResult
    assert.equal(grouped.total, 2)
    assert.equal(grouped.groups.find(group => group.kind === 'channel_dead_letter')?.count, 2)
    assert.deepEqual(grouped.groups.flatMap(group => group.items.map(item => item.sourceId)), ids)
    await app.store.transaction(tx => tx.identity.removeSessionGrant(sessionId, admin.userId))
    await hidden(first.nextCursor) // A previously authorized cursor never preserves revoked access.
    await app.store.transaction(tx => tx.identity.saveSessionGrant({ sessionId, userId: admin.userId }))
    await app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: admin.userId, role: 'viewer' }))
    await hidden(first.nextCursor) // A Session grant alone cannot bypass the manager requirement.
    await app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: project.id, userId: admin.userId, role: 'manager' }))
    await app.store.putRecord('session', sessionId, { ...session, shareScope: 'owner-only' })
    await hidden(first.nextCursor) // Stale selected-member grants do not expose owner-only Sessions.
    await app.store.putRecord('session', sessionId, { ...session, projectId: 'different-project' })
    await hidden(first.nextCursor) // Delivery and current Session must belong to the same Project.
    await app.store.putRecord('session', sessionId, session)
    await app.store.putRecord('session', sessionId, { ...session, deletedAt: at })
    await hidden(first.nextCursor) // Deleted Sessions fail closed despite a retained grant.
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
