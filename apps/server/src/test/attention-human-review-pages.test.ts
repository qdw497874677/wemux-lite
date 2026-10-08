import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectId, UserId } from '@wemux/domain'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.ts'
import { SqliteAttentionSource } from '../storage/sqlite/attention-source.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import { migrate, migrationCount } from '../storage/sqlite/migrations.ts'
import { AttentionService } from '../application/attention-service.ts'
import type { ProjectionService } from '../application/projection-service.ts'
import { seedAttentionHumanReview, reviewRequestedAt } from './fixtures/attention-human-reviews.ts'

const actorId = 'reviewer' as UserId
const projectId = 'project' as ProjectId
function fixture() {
  const database = new SharedSqliteDatabase(':memory:')
  const db = database.connection
  const source = new SqliteAttentionSource(database)
  const store = new SqliteServerStore(database)
  db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('project', projectId, JSON.stringify({ id: projectId, teamId: 'team', ownerId: actorId }))
  const query = { actorId, authorizedProjectIds: [projectId], limit: 2 }
  const updateTask = (id: string, path: string, value: string | number | null) => db.prepare('UPDATE tasks SET data=json_set(data,?,?) WHERE id=?').run(path, value, `task-${id}`)
  return { database, db, source, store, query, updateTask }
}

test('human review source authorizes before LIMIT+1 and uses review-id ties with indexed seek', async t => {
  const f = fixture()
  try {
    for (let i = 0; i < 110; i++) seedAttentionHumanReview(f.db, `aaa-self-${i}`, projectId, actorId)
    for (const id of ['b', 'c', 'd', 'e', 'f']) seedAttentionHumanReview(f.db, id, projectId)
    const prepare = f.db.prepare.bind(f.db)
    const observed: number[] = []
    t.mock.method(f.db, 'prepare', (sql: string) => {
      const stmt = prepare(sql)
      if (sql.includes('FROM review_requests v')) {
        const all = stmt.all.bind(stmt)
        t.mock.method(stmt, 'all', (...args: Parameters<typeof all>) => {
          assert.match(sql, /LIMIT \?/)
          assert.equal(args.at(-1), 3)
          const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join('\n')
          assert.match(plan, /(?:SEARCH|SCAN) v USING INDEX/)
          if (observed.length < 2) t.diagnostic(`Human review ${observed.length ? 'seek' : 'first'} page plan: ${plan}`)
          const rows = all(...args); observed.push(rows.length); return rows
        })
      }
      return stmt
    })
    const first = await f.source.listApprovalsPage(f.query)
    assert.deepEqual(first.items.map(item => item.reviewId), ['b', 'c'])
    assert.ok(first.nextCursor)
    assert.deepEqual(JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()), [1, 'approval', reviewRequestedAt, 'c'])
    // Cursor row may stop being actionable without blocking continuation.
    f.updateTask('c', '$.status', 'in_progress')
    const second = await f.source.listApprovalsPage({ ...f.query, cursor: first.nextCursor })
    assert.deepEqual(second.items.map(item => item.reviewId), ['d', 'e'])
    const third = await f.source.listApprovalsPage({ ...f.query, cursor: second.nextCursor! })
    assert.deepEqual(third.items.map(item => item.reviewId), ['f'])
    assert.equal(third.nextCursor, null)
    assert.deepEqual(observed, [3, 3, 1])
    assert.deepEqual(await f.source.listApprovalsPage({ ...f.query, actorId: 'stranger' as UserId, cursor: first.nextCursor }), { items: [], nextCursor: null })
    assert.deepEqual(await f.source.listApprovalsPage({ ...f.query, authorizedProjectIds: [] }), { items: [], nextCursor: null })
    assert.ok(f.db.prepare("SELECT name FROM sqlite_master WHERE name='attention_human_reviews_order'").get())
  } finally { f.database.close() }
})

test('human review source requires current membership/manager, excludes stale policies and cycles, and never reads Journal', async t => {
  const f = fixture()
  try {
    const ids = ['valid', 'wrong-policy', 'unfrozen', 'wrong-cycle', 'not-review', 'deleted', 'failed', 'superseded', 'active', 'closed']
    for (const id of ids) seedAttentionHumanReview(f.db, id, projectId)
    f.updateTask('wrong-policy', '$.metadataJson.values.reviewPolicy', 'agent')
    f.updateTask('unfrozen', '$.metadataJson.values.reviewPolicyFrozen', 1)
    f.updateTask('wrong-cycle', '$.currentReviewId', 'old-review')
    f.updateTask('not-review', '$.status', 'done')
    f.updateTask('deleted', '$.deletedAt', reviewRequestedAt)
    f.db.prepare("UPDATE task_runs SET status='failed',data=json_set(data,'$.status','failed') WHERE id='run-failed'").run()
    for (const [id, status, attempt] of [['superseded', 'succeeded', 2], ['active', 'running', 2]] as const) {
      const old = JSON.parse(String(f.db.prepare('SELECT data FROM task_runs WHERE id=?').get(`run-${id}`)!.data))
      const runId = `new-${id}`
      const command = JSON.parse(String(f.db.prepare('SELECT data FROM commands WHERE id=?').get(old.enqueueCommandId)!.data))
      f.db.prepare('INSERT INTO commands(id,worker_id,status,data,projection) VALUES(?,?,?,?,?)').run(runId, 'worker', 'pending', JSON.stringify(command), '{}')
      const run = { ...old, id: runId, requestId: runId, enqueueCommandId: runId, attempt, status, request: { ...old.request, requestId: runId } }
      f.db.prepare('INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,create_command_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?,?)').run(runId, old.taskId, runId, attempt, status, old.sessionId, null, runId, JSON.stringify(run))
    }
    f.db.prepare("UPDATE review_requests SET data=json_set(data,'$.closedAt',?) WHERE id='closed'").run(reviewRequestedAt)
    const prepare = f.db.prepare.bind(f.db)
    t.mock.method(f.db, 'prepare', (sql: string) => { assert.doesNotMatch(sql, /FROM events|kind='session'/); return prepare(sql) })
    assert.deepEqual((await f.source.listApprovalsPage(f.query)).items.map(item => item.reviewId), ['valid'])
    await f.store.putRecord('project', projectId, { id: projectId, teamId: 'team', ownerId: 'other' })
    await f.store.putRecord('project-grant', `${projectId}:${actorId}`, { projectId, userId: actorId, role: 'manager' })
    assert.deepEqual((await f.source.listApprovalsPage(f.query)).items, [], 'orphan manager grant denied')
    await f.store.putRecord('membership', `team:${actorId}`, { userId: actorId, teamId: 'team', role: 'member' })
    assert.equal((await f.source.listApprovalsPage(f.query)).items.length, 1)
    await f.store.putRecord('project-grant', `${projectId}:${actorId}`, { projectId, userId: actorId, role: 'contributor' })
    assert.deepEqual((await f.source.listApprovalsPage(f.query)).items, [])
    await assert.rejects(f.source.listApprovalsPage({ ...f.query, cursor: Buffer.from(JSON.stringify([1, 'run_problem', reviewRequestedAt, 'x'])).toString('base64url') }), { code: 'invalid_cursor' })
    await assert.rejects(f.source.listApprovalsPage({ ...f.query, limit: 101 }), { code: 'invalid_limit' })
  } finally { f.database.close() }
})

test('human review pages seek across mixed timestamps and review-id ties without gaps or duplicates', async () => {
  const f = fixture()
  try {
    const newer = '2026-04-04T00:00:00.000Z', older = '2026-04-02T23:59:59.999Z'
    // Deliberately neither insertion order nor id order; ties cross page boundaries.
    for (const [id, at] of [['z', older], ['d', reviewRequestedAt], ['b', newer], ['a', newer], ['c', reviewRequestedAt], ['e', reviewRequestedAt]] as const) {
      seedAttentionHumanReview(f.db, id, projectId, 'submitter', at)
    }
    const ids: string[] = [], cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await f.source.listApprovalsPage({ ...f.query, cursor })
      assert.equal(page.items.length, 2)
      ids.push(...page.items.map(item => item.reviewId))
      if (page.nextCursor) {
        assert.ok(!cursors.has(page.nextCursor), 'cursor strictly advances')
        cursors.add(page.nextCursor)
        const last = page.items.at(-1)!
        assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString()), [1, 'approval', last.requestedAt, last.reviewId])
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e', 'z'])
    assert.equal(new Set(ids).size, 6)
    assert.equal(cursors.size, 2)
  } finally { f.database.close() }
})

test('human review metadata candidate batches continue until eligible lookahead and terminal exhaustion', async t => {
  const f = fixture()
  try {
    // Numeric timestamps sort above valid dates after SQL's TEXT cast but fail
    // decision metadata validation. Smaller numeric Julian dates sort below;
    // production CHECK constraints remain enabled (null/malformed dates cannot be inserted).
    for (let i = 0; i < 8; i++) seedAttentionHumanReview(f.db, `bad-${i}`, projectId, 'submitter', 2461133 as unknown as string)
    for (const id of ['a', 'b', 'c']) seedAttentionHumanReview(f.db, id, projectId)
    for (let i = 0; i < 7; i++) {
      seedAttentionHumanReview(f.db, `tail-${i}`, projectId, 'submitter', 1234567 as unknown as string)
    }
    const prepare = f.db.prepare.bind(f.db), batches: string[][] = []
    t.mock.method(f.db, 'prepare', (sql: string) => {
      const statement = prepare(sql)
      if (sql.includes('FROM review_requests v')) {
        const all = statement.all.bind(statement)
        t.mock.method(statement, 'all', (...params: Parameters<typeof all>) => {
          assert.match(sql, /LIMIT \?/)
          assert.equal(params.at(-1), 3)
          const rows = all(...params)
          assert.ok(rows.length <= 3)
          batches.push(rows.map(row => String(row.id)))
          return rows
        })
      }
      return statement
    })
    const first = await f.source.listApprovalsPage(f.query)
    assert.deepEqual(first.items.map(item => item.reviewId), ['a', 'b'])
    assert.ok(first.nextCursor)
    const last = await f.source.listApprovalsPage({ ...f.query, cursor: first.nextCursor })
    assert.deepEqual(last.items.map(item => item.reviewId), ['c'])
    assert.equal(last.nextCursor, null)
    assert.deepEqual(batches.map(batch => batch.length), [3, 3, 3, 3, 3, 3, 2])
    assert.deepEqual(batches.slice(0, 3).flat(), [...Array.from({ length: 8 }, (_, i) => `bad-${i}`), 'a'])
    assert.deepEqual(batches.slice(4).flat().sort(), ['c', ...Array.from({ length: 7 }, (_, i) => `tail-${i}`)])
    t.diagnostic(`Human review candidate batch lengths: ${batches.map(batch => batch.length).join(',')}; every SELECT bounded to limit+1=3`)
  } finally { f.database.close() }
})

test('human review ordering migration retains existing review data and actionable page on replay', async () => {
  const f = fixture()
  try {
    seedAttentionHumanReview(f.db, 'retained', projectId)
    const before = f.db.prepare('SELECT * FROM review_requests WHERE id=?').get('retained')
    const page = await f.source.listApprovalsPage(f.query)
    assert.equal(page.items[0]?.reviewId, 'retained')
    f.db.exec('DROP INDEX attention_human_reviews_order')
    // Replay the migration that owns this index, not the last (personal Workspace visibility) migration.
    f.db.prepare('DELETE FROM schema_migrations WHERE version=?').run(migrationCount - 1)
    for (let replay = 0; replay < 2; replay++) {
      migrate(f.db)
      assert.deepEqual(f.db.prepare('SELECT * FROM review_requests WHERE id=?').get('retained'), before)
      assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM review_requests').get()?.count, 1)
      assert.deepEqual(await f.source.listApprovalsPage(f.query), page)
      assert.ok(f.db.prepare("SELECT name FROM sqlite_master WHERE name='attention_human_reviews_order'").get())
      assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count, migrationCount)
    }
  } finally { f.database.close() }
})

test('human review service holds authority and source in one transaction and next request sees revocation', async t => {
  const f = fixture()
  try {
    seedAttentionHumanReview(f.db, 'review', projectId)
    const service = new AttentionService({ approvals: () => { throw Error('unbounded projection') } } as unknown as ProjectionService, f.source, f.store)
    let entered!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = f.source.listApprovalsPage.bind(f.source)
    t.mock.method(f.source, 'listApprovalsPage', async (query: Parameters<typeof original>[0]) => { entered(); await gate; return original(query) })
    const pending = service.pages(actorId, false, { kind: 'approval', projectId })
    await reached
    let revoked = false
    const revoke = f.store.transaction(async tx => {
      await tx.resources.saveProject({ id: projectId, teamId: 'team', ownerId: 'other' } as never)
      revoked = true
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(revoked, false)
    release()
    const page = await pending
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0]?.href, '/next/projects/project?task=task-review')
    assert.equal(page.items[0]?.projectionKey, 'approval:task_review:task-review:run-review:review')
    assert.doesNotMatch(JSON.stringify(page), /session-review|decisionCapabilities|sourceRevision/)
    await revoke
    assert.deepEqual((await service.pages(actorId, true, { kind: 'approval', projectId })).items, [], 'admin cannot bypass revocation')
  } finally { f.database.close() }
})
