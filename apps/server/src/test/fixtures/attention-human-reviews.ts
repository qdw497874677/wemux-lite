import type { DatabaseSync } from 'node:sqlite'

export const reviewRequestedAt = '2026-04-03T00:00:00.000Z'

/** Real rows with production constraints/triggers enabled; a private Session is not an approval source. */
export function seedAttentionHumanReview(db: DatabaseSync, id: string, projectId: string, submitter = 'submitter', requestedAt = reviewRequestedAt) {
  const taskId = `task-${id}`, runId = `run-${id}`, sessionId = `session-${id}`
  const assignment = { workspaceId: 'workspace', workerId: 'worker', agentKey: 'pi', modelId: 'model' }
  const task = { id: taskId, projectId, title: `人工审查 ${id}`, description: '', acceptanceCriteria: '', links: [], blockedFrom: null, cancelledFrom: null, priority: 'medium', status: 'in_review', version: 1, currentReviewId: id, assignee: assignment, activeRun: null, lastRun: null, metadataJson: { schemaVersion: 1, values: { reviewPolicy: 'human', reviewPolicyFrozen: true } }, createdAt: reviewRequestedAt, updatedAt: reviewRequestedAt, lastActivityAt: reviewRequestedAt, deletedAt: null }
  db.prepare('INSERT INTO tasks(id,project_id,data) VALUES(?,?,?)').run(taskId, projectId, JSON.stringify(task))
  db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run('session', sessionId, JSON.stringify({ id: sessionId, projectId, ownerId: submitter, shareScope: 'owner-only', binding: { workspaceId: 'workspace', agent: { workerId: 'worker', agentKey: 'pi' }, modelId: 'model' } }))
  db.prepare('INSERT INTO commands(id,worker_id,status,data,projection) VALUES(?,?,?,?,?)').run(runId, 'worker', 'pending', JSON.stringify({ command: { kind: 'session.enqueue', sessionId, message: { sentByAccountId: submitter } } }), '{}')
  const run = { id: runId, taskId, projectId, sessionId, requestId: runId, attempt: 1, status: 'succeeded', createCommandId: null, enqueueCommandId: runId, fingerprint: 'a'.repeat(64), request: { requestId: runId, mode: 'reuse', reuseSessionId: sessionId, prompt: 'test', assignment }, snapshot: assignment, cancelCommandIds: [], createdAt: reviewRequestedAt, finishedAt: reviewRequestedAt }
  db.prepare('INSERT INTO task_runs(id,task_id,request_id,attempt,status,session_id,create_command_id,enqueue_command_id,data) VALUES(?,?,?,?,?,?,?,?,?)').run(runId, taskId, runId, 1, 'succeeded', sessionId, null, runId, JSON.stringify(run))
  const review = { id, taskId, taskRunId: runId, projectId, actor: submitter, status: 'requested', requestedAt, reviewer: null, decidedAt: null, closedAt: null }
  db.prepare('INSERT INTO review_requests(id,run_id,task_id,project_id,status,data) VALUES(?,?,?,?,?,?)').run(id, runId, taskId, projectId, 'requested', JSON.stringify(review))
  return { task, run, review }
}
