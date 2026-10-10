import type { CommandId, ProjectId, SessionId, UserId, WorkerId, WorkspaceId } from '@wemux/domain'

/** Signed by the Server, pinned during authenticated enrollment; never accept a key from a frame. */
export interface EnqueueAuthorization {
  readonly version: 1 | 2
  readonly kind?: 'runtime.approval.resolve'
  readonly keyId: string
  readonly commandId: CommandId
  readonly workerId: WorkerId
  readonly sessionId: SessionId
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly taskId: string | null
  readonly actorId: UserId
  readonly actorAuthVersion: number
  readonly commandDigest: string
  readonly issuedAt: string
  readonly expiresAt: string
}
export interface SignedEnqueueAuthorization {
  readonly claims: EnqueueAuthorization
  readonly signature: string
}
export function authorizationBytes(claims: EnqueueAuthorization): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version: claims.version, ...(claims.version === 2 ? { kind: claims.kind } : {}), keyId: claims.keyId, commandId: claims.commandId, workerId: claims.workerId, sessionId: claims.sessionId, projectId: claims.projectId, workspaceId: claims.workspaceId, taskId: claims.taskId, actorId: claims.actorId, actorAuthVersion: claims.actorAuthVersion, commandDigest: claims.commandDigest, issuedAt: claims.issuedAt, expiresAt: claims.expiresAt }))
}
