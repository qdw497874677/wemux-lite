import type { Artifact, ArtifactApplicationPort, RegisterArtifactCommand, ReviewArtifactCommand, UserId } from '@wemux/server-domain'
import type { ProjectId, SessionId, WorkerId, WorkspaceId } from '@wemux/domain'
import type { ArtifactRepository } from './ports/artifact-repository.ts'
import { AppError } from './errors.ts'
import type { ServerStore } from './ports/server-store.ts'
import type { ProjectAccessService } from './project-access-service.ts'

export class ArtifactService implements ArtifactApplicationPort {
  readonly #repository: ArtifactRepository
  readonly #store: ServerStore
  readonly #access: ProjectAccessService
  readonly #now: () => Date
  constructor(repository: ArtifactRepository, store: ServerStore, access: ProjectAccessService, now: () => Date = () => new Date()) { this.#repository = repository; this.#store = store; this.#access = access; this.#now = now }

  async register(actorId: UserId, command: RegisterArtifactCommand): Promise<Artifact> {
    if (!command.relativePath || command.relativePath.startsWith('/') || command.relativePath.split('/').includes('..')) throw new AppError(400, 'Artifact path must be relative', 'invalid_artifact_path')
    if (!Number.isSafeInteger(command.size) || command.size < 0) throw new AppError(400, 'Artifact size is invalid', 'invalid_artifact_size')
    const task = await this.#store.tasks.get(command.taskId)
    if (!task) throw new Error('Task not found')
    await this.#access.require(actorId, task.projectId as ProjectId, 'contributor')
    const run = (await this.#store.tasks.runs(task.id)).find(item => item.id === command.runId)
    if (!run || run.status !== 'succeeded' || !run.sessionId || !run.snapshot?.workerId || !run.snapshot.workspaceId) throw new Error('Artifact requires a completed run with a session')
    const now = this.#now().toISOString()
    const artifact: Artifact = { id: command.artifactId, projectId: task.projectId as ProjectId, taskId: task.id, runId: run.id, sessionId: run.sessionId as SessionId, workspaceId: run.snapshot.workspaceId as WorkspaceId, workerId: run.snapshot.workerId as WorkerId, relativePath: command.relativePath, mimeType: command.mimeType, size: command.size, source: 'manual', reviewState: 'pending', revision: 1, createdBy: actorId, createdAt: now, updatedAt: now }
    try { return await this.#repository.create(artifact, command.requestId, JSON.stringify(artifact), now) } catch (error) { throw this.#translate(error) }
  }

  async review(actorId: UserId, command: ReviewArtifactCommand): Promise<Artifact> {
    const existing = await this.#repository.get(command.artifactId)
    if (!existing) throw new Error('Artifact not found')
    await this.#access.require(actorId, existing.projectId, 'contributor')
    try { return await this.#repository.review(existing.id, command.decision, command.expectedRevision, command.requestId, this.#now().toISOString()) } catch (error) { throw this.#translate(error) }
  }

  async listByTask(actorId: UserId, taskId: Artifact['taskId']): Promise<readonly Artifact[]> { const task = await this.#store.tasks.get(taskId); if (!task) throw new Error('Task not found'); await this.#access.require(actorId, task.projectId as ProjectId); return this.#repository.listByTask(taskId) }
  async get(actorId: UserId, artifactId: string): Promise<Artifact> { const artifact = await this.#repository.get(artifactId); if (!artifact) throw new AppError(404, 'Artifact not found', 'artifact_not_found'); await this.#access.require(actorId, artifact.projectId); return artifact }
  #translate(error: unknown): Error { const message = error instanceof Error ? error.message : String(error); if (message === 'Idempotency conflict') return new AppError(409, message, 'idempotency_conflict'); if (message === 'Revision conflict') return new AppError(409, message, 'revision_conflict'); if (message === 'Artifact not found') return new AppError(404, message, 'artifact_not_found'); return error instanceof Error ? error : new Error(message) }
}
