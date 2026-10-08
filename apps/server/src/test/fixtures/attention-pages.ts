import type { DatabaseSync } from 'node:sqlite'

/** Real persisted source rows, with Commands inserted first to avoid unrelated trigger rescans. */
export function seedAttentionPages(db: DatabaseSync, actorId: string, otherActorId: string) {
  const recent = '2026-04-03T00:00:00.000Z'
  const older = '2026-04-02T00:00:00.000Z'
  const assignment = { workspaceId: 'workspace', workerId: 'worker', agentKey: 'pi', modelId: 'model' }
  for (const projectId of ['visible', 'hidden', 'other']) {
    db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('session', projectId, JSON.stringify({ id: projectId, projectId, ownerId: actorId, shareScope: 'project', binding: { workspaceId: 'workspace', agent: { workerId: 'worker', agentKey: 'pi' }, modelId: 'model' } }))
    db.prepare('INSERT INTO tasks(id,project_id,data) VALUES(?,?,?)').run(projectId, projectId, JSON.stringify({ id: projectId, projectId, title: projectId, status: 'in_progress' }))
  }
  const rows: { id: string; projectId: string; creator: string; timestamp: string }[] = []
  for (let i = 0; i < 110; i++) {
    const suffix = String(i).padStart(3, '0')
    rows.push({ id: `run-${suffix}`, projectId: 'visible', creator: actorId, timestamp: older })
    rows.push({ id: `hidden-${suffix}`, projectId: 'hidden', creator: actorId, timestamp: recent })
    rows.push({ id: `other-${suffix}`, projectId: 'visible', creator: otherActorId, timestamp: recent })
    rows.push({ id: `project-other-${suffix}`, projectId: 'other', creator: actorId, timestamp: recent })
  }
  for (const row of rows) {
    db.prepare('INSERT INTO commands(id,worker_id,status,data,projection) VALUES(?,?,?,?,?)').run(row.id, 'worker', 'pending', JSON.stringify({ command: { kind: 'session.enqueue', sessionId: row.projectId, message: { sentByAccountId: row.creator } } }), '{}')
  }
  let attempt = 0
  for (const row of rows) {
    const data = { id: row.id, taskId: row.projectId, projectId: row.projectId, sessionId: row.projectId, requestId: row.id, attempt: ++attempt, status: 'failed', createCommandId: null, enqueueCommandId: row.id, fingerprint: 'a'.repeat(64), request: { requestId: row.id, mode: 'reuse', reuseSessionId: row.projectId, prompt: 'test', assignment }, snapshot: assignment, cancelCommandIds: [], createdAt: older, finishedAt: row.timestamp }
    db.prepare('INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,create_command_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, row.projectId, row.id, attempt, 'failed', row.projectId, null, row.id, JSON.stringify(data))
    db.prepare(`INSERT INTO channel_outbound_deliveries(id,channel_id,binding_id,project_id,session_id,journal_identity,status,attempt,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, 'channel', 'binding', row.projectId, row.projectId, row.id, 'dead_letter', 4, older, row.timestamp, JSON.stringify({ title: row.id, lastError: 'delivery failed' }))
  }
}
