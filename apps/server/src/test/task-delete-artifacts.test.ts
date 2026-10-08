import test from 'node:test'
import assert from 'node:assert/strict'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, administratorToken, seedAdministrator } from './fixtures/administrator.ts'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import { SqliteArtifactRepository } from '../storage/sqlite/artifact-repository.ts'
import type { Artifact } from '@wemux/server-domain'

// Deliberately synthetic preexisting historical rows: no model execution, cannot be successful-delete fixtures.
test('Session/Run history blocks deletion; artifact mutation serialized and tombstone mutation refused', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] }), origin = await app.listen(0)
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const task = (await call('/projects/default-project/tasks', { title: 'Historical' })).data
    const path = `/projects/default-project/tasks/${task.id}`
    const enrollment = (await call('/enrollment-tokens', {})).data
    const worker = (await call('/workers/enroll', { token: enrollment.token, name: 'Historical fixture' })).data
    const workspace = (await call('/workspaces', { projectId: task.projectId, name: 'History', workerId: worker.workerId })).data.workspace
    const sessionId = 'historical-session', runId = 'historical-run', at = new Date().toISOString()
    await app.store.transaction(async tx => {
      await tx.resources.saveSession({ id: sessionId, projectId: task.projectId, ownerId: 'deployer-user', workspaceId: workspace.id, title: 'History', taskId: task.id, runId: null, shareScope: 'project', storageMode: 'local', archivedAt: null, deletedAt: null, runtimeState: 'idle', binding: { workspaceId: workspace.id, agent: { workerId: worker.workerId, agentKey: 'test' }, modelId: 'test' } } as never)
      await tx.commands.insertPending({ commandId: 'historical-command' as never, workerId: worker.workerId, command: { kind: 'session.enqueue', sessionId: sessionId as never, message: { messageId: 'historic-message' as never, content: 'historic' } }, payloadFingerprint: 'historic', createdAt: at as never })
      await tx.tasks.saveRun({ id: runId, taskId: task.id, projectId: task.projectId, requestId: 'historical', attempt: 1, sessionId, snapshot: { workspaceId: workspace.id, workerId: worker.workerId, agentKey: 'test', modelId: 'test' }, status: 'succeeded', request: { requestId: 'historical', mode: 'reuse', reuseSessionId: sessionId, prompt: 'historical', assignment: { workspaceId: workspace.id, workerId: worker.workerId, agentKey: 'test', modelId: 'test' } }, fingerprint: 'a'.repeat(64), createdAt: at, startedAt: at, finishedAt: at, cancelRequestedAt: null, createCommandId: null, enqueueCommandId: 'historical-command', messageId: null, turnId: null, cancelCommandIds: [], failure: null, resultSummary: 'historical', lastProjectedSeq: 0 } as never)
    })
    const artifact = { artifactId: 'retained-artifact', runId, relativePath: 'result.txt', mimeType: 'text/plain', size: 1, requestId: 'register' }
    const registered = await call(`${path}/artifacts`, artifact); assert.equal(registered.status, 201)
    const before = (await call(`${path}/activity`)).data
    assert.equal((await call(path, { version: task.version, requestId: 'delete' }, 'DELETE')).data.error.code, 'task_has_sessions')
    assert.equal((await call(`${path}/artifacts`)).data.items.length, 1)
    assert.deepEqual((await call(`${path}/activity`)).data, before)
    assert.equal((await call(`/sessions/${sessionId}`)).status, 200)
    // Missing Session rows are impossible through normal retained storage; simulate an incomplete
    // reader to ensure retained Run.sessionId independently blocks deletion.
    const transaction = app.store.transaction.bind(app.store)
    app.store.transaction = work => transaction(tx => work({ ...tx, resources: { ...tx.resources, listSessions: async () => [] } }))
    assert.equal((await call(path, { version: 1, requestId: 'delete-missing' }, 'DELETE')).data.error.code, 'task_has_sessions')
    app.store.transaction = transaction
    // Explicit corrupt/preexisting tombstone fixture: impossible via successful current DELETE.
    await app.store.transaction(async tx => { const value = (await tx.tasks.get(task.id))!; await tx.tasks.save({ ...value, deletedAt: at, deletedBy: 'deployer-user', version: value.version + 1 }) })
    assert.equal((await call(`${path}/artifacts`, { ...artifact, artifactId: 'no-new', requestId: 'no-new' })).status, 410)
    assert.equal((await call('/artifacts/retained-artifact/review', { decision: 'approved', expectedRevision: 1, requestId: 'no-review' })).status, 410)
    assert.equal((await call(`${path}/artifacts`)).data.items[0].revision, 1)
    // This tombstone is synthetic, not a successful history-bearing DELETE. It exposes the
    // current read gap: direct Session and Run history survive, Task-scoped Session listing does not.
    assert.equal((await call(`${path}/sessions`)).status, 410)
    assert.equal((await call(`${path}/runs`)).data.items[0].id, runId)
    assert.equal((await call(`/sessions/${sessionId}/messages`, { content: 'blocked' })).status, 410)
    for (const [suffix, body] of [['fs/write', { subpath: 'file', base64Content: 'eA==' }], ['terminal', { cols: 80, rows: 24 }]] as const) {
      const refused = await call(`/sessions/${sessionId}/${suffix}`, body)
      assert.equal(refused.status, 403)
      assert.equal(refused.data.error.code, 'write_channel_closed')
    }
    assert.equal((await call(`/sessions/${sessionId}`)).status, 200)
  } finally { await app.close() }
})

test('artifact repository joins ServerStore shared transaction: rollback and FIFO serialization', async () => {
  const database = new SharedSqliteDatabase(':memory:'), store = new SqliteServerStore(database), artifacts = new SqliteArtifactRepository(database)
  // Repository-only fixture intentionally has no Run/Session rows; this test proves transaction mechanics, not reachable Task deletion.
  database.connection.exec('PRAGMA foreign_keys=OFF')
  const artifact = { id: 'a', projectId: 'p', taskId: 't', runId: 'r', sessionId: 's', workspaceId: 'w', workerId: 'n', relativePath: 'f', mimeType: 'text/plain', size: 1, source: 'manual', reviewState: 'pending', revision: 1, createdBy: 'u', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' } as Artifact
  try {
    await assert.rejects(store.transaction(async () => { await artifacts.create(artifact, 'rollback', JSON.stringify(artifact), artifact.createdAt); throw Error('rollback') }), /rollback/)
    assert.equal(await artifacts.get('a'), null)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), start = new Promise<void>(resolve => { entered = resolve })
    const first = store.transaction(async () => { await artifacts.create(artifact, 'create', JSON.stringify(artifact), artifact.createdAt); entered(); await gate })
    await start
    let secondFinished = false
    const second = store.transaction(async () => { await artifacts.review('a', 'approved', 1, 'review', artifact.createdAt); secondFinished = true })
    await new Promise(resolve => setImmediate(resolve)); assert.equal(secondFinished, false)
    release(); await first; await second
    assert.equal((await artifacts.get('a'))!.revision, 2)
    await assert.rejects(store.transaction(async () => { await artifacts.review('a', 'changes_requested', 2, 'rollback-review', artifact.createdAt); throw Error('rollback') }), /rollback/)
    assert.equal((await artifacts.get('a'))!.revision, 2)
  } finally { artifacts.close(); store.close(); database.close() }
})
