import type { DatabaseSync } from 'node:sqlite'
import type { ProjectId, UserId } from '@wemux/domain'

// SQLite's boolean coercion differs from JavaScript for strings and containers.
// roleFrom/list use truthiness, not IS NULL or a whitelist of grant roles.
function jsonTruthy(data: string, path = '$'): string {
  const value = `json_extract(${data}, '${path}')`
  return `(CASE COALESCE(json_type(${data}, '${path}'), 'null')
    WHEN 'null' THEN 0 WHEN 'false' THEN 0
    WHEN 'integer' THEN ${value} <> 0 WHEN 'real' THEN ${value} <> 0
    WHEN 'text' THEN ${value} <> '' ELSE 1 END)`
}

/** Bounded Attention authorization only; legacy Project readers remain unchanged. */
export function listAccessibleProjectIds(db: DatabaseSync, actorId: UserId, scopedProjectId?: ProjectId): ProjectId[] {
  const sql = `SELECT p.id FROM records p
    LEFT JOIN records m ON m.kind='membership' AND m.id=json_extract(p.data, '$.teamId') || ':' || $actorId
    LEFT JOIN records g ON g.kind='project-grant' AND g.id=p.id || ':' || $actorId
    WHERE p.kind='project' ${scopedProjectId === undefined ? '' : 'AND p.id=$projectId'}
      AND json_type(p.data, '$.id')='text' AND json_extract(p.data, '$.id')=p.id
      AND NOT ${jsonTruthy('p.data', '$.deletedAt')}
      AND (json_extract(p.data, '$.ownerId')=$actorId OR (
        json_type(p.data, '$.teamId')='text' AND ${jsonTruthy('m.data')}
        AND CASE WHEN ${jsonTruthy('g.data')} THEN ${jsonTruthy('g.data', '$.role')}
          ELSE json_extract(p.data, '$.shareScope')='team' END
      )) ORDER BY p.rowid`
  // Membership/grant identities are the lookup keys, as in getIdentityRecords;
  // embedded identity fields are not an additional authorization source.
  // Unlike legacy list(), corrupt Project indexed/JSON identities fail closed,
  // never authorizing a different Project or falling back to a scoped full scan.
  // Non-owner team IDs must be strings, not coerced 'undefined'/'null' keys.
  const params: Record<string, string> = { $actorId: actorId }
  if (scopedProjectId !== undefined) params.$projectId = scopedProjectId
  return db.prepare(sql).all(params).map(row => row.id as ProjectId)
}
