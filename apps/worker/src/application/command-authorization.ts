import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import type { CommandId, WorkerId } from '@wemux/domain'
import type { WorkerCommand } from '@wemux/wire-protocol'
import {
  assertionScopeMatches,
  assertionVersionAccepted,
  authorizationBytes,
  isWorkerCommandKind,
  type EnqueueAuthorization,
  type SignedEnqueueAuthorization,
} from '@wemux/wire-protocol/command-assertion'

/** Cluster identity pinned at authenticated enrollment; never taken from frames. */
export interface CommandAuthorizationIdentity {
  readonly commandSigningKey?: { readonly keyId: string; readonly publicKey: string } | null
}

export type CommandAuthorizationFailure =
  | 'unknown_command_kind'
  | 'authorization_missing'
  | 'authorization_invalid'
  | 'authorization_expired'

const SIGNATURE_WINDOW_MS = 5 * 60_000
const CLOCK_SKEW_MS = 30_000

/**
 * Fail-closed assessment of a cluster command's Server-signed assertion.
 * Returns null only when the assertion proves: the command kind is known, the
 * signature comes from the pinned instance key, this Worker is the audience,
 * the claims scope binds exactly this command payload, and the signing window
 * is valid. `atLaunch` allows an already-accepted assertion whose window has
 * expired since: launch-time authority comes from the online Server re-check,
 * not from extending the old signature.
 */
export function commandAuthorizationFailure(
  identity: CommandAuthorizationIdentity | null | undefined,
  workerId: WorkerId,
  commandId: CommandId,
  command: WorkerCommand,
  assertion: SignedEnqueueAuthorization | undefined,
  atLaunch = false,
): CommandAuthorizationFailure | null {
  if (!isWorkerCommandKind(command?.kind)) return 'unknown_command_kind'
  if (!identity?.commandSigningKey) return 'authorization_missing'
  if (!assertion) return 'authorization_missing'
  try {
    const claims = assertion.claims
    if (!assertionVersionAccepted(command.kind, claims.version)) return 'authorization_invalid'
    if (claims.version >= 2 && claims.kind !== command.kind) return 'authorization_invalid'
    if (claims.keyId !== identity.commandSigningKey.keyId) return 'authorization_invalid'
    if (claims.commandId !== commandId) return 'authorization_invalid'
    if (claims.workerId !== workerId) return 'authorization_invalid'
    if (!assertionScopeMatches(claims, command)) return 'authorization_invalid'
    // The command payload names the acting account for user-driven kinds; the
    // assertion must authorize exactly that actor.
    const actorField =
      command.kind === 'session.enqueue'
        ? command.message.sentByAccountId
        : command.kind === 'runtime.approval.resolve'
          ? command.decidedByAccountId
          : undefined
    if (actorField !== undefined && claims.actorId !== actorField) return 'authorization_invalid'
    if (!Number.isSafeInteger(claims.actorAuthVersion) || claims.actorAuthVersion < 0) return 'authorization_invalid'
    if (claims.commandDigest !== createHash('sha256').update(JSON.stringify(command)).digest('hex')) return 'authorization_invalid'
    const issuedAt = Date.parse(claims.issuedAt)
    const expiresAt = Date.parse(claims.expiresAt)
    const current = Date.now()
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return 'authorization_invalid'
    if (issuedAt > current + CLOCK_SKEW_MS) return 'authorization_invalid'
    if (expiresAt <= issuedAt) return 'authorization_invalid'
    if (expiresAt - issuedAt > SIGNATURE_WINDOW_MS) return 'authorization_invalid'
    if (!atLaunch && expiresAt <= current) return 'authorization_expired'
    if (claims.keyId !== createHash('sha256').update(identity.commandSigningKey.publicKey).digest('hex')) return 'authorization_invalid'
    const verified = verifySignature(
      null,
      authorizationBytes(claims),
      createPublicKey(identity.commandSigningKey.publicKey),
      Buffer.from(assertion.signature, 'base64url'),
    )
    if (!verified) return 'authorization_invalid'
    return null
  } catch {
    return 'authorization_invalid'
  }
}

export function verifyCommandAuthorization(
  identity: CommandAuthorizationIdentity | null | undefined,
  workerId: WorkerId,
  commandId: CommandId,
  command: WorkerCommand,
  assertion: SignedEnqueueAuthorization | undefined,
  atLaunch = false,
): boolean {
  return commandAuthorizationFailure(identity, workerId, commandId, command, assertion, atLaunch) === null
}
