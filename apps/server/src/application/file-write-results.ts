import type { FileWriteResultPayload } from '@wemux/wire-protocol'
import { parseFileWriteResultStructure } from '@wemux/wire-protocol'
import { parseFileWriteAdmit, parseFileWriteResultAck } from '@wemux/wire-protocol/file-admission-node'
import type { FileWriteAdmission } from './ports/file-write-admission.ts'

/** Intentional validation/correlation denial, never an operational retry signal. */
export class FileWriteResultRejectedError extends Error {}

/** Retry classification, not a guarantee that the underlying storage will recover.
 * Keep the diagnostic cause in-process; only the fixed message may reach the peer.
 */
export class FileWriteResultUnavailableError extends Error {
  constructor(cause: unknown) { super('File result storage temporarily unavailable', { cause }) }
}

/** Wrap only pure validation. SQL reads/writes must remain outside this callback. */
export function validateFileWriteResult<T>(validate: () => T): T {
  try { return validate() }
  catch (cause) {
    if (cause instanceof FileWriteResultRejectedError) throw cause
    throw new FileWriteResultRejectedError(cause instanceof Error ? cause.message : 'Invalid file write result', { cause })
  }
}

/** Wire requestId is the immutable admissionId, never the actor's client key.
 * Verification fails closed for older internal admissions outside wire bounds.
 */
export function fileWriteWireAdmission(admission: FileWriteAdmission) {
  return parseFileWriteAdmit({
    type: 'fs.write.admit', requestId: admission.admissionId,
    actorId: admission.actorId, sessionId: admission.sessionId, clientRequestId: admission.requestId,
    operation: admission.operation, workerId: admission.workerId, binding: admission.binding,
    subpath: admission.subpath, base64Content: admission.base64Content,
    fingerprintVersion: admission.fingerprintVersion, fingerprint: admission.fingerprint,
  })
}

/** Capture all caller data synchronously before queueing; parsers return their input. */
export function snapshotFileWriteResult(input: unknown): FileWriteResultPayload {
  return validateFileWriteResult(() => Object.freeze(parseFileWriteResultStructure(structuredClone(input))))
}

/** Correlation receipt only. Unknown never authorizes success, settlement or retry. */
export function fileWriteResultAck(result: FileWriteResultPayload) {
  return Object.freeze(parseFileWriteResultAck({
    type: 'fs.write.result.ack', requestId: result.requestId, sessionId: result.sessionId,
    workerId: result.workerId, operation: result.operation,
    fingerprintVersion: result.fingerprintVersion, fingerprint: result.fingerprint,
    resultVersion: result.resultVersion, resultDigest: result.resultDigest,
  }, result))
}
