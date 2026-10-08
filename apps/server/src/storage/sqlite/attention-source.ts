import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { validReviewMetadata } from '@wemux/web-contract/task-platform'
import type { UserId } from '@wemux/domain'
import type { AttentionPagesKind } from '@wemux/server-domain'
import type { AttentionApprovalSourceItem, AttentionApprovalSourcePageQuery, AttentionDeadLetterSourceItem, AttentionRunSourceItem, AttentionSourcePort, AttentionTaskSourceItem, AttentionRunSourcePageQuery, AttentionDeadLetterSourceQuery, AttentionDeadLetterSourcePageQuery, AttentionSourcePage } from '../../application/ports/attention-source.ts'
import { encodeAttentionPageCursor, attentionPageInput } from '../../application/attention-page-input.ts'
import { attentionRunOrderTimestamp, attentionReviewOrderTimestamp } from './attention-page-indexes.ts'
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

  async listApprovalsPage(query: AttentionApprovalSourcePageQuery): Promise<AttentionSourcePage<AttentionApprovalSourceItem>> {
    const { limit, cursor } = attentionPageInput(query, 'approval')
    if (query.authorizedProjectIds.length === 0) return { items: [], nextCursor: null }
    return this.database.serial(() => {
      const eligible: Record<string, SQLOutputValue>[] = []
      let seek = cursor
      // SQL applies authority and lifecycle eligibility before bounded lookahead.
      // Metadata validation uses the same predicate as the decision reader; skip
      // corrupt candidates without mistaking an ineligible batch for exhaustion.
      while (eligible.length <= limit) {
        const rows = this.db.prepare(`WITH actor(actor_id) AS (VALUES (?))
          SELECT v.id, v.task_id, v.run_id, v.project_id, v.data,
            json_extract(t.data,'$.title') AS title, ${attentionReviewOrderTimestamp('v.data')} AS ordered_at
          FROM review_requests v JOIN tasks t ON t.id=v.task_id AND t.project_id=v.project_id
          JOIN task_runs r ON r.id=v.run_id AND r.task_id=t.id
          JOIN records p ON p.kind='project' AND p.id=v.project_id
          CROSS JOIN actor
          LEFT JOIN records m ON m.kind='membership' AND m.id=json_extract(p.data,'$.teamId') || ':' || actor.actor_id
          LEFT JOIN records g ON g.kind='project-grant' AND g.id=p.id || ':' || actor.actor_id
          WHERE v.status='requested' AND json_extract(v.data,'$.closedAt') IS NULL
            AND v.project_id IN (SELECT value FROM json_each(?))
            AND json_extract(p.data,'$.id')=p.id AND json_extract(p.data,'$.deletedAt') IS NULL
            AND (json_extract(p.data,'$.ownerId')=actor.actor_id OR (
              json_type(p.data,'$.teamId')='text' AND json_type(m.data)='object'
              AND json_extract(g.data,'$.role')='manager'
            ))
            AND json_extract(v.data,'$.actor')<>actor.actor_id
            AND json_extract(v.data,'$.id')=v.id AND json_extract(v.data,'$.taskId')=t.id
            AND json_extract(v.data,'$.taskRunId')=r.id AND json_extract(v.data,'$.projectId')=p.id
            AND json_extract(v.data,'$.status')='requested'
            AND json_type(v.data,'$.reviewer')='null' AND json_type(v.data,'$.decidedAt')='null'
            AND json_extract(t.data,'$.id')=t.id AND json_extract(t.data,'$.projectId')=p.id
            AND json_extract(t.data,'$.deletedAt') IS NULL AND json_extract(t.data,'$.status')='in_review'
            AND json_extract(t.data,'$.currentReviewId')=v.id
            AND json_extract(t.data,'$.metadataJson.values.reviewPolicy')='human'
            AND json_type(t.data,'$.metadataJson.values.reviewPolicyFrozen')='true'
            AND json_extract(r.data,'$.projectId')=p.id AND r.status='succeeded'
            AND NOT EXISTS (SELECT 1 FROM task_runs newer WHERE newer.task_id=t.id AND newer.attempt>r.attempt)
            AND NOT EXISTS (SELECT 1 FROM task_runs active WHERE active.task_id=t.id AND active.status IN ('pending','running','cancelling'))
            ${seek ? `AND (${attentionReviewOrderTimestamp('v.data')} < ? OR (${attentionReviewOrderTimestamp('v.data')} = ? AND v.id > ?))` : ''}
          ORDER BY ordered_at DESC, v.id ASC LIMIT ?`).all(
          query.actorId, JSON.stringify(query.authorizedProjectIds),
          ...(seek ? [seek.timestamp, seek.timestamp, seek.id] : []), limit + 1,
        )
        for (const row of rows) {
          if (validReviewMetadata(parseRecord(row.data))) eligible.push(row)
          if (eligible.length > limit) break
        }
        if (rows.length <= limit || eligible.length > limit) break
        const last = rows.at(-1)!
        seek = { timestamp: String(last.ordered_at), id: String(last.id) }
      }
      return sourcePage(eligible, limit, 'approval', row => ({
        reviewId: String(row.id), taskId: String(row.task_id), runId: String(row.run_id),
        projectId: String(row.project_id) as AttentionApprovalSourceItem['projectId'],
        title: typeof row.title === 'string' ? row.title : `Task ${String(row.task_id)}`,
        requestedAt: String(row.ordered_at),
      }))
    })
  }

  async listRunsPage(query: AttentionRunSourcePageQuery): Promise<AttentionSourcePage<AttentionRunSourceItem>> {
    const { limit, cursor } = attentionPageInput(query, 'run_problem')
    if (query.authorizedProjectIds.length === 0) return { items: [], nextCursor: null }
    return this.database.serial(() => {
      const rows = this.db.prepare(`SELECT r.id, r.task_id, t.project_id, r.status,
        json_extract(t.data,'$.title') AS title,
        json_extract(c.data,'$.command.message.sentByAccountId') AS created_by,
        ${attentionRunOrderTimestamp('r.data')} AS ordered_at
        FROM task_runs r JOIN tasks t ON t.id=r.task_id
        JOIN commands c ON c.id=r.enqueue_command_id
        WHERE r.status='failed' AND json_extract(t.data,'$.deletedAt') IS NULL
          AND json_extract(c.data,'$.command.kind')='session.enqueue'
          AND json_extract(c.data,'$.command.message.sentByAccountId')=?
          AND t.project_id IN (SELECT value FROM json_each(?))
          ${cursor ? `AND (${attentionRunOrderTimestamp('r.data')} < ? OR (${attentionRunOrderTimestamp('r.data')} = ? AND r.id > ?))` : ''}
        ORDER BY ordered_at DESC, r.id ASC LIMIT ?`).all(
        query.actorId, JSON.stringify(query.authorizedProjectIds),
        ...(cursor ? [cursor.timestamp, cursor.timestamp, cursor.id] : []), limit + 1,
      )
      return sourcePage(rows, limit, 'run_problem', row => ({
        runId: String(row.id), taskId: String(row.task_id),
        projectId: String(row.project_id) as AttentionRunSourceItem['projectId'],
        title: typeof row.title === 'string' ? row.title : `Run ${String(row.id)}`,
        status: 'failed', createdBy: String(row.created_by) as UserId,
      }))
    })
  }

  async listDeadLettersPage(query: AttentionDeadLetterSourcePageQuery): Promise<AttentionSourcePage<AttentionDeadLetterSourceItem>> {
    const { limit, cursor } = attentionPageInput(query, 'channel_dead_letter')
    if (query.authorizedProjectIds.length === 0) return { items: [], nextCursor: null }
    return this.database.serial(() => {
      // Mirror ProjectAccessService.roleFrom and SessionAccessService's read rule.
      // Instance administration never bypasses either resource authority. The indexed
      // Session lineage must resolve to a live Session in the same Project; do not
      // infer authority from a composite delivery ID or a historical binding.
      const rows = this.db.prepare(`WITH actor(actor_id) AS (VALUES (?))
        SELECT d.id, d.project_id, d.data, d.updated_at AS ordered_at
        FROM channel_outbound_deliveries d
        JOIN records p ON p.kind='project' AND p.id=d.project_id
        JOIN records s ON s.kind='session' AND s.id=d.session_id
        CROSS JOIN actor
        LEFT JOIN records m ON m.kind='membership' AND m.id=json_extract(p.data,'$.teamId') || ':' || actor.actor_id
        LEFT JOIN records g ON g.kind='project-grant' AND g.id=p.id || ':' || actor.actor_id
        LEFT JOIN records sg ON sg.kind='session-grant' AND sg.id=s.id || ':' || actor.actor_id
        WHERE d.status='dead_letter'
          AND d.project_id IN (SELECT value FROM json_each(?))
          AND json_extract(p.data,'$.id')=p.id AND json_extract(p.data,'$.deletedAt') IS NULL
          AND (json_extract(p.data,'$.ownerId')=actor.actor_id OR (
            json_type(p.data,'$.teamId')='text' AND json_type(m.data)='object'
            AND json_extract(g.data,'$.role')='manager'
          ))
          AND json_extract(s.data,'$.id')=s.id AND json_extract(s.data,'$.projectId')=p.id
          AND json_extract(s.data,'$.deletedAt') IS NULL
          AND (json_extract(s.data,'$.ownerId')=actor.actor_id
            OR json_extract(s.data,'$.shareScope')='project'
            OR (json_extract(s.data,'$.shareScope')='selected-members' AND json_type(sg.data)='object'))
          ${cursor ? 'AND (d.updated_at < ? OR (d.updated_at = ? AND d.id > ?))' : ''}
        ORDER BY d.updated_at DESC, d.id ASC LIMIT ?`).all(
        query.actorId, JSON.stringify(query.authorizedProjectIds),
        ...(cursor ? [cursor.timestamp, cursor.timestamp, cursor.id] : []), limit + 1,
      )
      return sourcePage(rows, limit, 'channel_dead_letter', row => {
        const data = parseRecord(row.data)
        return {
          id: String(row.id), projectId: String(row.project_id) as AttentionDeadLetterSourceItem['projectId'],
          title: typeof data.title === 'string' ? data.title : `投递 ${String(row.id)}`,
          detail: typeof data.lastError === 'string' ? data.lastError : 'Channel 投递多次失败',
        }
      })
    })
  }

  async listTasks(): Promise<readonly AttentionTaskSourceItem[]> {
    return this.database.serial(() => this.db.prepare(`SELECT id, project_id,
      json_extract(data,'$.title') AS title, json_extract(data,'$.status') AS status
      FROM tasks WHERE json_extract(data,'$.deletedAt') IS NULL AND json_extract(data,'$.status') IN ('in_progress','in_review')
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
      WHERE r.status='failed' AND json_extract(t.data,'$.deletedAt') IS NULL
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

  async listDeadLetters(query: AttentionDeadLetterSourceQuery): Promise<readonly AttentionDeadLetterSourceItem[]> {
    // The grouped API needs every authorized item for its counts, but shares the
    // bounded, authority-filtered SQL reader instead of hydrating candidate rows.
    return this.database.transaction(async () => {
      const items: AttentionDeadLetterSourceItem[] = []
      let cursor: string | undefined
      do {
        const page = await this.listDeadLettersPage({ ...query, limit: 100, cursor })
        items.push(...page.items)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return items
    })
  }
}

function sourcePage<T>(rows: Record<string, SQLOutputValue>[], limit: number, kind: AttentionPagesKind, map: (row: Record<string, SQLOutputValue>) => T): AttentionSourcePage<T> {
  // SQL returns at most limit + 1 rows; discard only that lookahead, never an unbounded list.
  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  const last = rows.at(-1)
  return {
    items: rows.map(map),
    nextCursor: hasMore && last ? encodeAttentionPageCursor(kind, { timestamp: String(last.ordered_at), id: String(last.id) }) : null,
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} }
}
