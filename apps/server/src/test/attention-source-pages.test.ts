import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { ProjectId, UserId } from '@wemux/domain'
import type { AttentionSourcePage } from '../application/ports/attention-source.ts'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.ts'
import { SqliteAttentionSource } from '../storage/sqlite/attention-source.ts'
import { migrate, migrationCount } from '../storage/sqlite/migrations.ts'

const actorId = 'submitter' as UserId
const authorizedProjectIds = ['project-a', 'project-b'] as ProjectId[]
const assignment = { workspaceId: 'workspace', workerId: 'worker', agentKey: 'pi', modelId: 'model' }
const recent = '2026-04-03T00:00:00.000Z'
const older = '2026-04-02T00:00:00.000Z'

function fixture() {
  const database = new SharedSqliteDatabase(':memory:')
  const db = database.connection
  const source = new SqliteAttentionSource(database)
  for (const projectId of ['project-a', 'project-b', 'hidden', 'deleted']) {
    db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('project', projectId, JSON.stringify({ id: projectId, ownerId: actorId }))
    db.prepare('INSERT INTO tasks(id,project_id,data) VALUES(?,?,?)').run(projectId, projectId, JSON.stringify({
      id: projectId, projectId, title: `任务 ${projectId}`, status: 'in_progress',
      metadataJson: { schemaVersion: 1, values: {} }, ...(projectId === 'deleted' ? { deletedAt: recent } : {}),
    }))
    db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('session', projectId, JSON.stringify({
      id: projectId, projectId, ownerId: 'session-owner', shareScope: 'project', binding: { workspaceId: 'workspace', agent: { workerId: 'worker', agentKey: 'pi' }, modelId: 'model' },
    }))
  }
  let attempt = 0
  const pendingRuns: (() => void)[] = []
  // Insert Commands before Runs so the existing Command cancellation invariant does
  // not repeatedly rescan a growing Run history during this read-side fixture setup.
  // All production triggers remain enabled for both phases.
  function stageRun(id: string, projectId: string, creator: string | null, timestamp: string | null, kind = 'session.enqueue', status = 'failed', createdAt: string | null = older) {
    attempt++
    db.prepare('INSERT INTO commands(id,worker_id,status,data,projection) VALUES(?,?,?,?,?)').run(id, 'worker', 'pending', JSON.stringify({
      command: { kind, sessionId: projectId, message: creator === null ? {} : { sentByAccountId: creator } },
    }), '{}')
    const data = {
      id, taskId: projectId, projectId, sessionId: projectId, requestId: id, attempt, status,
      createCommandId: null, enqueueCommandId: id, fingerprint: 'a'.repeat(64),
      request: { requestId: id, mode: 'reuse', reuseSessionId: projectId, prompt: 'hello', assignment },
      snapshot: assignment, cancelCommandIds: [], createdAt, finishedAt: timestamp,
    }
    pendingRuns.push(() => db.prepare('INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,create_command_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, id, data.attempt, status, projectId, null, id, JSON.stringify(data)))
  }
  function insertRuns() {
    for (const insert of pendingRuns) insert()
    pendingRuns.length = 0
  }
  function deadLetter(id: string, projectId: string, timestamp: string, status = 'dead_letter') {
    db.prepare(`INSERT INTO channel_outbound_deliveries(id,channel_id,binding_id,project_id,session_id,journal_identity,status,attempt,created_at,updated_at,data)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'channel', 'binding', projectId, projectId, id, status, 4, older, timestamp, JSON.stringify({ title: id, lastError: 'delivery failed' }))
  }
  return { database, db, source, stageRun, insertRuns, deadLetter }
}

// Observe real SQLite statement output, not only the final JS page length.
function observeBoundedSelects(t: TestContext, database: SharedSqliteDatabase) {
  const calls: { sql: string; limit: number; rows: number; milliseconds: number; plan: string[] }[] = []
  const prepare = database.connection.prepare.bind(database.connection)
  t.mock.method(database.connection, 'prepare', (sql: string) => {
    const statement = prepare(sql)
    if (/FROM task_runs r|FROM channel_outbound_deliveries/.test(sql)) {
      const all = statement.all.bind(statement)
      t.mock.method(statement, 'all', (...params: Parameters<typeof all>) => {
        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => String(row.detail))
        const start = performance.now()
        const rows = all(...params)
        calls.push({ sql, limit: Number(params.at(-1)), rows: rows.length, milliseconds: performance.now() - start, plan })
        assert.match(sql, /LIMIT \?/)
        assert.ok(Number(params.at(-1)) <= 101)
        assert.ok(rows.length <= Number(params.at(-1)))
        return rows
      })
    }
    return statement
  })
  return calls
}

async function collectPages<T>(read: (cursor?: string) => Promise<AttentionSourcePage<T>>, size: number): Promise<T[]> {
  const items: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await read(cursor)
    assert.ok(page.items.length <= size)
    items.push(...page.items)
    if (page.nextCursor !== null) {
      assert.equal(page.items.length, size)
      assert.ok(!cursors.has(page.nextCursor), 'cursor must strictly advance')
      cursors.add(page.nextCursor)
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}

function sortedIds(items: { id: string; timestamp: string }[]): string[] {
  return items.sort((a, b) => a.timestamp === b.timestamp ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.timestamp > b.timestamp ? -1 : 1).map(item => item.id)
}

test('Run attention pages SQL-filter creator and Projects before bounded lookahead, with no gaps at timestamp ties', async t => {
  const start = performance.now()
  const f = fixture()
  try {
    // Excluded rows sort before authorized rows and exceed an entire page.
    for (let i = 0; i < 110; i++) {
      f.stageRun(`hidden-${i}`, 'hidden', actorId, recent)
      f.stageRun(`other-${i}`, 'project-a', 'other-actor', recent)
    }
    const expected: { id: string; timestamp: string }[] = []
    for (let i = 0; i < 225; i++) {
      const id = `run-${String(i).padStart(3, '0')}`
      const timestamp = i < 125 ? recent : older
      f.stageRun(id, i % 2 ? 'project-a' : 'project-b', actorId, timestamp)
      expected.push({ id, timestamp })
    }
    f.stageRun('legacy-created', 'project-a', actorId, null)
    expected.push({ id: 'legacy-created', timestamp: older })
    f.stageRun('legacy-undated', 'project-a', actorId, null, 'session.enqueue', 'failed', null)
    expected.push({ id: 'legacy-undated', timestamp: '' })
    f.stageRun('unattributed', 'project-a', null, recent)
    f.stageRun('wrong-kind', 'project-a', actorId, recent, 'session.create')
    f.stageRun('succeeded', 'project-a', actorId, recent, 'session.enqueue', 'succeeded')
    f.stageRun('deleted-task', 'deleted', actorId, recent)
    f.insertRuns()
    t.diagnostic(`Run fixture setup: ${(performance.now() - start).toFixed(1)}ms (all write triggers enabled)`)
    const calls = observeBoundedSelects(t, f.database)
    const query = { actorId, authorizedProjectIds: [...authorizedProjectIds, 'deleted' as ProjectId], limit: 100 }
    const items = await collectPages(cursor => f.source.listRunsPage({ ...query, cursor }), 100)
    assert.deepEqual(items.map(item => item.runId), sortedIds(expected))
    assert.equal(new Set(items.map(item => item.runId)).size, 227)
    assert.ok(items.every(item => item.createdBy === actorId && authorizedProjectIds.includes(item.projectId)))
    assert.deepEqual(calls.map(call => call.rows), [101, 101, 27])
    assert.ok(calls.every(call => call.sql.includes("json_extract(c.data,'$.command.message.sentByAccountId')=?")))
    const scoped = await collectPages(cursor => f.source.listRunsPage({ actorId, authorizedProjectIds: ['project-b' as ProjectId], cursor, limit: 17 }), 17)
    assert.deepEqual(scoped.map(item => item.runId), items.filter(item => item.projectId === 'project-b').map(item => item.runId))
    assert.equal((await f.source.listRunsPage({ actorId, authorizedProjectIds })).items.length, 50)
    const otherActorItems = await collectPages(cursor => f.source.listRunsPage({ actorId: 'other-actor' as UserId, authorizedProjectIds, cursor, limit: 100 }), 100)
    assert.equal(otherActorItems.length, 110)
    assert.ok(otherActorItems.every(item => item.createdBy === 'other-actor' && item.runId.startsWith('other-')))
    assert.deepEqual(await f.source.listRunsPage({ actorId: 'session-owner' as UserId, authorizedProjectIds }), { items: [], nextCursor: null })
    const first = await f.source.listRunsPage(query)
    assert.ok(first.nextCursor)
    assert.deepEqual(await f.source.listRunsPage({ ...query, actorId: 'unrelated' as UserId, cursor: first.nextCursor }), { items: [], nextCursor: null }, 'a cursor never grants another actor access')
    const before = calls.length
    assert.deepEqual(await f.source.listRunsPage({ actorId, authorizedProjectIds: [] }), { items: [], nextCursor: null })
    assert.equal(calls.length, before, 'empty authorization must not query Run rows')
    // Guard indexed access on the actual first-page and cursor queries without
    // pinning the planner's join order or asserting bounded rows visited. Project
    // selectivity may favor task_id lookup + sort over the ordered Run index.
    for (const call of calls) {
      assert.ok(call.plan.some(detail => /(?:SEARCH|SCAN) r USING (?:COVERING )?INDEX /.test(detail)), call.plan.join('\n'))
      assert.ok(call.plan.some(detail => /SEARCH c USING (?:COVERING )?INDEX .*\(id=\?\)/.test(detail)), call.plan.join('\n'))
    }
    t.diagnostic(`Run SQL: ${calls.length} real SELECTs, ${calls.reduce((sum, call) => sum + call.milliseconds, 0).toFixed(1)}ms total (excludes EXPLAIN and mock overhead)`)
  } finally { f.database.close() }
})

test('dead-letter attention pages SQL-filter Projects and status with strict persisted timestamp/id seek', async t => {
  const f = fixture()
  try {
    for (let i = 0; i < 110; i++) {
      f.deadLetter(`hidden-${i}`, 'hidden', recent)
      f.deadLetter(`pending-${i}`, 'project-a', recent, 'pending')
    }
    // More than a full page of private Session rows sort ahead of visible rows.
    f.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('session', 'private', JSON.stringify({ id: 'private', projectId: 'project-a', ownerId: 'other', shareScope: 'owner-only' }))
    for (let i = 0; i < 150; i++) {
      const id = `aaa-private-${i}`
      f.deadLetter(id, 'project-a', recent)
      f.db.prepare('UPDATE channel_outbound_deliveries SET session_id=? WHERE id=?').run('private', id)
    }
    const expected: { id: string; timestamp: string }[] = []
    for (let i = 0; i < 225; i++) {
      const id = `delivery-${String(i).padStart(3, '0')}`
      const timestamp = i < 125 ? recent : older
      f.deadLetter(id, i % 2 ? 'project-a' : 'project-b', timestamp)
      expected.push({ id, timestamp })
    }
    const calls = observeBoundedSelects(t, f.database)
    const items = await collectPages(cursor => f.source.listDeadLettersPage({ actorId, authorizedProjectIds, cursor, limit: 100 }), 100)
    assert.deepEqual(items.map(item => item.id), sortedIds(expected))
    assert.equal(new Set(items.map(item => item.id)).size, 225)
    assert.deepEqual(calls.map(call => call.rows), [101, 101, 25])
    assert.deepEqual((await f.source.listDeadLetters({ actorId, authorizedProjectIds })).map(item => item.id), sortedIds(expected))
    assert.deepEqual(calls.slice(3).map(call => call.rows), [101, 101, 25], 'grouped counts also use bounded authorized reads')
    const scoped = await collectPages(cursor => f.source.listDeadLettersPage({ actorId, authorizedProjectIds: ['project-a' as ProjectId], cursor, limit: 1 }), 1)
    assert.deepEqual(scoped.map(item => item.id), items.filter(item => item.projectId === 'project-a').map(item => item.id))
    assert.equal((await f.source.listDeadLettersPage({ actorId, authorizedProjectIds })).items.length, 50)
    const before = calls.length
    assert.deepEqual(await f.source.listDeadLettersPage({ actorId, authorizedProjectIds: [] }), { items: [], nextCursor: null })
    assert.equal(calls.length, before)
    const first = await f.source.listDeadLettersPage({ actorId, authorizedProjectIds, limit: 100 })
    assert.ok(first.nextCursor)
    assert.deepEqual(await f.source.listDeadLettersPage({ actorId, authorizedProjectIds: ['no-access' as ProjectId], cursor: first.nextCursor }), { items: [], nextCursor: null })
    f.db.prepare('DELETE FROM channel_outbound_deliveries WHERE id=?').run(first.items.at(-1)!.id)
    const remaining = await collectPages(cursor => f.source.listDeadLettersPage({ actorId, authorizedProjectIds, cursor: cursor ?? first.nextCursor!, limit: 100 }), 100)
    assert.deepEqual(remaining.map(item => item.id), items.slice(100).map(item => item.id), 'seek does not require the cursor row to still exist')
  } finally { f.database.close() }
})

test('attention page inputs reject invalid limits, malformed and cross-source cursors even with empty authorization', async () => {
  const f = fixture()
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  try {
    for (const read of [
      (query: { limit?: number; cursor?: string }) => f.source.listRunsPage({ actorId, authorizedProjectIds: [], ...query }),
      (query: { limit?: number; cursor?: string }) => f.source.listDeadLettersPage({ actorId, authorizedProjectIds: [], ...query }),
    ]) {
      for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) await assert.rejects(read({ limit }), { code: 'invalid_limit' })
      for (const cursor of ['', 'garbage', '%%%%', encoded({}), encoded([1, 'run_problem']), encoded([2, 'run_problem', older, 'id']), encoded([1, 'unknown', older, 'id']), encoded([1, 'run_problem', 1, 'id']), encoded([1, 'channel_dead_letter', older, ''])]) {
        await assert.rejects(read({ cursor }), { code: 'invalid_cursor' })
      }
    }
    const runCursor = encoded([1, 'run_problem', older, 'run'])
    const deadLetterCursor = encoded([1, 'channel_dead_letter', older, 'delivery'])
    await assert.rejects(f.source.listRunsPage({ actorId, authorizedProjectIds, cursor: deadLetterCursor }), { code: 'invalid_cursor' })
    await assert.rejects(f.source.listDeadLettersPage({ actorId, authorizedProjectIds, cursor: runCursor }), { code: 'invalid_cursor' })
    await assert.rejects(f.source.listRunsPage({ actorId, authorizedProjectIds, cursor: `${runCursor}=` }), { code: 'invalid_cursor' })
    assert.deepEqual(await f.source.listRunsPage({ actorId, authorizedProjectIds, cursor: runCursor }), { items: [], nextCursor: null })
  } finally { f.database.close() }
})

test('attention ordering indexes migrate existing rows and replay without changing data', () => {
  const f = fixture()
  try {
    f.stageRun('existing-run', 'project-a', actorId, recent)
    f.insertRuns()
    f.deadLetter('existing-delivery', 'project-a', recent)
    f.db.exec('DROP INDEX attention_failed_runs_order; DROP INDEX attention_dead_letters_order; DROP INDEX attention_human_reviews_order')
    // The two attention indexes precede the human review index and personal visibility migration.
    for (const version of [migrationCount - 1, migrationCount - 2]) {
      f.db.prepare('DELETE FROM schema_migrations WHERE version=?').run(version)
    }
    migrate(f.db)
    migrate(f.db)
    const indexes = f.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'attention_%' ORDER BY name").all()
    assert.deepEqual(indexes.map(row => row.name), ['attention_dead_letters_order', 'attention_failed_runs_order', 'attention_human_reviews_order'])
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count, migrationCount)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get()?.count, 1)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM channel_outbound_deliveries').get()?.count, 1)
  } finally { f.database.close() }
})
