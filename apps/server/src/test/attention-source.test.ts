import assert from 'node:assert/strict'
import test from 'node:test'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.ts'
import { SqliteAttentionSource } from '../storage/sqlite/attention-source.ts'

test('attention source queries the real migrated schema, including an empty instance', async () => {
  const database = new SharedSqliteDatabase(':memory:')
  const source = new SqliteAttentionSource(database)
  try {
    assert.deepEqual(await source.listTasks(), [])
    assert.deepEqual(await source.listRuns(), [])
    assert.deepEqual(await source.listDeadLetters(), [])
  } finally { database.close() }
})

test('attention reads JSON task titles and failed Run submitters without inventing human assignments', async () => {
  const database = new SharedSqliteDatabase(':memory:')
  const source = new SqliteAttentionSource(database)
  const db = database.connection
  try {
    const assignment = { workspaceId: 'workspace', workerId: 'worker', agentKey: 'pi', modelId: 'model' }
    db.prepare('INSERT INTO tasks(id,project_id,data) VALUES(?,?,?)').run('task', 'project', JSON.stringify({ id: 'task', projectId: 'project', title: '真实任务', status: 'in_progress', assignee: assignment, metadataJson: { schemaVersion: 1, values: {} }, updatedAt: '2026-01-01' }))
    db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('session', 'session', JSON.stringify({ id: 'session', projectId: 'project', ownerId: 'not-the-submitter', binding: { workspaceId: 'workspace', agent: { workerId: 'worker', agentKey: 'pi' }, modelId: 'model' } }))
    db.prepare('INSERT INTO commands(id,worker_id,status,data,projection) VALUES(?,?,?,?,?)').run('enqueue', 'worker', 'pending', JSON.stringify({ command: { kind: 'session.enqueue', sessionId: 'session', message: { sentByAccountId: 'submitter' } } }), '{}')
    const run = { id: 'run', taskId: 'task', projectId: 'project', sessionId: 'session', requestId: 'request', attempt: 1, status: 'failed', createCommandId: null, enqueueCommandId: 'enqueue', fingerprint: 'a'.repeat(64), request: { requestId: 'request', mode: 'reuse', reuseSessionId: 'session', prompt: 'hello', assignment }, snapshot: assignment, cancelCommandIds: [], createdAt: '2026-01-01', finishedAt: '2026-01-02' }
    db.prepare('INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,create_command_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?,?)').run('run', 'task', 'request', 1, 'failed', 'session', null, 'enqueue', JSON.stringify(run))
    assert.deepEqual(await source.listTasks(), [{ taskId: 'task', projectId: 'project', title: '真实任务', status: 'in_progress', assigneeUserIds: [] }])
    assert.deepEqual(await source.listRuns(), [{ runId: 'run', taskId: 'task', projectId: 'project', title: '真实任务', status: 'failed', createdBy: 'submitter' }])
    db.prepare('UPDATE commands SET data=? WHERE id=?').run(JSON.stringify({ command: { kind: 'session.enqueue', message: {} } }), 'enqueue')
    assert.equal((await source.listRuns())[0]?.createdBy, null, 'legacy records must not attribute the Run to the Session owner')
  } finally { database.close() }
})
