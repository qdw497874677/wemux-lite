import type { FileWriteAdmitPayload, FileWriteResultPayload } from '@wemux/wire-protocol'

/** Permanent dedupe record. An acknowledged unknown still represents uncertain effect. */
export interface WorkerFileWriteRecord {
  readonly admission: FileWriteAdmitPayload
  readonly result: FileWriteResultPayload | null
  readonly acknowledged: boolean
}

/**
 * PROVISIONAL inside a transaction. Only the successfully resolved outer
 * store.transaction(...) return value may authorize execution or publication.
 * Never perform effects, invoke effect callbacks, or use leaked decisions inside
 * the callback. Rollback invalidates every provisional decision.
 */
export type WorkerFileWriteReservation =
  | { readonly status: 'execute'; readonly admission: FileWriteAdmitPayload }
  | { readonly status: 'await-existing'; readonly admission: FileWriteAdmitPayload }
  | { readonly status: 'replay' | 'unknown'; readonly result: FileWriteResultPayload }
  | { readonly status: 'reject'; readonly reason: 'identity-conflict' }
