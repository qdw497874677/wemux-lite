import assert from 'node:assert/strict'
import test from 'node:test'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.ts'
import { migrate, migrationCount, teamCoordinationSourceVersion } from '../storage/sqlite/migrations.ts'
import { runInvariants } from '../storage/sqlite/run-invariants.ts'

const teamId = 'team-a', ownerId = 'owner-a', workerId = 'worker-a', agentKey = 'test'
const taskId = 'coordination:source-test', projectId = 'project-a', sessionId = 'session-a'
const session = { id: sessionId, taskId, runId: null, projectId, ownerId,
  binding: { workspaceId: 'workspace-a', agent: { workerId, agentKey }, modelId: 'model-a' }, deletedAt: null }

function fixture(withTeamSession = true) {
  const database = new SharedSqliteDatabase(':memory:')
  const db = database.connection
  db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('project', projectId, JSON.stringify({ id: projectId, teamId }))
  db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('project', 'project-other-team', JSON.stringify({ id: 'project-other-team', teamId: 'team-b' }))
  db.prepare('INSERT INTO tasks(id,project_id,data) VALUES(?,?,?)').run(taskId, `team:${teamId}`, JSON.stringify({
    id: taskId, projectId: `team:${teamId}`, title: 'Team conversation', status: 'in_progress',
    metadataJson: { schemaVersion: 1, values: {} }, teamCoordination: { teamId, ownerId, workerId, agentKey },
  }))
  if (withTeamSession) db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('session', sessionId, JSON.stringify(session))
  return { database, db }
}

test('Team coordination source migration upgrades an existing database and replays without changing source', () => {
  const { database, db } = fixture(false)
  try {
    // An existing Project Task/Session was valid before Team coordination. Restore
    // the exact old source view before applying only the final upgrade migration.
    const ordinaryTask = { id: 'ordinary-task', projectId, title: 'Existing conversation', status: 'in_progress', metadataJson: { schemaVersion: 1, values: {} } }
    const ordinarySession = { ...session, id: 'ordinary-session', taskId: ordinaryTask.id }
    db.prepare('INSERT INTO tasks(id,project_id,data) VALUES(?,?,?)').run(ordinaryTask.id, projectId, JSON.stringify(ordinaryTask))
    db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('session', ordinarySession.id, JSON.stringify(ordinarySession))
    const before = db.prepare("SELECT data FROM records WHERE kind='session' AND id=?").get(ordinarySession.id)?.data
    db.exec('DROP TRIGGER session_task_scope; DROP VIEW invalid_session_source;')
    const view = runInvariants.split('CREATE VIEW invalid_session_source AS ')[1]?.split(';\nCREATE TABLE run_invariant_preflight')[0]
    assert.ok(view, 'previous migration source view must be present')
    db.exec(`CREATE VIEW invalid_session_source AS ${view};`)
    db.exec(`CREATE TRIGGER session_task_scope BEFORE UPDATE ON records WHEN NEW.kind='session' AND json_extract(NEW.data,'$.taskId') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE id=json_extract(NEW.data,'$.taskId') AND project_id=json_extract(NEW.data,'$.projectId'))
      BEGIN SELECT RAISE(ABORT,'Session Task project mismatch'); END;`)
    // 只回退本迁移的版本行，避免把「最后一条迁移」与它绑死。
    db.prepare('DELETE FROM schema_migrations WHERE version=?').run(teamCoordinationSourceVersion)
    migrate(db)
    migrate(db)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count, migrationCount)
    assert.equal(db.prepare("SELECT data FROM records WHERE kind='session' AND id=?").get(ordinarySession.id)?.data, before)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM invalid_session_source').get()?.count, 0)
    db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('session', sessionId, JSON.stringify(session))
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM invalid_session_source').get()?.count, 0)
    assert.equal(db.prepare("SELECT data FROM records WHERE kind='session' AND id=?").get(sessionId)?.data, JSON.stringify(session))
  } finally { database.close() }
})

test('Team source exception rejects mismatched owner, Worker, Agent, Team Project and Run source', () => {
  const { database, db } = fixture()
  try {
    const overwrite = (patch: object) => db.prepare("UPDATE records SET data=? WHERE kind='session' AND id=?")
      .run(JSON.stringify({ ...session, ...patch }), sessionId)
    for (const patch of [
      { ownerId: 'another-owner' },
      { binding: { ...session.binding, agent: { ...session.binding.agent, workerId: 'another-worker' } } },
      { binding: { ...session.binding, agent: { ...session.binding.agent, agentKey: 'another-agent' } } },
      { projectId: 'project-other-team' },
      { runId: 'run-not-permitted' },
    ]) {
      assert.throws(() => overwrite(patch), /Session Task project mismatch|Invalid Session source|FOREIGN KEY constraint failed/)
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM invalid_session_source').get()?.count, 0)
    }
    assert.equal(db.prepare("SELECT json_extract(data,'$.ownerId') AS ownerId FROM records WHERE kind='session' AND id=?").get(sessionId)?.ownerId, ownerId)
  } finally { database.close() }
})
