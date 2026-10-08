import type { AttentionPagesKind } from '@wemux/server-domain'
import type { AttentionSourcePageQuery } from './ports/attention-source.ts'
import { AppError } from './errors.ts'

interface PageCursor { readonly timestamp: string; readonly id: string }

export function encodeAttentionPageCursor(kind: AttentionPagesKind, cursor: PageCursor): string {
  return Buffer.from(JSON.stringify([1, kind, cursor.timestamp, cursor.id]), 'utf8').toString('base64url')
}

export function attentionPageInput(query: AttentionSourcePageQuery, kind: AttentionPagesKind): { limit: number; cursor: PageCursor | null } {
  const limit = query.limit === undefined ? 50 : query.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'limit must be between 1 and 100', 'invalid_limit')
  if (query.cursor === undefined) return { limit, cursor: null }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== 1 || parsed[1] !== kind
      || typeof parsed[2] !== 'string' || typeof parsed[3] !== 'string' || parsed[3].length === 0) throw new Error()
    const cursor = { timestamp: parsed[2], id: parsed[3] }
    if (encodeAttentionPageCursor(kind, cursor) !== query.cursor) throw new Error()
    return { limit, cursor }
  } catch { throw new AppError(400, 'Invalid attention source cursor', 'invalid_cursor') }
}

