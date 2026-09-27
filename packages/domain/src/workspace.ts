import type { ProjectId, RepositoryId, WorkerId, WorkspaceId } from './ids.js'

export type WorkspacePlacementStatus =
  | 'ready'
  | 'stopped'
  | 'deleted'
  | 'failed'
  | 'unhealthy'

/** Worker-local provisioning reports retain operation phases; Server placements expose lifecycle states. */
export type WorkspaceStatus =
  | 'unplaced'
  | 'pending'
  | 'provisioning'
  | WorkspacePlacementStatus
  | 'deleting'

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

/** Project-scoped logical Workspace. Worker ownership belongs to placements, not identity. */
export interface WorkspaceDefinition {
  readonly id: WorkspaceId
  readonly projectId: ProjectId
  readonly name: string
  readonly spec: WorkspaceSpec
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
