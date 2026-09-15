import type { AgentCapability, SessionId } from '@wemux/domain'
import type { WorkerIdentity } from '../../domain/worker-identity.js'
import type { SessionExecution } from '../../domain/session-execution.js'
import type { LocalWorkspace } from '../../domain/local-workspace.js'

export interface LocalState {
  identity(): WorkerIdentity | null
  saveIdentity(identity: WorkerIdentity): void
  capabilities(): readonly AgentCapability[]
  saveCapabilities(capabilities: readonly AgentCapability[]): void
  listSessions(): Promise<readonly SessionExecution[]>
  listWorkspaces(): Promise<readonly LocalWorkspace[]>
}
export interface WorkspaceProvisioner {
  stop?(): Promise<void>
  provision(input: import('@wemux/domain').WorkspaceProvisionSpec): Promise<{
    rootPath: string
    checkouts: readonly import('../../domain/local-workspace.js').RepositoryCheckout[]
  }>
}
export interface RuntimeTransport {
  send(message: import('@wemux/wire-protocol').WorkerToServer): void
}
export type SessionTask = { sessionId: SessionId; done: Promise<void> }
