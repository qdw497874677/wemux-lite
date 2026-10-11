import { createHash, sign, type KeyObject } from 'node:crypto'
import type { CommandId, ProjectId, WorkerId, WorkspaceId } from '@wemux/domain'
import type { WorkerCommand } from '@wemux/wire-protocol'
import { authorizationBytes, type EnqueueAuthorization, type SignedEnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'

export interface ClusterAssertionDefaults {
  workerId: WorkerId
  projectId: ProjectId
  workspaceId: WorkspaceId
  actorId?: string
}

/**
 * Builds a signed v3 command assertion for any WorkerCommand kind, deriving the
 * scope fields the way the Server does at issuance. Test fixtures use this to
 * deliver authorized cluster frames without hand-rolling claims per kind.
 */
export function clusterCommandAssertion(privateKey: KeyObject, keyId: string, defaults: ClusterAssertionDefaults, id: string, command: WorkerCommand): SignedEnqueueAuthorization {
  const claims: EnqueueAuthorization = {
    version: 3,
    kind: command.kind,
    keyId,
    commandId: id as CommandId,
    workerId: defaults.workerId,
    sessionId: command.kind === 'session.create' ? command.session.sessionId : 'sessionId' in command ? command.sessionId : null,
    projectId: command.kind === 'workspace.provision' ? command.workspace.workspace.projectId : defaults.projectId,
    workspaceId: command.kind === 'session.create' ? command.session.binding.workspaceId : command.kind === 'workspace.provision' ? command.workspace.workspace.id : 'sessionId' in command ? defaults.workspaceId : null,
    taskId: null,
    actorId: (command.kind === 'session.enqueue' ? command.message.sentByAccountId : command.kind === 'runtime.approval.resolve' ? (command.decidedByAccountId ?? 'actor') : (defaults.actorId ?? 'actor')) as never,
    actorAuthVersion: 1,
    commandDigest: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  }
  return { claims, signature: sign(null, authorizationBytes(claims), privateKey).toString('base64url') }
}
