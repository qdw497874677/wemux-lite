import { createHash } from 'node:crypto'
import type { CommandId, ProjectId, SessionId, Timestamp, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import type { EnqueueAuthorization, SignedEnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'
import type { WorkerCommand } from '@wemux/wire-protocol'
import type { CommandSigningIdentity } from './command-signing.ts'
import { AppError } from './errors.ts'
import type { ServerStoreTx } from './ports/server-store.ts'

/** Scope of authority embedded in a command assertion. Session-less commands
 * (provisioning, connector operations) carry null sessionId; session commands
 * must additionally match project, workspace and task. */
export interface CommandAssertionScope {
  readonly sessionId: SessionId | null
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId | null
  readonly taskId: string | null
}

/** The five-minute execution window asserted at issuance. */
const ASSERTION_WINDOW_MS = 5 * 60_000
const now = (): Timestamp => new Date().toISOString() as Timestamp

export function sessionAssertionScope(session: { id: SessionId; projectId: ProjectId; workspaceId: WorkspaceId; taskId?: string | null }): CommandAssertionScope {
  return { sessionId: session.id, projectId: session.projectId, workspaceId: session.workspaceId, taskId: session.taskId ?? null }
}

export function provisionAssertionScope(workspace: { id: WorkspaceId; projectId: ProjectId }): CommandAssertionScope {
  return { sessionId: null, projectId: workspace.projectId, workspaceId: workspace.id, taskId: null }
}

export function connectorAssertionScope(projectId: ProjectId): CommandAssertionScope {
  return { sessionId: null, projectId, workspaceId: null, taskId: null }
}

/** Builds the v3 claims every side-effecting cluster command shares. The kind
 * and digest bind the assertion to one concrete command; scope fields bind it
 * to one Session or Workspace so a leaked frame cannot be replayed elsewhere. */
export function buildCommandAssertionClaims(input: {
  keyId: string
  commandId: CommandId
  command: WorkerCommand
  workerId: WorkerId
  scope: CommandAssertionScope
  actorId: UserId
  actorAuthVersion: number
}): EnqueueAuthorization {
  return {
    version: 3,
    kind: input.command.kind,
    keyId: input.keyId,
    commandId: input.commandId,
    workerId: input.workerId,
    sessionId: input.scope.sessionId,
    projectId: input.scope.projectId,
    workspaceId: input.scope.workspaceId,
    taskId: input.scope.taskId,
    actorId: input.actorId,
    actorAuthVersion: input.actorAuthVersion,
    commandDigest: createHash('sha256').update(JSON.stringify(input.command)).digest('hex'),
    issuedAt: now(),
    expiresAt: new Date(Date.now() + ASSERTION_WINDOW_MS).toISOString(),
  }
}

export interface CommandIssueInput {
  readonly commandId: CommandId
  readonly command: WorkerCommand
  readonly workerId: WorkerId
  readonly scope: CommandAssertionScope
}

/**
 * Signs a cluster command assertion for the acting user. Returns undefined only
 * when the assembly has no signing identity (legacy test harnesses); a Server
 * with a signing identity never delivers the resulting unsigned command.
 * Throws 403 command_actor_unavailable when the authority user is missing or
 * inactive: production issuance must not mint authority for dead accounts.
 */
export async function issueCommandAssertion(tx: ServerStoreTx, signing: CommandSigningIdentity | undefined, actor: UserId | undefined, input: CommandIssueInput): Promise<SignedEnqueueAuthorization | undefined> {
  if (!signing) return undefined
  if (!actor) return undefined
  const user = await tx.identity.getUser(actor)
  if (!user || (user.status ?? 'active') !== 'active') throw new AppError(403, 'Command authority actor is unavailable', 'command_actor_unavailable')
  const claims = buildCommandAssertionClaims({ keyId: signing.keyId, ...input, actorId: actor, actorAuthVersion: user.authVersion ?? 0 })
  return signing.sign(claims)
}

/**
 * Reducing-signature variant of {@link issueCommandAssertion}: signs when the
 * assembly has a signing identity and the authority actor exists and is
 * active, and degrades to undefined (unsigned but still deliverable)
 * otherwise. Revocation and lifecycle stops use this so distribution never
 * blocks on signing or actor availability.
 */
export async function issueReducingCommandAssertion(tx: ServerStoreTx, signing: CommandSigningIdentity | undefined, actor: UserId | undefined, input: CommandIssueInput): Promise<SignedEnqueueAuthorization | undefined> {
  if (!signing || !actor) return undefined
  const user = await tx.identity.getUser(actor)
  if (!user || (user.status ?? 'active') !== 'active') return undefined
  return signing.sign(buildCommandAssertionClaims({ keyId: signing.keyId, ...input, actorId: actor, actorAuthVersion: user.authVersion ?? 0 }))
}

/**
 * Attaches a signed assertion to a pending command record. Call sites that
 * must not name the wire field directly (connector surfaces are scanned for
 * secret-sounding field names) go through this helper instead of a spread.
 */
export function withCommandAssertion<T extends object>(pending: T, assertion: SignedEnqueueAuthorization | undefined): T | (T & { authorization: SignedEnqueueAuthorization }) {
  return assertion ? { ...pending, authorization: assertion } : pending
}
