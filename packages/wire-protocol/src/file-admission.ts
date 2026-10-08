import type { SessionBinding, SessionId, UserId, WorkerId } from '@wemux/domain'

export const FS_WRITE_ADMISSION_V1 = 'fs-write-admission-v1' as const
export const FILE_WRITE_MAX_BYTES = 10 * 1024 * 1024

/** Both advertisements must be explicit. Transport major/minor never implies support. */
export function supportsFileWriteAdmission(localFeatures: readonly string[] | undefined, peerFeatures: readonly string[] | undefined): boolean {
  return Boolean(localFeatures?.includes(FS_WRITE_ADMISSION_V1) && peerFeatures?.includes(FS_WRITE_ADMISSION_V1))
}

export interface FileWriteFingerprintInput {
  readonly fingerprintVersion: 1
  /** Provenance/correlation only, not Worker authorization. */
  readonly actorId: UserId
  readonly sessionId: SessionId
  /** Original client key, NOT the admission identity carried as requestId. */
  readonly clientRequestId: string
  readonly operation: 'fs.write'
  readonly workerId: WorkerId
  readonly binding: SessionBinding
  readonly subpath: string
  readonly base64Content: string
}

export interface FileWriteAdmitPayload extends FileWriteFingerprintInput {
  readonly type: 'fs.write.admit'
  /** Server admissionId; stable across transport replay. */
  readonly requestId: string
  readonly fingerprint: string
}

interface FileWriteResultIdentity {
  readonly requestId: string
  readonly sessionId: SessionId
  readonly workerId: WorkerId
  readonly operation: 'fs.write'
  readonly fingerprintVersion: 1
  readonly fingerprint: string
  /** Versions both the retained result schema and its digest representation. */
  readonly resultVersion: 1
}

export type FileWriteOutcome = 'succeeded' | 'rejected-before-effect' | 'unknown'
export type FileWriteRetainedResult =
  | { readonly ok: true; readonly operation: 'write'; readonly subpath: string; readonly size: number }
  | { readonly ok: false; readonly operation: 'write'; readonly effect: 'not-started' | 'uncertain'; readonly error: string }

export interface FileWriteResultPayload extends FileWriteResultIdentity {
  readonly type: 'fs.write.result'
  /** Unknown is uncertain effect, never success, safe retry, or settlement authority. */
  readonly outcome: FileWriteOutcome
  readonly resultJson: string
  readonly resultDigest: string
}

export interface FileWriteResultAckPayload extends FileWriteResultIdentity {
  readonly type: 'fs.write.result.ack'
  readonly resultDigest: string
}

export type FileWriteAdmissionPayload = FileWriteAdmitPayload | FileWriteResultPayload | FileWriteResultAckPayload

const fingerprintKeys = ['fingerprintVersion', 'actorId', 'sessionId', 'clientRequestId', 'operation', 'workerId', 'binding', 'subpath', 'base64Content'] as const
const resultIdentityKeys = ['requestId', 'sessionId', 'workerId', 'operation', 'fingerprintVersion', 'fingerprint', 'resultVersion'] as const
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const unicode = (value: string) => decoder.decode(encoder.encode(value)) === value
const id = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value) && unicode(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const path = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && encoder.encode(value).length <= 4096 && unicode(value) && !/[\x00-\x1f\x7f\\:]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..')

/** Canonical RFC 4648 base64, including zero pad bits; no Buffer/browser dependency. */
export function fileWriteContentSize(value: unknown): number {
  if (typeof value !== 'string' || value.length > Math.ceil(FILE_WRITE_MAX_BYTES / 3) * 4 || value.length % 4 !== 0) throw new Error('Invalid file write content')
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const end = value.length - padding
  for (let index = 0; index < end; index++) {
    if (!alphabet.includes(value[index])) throw new Error('Invalid file write content')
  }
  if ((padding === 2 && (alphabet.indexOf(value[end - 1]) & 15) !== 0) || (padding === 1 && (alphabet.indexOf(value[end - 1]) & 3) !== 0)) throw new Error('Invalid file write content')
  const size = value.length / 4 * 3 - padding
  if (size > FILE_WRITE_MAX_BYTES) throw new Error('Invalid file write content')
  return size
}

function validFingerprintInput(value: Record<string, unknown>): boolean {
  const binding = object(value.binding)
  const agent = binding && object(binding.agent)
  if (value.fingerprintVersion !== 1 || value.operation !== 'fs.write' || !id(value.actorId) || !id(value.sessionId) || !id(value.clientRequestId) || !id(value.workerId) || !path(value.subpath)) return false
  if (!binding || !exact(binding, ['workspaceId', 'agent', 'modelId']) || !id(binding.workspaceId) || !(binding.modelId === null || id(binding.modelId)) || !agent || !exact(agent, ['workerId', 'agentKey']) || !id(agent.workerId) || !id(agent.agentKey) || value.workerId !== agent.workerId) return false
  try { fileWriteContentSize(value.base64Content); return true } catch { return false }
}

/** Persisted stage 1 v1 bytes. Never add admissionId, reorder, or normalize this tuple. */
export function serializeFileWriteFingerprint(value: FileWriteFingerprintInput): string {
  const item = object(value)
  if (!item || !validFingerprintInput(item)) throw new Error('Invalid file write fingerprint input')
  return JSON.stringify([
    1, value.actorId, value.sessionId, value.clientRequestId, 'fs.write', value.workerId,
    value.binding.workspaceId, value.binding.agent.workerId, value.binding.agent.agentKey,
    value.binding.modelId, value.subpath, value.base64Content,
  ])
}

/** Structural only. Use the Node subpath parser before any admission/effect boundary. */
export function parseFileWriteAdmitStructure(value: unknown): FileWriteAdmitPayload {
  const item = object(value)
  if (!item || !exact(item, ['type', 'requestId', 'fingerprint', ...fingerprintKeys]) || item.type !== 'fs.write.admit' || !id(item.requestId) || !hash(item.fingerprint) || !validFingerprintInput(item)) throw new Error('Invalid file write admission structure')
  return value as FileWriteAdmitPayload
}

/** Canonical retained bytes reject duplicate keys and preserve an unambiguous schema. */
export function serializeFileWriteRetainedResult(outcome: FileWriteOutcome, value: FileWriteRetainedResult): string {
  const item = object(value)
  if (item && outcome === 'succeeded' && exact(item, ['ok', 'operation', 'subpath', 'size']) && item.ok === true && item.operation === 'write' && path(item.subpath) && typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= FILE_WRITE_MAX_BYTES) {
    return JSON.stringify({ ok: true, operation: 'write', subpath: item.subpath, size: item.size })
  }
  const effect = outcome === 'rejected-before-effect' ? 'not-started' : outcome === 'unknown' ? 'uncertain' : null
  if (item && effect && exact(item, ['ok', 'operation', 'effect', 'error']) && item.ok === false && item.operation === 'write' && item.effect === effect && typeof item.error === 'string' && item.error.trim().length > 0 && item.error.length <= 4096 && encoder.encode(item.error).length <= 4096 && unicode(item.error) && !item.error.includes('\0')) {
    return JSON.stringify({ ok: false, operation: 'write', effect, error: item.error })
  }
  throw new Error('Invalid file write retained result')
}

function validResultIdentity(item: Record<string, unknown>): boolean {
  return id(item.requestId) && id(item.sessionId) && id(item.workerId) && item.operation === 'fs.write' && item.fingerprintVersion === 1 && hash(item.fingerprint) && item.resultVersion === 1
}

/** Structural only; does not verify resultDigest or compare a persisted admission. */
export function parseFileWriteResultStructure(value: unknown): FileWriteResultPayload {
  const item = object(value)
  if (!item || !exact(item, ['type', ...resultIdentityKeys, 'outcome', 'resultJson', 'resultDigest']) || item.type !== 'fs.write.result' || !validResultIdentity(item) || !hash(item.resultDigest) || typeof item.resultJson !== 'string' || item.resultJson.length > 32768) throw new Error('Invalid file write result structure')
  const result = JSON.parse(item.resultJson) as FileWriteRetainedResult
  if (serializeFileWriteRetainedResult(item.outcome as FileWriteOutcome, result) !== item.resultJson) throw new Error('Invalid file write result bytes')
  return value as FileWriteResultPayload
}

/** Structural only; an ACK is valid only against the exact retained result. */
export function parseFileWriteResultAckStructure(value: unknown): FileWriteResultAckPayload {
  const item = object(value)
  if (!item || !exact(item, ['type', ...resultIdentityKeys, 'resultDigest']) || item.type !== 'fs.write.result.ack' || !validResultIdentity(item) || !hash(item.resultDigest)) throw new Error('Invalid file write result ACK structure')
  return value as FileWriteResultAckPayload
}

/** SHA-256 input is UTF-8 of this domain-separated tuple, including exact resultJson. */
export function serializeFileWriteResultDigest(value: Omit<FileWriteResultPayload, 'resultDigest'>): string {
  const parsed = parseFileWriteResultStructure({ ...value, resultDigest: '0'.repeat(64) })
  return JSON.stringify([
    'fs.write.result', parsed.resultVersion, parsed.requestId, parsed.sessionId, parsed.workerId,
    parsed.operation, parsed.fingerprintVersion, parsed.fingerprint, parsed.outcome, parsed.resultJson,
  ])
}

export function isFileWriteAdmissionType(value: unknown): boolean {
  const item = object(value)
  return Boolean(item && ['fs.write.admit', 'fs.write.result', 'fs.write.result.ack'].includes(String(item.type)))
}

/** Transport shape recognition only, never cryptographic or authorization validation. */
export function isServerFileWriteAdmissionStructure(value: unknown): value is FileWriteAdmitPayload | FileWriteResultAckPayload {
  try {
    if (object(value)?.type === 'fs.write.admit') parseFileWriteAdmitStructure(value)
    else parseFileWriteResultAckStructure(value)
    return true
  } catch { return false }
}

export function isWorkerFileWriteAdmissionStructure(value: unknown): value is FileWriteResultPayload {
  try { parseFileWriteResultStructure(value); return true } catch { return false }
}
