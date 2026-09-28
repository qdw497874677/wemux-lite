import type { ProjectId, SessionId, UserId, WorkerId, WorkspaceId } from '@wemux/domain'

export type ArtifactTaskId = string
export type ArtifactRunId = string
export const ARTIFACT_REVIEW_STATES = ['pending', 'approved', 'changes_requested'] as const
export type ArtifactReviewState = typeof ARTIFACT_REVIEW_STATES[number]
export type ArtifactSource = 'manual'
export const ARTIFACT_TIMELINE_SOURCE_KIND = 'artifact' as const

export interface Artifact {
  readonly id: string
  readonly projectId: ProjectId
  readonly taskId: ArtifactTaskId
  readonly runId: ArtifactRunId
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly relativePath: string
  readonly mimeType: string
  readonly size: number
  readonly source: ArtifactSource
  readonly reviewState: ArtifactReviewState
  readonly revision: number
  readonly createdBy: UserId
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RegisterArtifactCommand {
  readonly artifactId: string
  readonly taskId: ArtifactTaskId
  readonly runId: ArtifactRunId
  readonly relativePath: string
  readonly mimeType: string
  readonly size: number
  readonly requestId: string
}

export interface ReviewArtifactCommand {
  readonly artifactId: string
  readonly decision: 'approved' | 'changes_requested'
  readonly expectedRevision: number
  readonly requestId: string
}

export interface ArtifactApplicationPort {
  register(actorId: UserId, command: RegisterArtifactCommand): Promise<Artifact>
  review(actorId: UserId, command: ReviewArtifactCommand): Promise<Artifact>
  listByTask(actorId: UserId, taskId: ArtifactTaskId): Promise<readonly Artifact[]>
  get(actorId: UserId, artifactId: string): Promise<Artifact>
}
