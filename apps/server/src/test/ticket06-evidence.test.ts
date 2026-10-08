import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AgentKey, CommandId, EventSeq, JournalEvent, MessageId, ModelId, SessionId, Timestamp, UserId, WorkerId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { migrate } from '../storage/sqlite/migrations.js'
import { ServerService } from '../application/server-service.js'
import { TaskService } from '../application/task-service.js'
import { WorkerService } from '../application/worker-service.js'
import { Notifications } from '../application/notifications.js'
import { AuthenticationService } from '../application/auth.js'
import { httpHandler } from '../http/handler.js'
import { SessionStreams } from '../http/sse.js'
import { administratorDirectory, administratorToken, instanceOperatorId, seedOperator } from './fixtures/administrator.js'

const context = { actor: instanceOperatorId, requestId: 'ticket06-evidence' }
async function fixture(path: string, cancel = true) {
  const store = new SqliteServerStore(path), signals = new Notifications()
  const server = new ServerService(store, signals)
  await seedOperator(store, server)
  const { worker } = await server.enroll({ token: (await server.createEnrollment({})).token, name: 'Evidence worker' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
  const tasks = new TaskService(store, event => signals.project(event), server)
  const task = await tasks.create('default-project', { title: 'Ticket06 evidence' }, context)
  const { workspace } = await tasks.createWorkspace(task.projectId, task.id, { name: task.title, workerId: worker.id, source: 'empty' }, context)
  await store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready' }))
  const assignment = { workspaceId: workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' }
  await tasks.assignment(task.projectId, task.id, { version: 1, assignee: assignment }, false, context)
  const { session: independent } = await tasks.createSession(task.projectId, task.id, { title: 'Independent', requestId: 'independent-session' }, context)
  const { run } = await tasks.launch(task.projectId, task.id, { requestId: 'launch', mode: 'new', reuseSessionId: null, prompt: 'Evidence', assignment }, context)
  if (cancel) await tasks.cancelRun(task.projectId, task.id, run.id, { runId: run.id, sessionId: run.sessionId, requestId: 'cancel' }, context)
  return { store, server, tasks, signals, task, worker, run: (await store.tasks.run(run.id))!, independent }
}

function snapshot(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => ({ name: row.name, rows: db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all() }))
}

// Direct SQL failures must leave both the statement and enclosing transaction atomic.
test('Ticket06 direct SQLite insert/update/delete matrix, exact errors and all-table rollback across restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket06-matrix-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  const source = (await f.store.resources.getSession(f.run.sessionId as SessionId))!
  f.store.close()
  try {
    for (let restart = 0; restart < 2; restart++) {
      const reopened = new SqliteServerStore(path)
      assert.deepEqual(await reopened.tasks.run(f.run.id), f.run)
      assert.deepEqual(await reopened.resources.getSession(source.id), source)
      assert.deepEqual(await reopened.resources.getSession(f.independent.id), f.independent)
      reopened.close()
      const db = new DatabaseSync(path)
      db.exec('PRAGMA foreign_keys=ON')
      let baseline = snapshot(db)
      const probe = (name: string, sql: string, args: (string | number | null)[], expected: string | null) => {
        db.exec('BEGIN IMMEDIATE')
        try {
          db.prepare('INSERT INTO records VALUES(?,?,?)').run('matrix-sentinel', name, '{}')
          const beforeStatement = snapshot(db)
          let actual: string | null = null
          try { db.prepare(sql).run(...args) } catch (error) { actual = (error as Error).message }
          assert.equal(actual, expected, name)
          if (actual) assert.deepEqual(snapshot(db), beforeStatement, `${name}: failed statement has no partial writes`)
          t.diagnostic(JSON.stringify({ restart, name, result: actual ?? 'ACCEPTED_INVALID', rollback: 'all tables restored' }))
        } finally { db.exec('ROLLBACK') }
        assert.deepEqual(snapshot(db), baseline, `${name}: no partial writes after rollback`)
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
      }
      const fk = 'FOREIGN KEY constraint failed', immutable = 'Immutable Run identity changed'
      probe('cancel duplicate identity INSERT', 'INSERT INTO run_cancel_requests VALUES(?,?,?)', [f.run.id, 'cancel', source.id], 'UNIQUE constraint failed: run_cancel_requests.run_id, run_cancel_requests.request_id')
      probe('cancel missing Run INSERT', 'INSERT INTO run_cancel_requests VALUES(?,?,?)', ['missing', 'new', source.id], 'Invalid cancel request identity or Session')
      probe('cancel missing Run UPDATE', 'UPDATE run_cancel_requests SET run_id=?', ['missing'], 'Cancel request identity is immutable')
      probe('cancel null identity INSERT', 'INSERT INTO run_cancel_requests VALUES(?,?,?)', [f.run.id, null, source.id], 'NOT NULL constraint failed: run_cancel_requests.request_id')
      probe('cancel empty identity INSERT', 'INSERT INTO run_cancel_requests VALUES(?,?,?)', [f.run.id, '', source.id], 'Invalid cancel request identity or Session')
      probe('cancel missing Session INSERT', 'INSERT INTO run_cancel_requests VALUES(?,?,?)', [f.run.id, 'new', 'missing'], 'Invalid cancel request identity or Session')
      probe('cancel wrong Session INSERT', 'INSERT INTO run_cancel_requests VALUES(?,?,?)', [f.run.id, 'new', f.independent.id], 'Invalid cancel request identity or Session')
      probe('cancel oversized identity INSERT', 'INSERT INTO run_cancel_requests VALUES(?,?,?)', [f.run.id, 'x'.repeat(201), source.id], 'Invalid cancel request identity or Session')
      probe('cancel null Session INSERT', 'INSERT INTO run_cancel_requests VALUES(?,?,?)', [f.run.id, 'new', null], 'NOT NULL constraint failed: run_cancel_requests.session_id')
      probe('cancel duplicate identity UPDATE', 'UPDATE run_cancel_requests SET request_id=NULL', [], 'Cancel request identity is immutable')
      probe('cancel wrong Session UPDATE', 'UPDATE run_cancel_requests SET session_id=?', [f.independent.id], 'Cancel request identity is immutable')
      probe('cancel identity mutation UPDATE', 'UPDATE run_cancel_requests SET request_id=?', ['replacement'], 'Cancel request identity is immutable')
      probe('cancel identity DELETE', 'DELETE FROM run_cancel_requests', [], 'Cancel request identity is retained')
      probe('referenced Run DELETE', 'DELETE FROM task_runs WHERE id=?', [f.run.id], fk)
      probe('referenced Task DELETE', 'DELETE FROM tasks WHERE id=?', [f.task.id], 'Session source Task is referenced')
      probe('referenced Session DELETE', 'DELETE FROM records WHERE kind=\'session\' AND id=?', [source.id], 'Session identity and provenance are retained')
      for (const id of [f.run.createCommandId!, f.run.enqueueCommandId]) probe('referenced dispatch DELETE ' + id, 'DELETE FROM commands WHERE id=?', [id], fk)
      probe('cancel dispatch DELETE', 'DELETE FROM commands WHERE id=?', [f.run.cancelCommandIds[0]!], 'Run cancellation dispatch is referenced')
      probe('cancel dangling dispatch JSON UPDATE', "UPDATE task_runs SET data=json_set(data,'$.cancelCommandIds',json('[\"missing\"]')) WHERE id=?", [f.run.id], 'Invalid Run cancellation dispatch')
      probe('cancel duplicate dispatch JSON UPDATE', "UPDATE task_runs SET data=json_set(data,'$.cancelCommandIds',json(?)) WHERE id=?", [JSON.stringify([f.run.cancelCommandIds[0], f.run.cancelCommandIds[0]]), f.run.id], 'Invalid Run cancellation dispatch')
      for (const [column, value, error] of [
        ['session_id', 'missing', immutable], ['task_id', 'missing', immutable], ['create_command_id', 'missing', immutable], ['enqueue_command_id', 'missing', immutable],
        ['attempt', 0, immutable], ['session_kind', 'workspace', immutable],
        ['status', 'bogus', "CHECK constraint failed: status IN ('pending','running','cancelling','succeeded','failed','cancelled')"], ['data', '{', 'malformed JSON'],
      ] as const) probe('Run UPDATE ' + column, `UPDATE task_runs SET ${column}=? WHERE id=?`, [value, f.run.id], error)
      probe('Run scope UPDATE to independent same-project Session', 'UPDATE task_runs SET session_id=? WHERE id=?', [f.independent.id, f.run.id], 'Immutable Run identity changed')
      probe('Run missing Session INSERT', 'INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?)', ['new-run', f.task.id, 'new', 2, 'succeeded', 'missing', f.run.enqueueCommandId, '{}'], 'Run Session project mismatch or deleted')
      probe('Run missing Task INSERT', 'INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?)', ['new-run', 'missing', 'new', 2, 'succeeded', source.id, f.run.enqueueCommandId, '{}'], 'Run Session project mismatch or deleted')
      probe('dependency missing command INSERT', 'INSERT INTO command_dependencies VALUES(?,?)', ['missing', f.run.createCommandId!], fk)
      probe('dependency missing prerequisite UPDATE', 'UPDATE command_dependencies SET prerequisite_id=?', ['missing'], fk)
      probe('dependency missing prerequisite INSERT', 'INSERT INTO command_dependencies VALUES(?,?)', [f.run.createCommandId!, 'missing'], fk)
      probe('dependency self INSERT', 'INSERT INTO command_dependencies VALUES(?,?)', [f.run.createCommandId!, f.run.createCommandId!], 'CHECK constraint failed: command_id <> prerequisite_id')
      probe('dependency self UPDATE', 'UPDATE command_dependencies SET prerequisite_id=command_id', [], 'CHECK constraint failed: command_id <> prerequisite_id')
      probe('dependency duplicate INSERT', 'INSERT INTO command_dependencies VALUES(?,?)', [f.run.enqueueCommandId, f.run.createCommandId!], 'UNIQUE constraint failed: command_dependencies.command_id')
      probe('activity missing Task INSERT', 'INSERT INTO task_activity VALUES(?,?,?,?)', ['missing', 1, '{}', null], fk)
      probe('activity duplicate source INSERT', 'INSERT INTO task_activity SELECT task_id,999999,data,source_key FROM task_activity WHERE source_key IS NOT NULL LIMIT 1', [], 'UNIQUE constraint failed: task_activity.task_id, task_activity.source_key')
      for (const session of [source, f.independent]) {
        for (const key of ['taskId', 'runId']) probe(`frozen ${session.runId ? 'Run' : 'independent'} ${key} UPDATE`, `UPDATE records SET data=json_set(data,'$.${key}',?) WHERE kind='session' AND id=?`, [key === 'taskId' ? null : 'changed', session.id], 'Session creation provenance is immutable')
        probe('Session project UPDATE ' + session.id, "UPDATE records SET data=json_set(data,'$.projectId','missing') WHERE kind='session' AND id=?", [session.id], 'Session Task project mismatch')
      }
      probe('Session invalid Task INSERT', 'INSERT INTO records VALUES(?,?,?)', ['session', 'bad-task', JSON.stringify({ ...source, id: 'bad-task', taskId: 'missing' })], 'Invalid Session source')
      probe('Session invalid Run INSERT', 'INSERT INTO records VALUES(?,?,?)', ['session', 'bad-run', JSON.stringify({ ...source, id: 'bad-run' })], 'Invalid Session source')
      for (const requestId of [' ', '\t\n', '\u00a0', '😀'.repeat(101), 'a\0b']) probe('invalid cancel identity ' + JSON.stringify(requestId), 'INSERT INTO run_cancel_requests VALUES(?,?,?)', [f.run.id, requestId, source.id], 'Invalid cancel request identity or Session')
      for (const value of ['null', '{}', '[1]', '[null]', JSON.stringify([f.run.enqueueCommandId])]) probe('invalid dispatch array ' + value, "UPDATE task_runs SET data=json_set(data,'$.cancelCommandIds',json(?)) WHERE id=?", [value, f.run.id], 'Invalid Run cancellation dispatch')
      for (const [key, value] of [['workerId', 'wrong'], ['command.sessionId', f.independent.id], ['command.kind', 'session.delete'], ['command.submissionCommandId', 'wrong']]) probe('cancel command mutation ' + key, `UPDATE commands SET data=json_set(data,'$.${key}',?) WHERE id=?`, [value!, f.run.cancelCommandIds[0]!], 'Invalid Run cancellation dispatch')
      probe('cancel command REPLACE', 'INSERT OR REPLACE INTO commands SELECT id,worker_id,status,json_set(data,\'$.command.kind\',\'session.delete\'),projection FROM commands WHERE id=?', [f.run.cancelCommandIds[0]!], 'Invalid Run cancellation dispatch')
      probe('cancel indexed Worker mutation', 'UPDATE commands SET worker_id=? WHERE id=?', ['wrong', f.run.cancelCommandIds[0]!], 'Invalid Run cancellation dispatch')
      for (const key of ['id', 'taskId', 'sessionId', 'requestId', 'request.requestId', 'attempt', 'status', 'enqueueCommandId', 'projectId']) probe('Run JSON identity ' + key, `UPDATE task_runs SET data=json_set(data,'$.${key}','wrong') WHERE id=?`, [f.run.id], key === 'request.requestId' ? immutable : 'Invalid Run identity or binding')
      probe('Run fingerprint mutation', "UPDATE task_runs SET data=json_set(data,'$.fingerprint','bad') WHERE id=?", [f.run.id], immutable)
      for (const session of [source, f.independent]) {
        probe('Session binding mutation ' + session.id, "UPDATE records SET data=json_set(data,'$.binding.agent.workerId','wrong') WHERE kind='session' AND id=?", [session.id], 'Session creation provenance is immutable')
        probe('Session REPLACE source ' + session.id, 'INSERT OR REPLACE INTO records(kind,id,data) VALUES(?,?,?)', ['session', session.id, JSON.stringify({ ...session, runId: 'wrong' })], 'Session creation provenance is immutable')
      }
      // A second Run may reuse the Session, but not another Run's queued cancel.
      db.exec('BEGIN')
      const other = { ...f.run, id: 'other-run', requestId: 'other', request: { ...f.run.request, requestId: 'other', mode: 'reuse', reuseSessionId: source.id }, attempt: 2, status: 'succeeded', createCommandId: null, enqueueCommandId: 'other-enqueue', cancelCommandIds: [] }
      const enqueue = db.prepare('SELECT * FROM commands WHERE id=?').get(f.run.enqueueCommandId)!
      db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run('other-enqueue', enqueue.worker_id!, enqueue.status!, enqueue.data!, enqueue.projection!)
      db.prepare('INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,create_command_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?,?)').run(other.id, other.taskId, other.requestId, other.attempt, other.status, other.sessionId, null, other.enqueueCommandId, JSON.stringify(other))
      const beforeCrossRun = snapshot(db)
      assert.throws(() => db.prepare("UPDATE task_runs SET data=json_set(data,'$.cancelCommandIds',json(?)) WHERE id=?").run(JSON.stringify(f.run.cancelCommandIds), other.id), { message: 'Invalid Run cancellation dispatch' })
      assert.deepEqual(snapshot(db), beforeCrossRun)
      db.exec('ROLLBACK')
      // Valid stop linkage, wrong turn rejection, and reverse protection.
      db.exec('BEGIN')
      const stop = { commandId: 'stop', workerId: f.worker.id, command: { kind: 'turn.stop', sessionId: source.id, turnId: 'turn' } }
      db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run('stop', f.worker.id, 'pending', JSON.stringify(stop), '{}')
      db.prepare("UPDATE task_runs SET data=json_set(data,'$.turnId','turn','$.cancelCommandIds',json(?)) WHERE id=?").run(JSON.stringify([...f.run.cancelCommandIds, 'stop']), f.run.id)
      const beforeStop = snapshot(db)
      assert.throws(() => db.prepare("UPDATE commands SET data=json_set(data,'$.command.turnId','wrong') WHERE id='stop'").run(), { message: 'Invalid Run cancellation dispatch' })
      assert.deepEqual(snapshot(db), beforeStop)
      assert.throws(() => db.prepare("UPDATE task_runs SET data=json_set(data,'$.turnId','wrong') WHERE id=?").run(f.run.id), { message: 'Invalid Run cancellation dispatch' })
      assert.deepEqual(snapshot(db), beforeStop)
      db.exec('ROLLBACK')
      assert.deepEqual(snapshot(db), baseline)
      // Deferred FK allows a new source to await its Run only inside a transaction.
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('session', 'orphan', JSON.stringify({ ...source, id: 'orphan', runId: 'missing' }))
      assert.throws(() => db.exec('COMMIT'), { message: fk })
      db.exec('ROLLBACK')
      assert.deepEqual(snapshot(db), baseline)
      // Protocol length is JS UTF-16 units, not SQLite code points.
      for (const requestId of ['x'.repeat(200), '😀'.repeat(100)]) {
        db.exec('BEGIN'); db.prepare('INSERT INTO run_cancel_requests VALUES(?,?,?)').run(f.run.id, requestId, source.id); db.exec('ROLLBACK')
        assert.deepEqual(snapshot(db), baseline)
      }
      probe('active Session tombstone UPDATE', "UPDATE records SET data=json_set(data,'$.deletedAt','deleted') WHERE kind='session' AND id=?", [source.id], 'Session has active Run')
      probe('independent source DELETE', "DELETE FROM records WHERE kind='session' AND id=?", [f.independent.id], 'Session identity and provenance are retained')
      // Positive deletion and forbidden resurrection are tested in a rolled-back transaction.
      db.exec('BEGIN IMMEDIATE')
      db.prepare("UPDATE task_runs SET status='cancelled',data=json_set(data,'$.status','cancelled') WHERE id=?").run(f.run.id)
      db.prepare("UPDATE records SET data=json_set(data,'$.deletedAt','deleted') WHERE kind='session' AND id=?").run(source.id)
      const tombstoned = snapshot(db)
      baseline = tombstoned
      for (const [name, sql] of [
        ['tombstone resurrection UPDATE', "UPDATE records SET data=json_set(data,'$.deletedAt',NULL) WHERE kind='session' AND id=?"],
        ['deleted Session late event INSERT', "INSERT INTO events VALUES(?,1,'{}')"],
      ]) {
        assert.throws(() => db.prepare(sql!).run(source.id), { message: name.startsWith('tombstone') ? 'Session tombstone is immutable' : 'Session deleted' })
        assert.deepEqual(snapshot(db), tombstoned)
        t.diagnostic(JSON.stringify({ restart, name, result: 'REJECTED', rollback: 'all tables restored' }))
      }
      assert.throws(() => db.prepare('INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?)').run('new-run', f.task.id, 'new', 2, 'pending', source.id, 'missing', '{}'), /Run Session project mismatch or deleted/)
      db.exec('ROLLBACK')
      db.close()
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Ticket06 v7 migration preserves valid JSON and rejects invalid legacy rows atomically on every retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket06-upgrade-')), path = join(dir, 'server.db')
  const f = await fixture(path)
  const source = (await f.store.resources.getSession(f.run.sessionId as SessionId))!
  f.store.close()
  const db = new DatabaseSync(path)
  try {
    // Reconstruct the immediately preceding schema, without changing domain rows.
    const oldTriggers = ['task_workspaces_project', 'run_session_scope', 'active_run_session_delete', 'session_task_scope']
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) if (!oldTriggers.includes(String(row.name))) db.exec(`DROP TRIGGER "${String(row.name)}"`)
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all()) db.exec(`DROP VIEW "${String(row.name)}"`)
    // v39/v40 的 attention 排序索引建在存活的 task_runs / channel_outbound_deliveries 上，
    // 只删 schema_migrations 版本行而不删物理索引，会让重放的 CREATE INDEX 撞名。
    // 与 task-runs.test.ts、attention-source-pages.test.ts 保持同一约定。
    db.exec('DROP INDEX IF EXISTS attention_failed_runs_order; DROP INDEX IF EXISTS attention_dead_letters_order; DROP INDEX IF EXISTS attention_human_reviews_order')
    db.exec("DROP TRIGGER IF EXISTS command_rejection_no_dispatch; DROP TABLE command_rejections; DROP TABLE project_activity; DROP TABLE review_requests; ALTER TABLE records DROP COLUMN source_run_id; DELETE FROM schema_migrations WHERE version>=8; CREATE TRIGGER session_creation_provenance BEFORE UPDATE ON records WHEN 0 BEGIN SELECT RAISE(ABORT,'unused'); END;")
    const valid = snapshot(db)
    for (const sql of [
      "UPDATE run_cancel_requests SET session_id='wrong'",
      "UPDATE run_cancel_requests SET request_id=''",
      "UPDATE task_runs SET data=json_set(data,'$.fingerprint','bad')",
      "UPDATE task_runs SET data=json_set(data,'$.cancelCommandIds',json('[\"missing\"]'))",
      "UPDATE task_runs SET data=json_set(data,'$.cancelCommandIds',json_array(json_extract(data,'$.cancelCommandIds[0]'),json_extract(data,'$.cancelCommandIds[0]')))",
      "UPDATE records SET data=json_set(data,'$.runId','missing') WHERE kind='session' AND json_extract(data,'$.runId') IS NOT NULL",
      "UPDATE records SET data=json_set(data,'$.binding.agent.workerId','wrong') WHERE kind='session' AND json_extract(data,'$.runId') IS NOT NULL",
    ]) {
      db.exec(sql)
      const invalid = snapshot(db), schema = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
      for (let retry = 0; retry < 2; retry++) {
        assert.throws(() => migrate(db), { message: 'CHECK constraint failed: legacy_run_invariant_violation' })
        assert.deepEqual(snapshot(db), invalid)
        assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), schema)
      }
      db.prepare('UPDATE run_cancel_requests SET request_id=?,session_id=?').run('cancel', source.id)
      db.prepare('UPDATE task_runs SET data=? WHERE id=?').run(JSON.stringify(f.run), f.run.id)
      db.prepare("UPDATE records SET data=? WHERE kind='session' AND id=?").run(JSON.stringify(source), source.id)
      assert.deepEqual(snapshot(db), valid)
    }
    migrate(db); migrate(db)
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT data FROM task_runs WHERE id=?').get(f.run.id)!.data)), f.run)
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT data FROM records WHERE kind='session' AND id=?").get(source.id)!.data)), source)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})

test('Ticket06 composed constructive recovery emits only first committed dispatch notifications', async () => {
  for (const recovery of ['startup', 'public'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'composed-recovery-')), path = join(dir, 'server.db')
    const f = await fixture(path, false)
    await f.store.transaction(async tx => {
      await tx.tasks.saveCancelRequest(f.run.id, 'recover', f.run.sessionId)
      await tx.tasks.saveRun({ ...f.run, status: 'cancelling', cancelRequestedAt: f.run.createdAt, cancelCommandIds: [] })
    })
    f.store.close()
    const store = new SqliteServerStore(path), signals = new Notifications(), server = new ServerService(store, signals)
    const tasks = new TaskService(store, event => signals.project(event), server), workers = new WorkerService(store, signals)
    const seen: string[] = []
    signals.onCommands(f.worker.id, () => { seen.push(`commands:${f.worker.id}`) })
    signals.onCommands('wrong' as WorkerId, () => { seen.push('wrong-worker') })
    for (const id of [f.run.sessionId, f.independent.id]) signals.onSession(id as SessionId, () => { seen.push(`session:${id}`) })
    signals.onProject(f.task.projectId, event => { assert.equal(event.taskId, f.task.id); assert.ok('runId' in event); assert.equal(event.runId, f.run.id); seen.push(`project:${event.projectId}:${event.type}`) })
    signals.onProject('wrong', () => { seen.push('wrong-project') })
    const cancel = () => tasks.cancelRun(f.task.projectId, f.task.id, f.run.id, { runId: f.run.id, sessionId: f.run.sessionId, requestId: 'recover' }, context)
    try {
      if (recovery === 'startup') await Promise.all([workers.recoverRuns(), workers.recoverRuns(), cancel()])
      else await Promise.all([cancel(), cancel(), workers.recoverRuns()])
      assert.deepEqual(seen, [`commands:${f.worker.id}`, `project:${f.task.projectId}:run.changed`])
      const recovered = (await store.tasks.run(f.run.id))!
      assert.equal(recovered.cancelCommandIds.length, 1)
      assert.ok(await store.commands.get(recovered.cancelCommandIds[0] as CommandId))
      seen.length = 0
      await Promise.all([workers.recoverRuns(), workers.recoverRuns(), cancel(), cancel()])
      assert.deepEqual(seen, [])
      assert.deepEqual(await store.tasks.run(f.run.id), recovered)
    } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
  }
})

test('Ticket06 v8 retention backfill is transactional and remains enforced after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'server-retention-')), path = join(dir, 'server.db')
  const f = await fixture(path, false); f.store.close()
  const db = new DatabaseSync(path)
  try {
    for (const name of ['cancel_request_retention', 'session_record_retention', 'session_record_identity', 'session_tombstone_update', 'session_tombstone_insert', 'deleted_session_event_insert', 'deleted_session_event_update']) db.exec(`DROP TRIGGER ${name}`)
    db.exec('DELETE FROM schema_migrations WHERE version=9')
    db.prepare("UPDATE records SET data=json_set(data,'$.deletedAt','then') WHERE kind='session' AND id=?").run(f.independent.id)
    db.prepare('INSERT INTO events VALUES(?,1,?)').run(f.independent.id, '{}')
    db.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END")
    const before = snapshot(db), schema = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
    for (let i = 0; i < 2; i++) {
      assert.throws(() => migrate(db), /injected cleanup failure/)
      assert.deepEqual(snapshot(db), before)
      assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), schema)
    }
    db.exec('DROP TRIGGER fail_cleanup')
    for (let i = 0; i < 2; i++) {
      const store = new SqliteServerStore(path); store.close()
      assert.deepEqual(db.prepare('SELECT * FROM events').all(), [])
      const retained = snapshot(db)
      for (const sql of ["UPDATE records SET data=json_set(data,'$.deletedAt',NULL) WHERE kind='session' AND id=?", "INSERT OR REPLACE INTO records(kind,id,data) SELECT kind,id,json_set(data,'$.deletedAt',NULL) FROM records WHERE kind='session' AND id=?"]) {
        assert.throws(() => db.prepare(sql).run(f.independent.id), /Session tombstone is immutable/)
        assert.deepEqual(snapshot(db), retained)
      }
      assert.throws(() => db.prepare("UPDATE records SET kind='other' WHERE kind='session' AND id=?").run(f.independent.id), /Session identity and provenance are retained/)
      assert.throws(() => db.prepare('INSERT INTO events VALUES(?,1,?)').run(f.independent.id, '{}'), /Session deleted/)
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    }
  } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})

// Real public services, HTTP validation, durable SQLite, and public subscriptions;
// no overridden notification methods or mocked Store/transaction implementations.
test('Ticket06 exact notification recipient/type/count matrix with durable restart and HTTP zero effects', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket06-notifications-')), path = join(dir, 'server.db')
  const f = await fixture(path, false)
  let store = f.store, signals = f.signals, server = f.server, tasks = f.tasks
  const sessionId = f.run.sessionId as SessionId, workerId = f.worker.id
  let workers = new WorkerService(store, signals)
  const seen: string[] = []
  const command = `commands:${workerId}`, session = `session:${sessionId}`, project = `project:${f.task.projectId}:run.changed`
  const subscribe = () => {
    signals.onCommands(workerId, () => { seen.push(command) })
    signals.onSession(sessionId, () => { seen.push(session) })
    signals.onSession(f.independent.id, () => { seen.push(`session:${f.independent.id}`) })
    signals.onCommands('unrelated-worker' as WorkerId, () => { seen.push('wrong-worker') })
    signals.onSession('unrelated-session' as SessionId, () => { seen.push('wrong-session') })
    signals.onProject(f.task.projectId, event => { seen.push(`project:${event.projectId}:${event.type}`); assert.equal(event.taskId, f.task.id) })
    signals.onProject('unrelated-project', () => { seen.push('wrong-project') })
  }
  const check = async (name: string, action: () => Promise<unknown>, expected: string[]) => {
    seen.length = 0
    await action()
    assert.deepEqual(seen, expected, name)
    t.diagnostic(JSON.stringify({ name, notifications: seen, count: seen.length }))
  }
  const input = { runId: f.run.id, sessionId, requestId: 'cancel' }
  const cancel = (requestId = input.requestId) => tasks.cancelRun(f.task.projectId, f.task.id, f.run.id, { ...input, requestId }, context)
  const ack = (id: string, rejected: boolean) => workers.receive(workerId, { type: 'ack', receipt: rejected ? { commandId: id as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'Controlled rejection', retryable: false } } : { commandId: id as CommandId, status: 'accepted' } })
  const event = (seq: number, payload: JournalEvent['payload']): JournalEvent => ({ sessionId, seq: seq as EventSeq, occurredAt: f.run.createdAt as Timestamp, payload })
  const receive = (e: JournalEvent) => workers.receive(workerId, { type: 'event', scope: 'session', event: e })
  let http: ReturnType<typeof createServer> | undefined
  try {
    subscribe()
    await check('cancel accepted + concurrent idempotent replay', () => Promise.all([cancel(), cancel()]), [command, project])
    const target = (await store.tasks.run(f.run.id))!.cancelCommandIds[0]!
    // Ticket07 adds one committed project invalidation; Session/command recipients stay unchanged.
    await check('cancel rejected receipt', () => ack(target, true), [project, session, command])
    await check('duplicate rejected receipt', () => ack(target, true), [])
    await check('same request after rejection', () => cancel(), [])
    await check('explicit retry accepted + concurrent replay', () => Promise.all([cancel('retry'), cancel('retry')]), [command, project])
    const retryTarget = (await store.tasks.run(f.run.id))!.cancelCommandIds.at(-1)!
    await check('Worker accepted retry', () => ack(retryTarget, false), [command])
    await check('duplicate Worker accepted retry', () => ack(retryTarget, false), [])
    await check('initial message queued Journal', () => receive(event(1, { kind: 'message.queued', commandId: f.run.enqueueCommandId as CommandId, messageId: 'initial' as MessageId, content: 'Evidence', position: 0 })), [project, session, command])
    const terminal = event(2, { kind: 'message.cancelled', commandId: f.run.enqueueCommandId as CommandId, messageId: 'initial' as MessageId })
    await check('terminal cancelled Journal', () => receive(terminal), [project, session, command])
    assert.equal((await store.tasks.run(f.run.id))!.status, 'cancelled')
    await check('terminal idempotent HTTP-equivalent service replay', () => cancel('retry'), [])
    const finished = await store.tasks.activity(f.task.id, 0)
    await check('duplicate terminal Journal', () => receive(terminal), [])
    await check('duplicate terminal Journal batch', () => workers.receive(workerId, { type: 'sync', kind: 'batch', sessionId, events: [terminal], throughSeq: terminal.seq, hasMore: false }), [])
    await check('late conflicting rejected receipt after terminal rolls back', () => assert.rejects(ack(retryTarget, true), /Conflicting receipt/), [])
    const third = event(4, { kind: 'session.runtime.changed', state: 'idle', reason: null })
    const second = event(3, { kind: 'session.runtime.changed', state: 'idle', reason: null })
    await check('out-of-order event opens gap', () => receive(third), [session, command])
    await check('late event closes gap', () => receive(second), [project, session, command])
    assert.deepEqual(await store.tasks.activity(f.task.id, 0), finished)
    assert.equal(finished.filter(a => a.type === 'run.finished').length, 1)
    const beforeRestart = (await store.tasks.run(f.run.id))!
    store.close(); store = new SqliteServerStore(path)
    signals = new Notifications(); server = new ServerService(store, signals)
    tasks = new TaskService(store, event => signals.project(event), server); workers = new WorkerService(store, signals); subscribe()
    await check('restart reconciliation twice', async () => { await workers.recoverRuns(); await workers.recoverRuns() }, [])
    await check('restart terminal request replay', () => cancel('retry'), [])
    assert.deepEqual(await store.tasks.run(f.run.id), beforeRestart)
    assert.deepEqual(await store.tasks.activity(f.task.id, 0), finished)
    // All HTTP negatives snapshot every durable table, and observe every channel.
    http = createServer(httpHandler({ service: server, auth: new AuthenticationService(store, administratorDirectory(store)), streams: new SessionStreams(server), tasks }))
    http.listen(0, '127.0.0.1'); await once(http, 'listening')
    const address = http.address(); assert.ok(address && typeof address !== 'string'); assert.notEqual(address.port, 8004)
    const route = `/api/projects/${f.task.projectId}/tasks/${f.task.id}/runs/${f.run.id}/cancel`
    const observer = new DatabaseSync(path)
    try {
      for (const [name, url, body, status] of [
        ['malformed JSON', route, '{', 400], ['extra field', route, JSON.stringify({ ...input, extra: true }), 400],
        ['NUL cancel', route, JSON.stringify({ ...input, requestId: 'a\0b' }), 400],
        ['NUL launch', route.replace(`/runs/${f.run.id}/cancel`, '/launch'), JSON.stringify({ ...f.run.request, requestId: 'a\0b' }), 400],
        ['wrong Session', route, JSON.stringify({ ...input, sessionId: f.independent.id }), 400],
        ['wrong Run', route, JSON.stringify({ ...input, runId: 'wrong' }), 400],
        ['wrong project', route.replace(f.task.projectId, 'wrong-project'), JSON.stringify(input), 404],
        ['wrong Task', route.replace(f.task.id, 'wrong-task'), JSON.stringify(input), 404],
      ] as const) {
        const before = snapshot(observer)
        await check('HTTP ' + name, async () => {
          const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { method: 'POST', headers: { authorization: `Bearer ${administratorToken}`, 'content-type': 'application/json' }, body })
          assert.equal(response.status, status)
          if (name.startsWith('NUL')) assert.deepEqual(await response.json(), { error: { code: 'invalid_request', message: name === 'NUL cancel' ? 'Cancel requires matching runId/sessionId and requestId' : 'Invalid launch request' } })
        }, [])
        assert.deepEqual(snapshot(observer), before)
      }
    } finally { observer.close() }
    await check('wrong Worker Session scope', () => assert.rejects(workers.receive('missing-worker' as WorkerId, { type: 'event', scope: 'session', event: terminal })), [])
    await check('settle initial enqueue', () => ack(f.run.enqueueCommandId, false), [command])
    await check('Worker hello after restart', () => workers.connected(workerId, { name: 'Evidence worker', workerVersion: 'test', platform: 'linux' }), [])
    await check('fresh live head after restart', () => workers.receive(workerId, { type: 'sync', kind: 'heads', complete: true, heads: [{ sessionId, lastSeq: 4 as EventSeq }] }), [session, command])
    await check('delete Session', () => server.delete('sessions', sessionId), [session, command])
    await check('delete replay rejected', () => assert.rejects(server.delete('sessions', sessionId)), [])
    const deletedRun = await store.tasks.run(f.run.id), deletedActivities = await store.tasks.activity(f.task.id, 0)
    store.close(); store = new SqliteServerStore(path)
    signals = new Notifications(); server = new ServerService(store, signals); workers = new WorkerService(store, signals); subscribe()
    await check('deleted restart reconciliation', () => workers.recoverRuns(), [])
    await check('deleted late/out-of-order events', async () => { await receive(third); await receive(terminal); await receive(second) }, [])
    await check('deleted late head', () => workers.receive(workerId, { type: 'sync', kind: 'heads', complete: true, heads: [{ sessionId, lastSeq: 10 as EventSeq }] }), [])
    assert.deepEqual(await store.tasks.run(f.run.id), deletedRun)
    assert.deepEqual(await store.tasks.activity(f.task.id, 0), deletedActivities)
    assert.deepEqual((await store.cache.readEvents(sessionId, 1 as EventSeq, 100)).events, [])
    assert.ok((await store.resources.getSession(sessionId))!.deletedAt)
  } finally {
    if (http) { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve())) }
    store.close(); await rm(dir, { recursive: true, force: true })
  }
})
