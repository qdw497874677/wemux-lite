import { createHash } from 'node:crypto'
import {
  fileWriteContentSize,
  parseFileWriteAdmitStructure,
  parseFileWriteResultAckStructure,
  parseFileWriteResultStructure,
  serializeFileWriteFingerprint,
  serializeFileWriteResultDigest,
  supportsFileWriteAdmission,
  type FileWriteAdmitPayload,
  type FileWriteFingerprintInput,
  type FileWriteResultAckPayload,
  type FileWriteResultPayload,
  type FileWriteRetainedResult,
} from './file-admission.js'
import { parseServerTransportFrame, parseWorkerTransportFrame, type DurableDataFrame } from './transport-v2.js'

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

export function computeFileWriteFingerprint(value: FileWriteFingerprintInput): string {
  return sha256(serializeFileWriteFingerprint(value))
}

export function computeFileWriteResultDigest(value: Omit<FileWriteResultPayload, 'resultDigest'>): string {
  return sha256(serializeFileWriteResultDigest(value))
}

/** Integrity only. Caller must authenticate origin and enforce binding/Workspace access. */
export function parseFileWriteAdmit(value: unknown): FileWriteAdmitPayload {
  const parsed = parseFileWriteAdmitStructure(value)
  if (parsed.fingerprint !== computeFileWriteFingerprint(parsed)) throw new Error('File write fingerprint mismatch')
  return parsed
}

function verifyResult(value: unknown): FileWriteResultPayload {
  const parsed = parseFileWriteResultStructure(value)
  if (parsed.resultDigest !== computeFileWriteResultDigest(parsed)) throw new Error('File write result digest mismatch')
  return parsed
}

const identityKeys = ['requestId', 'sessionId', 'workerId', 'operation', 'fingerprintVersion', 'fingerprint'] as const

/** Compare the result with the immutable admission, not only its self-reported digest. */
export function parseFileWriteResult(value: unknown, admission: FileWriteAdmitPayload): FileWriteResultPayload {
  const expected = parseFileWriteAdmit(admission)
  const parsed = verifyResult(value)
  if (identityKeys.some(key => parsed[key] !== expected[key])) throw new Error('File write result identity mismatch')
  if (parsed.outcome === 'succeeded') {
    const result = JSON.parse(parsed.resultJson) as Extract<FileWriteRetainedResult, { ok: true }>
    if (result.subpath !== expected.subpath || result.size !== fileWriteContentSize(expected.base64Content)) throw new Error('File write success result mismatch')
  }
  return parsed
}

/** Application ACK correlation, not transport ACK, recovery, or settlement authority. */
export function parseFileWriteResultAck(value: unknown, result: FileWriteResultPayload): FileWriteResultAckPayload {
  const expected = verifyResult(result)
  const parsed = parseFileWriteResultAckStructure(value)
  const keys = [...identityKeys, 'resultVersion', 'resultDigest'] as const
  if (keys.some(key => parsed[key] !== expected[key])) throw new Error('File write result ACK mismatch')
  return parsed
}

export interface FileWriteAdmissionNegotiation {
  readonly localFeatures: readonly string[] | undefined
  readonly peerFeatures: readonly string[] | undefined
}

function requireNegotiation(negotiation: FileWriteAdmissionNegotiation): void {
  if (!supportsFileWriteAdmission(negotiation.localFeatures, negotiation.peerFeatures)) throw new Error('File write admission not negotiated')
}

/** Required Node integration boundary for new Server messages; legacy frames use the old parser. */
export function parseVerifiedServerFileWriteFrame(value: unknown, negotiation: FileWriteAdmissionNegotiation, retainedResult?: FileWriteResultPayload): DurableDataFrame<FileWriteAdmitPayload | FileWriteResultAckPayload> {
  requireNegotiation(negotiation)
  const frame = parseServerTransportFrame(value)
  if (frame.frameType !== 'data' || frame.durability !== 'durable') throw new Error('Invalid verified Server file write frame')
  if (frame.payload.type === 'fs.write.admit') parseFileWriteAdmit(frame.payload)
  else if (frame.payload.type === 'fs.write.result.ack' && retainedResult) parseFileWriteResultAck(frame.payload, retainedResult)
  else throw new Error('Invalid verified Server file write frame')
  return frame as DurableDataFrame<FileWriteAdmitPayload | FileWriteResultAckPayload>
}

/** Required before Server result persistence; authenticated Worker matching remains the caller's job. */
export function parseVerifiedWorkerFileWriteFrame(value: unknown, negotiation: FileWriteAdmissionNegotiation, admission: FileWriteAdmitPayload): DurableDataFrame<FileWriteResultPayload> {
  requireNegotiation(negotiation)
  const frame = parseWorkerTransportFrame(value)
  if (frame.frameType !== 'data' || frame.durability !== 'durable' || frame.payload.type !== 'fs.write.result') throw new Error('Invalid verified Worker file write frame')
  parseFileWriteResult(frame.payload, admission)
  return frame as DurableDataFrame<FileWriteResultPayload>
}
