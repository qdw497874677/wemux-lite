import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { Artifact } from '@wemux/server-domain'
import { SqliteArtifactRepository } from '../storage/sqlite/artifact-repository.ts'

const artifact: Artifact = { id: 'artifact-1', projectId: 'project-1' as never, taskId: 'task-1', runId: 'run-1', sessionId: 'session-1' as never, workspaceId: 'workspace-1' as never, workerId: 'worker-1' as never, relativePath: 'reports/result.md', mimeType: 'text/markdown', size: 12, source: 'manual', reviewState: 'pending', revision: 1, createdBy: 'user-1' as never, createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z' }

async function fixture() { const dir = await mkdtemp(path.join(os.tmpdir(), 'wemux-artifact-')); const file = path.join(dir, 'server.sqlite'); return { dir, file } }

test('artifact create and review are idempotent and persist across reopen', async () => {
  const { dir, file } = await fixture()
  try {
    const first = new SqliteArtifactRepository(file)
    assert.equal((await first.create(artifact, 'request-create', JSON.stringify(artifact), artifact.createdAt)).id, artifact.id)
    assert.equal((await first.create(artifact, 'request-create', JSON.stringify(artifact), artifact.createdAt)).id, artifact.id)
    const reviewed = await first.review(artifact.id, 'approved', 1, 'request-review', '2026-04-01T01:00:00.000Z')
    assert.equal(reviewed.reviewState, 'approved')
    assert.equal((await first.review(artifact.id, 'approved', 1, 'request-review', '2026-04-01T01:00:00.000Z')).revision, 2)
    first.close()
    const raw = new DatabaseSync(file)
    raw.prepare("UPDATE artifact_requests SET created_at='2026-03-01T00:00:00.000Z'").run()
    raw.close()
    const reopened = new SqliteArtifactRepository(file)
    assert.equal((await reopened.get(artifact.id))?.reviewState, 'approved')
    await reopened.review(artifact.id, 'changes_requested', 2, 'request-cleanup', '2026-04-02T01:00:00.000Z')
    const verify = new DatabaseSync(file)
    assert.equal((verify.prepare('SELECT COUNT(*) AS count FROM artifact_requests').get() as { count: number }).count, 1)
    verify.close()
    reopened.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('artifact review enforces CAS and request id payload consistency', async () => {
  const { dir, file } = await fixture()
  try {
    const repository = new SqliteArtifactRepository(file)
    await repository.create(artifact, 'request-create', JSON.stringify(artifact), artifact.createdAt)
    await assert.rejects(() => repository.review(artifact.id, 'approved', 0, 'request-stale', artifact.updatedAt), /Revision conflict/)
    await repository.review(artifact.id, 'approved', 1, 'request-review', artifact.updatedAt)
    await assert.rejects(() => repository.review(artifact.id, 'changes_requested', 1, 'request-review', artifact.updatedAt), /Idempotency conflict/)
    repository.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
