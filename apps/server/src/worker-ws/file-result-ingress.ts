import type { WorkerId } from '@wemux/domain'
import type { FileWriteResultAckPayload } from '@wemux/wire-protocol'
import type { FileWriteReader } from '../application/ports/file-write-admission.ts'

/** Trusted internal embedding only. No production constructor supplies this port.
 * The receiver must resolve only after application commit; transport receipt is separate.
 * Operational storage failures must throw FileWriteResultUnavailableError (cause retained
 * in-process); intentional validation/conflict failures must never use that category.
 * Unclassified port failures remain permanent rather than silently weakening validation.
 */
export interface ServerFileResultIngress {
  readonly admissions: Pick<FileWriteReader, 'get'>
  receiveFileWriteResult(authenticatedWorkerId: WorkerId, input: unknown): Promise<FileWriteResultAckPayload>
}
