import type { TaskMetadata } from '@wemux/web-contract/task-platform'

export const defaultTaskMetadataJson = JSON.stringify({ schemaVersion: 1, values: {} }, null, 2)

/** Mirrors TaskService.content, including its serialized 16000-character limit.
 * Empty text/null are invalid metadata, not a request to erase or substitute values. */
export function parseTaskMetadata(raw: string): TaskMetadata {
  const metadata: unknown = JSON.parse(raw)
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  if (!object(metadata)) throw Error('Expected an object')
  if (metadata.schemaVersion !== 1 || Object.keys(metadata).some(key => !['schemaVersion', 'values'].includes(key))) throw Error('metadataJson requires schemaVersion 1 and values')
  if (!object(metadata.values)) throw Error('Expected an object')
  if (JSON.stringify(metadata).length > 16000) throw Error('Metadata too large')
  return metadata as unknown as TaskMetadata
}

/** Identity only: recursively order parsed JSON object keys without changing the raw
 * draft or request payload. fromEntries preserves own keys such as __proto__. */
export function taskMetadataIntentKey(metadata: TaskMetadata): string {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])]))
      : value
  return JSON.stringify(ordered(metadata))
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equalJson(a[key], b[key]))
}

/** Object key order/formatting are not edits; array order and null/empty are distinct.
 * Invalid drafts remain raw and dirty, and never turn into an empty object. */
export function sameTaskMetadata(left: string, right: string): boolean {
  if (left === right) return true
  try { return equalJson(parseTaskMetadata(left), parseTaskMetadata(right)) } catch { return false }
}
