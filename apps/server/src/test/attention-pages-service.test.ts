import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectId, UserId } from '@wemux/domain'
import type { AttentionPagesQuery } from '@wemux/server-domain'
import { AttentionService } from '../application/attention-service.ts'
import { ProjectionService } from '../application/projection-service.ts'
import { ProjectAccessService } from '../application/project-access-service.ts'
import type { SessionAccessService } from '../application/session-access-service.ts'
import type { ApprovalDecisionRepository } from '../application/ports/approval-decision-repository.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import { SqliteAttentionSource } from '../storage/sqlite/attention-source.ts'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.ts'
import { seedAttentionPages } from './fixtures/attention-pages.ts'

const actor = 'actor' as UserId
const at = '2026-04-04T00:00:00.000Z'

test('attention pages keep authorization and source in one committed SQLite snapshot', async t => {
  const database = new SharedSqliteDatabase(':memory:')
  try {
    const store = new SqliteServerStore(database)
    const source = new SqliteAttentionSource(database)
    seedAttentionPages(database.connection, actor, 'other-actor')
    await store.putRecord('project', 'visible', { id: 'visible', teamId: 'team', ownerId: actor, deletedAt: null })
    const projects = new ProjectAccessService(store)
    const projections = new ProjectionService(store, projects, {} as SessionAccessService, {} as ApprovalDecisionRepository)
    const service = new AttentionService(projections, source, store, () => new Date(at))
    let reachedSource!: () => void
    let releaseSource!: () => void
    const entered = new Promise<void>(resolve => { reachedSource = resolve })
    const release = new Promise<void>(resolve => { releaseSource = resolve })
    const original = source.listRunsPage.bind(source)
    const pageSource = t.mock.method(source, 'listRunsPage', async (...args: Parameters<typeof original>) => {
      reachedSource()
      await release
      return original(...args)
    })
    const pagePromise = service.pages(actor, true, { kind: 'run_problem', projectId: 'visible' as ProjectId })
    await entered
    let revoked = false
    const revocation = store.transaction(async tx => {
      await tx.resources.saveProject({ id: 'visible' as ProjectId, teamId: 'team' as never, ownerId: 'other-actor' as never, deletedAt: null } as never)
      revoked = true
    })
    // The queued write cannot interleave after authorization and before source rows.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(revoked, false)
    releaseSource()
    const page = await pagePromise
    assert.equal(page.items.length, 50)
    assert.equal(pageSource.mock.callCount(), 1)
    await revocation
    assert.equal(revoked, true)
    assert.deepEqual((await service.pages(actor, true, { kind: 'run_problem', projectId: 'visible' as ProjectId })).items, [])
  } finally { database.close() }
})

test('attention pages service authorizes and intersects before bounded SQL, never calling legacy scans', async t => {
  const database = new SharedSqliteDatabase(':memory:')
  try {
    seedAttentionPages(database.connection, actor, 'other-actor')
    const source = new SqliteAttentionSource(database)
    for (const name of ['listRuns', 'listTasks', 'listDeadLetters'] as const) t.mock.method(source, name, () => { throw new Error('legacy scan') })
    const store = new SqliteServerStore(database)
    for (const id of ['visible', 'other', 'hidden', 'deleted']) {
      await store.putRecord('project', id, { id, teamId: 'team', ownerId: id === 'hidden' ? 'other-actor' : actor, deletedAt: id === 'deleted' ? at : null })
    }
    const projects = new ProjectAccessService(store)
    const projections = new ProjectionService(store, projects, {} as SessionAccessService, {} as ApprovalDecisionRepository)
    t.mock.method(projections, 'allowedProjectIds', () => { throw new Error('legacy authorization scan') })
    t.mock.method(store.resources, 'listProjects', () => { throw new Error('Project hydration') })
    t.mock.method(store.identity, 'getIdentityRecords', () => { throw new Error('N+1 role query') })
    t.mock.method(projections, 'approvals', () => { throw new Error('approval scan') })
    const service = new AttentionService(projections, source, store, () => new Date(at))
    const runCall = t.mock.method(source, 'listRunsPage')
    const deadCall = t.mock.method(source, 'listDeadLettersPage')
    for (const kind of ['run_problem', 'channel_dead_letter'] as const) {
      const seen: string[] = []
      let cursor: string | undefined
      do {
        const page = await service.pages(actor, true, { kind, projectId: 'visible' as ProjectId, limit: 100, cursor })
        assert.deepEqual(Object.keys(page).sort(), ['generatedAt', 'items', 'nextCursor'])
        assert.equal(page.generatedAt, at)
        assert.ok(page.items.length <= 100)
        assert.ok(page.items.every(item => item.projectId === 'visible'))
        assert.ok(page.items.every(item => kind === 'run_problem' ? item.href === `/next/projects/visible?task=visible&run=${item.sourceId}` : item.href === `/projects/visible/channels?delivery=${encodeURIComponent(item.sourceId)}`))
        seen.push(...page.items.map(item => item.sourceId))
        assert.notEqual(page.nextCursor, cursor)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      assert.equal(new Set(seen).size, seen.length)
      assert.equal(seen.length, kind === 'run_problem' ? 110 : 220)
      if (kind === 'run_problem') assert.deepEqual(seen, Array.from({ length: 110 }, (_, i) => `run-${String(i).padStart(3, '0')}`))
    }
    assert.ok(runCall.mock.callCount() > 0 && deadCall.mock.callCount() > 0)
    assert.ok(runCall.mock.calls.every(call => JSON.stringify(call.arguments[0].authorizedProjectIds) === '["visible"]'))
    assert.ok(deadCall.mock.calls.every(call => JSON.stringify(call.arguments[0].authorizedProjectIds) === '["visible"]'))
    const before = runCall.mock.callCount() + deadCall.mock.callCount()
    await assert.rejects(service.pages(actor, false, { kind: 'channel_dead_letter' }), { status: 403 })
    for (const kind of ['run_problem', 'channel_dead_letter'] as const) {
      for (const projectId of ['hidden', 'deleted', 'missing']) {
        assert.deepEqual(await service.pages(actor, true, { kind, projectId: projectId as ProjectId }), { items: [], nextCursor: null, generatedAt: at })
      }
      assert.deepEqual(await service.pages('nobody' as UserId, true, { kind }), { items: [], nextCursor: null, generatedAt: at })
      await assert.rejects(service.pages('nobody' as UserId, true, { kind, cursor: '' }), { status: 400, code: 'invalid_cursor' })
      await assert.rejects(service.pages(actor, true, { kind, limit: 101 }), { status: 400, code: 'invalid_limit' })
    }
    for (const kind of ['task_assignment']) await assert.rejects(service.pages(actor, true, { kind } as AttentionPagesQuery), { status: 422 })
    assert.equal(runCall.mock.callCount() + deadCall.mock.callCount(), before, 'unauthorized/empty/invalid inputs must not call a source')
  } finally { database.close() }
})

for (const mode of ['pages', 'grouped'] as const) {
  test(`dead-letter ${mode} authorization and Session grants share one transaction snapshot`, async t => {
    const database = new SharedSqliteDatabase(':memory:')
    try {
      const store = new SqliteServerStore(database)
      const source = new SqliteAttentionSource(database)
      seedAttentionPages(database.connection, 'other-actor', actor)
      await store.putRecord('project', 'visible', { id: 'visible', teamId: 'team', ownerId: actor, deletedAt: null })
      const session = await store.resources.getSession('visible' as never)
      assert.ok(session)
      await store.putRecord('session', 'visible', { ...session, shareScope: 'selected-members' })
      await store.transaction(tx => tx.identity.saveSessionGrant({ sessionId: 'visible' as never, userId: actor }))
      const projections = new ProjectionService(store, new ProjectAccessService(store), {} as SessionAccessService, {} as ApprovalDecisionRepository)
      t.mock.method(projections, 'approvals', async () => ({ items: [], nextCursor: null, generatedAt: at } as never))
      const service = new AttentionService(projections, source, store)
      let reachedSource!: () => void
      let releaseSource!: () => void
      const entered = new Promise<void>(resolve => { reachedSource = resolve })
      const release = new Promise<void>(resolve => { releaseSource = resolve })
      const original = source.listDeadLettersPage.bind(source)
      t.mock.method(source, 'listDeadLettersPage', async (...args: Parameters<typeof original>) => {
        reachedSource()
        await release
        return original(...args)
      })
      const read = async () => mode === 'pages'
        ? (await service.pages(actor, true, { kind: 'channel_dead_letter', projectId: 'visible' as ProjectId })).items.length
        : (await service.query(actor, true, { actorId: actor, kind: 'channel_dead_letter', projectId: 'visible' as ProjectId })).total
      const pending = read()
      await entered
      let revoked = false
      const revocation = store.transaction(async tx => {
        await tx.identity.removeSessionGrant('visible' as never, actor)
        revoked = true
      })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(revoked, false, 'Session revocation cannot interleave with the source snapshot')
      releaseSource()
      assert.equal(await pending, mode === 'pages' ? 50 : 220)
      await revocation
      assert.equal(await read(), 0, 'the next request sees the current grant revocation')
    } finally { database.close() }
  })
}
