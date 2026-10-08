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
  WorkspacePlacementStatus,
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
  /** Absent on historical projects means no mandatory review. */
  readonly reviewPolicy?: 'none' | 'agent' | 'human' | 'multi-stage'
  /** Dedicated CAS for the project review default; historical records read as version 1. */
  readonly reviewPolicyVersion?: number
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

export interface WorkspaceProvisioningAttempt {
  readonly commandId: string
  readonly startedAt: string
  readonly reportedAt?: string
  /** Validated current command terminal report only; never inferred from ACK/receipt/legacy reportedAt. */
  readonly terminalReport?: { readonly commandId: string; readonly workerId: WorkerId; readonly status: 'ready' | 'failed'; readonly occurredAt: string }
  /** True only after issuing a replacement command, never for request coalescing. */
  readonly replacedAttempt?: boolean
  readonly requests: Readonly<Record<string, string>>
}

export interface WorkspacePlacement {
  readonly workerId: WorkerId
  readonly status: WorkspacePlacementStatus
  readonly failureReason: string | null
  readonly provisioning?: WorkspaceProvisioningAttempt
  /** Read-only observation reported by this Worker after provisioning. */
  readonly location: WorkspaceLocationObservation | null
}

export interface Workspace extends WorkspaceDefinition {
  /** A logical Workspace may be materialized independently on several Workers. */
  readonly placements: readonly WorkspacePlacement[]
  readonly deletedAt: Timestamp | null
  /** @deprecated Single-placement compatibility view. New code must use placements. */
  readonly workerId?: WorkerId
  /** @deprecated Single-placement compatibility view. New code must use placements. */
  readonly status?: import('@wemux/domain').WorkspaceStatus
  /** @deprecated Single-placement compatibility view. New code must use placements. */
  readonly failureReason?: string | null
  /** @deprecated Single-placement compatibility view. New code must use placements. */
  readonly provisioning?: WorkspaceProvisioningAttempt
  /** @deprecated Single-placement compatibility view. New code must use placements. */
  readonly location?: WorkspaceLocationObservation | null
}

export interface Session {
  /** Resolved at creation; absent only on legacy records, interpreted as local on read. */
  readonly storageMode?: import('@wemux/domain').SessionStorageMode
  /** Immutable creation provenance; absent only on legacy standalone Sessions. */
  readonly taskId?: string | null
  readonly runId?: string | null
  /** Durable idempotency identity for standalone Session creation. */
  readonly creation?: {
    readonly requestId: string
    readonly fingerprint: string
    readonly commandId: string
  }
  readonly id: SessionId
  readonly projectId: ProjectId
  readonly ownerId: UserId
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly shareScope: SessionShareScope
  readonly binding: SessionBinding
  readonly runtimeState: SessionRuntimeState
  /** Absent on legacy records; archiving never deletes execution history. */
  readonly archivedAt?: Timestamp | null
  readonly deletedAt: Timestamp | null
}
