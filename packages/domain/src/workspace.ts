import type { ProjectId, RepositoryId, WorkerId, WorkspaceId } from './ids.js'

export type WorkspaceStatus =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'failed'
  | 'deleting'
  | 'deleted'

export type RepositoryWorkspaceOwnership =
  | { readonly kind: 'standalone' }
  | {
      readonly kind: 'composite-member'
      readonly compositeWorkspaceId: WorkspaceId
      readonly role: 'ordinary' | 'coordination'
    }

export type WorkspaceSpec =
  | {
      readonly kind: 'repository'
      readonly repositoryId: RepositoryId
      readonly ownership: RepositoryWorkspaceOwnership
    }
  | {
      readonly kind: 'composite'
      readonly memberWorkspaceIds: readonly WorkspaceId[]
    }

export interface WorkspaceDefinition {
  readonly id: WorkspaceId
  readonly projectId: ProjectId
  readonly workerId: WorkerId
  readonly name: string
  readonly spec: WorkspaceSpec
  readonly status: WorkspaceStatus
  readonly failureReason: string | null
}

export interface RepositoryCheckoutSpec {
  readonly repositoryId: RepositoryId
  readonly gitUrl: string
  readonly revision: string
}

/** Worker-owned path observations may be reported to Server but never sent as provisioning input. */
export interface WorkspaceLocationObservation {
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly rootPath: string
  readonly checkouts: readonly {
    readonly repositoryId: RepositoryId
    readonly absolutePath: string
  }[]
}

/** Provisioning input deliberately contains no Worker absolute path or credentials. */
export interface WorkspaceProvisionSpec {
  readonly workspace: WorkspaceDefinition
  readonly repositories: readonly RepositoryCheckoutSpec[]
}
