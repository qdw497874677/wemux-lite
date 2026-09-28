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
    return this.database.serial(() => this.db.prepare("SELECT id, project_id, title, status, assignee_user_ids_json FROM tasks WHERE status IN ('in_progress','in_review') ORDER BY updated_at DESC").all().map(row => ({
      taskId: String(row.id) as never,
      projectId: String(row.project_id) as never,
      title: String(row.title),
      status: String(row.status) as AttentionTaskSourceItem['status'],
      assigneeUserIds: parseUserIds(row.assignee_user_ids_json),
    })))
  }

  async listRuns(): Promise<readonly AttentionRunSourceItem[]> {
    return this.database.serial(() => this.db.prepare("SELECT id, task_id, project_id, status, created_by, data FROM runs WHERE status IN ('blocked','failed') ORDER BY updated_at DESC").all().map(row => {
      const data = parseRecord(row.data)
      return {
        runId: String(row.id) as never,
        taskId: String(row.task_id) as never,
        projectId: String(row.project_id) as never,
        title: typeof data.title === 'string' ? data.title : `Run ${String(row.id)}`,
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

function parseUserIds(value: unknown): readonly UserId[] {
  if (typeof value !== 'string') return []
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') as UserId[] : [] } catch { return [] }
}
function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} }
}
