import type {
  CommandId,
  ProjectId,
  SessionId,
  UserId,
  WorkerId,
  WorkspaceId,
} from '@wemux/domain'
import type { WorkerCommand } from './commands.js'

/**
 * Server-signed short-term authorization for one side-effecting cluster command.
 *
 * v1 signed `session.enqueue` only; v2 added `runtime.approval.resolve` with a
 * bound command kind; v3 extends the same assertion shape to every
 * side-effecting cluster command kind and allows session-less scope fields
 * (`sessionId`/`workspaceId` null for workspace- or connector-level commands).
 * Byte layout of earlier versions is frozen: v1/v2 serialization must not
 * change so records signed before the v3 rollout still verify.
 */
export interface EnqueueAuthorization {
  readonly version: 1 | 2 | 3
  /**
   * Command kind bound into the assertion. Required for v2+; v1 implicitly
   * authorizes `session.enqueue`.
   */
  readonly kind?: WorkerCommand['kind']
  readonly keyId: string
  readonly commandId: CommandId
  /** Audience: the single Worker allowed to execute the command. */
  readonly workerId: WorkerId
  /** v1/v2 always reference a session; v3 uses null for session-less commands. */
  readonly sessionId: SessionId | null
  readonly projectId: ProjectId | null
  readonly workspaceId: WorkspaceId | null
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

/** Every kind the cluster transport may legally carry; anything else fails closed. */
export const WORKER_COMMAND_KINDS: readonly string[] = [
  'workspace.provision',
  'workspace.delete',
  'session.create',
  'session.enqueue',
  'session.attachment.deliver',
  'session.cancel-queued',
  'session.delete',
  'turn.stop',
  'runtime.command',
  'runtime.approval.resolve',
  'connector.definition.sync',
  'connector.definition.revoke',
  'connector.test',
]

/**
 * Cluster command kinds that must carry a Server-signed assertion before any
 * Worker side effect. Currently every known kind is side-effecting, so this
 * list equals {@link WORKER_COMMAND_KINDS}; a future read-only kind would be
 * listed in WORKER_COMMAND_KINDS but not here.
 */
export const ASSERTION_REQUIRED_COMMAND_KINDS: readonly string[] = [...WORKER_COMMAND_KINDS]

export function isWorkerCommandKind(kind: unknown): kind is WorkerCommand['kind'] {
  return typeof kind === 'string' && WORKER_COMMAND_KINDS.includes(kind)
}

/** True when the kind needs a Server-signed assertion before any side effect. */
export function requiresCommandAssertion(kind: unknown): boolean {
  return typeof kind === 'string' && ASSERTION_REQUIRED_COMMAND_KINDS.includes(kind)
}

/**
 * Assertion versions accepted per command kind. `session.enqueue` keeps v1 and
 * `runtime.approval.resolve` keeps v2 so records signed before the v3 rollout
 * (and their replay after a same-version restart) still authorize; every other
 * kind requires v3.
 */
export function assertionVersionAccepted(commandKind: string, version: unknown): boolean {
  if (version !== 1 && version !== 2 && version !== 3) return false
  if (commandKind === 'session.enqueue') return version === 1 || version === 3
  if (commandKind === 'runtime.approval.resolve') return version === 2 || version === 3
  return version === 3
}

/**
 * Scope binding between claims and the command payload. Both the Server
 * re-check and the Worker verification use this same rule, so the definition
 * of "this assertion authorizes exactly this command" lives in one place.
 * Project-level scope is checked by the Server only: the Worker's session
 * records do not carry `projectId`.
 */
export function assertionScopeMatches(
  claims: EnqueueAuthorization,
  command: WorkerCommand,
): boolean {
  switch (command.kind) {
    case 'session.enqueue':
    case 'session.attachment.deliver':
    case 'session.cancel-queued':
    case 'session.delete':
    case 'turn.stop':
    case 'runtime.command':
    case 'runtime.approval.resolve':
      return claims.sessionId === command.sessionId
    case 'session.create':
      return (
        claims.sessionId === command.session.sessionId &&
        claims.workspaceId === command.session.binding.workspaceId
      )
    case 'workspace.provision':
      return (
        claims.sessionId === null &&
        claims.workspaceId === command.workspace.workspace.id &&
        claims.projectId === command.workspace.workspace.projectId
      )
    case 'workspace.delete':
      return claims.sessionId === null && claims.workspaceId === command.workspaceId
    case 'connector.definition.sync':
      return (
        claims.sessionId === null &&
        claims.workspaceId === null &&
        claims.projectId === command.definition.projectId
      )
    case 'connector.definition.revoke':
    case 'connector.test':
      return (
        claims.sessionId === null && claims.workspaceId === null && claims.projectId === command.projectId
      )
  }
}

export function authorizationBytes(claims: EnqueueAuthorization): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: claims.version,
      ...(claims.version >= 2 ? { kind: claims.kind } : {}),
      keyId: claims.keyId,
      commandId: claims.commandId,
      workerId: claims.workerId,
      sessionId: claims.sessionId,
      projectId: claims.projectId,
      workspaceId: claims.workspaceId,
      taskId: claims.taskId,
      actorId: claims.actorId,
      actorAuthVersion: claims.actorAuthVersion,
      commandDigest: claims.commandDigest,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    }),
    'utf8',
  )
}
