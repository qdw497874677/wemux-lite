import type {
  AgentCapability,
  ProjectId,
  RepositoryId,
  SessionBinding,
  SessionId,
  SessionRuntimeState,
  TeamId,
  Timestamp,
  UserId,
  WorkerId,
  WorkspaceDefinition,
  WorkspaceId,
  WorkspaceLocationObservation,
} from '@wemux/domain'
import type { ResourceShareScope, SessionShareScope } from './access.js'

export type WorkerConnectionState = 'online' | 'offline' | 'revoked'

export interface Worker {
  readonly id: WorkerId
  readonly teamId: TeamId
  readonly ownerId: UserId
  readonly name: string
  readonly shareScope: ResourceShareScope
  readonly connectionState: WorkerConnectionState
  readonly version: string | null
  readonly platform: string | null
  readonly capabilities: readonly AgentCapability[]
  readonly lastSeenAt: Timestamp | null
}

export interface Project {
  readonly id: ProjectId
  readonly teamId: TeamId
  readonly ownerId: UserId
  readonly name: string
  readonly shareScope: ResourceShareScope
  readonly deletedAt: Timestamp | null
}

export interface Repository {
  readonly id: RepositoryId
  readonly projectId: ProjectId
  readonly name: string
  readonly gitUrl: string
  readonly defaultBranch: string
}

export interface Workspace extends WorkspaceDefinition {
  /** Durable Server-side provisioning attempt, independent of Session execution. */
  readonly provisioning?: {
    readonly commandId: string
    readonly startedAt: string
    readonly reportedAt?: string
    /** True only after issuing a replacement command, never for request coalescing. */
    readonly replacedAttempt?: boolean
    readonly requests: Readonly<Record<string, string>>
  }
  /** Read-only observation reported by the owning Worker after provisioning. */
  readonly location: WorkspaceLocationObservation | null
}

export interface Session {
  /** Immutable creation provenance; absent only on legacy standalone Sessions. */
  readonly taskId?: string | null
  readonly runId?: string | null
  readonly id: SessionId
  readonly projectId: ProjectId
  readonly ownerId: UserId
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly shareScope: SessionShareScope
  readonly binding: SessionBinding
  readonly runtimeState: SessionRuntimeState
  readonly deletedAt: Timestamp | null
}
