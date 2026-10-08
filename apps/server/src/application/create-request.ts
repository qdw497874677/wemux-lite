import { createHash } from 'node:crypto'
import type { ServerStoreTx } from './ports/server-store.ts'
import { AppError } from './errors.ts'

/** Explicit body requestId only: X-Request-ID remains reusable tracing context. */
export function createRequest(actor: string, operation: 'project' | 'workspace' | 'task' | 'task-workspace' | 'task-delete' | 'task-completion' | 'task-review-submission' | 'human-review-decision' | 'workspace-delete' | 'workspace-visibility', scope: string, requestId: unknown, input: unknown) {
  if (requestId === undefined) return null
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new AppError(400, 'Invalid requestId', 'invalid_request')
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value
  return { key: JSON.stringify([actor, operation, scope, requestId]), fingerprint: createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex') }
}
export async function replayCreate<T>(tx: ServerStoreTx, request: ReturnType<typeof createRequest>): Promise<T | undefined> {
  if (!request) return undefined
  const previous = await tx.resources.getCreateRequest(request.key)
  if (!previous) return undefined
  if (previous.fingerprint !== request.fingerprint) throw new AppError(409, 'requestId already belongs to a different create request', 'request_id_conflict')
  return previous.result as T
}
export async function recordCreate(tx: ServerStoreTx, request: ReturnType<typeof createRequest>, result: unknown) {
  if (request) await tx.resources.saveCreateRequest(request.key, { fingerprint: request.fingerprint, result })
}
