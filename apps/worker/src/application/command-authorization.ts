import { createHash, createPublicKey, verify } from 'node:crypto'
import type { CommandId, WorkerId } from '@wemux/domain'
import type { WorkerCommand } from '@wemux/wire-protocol'
import { authorizationBytes, type SignedEnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'
import type { WorkerIdentity } from '../domain/worker-identity.js'

export function verifyCommandAuthorization(identity: WorkerIdentity | null, workerId: WorkerId, commandId: CommandId, command: WorkerCommand, assertion: SignedEnqueueAuthorization | undefined, atLaunch = false): boolean {
  if ((command.kind !== 'session.enqueue' && command.kind !== 'runtime.approval.resolve') || !identity?.commandSigningKey || !assertion) return false
  try {
    const claims = assertion.claims
    if ((command.kind === 'session.enqueue' ? claims.version !== 1 : claims.version !== 2 || claims.kind !== command.kind) || claims.keyId !== identity.commandSigningKey.keyId || claims.commandId !== commandId || claims.workerId !== workerId || claims.sessionId !== command.sessionId || claims.actorId !== (command.kind === 'session.enqueue' ? command.message.sentByAccountId : command.decidedByAccountId) || !Number.isSafeInteger(claims.actorAuthVersion) || claims.actorAuthVersion < 0) return false
    if (claims.commandDigest !== createHash('sha256').update(JSON.stringify(command)).digest('hex')) return false
    const issued = Date.parse(claims.issuedAt), expires = Date.parse(claims.expiresAt), current = Date.now()
    // An accepted queue may wait beyond the receipt-time expiry. At launch the
    // online Server check, not a stale signing window, decides current access.
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > current + 30_000 || (!atLaunch && expires <= current) || expires <= issued || expires - issued > 5 * 60_000) return false
    const publicKey = createPublicKey(identity.commandSigningKey.publicKey)
    if (createHash('sha256').update(identity.commandSigningKey.publicKey).digest('hex') !== identity.commandSigningKey.keyId) return false
    return verify(null, authorizationBytes(claims), publicKey, Buffer.from(assertion.signature, 'base64url'))
  } catch { return false }
}
