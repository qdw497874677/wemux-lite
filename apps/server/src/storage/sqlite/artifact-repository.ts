import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrations.ts'
import type { Artifact, ArtifactReviewState } from '@wemux/server-domain'
import type { ArtifactRepository } from '../../application/ports/artifact-repository.ts'

function rowToArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: String(row.id), projectId: String(row.project_id) as Artifact['projectId'], taskId: String(row.task_id) as Artifact['taskId'],
    runId: String(row.run_id) as Artifact['runId'], sessionId: String(row.session_id) as Artifact['sessionId'], workspaceId: String(row.workspace_id) as Artifact['workspaceId'],
    workerId: String(row.worker_id) as Artifact['workerId'], relativePath: String(row.relative_path), mimeType: String(row.mime_type), size: Number(row.size),
    source: 'manual', reviewState: String(row.review_state) as ArtifactReviewState, revision: Number(row.revision), createdBy: String(row.created_by) as Artifact['createdBy'],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class SqliteArtifactRepository implements ArtifactRepository {
  readonly #db: DatabaseSync
  constructor(databasePath: string) { this.#db = new DatabaseSync(databasePath); migrate(this.#db); this.#db.exec('PRAGMA foreign_keys = OFF') }
  close(): void { this.#db.close() }

  async create(artifact: Artifact, requestId: string, responseBody: string, now: string): Promise<Artifact> {
    const requestHash = hash(artifact)
    const previous = this.#db.prepare('SELECT request_hash,response_json FROM artifact_requests WHERE request_id=?').get(requestId) as Record<string, unknown> | undefined
    if (previous) {
      if (previous.request_hash !== requestHash) throw new Error('Idempotency conflict')
      return JSON.parse(String(previous.response_json)) as Artifact
    }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`INSERT INTO artifacts(id,project_id,task_id,run_id,session_id,workspace_id,worker_id,relative_path,mime_type,size,source,review_state,revision,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(artifact.id, artifact.projectId, artifact.taskId, artifact.runId, artifact.sessionId, artifact.workspaceId, artifact.workerId, artifact.relativePath, artifact.mimeType, artifact.size, artifact.source, artifact.reviewState, artifact.revision, artifact.createdBy, artifact.createdAt, artifact.updatedAt)
      this.#db.prepare('INSERT INTO artifact_requests(request_id,operation,artifact_id,request_hash,response_json,created_at) VALUES(?,?,?,?,?,?)').run(requestId, 'create', artifact.id, requestHash, responseBody, now)
      this.#db.prepare("DELETE FROM artifact_requests WHERE created_at < datetime(?, '-24 hours')").run(now)
      this.#db.exec('COMMIT')
      return artifact
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }

  async get(id: string): Promise<Artifact | null> { const row = this.#db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Record<string, unknown> | undefined; return row ? rowToArtifact(row) : null }
  async listByTask(taskId: string): Promise<readonly Artifact[]> { return (this.#db.prepare('SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at DESC').all(taskId) as Record<string, unknown>[]).map(rowToArtifact) }

  async review(id: string, decision: Exclude<ArtifactReviewState, 'pending'>, expectedRevision: number, requestId: string, now: string): Promise<Artifact> {
    const requestHash = hash({ id, decision, expectedRevision })
    const previous = this.#db.prepare('SELECT request_hash,response_json FROM artifact_requests WHERE request_id=?').get(requestId) as Record<string, unknown> | undefined
    if (previous) { if (previous.request_hash !== requestHash) throw new Error('Idempotency conflict'); return JSON.parse(String(previous.response_json)) as Artifact }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.#db.prepare('UPDATE artifacts SET review_state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(decision, now, id, expectedRevision)
      if (Number(changed.changes) === 0) { const exists = this.#db.prepare('SELECT 1 FROM artifacts WHERE id=?').get(id); throw new Error(exists ? 'Revision conflict' : 'Artifact not found') }
      const artifact = rowToArtifact(this.#db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Record<string, unknown>)
      this.#db.prepare('INSERT INTO artifact_requests(request_id,operation,artifact_id,request_hash,response_json,created_at) VALUES(?,?,?,?,?,?)').run(requestId, 'review', id, requestHash, JSON.stringify(artifact), now)
      this.#db.prepare("DELETE FROM artifact_requests WHERE created_at < datetime(?, '-24 hours')").run(now)
      this.#db.exec('COMMIT')
      return artifact
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
}
