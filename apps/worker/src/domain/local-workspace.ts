import type {
  ProjectId,
  RepositoryId,
  Timestamp,
  WorkerId,
  WorkspaceId,
  WorkspaceSpec,
  WorkspaceStatus,
} from '@wemux/domain'

export interface LocalWorkspace {
  readonly provisionCommandId?: import('@wemux/domain').CommandId
  readonly id: WorkspaceId
  readonly workerId: WorkerId
  readonly projectId: ProjectId
  readonly rootPath: string
  readonly spec: WorkspaceSpec
  readonly provisionSpec?: import('@wemux/domain').WorkspaceProvisionSpec
  readonly status: WorkspaceStatus
  readonly failureReason: string | null
  readonly updatedAt: Timestamp
}

export interface RepositoryCheckout {
  readonly workspaceId: WorkspaceId
  readonly repositoryId: RepositoryId
  readonly absolutePath: string
  readonly revision: string
}
