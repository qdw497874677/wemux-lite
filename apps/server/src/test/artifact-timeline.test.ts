import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Artifact } from '@wemux/server-domain'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../storage/sqlite/migrations.ts'
import { SqliteArtifactRepository } from '../storage/sqlite/artifact-repository.ts'

const artifact: Artifact = { id: 'artifact-timeline', projectId: 'project-1' as never, taskId: 'task-1', runId: 'run-1', sessionId: 'session-1' as never, workspaceId: 'workspace-1' as never, workerId: 'worker-1' as never, relativePath: 'out/result.txt', mimeType: 'text/plain', size: 2, source: 'manual', reviewState: 'pending', revision: 1, createdBy: 'user-1' as never, createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z' }

test('artifact register and review append task timeline activity without changing task status', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wemux-artifact-timeline-')), file = path.join(dir, 'server.sqlite')
  try {
    const db = new DatabaseSync(file); migrate(db); db.close()
    const fixtureDb = new DatabaseSync(file); fixtureDb.exec('PRAGMA foreign_keys = OFF')
    fixtureDb.prepare("INSERT INTO tasks(id,project_id,data) VALUES(?,?,?)").run('task-1', 'project-1', JSON.stringify({ id: 'task-1', projectId: 'project-1', title: 'Task', status: 'in_review', priority: 'none', version: 1, metadataJson: { schemaVersion: 1 }, createdAt: artifact.createdAt, updatedAt: artifact.createdAt }))
    fixtureDb.close()
    const repository = new SqliteArtifactRepository(file)
    await repository.create(artifact, 'create-timeline', JSON.stringify(artifact), artifact.createdAt)
    await repository.review(artifact.id, 'approved', 1, 'review-timeline', '2026-04-01T01:00:00.000Z')
    repository.close()
    const verify = new DatabaseSync(file)
    const activity = verify.prepare("SELECT json_extract(data,'$.type') AS type FROM task_activity WHERE task_id='task-1' ORDER BY seq").all() as { type: string }[]
    assert.deepEqual(activity.map(row => row.type), ['artifact.registered', 'artifact.reviewed'])
    const artifactTimeline = verify.prepare("SELECT json_extract(data,'$.type') AS type FROM task_activity WHERE task_id='task-1' AND json_extract(data,'$.type') LIKE 'artifact.%' ORDER BY seq").all() as { type: string }[]
    assert.deepEqual(artifactTimeline.map(row => ({ sourceKind: 'artifact', event: row.type })), [
      { sourceKind: 'artifact', event: 'artifact.registered' },
      { sourceKind: 'artifact', event: 'artifact.reviewed' },
    ])
    assert.equal((JSON.parse((verify.prepare("SELECT data FROM tasks WHERE id='task-1'").get() as { data: string }).data) as { status: string }).status, 'in_review')
    verify.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
