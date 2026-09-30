import type { DatabaseSync } from 'node:sqlite'
import type { UserId } from '@wemux/domain'
import type { AttentionDeadLetterSourceItem, AttentionRunSourceItem, AttentionSourcePort, AttentionTaskSourceItem } from '../../application/ports/attention-source.ts'
import { resolveSqliteDatabase, type SharedSqliteDatabase, type SqliteDatabaseSource } from './shared-database.ts'

export class SqliteAttentionSource implements AttentionSourcePort {
  private readonly db: DatabaseSync
  private readonly database: SharedSqliteDatabase
  private readonly ownsDatabase: boolean
  constructor(source: SqliteDatabaseSource) {
    const resolved = resolveSqliteDatabase(source)
    this.database = resolved.database
    this.ownsDatabase = resolved.owned
    this.db = this.database.connection
  }
  close(): void { if (this.ownsDatabase) this.database.close() }

  async listTasks(): Promise<readonly AttentionTaskSourceItem[]> {
    return this.database.serial(() => this.db.prepare(`SELECT id, project_id,
      json_extract(data,'$.title') AS title, json_extract(data,'$.status') AS status
      FROM tasks WHERE json_extract(data,'$.status') IN ('in_progress','in_review')
      ORDER BY json_extract(data,'$.updatedAt') DESC, id`).all().map(row => ({
      taskId: String(row.id),
      projectId: String(row.project_id) as AttentionTaskSourceItem['projectId'],
      title: String(row.title),
      status: String(row.status) as AttentionTaskSourceItem['status'],
      // Task.assignee is a Worker/Agent binding, not a human assignment.
      // Do not manufacture personal inbox entries from resource ownership.
      assigneeUserIds: [],
    })))
  }

  async listRuns(): Promise<readonly AttentionRunSourceItem[]> {
    return this.database.serial(() => this.db.prepare(`SELECT r.id, r.task_id, t.project_id, r.status,
      json_extract(t.data,'$.title') AS title,
      json_extract(c.data,'$.command.message.sentByAccountId') AS created_by
      FROM task_runs r JOIN tasks t ON t.id=r.task_id
      LEFT JOIN commands c ON c.id=r.enqueue_command_id
        AND json_extract(c.data,'$.command.kind')='session.enqueue'
      WHERE r.status='failed'
      ORDER BY COALESCE(json_extract(r.data,'$.finishedAt'),json_extract(r.data,'$.createdAt')) DESC, r.id`).all().map(row => {
      return {
        runId: String(row.id) as never,
        taskId: String(row.task_id) as never,
        projectId: String(row.project_id) as never,
        title: typeof row.title === 'string' ? row.title : `Run ${String(row.id)}`,
        status: String(row.status) as AttentionRunSourceItem['status'],
        createdBy: row.created_by === null ? null : String(row.created_by) as UserId,
      }
    }))
  }

  async listDeadLetters(): Promise<readonly AttentionDeadLetterSourceItem[]> {
    return this.database.serial(() => this.db.prepare("SELECT id, project_id, data FROM channel_outbound_deliveries WHERE status='dead_letter' ORDER BY updated_at DESC").all().map(row => {
      const data = parseRecord(row.data)
      return {
        id: String(row.id),
        projectId: String(row.project_id) as never,
        title: typeof data.title === 'string' ? data.title : `投递 ${String(row.id)}`,
        detail: typeof data.lastError === 'string' ? data.lastError : 'Channel 投递多次失败',
      }
    }))
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} }
}
