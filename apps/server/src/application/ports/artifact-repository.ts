import type { Artifact, ArtifactReviewState } from '@wemux/server-domain'

export interface ArtifactRepository {
  create(artifact: Artifact, requestId: string, responseBody: string, now: string): Promise<Artifact>
  get(id: string): Promise<Artifact | null>
  listByTask(taskId: string): Promise<readonly Artifact[]>
  review(id: string, decision: Exclude<ArtifactReviewState, 'pending'>, expectedRevision: number, requestId: string, now: string): Promise<Artifact>
}
