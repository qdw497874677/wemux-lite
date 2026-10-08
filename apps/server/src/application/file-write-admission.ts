import { createHash, randomUUID } from 'node:crypto'
import type { SessionBinding, Timestamp } from '@wemux/domain'
import type { Session } from '@wemux/server-domain'
import { AppError } from './errors.ts'
import type { FileWriteAdmission, FileWriteKey } from './ports/file-write-admission.ts'
import type { ServerStoreTx } from './ports/server-store.ts'

const maxBytes = 10 * 1024 * 1024

/** Capture primitives before the first await; validation follows authorization. */
export function snapshotFileWriteInput(input: unknown) {
  const object = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
  const { requestId, subpath, base64Content } = object ?? {}
  return {
    validShape: object !== null && Object.keys(object).every(key => ['requestId', 'subpath', 'base64Content'].includes(key)),
    requestId: typeof requestId === 'string' ? requestId : null,
    subpath: typeof subpath === 'string' ? subpath : null,
    base64Content: typeof base64Content === 'string' ? base64Content : null,
  }
}

export async function admitFileWriteInTx(tx: ServerStoreTx, actorId: FileWriteKey['actorId'], session: Session, input: ReturnType<typeof snapshotFileWriteInput>): Promise<FileWriteAdmission> {
  const { requestId, subpath, base64Content } = input
  const invalid = () => new AppError(400, 'Invalid file write admission', 'invalid_request')
  if (!input.validShape || !requestId?.trim() || requestId.length > 200 || /[\x00-\x1f\x7f]/.test(requestId)) throw invalid()
  // Lexical validation only. Worker must independently enforce realpath/symlink sandboxing.
  if (!subpath || Buffer.byteLength(subpath) > 4096 || /[\x00-\x1f\x7f\\:]/.test(subpath) || subpath.startsWith('/') || subpath.split('/').some(part => !part || part === '.' || part === '..') || Buffer.from(subpath).toString() !== subpath) throw invalid()
  if (base64Content === null || base64Content.length > Math.ceil(maxBytes / 3) * 4) throw invalid()
  const bytes = Buffer.from(base64Content, 'base64')
  if (bytes.length > maxBytes || bytes.toString('base64') !== base64Content) throw invalid()
  // Binding authority is the authorized Session, never the caller's body.
  const binding: SessionBinding = {
    workspaceId: session.binding.workspaceId,
    agent: { workerId: session.binding.agent.workerId, agentKey: session.binding.agent.agentKey },
    modelId: session.binding.modelId,
  }
  const workerId = binding.agent.workerId
  const key: FileWriteKey = { actorId, sessionId: session.id, requestId }
  // Version 1 hashes this fixed-order tuple, including exact (not normalized) input strings.
  const fingerprint = createHash('sha256').update(JSON.stringify([
    1, actorId, session.id, requestId, 'fs.write', workerId,
    binding.workspaceId, binding.agent.workerId, binding.agent.agentKey, binding.modelId, subpath, base64Content,
  ])).digest('hex')
  const previous = await tx.fileWrites.find(key)
  if (previous) {
    if (previous.fingerprintVersion !== 1 || previous.fingerprint !== fingerprint) throw new AppError(409, 'Conflicting file write requestId', 'request_id_conflict')
    return previous
  }
  const admission: FileWriteAdmission = {
    ...key, admissionId: randomUUID(), operation: 'fs.write', workerId, binding,
    subpath, base64Content, fingerprintVersion: 1, fingerprint, admittedAt: new Date().toISOString() as Timestamp,
  }
  await tx.fileWrites.insertHeld(admission)
  return admission
}
