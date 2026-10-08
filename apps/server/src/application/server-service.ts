import { workspaceRevision } from './workspace-revision.ts'
import { admitFileWriteInTx, snapshotFileWriteInput } from './file-write-admission.ts'
import { FileWriteResultRejectedError, FileWriteResultUnavailableError, fileWriteResultAck, snapshotFileWriteResult } from './file-write-results.ts'
import { assertSessionTaskMutable } from './task-lifecycle.ts'
import { createRequest, replayCreate, recordCreate } from './create-request.ts'
import { dedicatedConversationTask } from './dedicated-conversation-task.ts'
import { sessionIdleReason } from './session-idle.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AgentKey, ApprovalId, CommandId, EventSeq, Id, MessageId, ModelId, ProjectId, RuntimeOperationId, SessionId, TeamId, Timestamp, TurnId, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import type { AuditResource, CommandProjection, Project, Session, Worker, Workspace, WorkspacePlacement } from '@wemux/server-domain'
import type { WorkerCommand } from '@wemux/wire-protocol'
import type { ServerStore, ServerStoreTx } from './ports/server-store.ts'
import { AppError, requireValue } from './errors.ts'
import { hashSecret } from './auth.ts'
import { sendCapability } from './action-capabilities.ts'
import type { CapabilityService } from './capability-service.ts'
import { Notifications } from './notifications.ts'
import { integer, object, text } from './validation.ts'
import type { WorkerAccessService } from './worker-access-service.ts'
import type { ProjectAccessService } from './project-access-service.ts'
import type { SessionAccessService } from './session-access-service.ts'

export const newId = <N extends string>(): Id<N> => randomUUID() as Id<N>
export const now = (): Timestamp => new Date().toISOString() as Timestamp
const teamId = 'default-team' as TeamId
const projectId = 'default-project' as ProjectId

/** Creation provenance a composing service may attach without re-implementing binding validation. */
export interface SessionProvenance {
  readonly taskId?: string | null
  readonly runId?: string | null
  /** Operator the Session belongs to; defaults to the instance administrator. */
  readonly ownerId?: UserId
  /** Task-owned Session defaults may be broader than the direct-chat owner-only default. */
  readonly shareScope?: import('@wemux/server-domain').SessionShareScope
}

/** Inputs the Session Lineage module may set on a Fork target; binding validation stays here. */
export interface ForkTargetSessionInput {
  readonly taskId?: string | null
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly agentKey: AgentKey
  readonly modelId: ModelId | null
  readonly title: string
  readonly ownerId: UserId
  readonly storageMode?: import('@wemux/domain').SessionStorageMode
  /** 发起 Fork 的 requestId；目标 Session 的创建身份由它派生，不另开一套幂等键。 */
  readonly requestId: string
}

export class ServerService {
  private readonly store: ServerStore
    readonly notifications: Notifications
  private readonly capabilities?: CapabilityService
  private readonly workerAccess?: WorkerAccessService
  private readonly projectAccess?: ProjectAccessService
  private readonly sessionAccess?: SessionAccessService
  constructor(store: ServerStore, notifications: Notifications, capabilities?: CapabilityService, workerAccess?: WorkerAccessService, projectAccess?: ProjectAccessService, sessionAccess?: SessionAccessService) { this.store = store; this.notifications = notifications; this.capabilities = capabilities; this.workerAccess = workerAccess; this.projectAccess = projectAccess; this.sessionAccess = sessionAccess;}
  async requireWorkerUseInTx(tx: ServerStoreTx, actor: UserId, workerId: WorkerId) {
    return this.workerAccess ? this.workerAccess.requireInTx(tx, actor, workerId) : requireValue(await tx.resources.getWorker(workerId))
  }
  async listWorkers() { return this.store.resources.listWorkers() }
  async getWorker(id: WorkerId) { return requireValue(await this.store.resources.getWorker(id)) }
  async getCommand(id: CommandId) { return requireValue(await this.store.commands.get(id)) }
  async listCommands(input: { workerId?: string; status?: string; limit?: number }) {
    const statuses: readonly CommandProjection['status'][] = ['pending', 'accepted', 'rejected', 'completed', 'failed', 'cancelled']
    const status = input.status === undefined ? undefined : statuses.find(value => value === input.status)
    if (input.status !== undefined && !status) throw new AppError(400, 'Unknown command status')
    return this.store.commands.list({ workerId: input.workerId as WorkerId | undefined, status, limit: input.limit && input.limit >= 1 && input.limit <= 500 ? Math.floor(input.limit) : 100 })
  }
  async cancelCommand(id: CommandId) {
    const command = await this.getCommand(id)
    const cancelled = await this.store.transaction(async tx => {
      requireValue(await tx.commands.get(id))
      // Pending does not mean undispatched: transport replay or a terminal report may
      // precede the application receipt. Generic cancellation cannot stop preparation.
      const pending = await tx.commands.getPendingCommand(id)
      if (pending?.command.kind === 'workspace.provision') throw new AppError(409, 'protected_command: Workspace preparation cancellation is unavailable', 'protected_command')
      if (await tx.tasks.runByCommand(id)) throw new AppError(409, 'protected_command: Run commands cannot be cancelled; Run cancellation is not implemented')
      if (!await tx.commands.cancelPending(id, now())) return false
      await this.audit(tx, 'command.cancel', { kind: 'worker', id: command.workerId })
      return true
    })
    if (!cancelled) throw new AppError(409, 'Only pending commands can be cancelled')
    this.notifications.commands(command.workerId)
    return await this.getCommand(id)
  }
  async revokeWorker(id: WorkerId, disconnect: (workerId: WorkerId) => void, actor?: UserId) {
    return this.revokeWorkerAs(id, disconnect, 'worker.revoke', actor)
  }
  async leaveWorker(id: WorkerId, disconnect: (workerId: WorkerId) => void) {
    return this.revokeWorkerAs(id, disconnect, 'worker.leave')
  }
  private async revokeWorkerAs(id: WorkerId, disconnect: (workerId: WorkerId) => void, action: 'worker.revoke' | 'worker.leave', actor?: UserId) {
    const worker = await this.getWorker(id)
    if (worker.connectionState === 'revoked') return worker
    await this.store.transaction(async tx => {
      await tx.resources.saveWorker({ ...worker, connectionState: 'revoked', lastSeenAt: now() })
      await tx.identity.revokeWorkerCredential(id, now())
      await this.audit(tx, action, { kind: 'worker', id }, actor)
    })
    disconnect(id)
    for (const session of await this.store.resources.listSessions()) if (session.binding.agent.workerId === id) this.notifications.session(session.id)
    return await this.getWorker(id)
  }
  async reprovisionWorkspace(id: WorkspaceId, requestId: string = randomUUID(), workerId?: WorkerId, actor?: UserId) {
    const result = await this.store.transaction(async tx => {
      const result = await this.reprovisionWorkspaceInTx(tx, id, requestId, workerId, actor)
      const binding = await tx.tasks.binding(id)
      if (result.created && binding) {
        const task = requireValue(await tx.tasks.get(binding.taskId)), at = now()
        await tx.tasks.save({ ...task, updatedAt: at, lastActivityAt: at })
        await tx.tasks.append({ taskId: task.id, projectId: task.projectId, type: 'workspace.retried', actor: actor ?? await this.operator(undefined, tx), requestId, occurredAt: at, payload: { workspaceId: id, workerId: result.workerId, commandId: result.commandId } })
      }
      return { ...result, taskId: binding?.taskId }
    })
    if (result.created) {
      this.notifications.commands(result.workerId)
      this.notifications.project({ id: randomUUID(), projectId: result.workspace.projectId, workspaceId: id, ...(result.taskId ? { taskId: result.taskId } : {}), type: 'workspace.provisioning' })
    }
    return result
  }
  async reprovisionWorkspaceInTx(tx: ServerStoreTx, id: WorkspaceId, requestId: string, requestedWorkerId?: WorkerId, actor?: UserId) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw new AppError(400, 'Invalid retry requestId')
    const workspace = await this.authorizedWorkspaceInTx(tx, id, actor)
    const legacyWorkerId = (workspace as Workspace & { workerId?: WorkerId }).workerId
    const workerId = requestedWorkerId ?? workspace.placements.find(placement => placement.status === 'failed' || placement.status === 'stopped')?.workerId ?? legacyWorkerId
    if (!workerId) throw new AppError(400, 'workerId is required when Workspace has no retryable placement')
    const worker = actor && this.workerAccess ? await this.workerAccess.requireInTx(tx, actor, workerId) : requireValue(await tx.resources.getWorker(workerId))
    if (actor && this.projectAccess) await this.projectAccess.requireInTx(tx, actor, workspace.projectId, 'contributor')
    if (worker.teamId !== (await this.getProject(workspace.projectId, tx.resources)).teamId || worker.connectionState === 'revoked') throw new AppError(403, 'Worker not usable')
    const placement = workspace.placements.find(value => value.workerId === worker.id)
    const previous = placement?.provisioning
    if (previous && Object.hasOwn(previous.requests, requestId)) {
      const commandId = previous.requests[requestId]
      if (typeof commandId === 'string' && commandId.trim()) return { workspace, workerId: worker.id, commandId, created: false }
    }
    if (placement && ['stopped', 'pending', 'provisioning'].includes(placement.status) && previous) {
      const nextPlacement = { ...placement, provisioning: { ...previous, requests: { ...previous.requests, [requestId]: previous.commandId } } }
      const next = this.replacePlacement(workspace, nextPlacement)
      await tx.resources.saveWorkspace(next)
      return { workspace: next, workerId: worker.id, commandId: previous.commandId, created: false }
    }
    if (placement && placement.status !== 'failed' && !['stopped', 'pending', 'provisioning'].includes(placement.status)) throw new AppError(409, 'Only absent, stopped or failed Workspace placements can be provisioned')
    const repositories = workspace.spec.kind === 'repository'
      ? [requireValue(await tx.resources.getRepository(workspace.spec.repositoryId))].map(repository => ({ repositoryId: repository.id, gitUrl: repository.gitUrl, revision: repository.defaultBranch })) : []
    if (workspace.spec.kind === 'composite' && workspace.spec.memberWorkspaceIds.length) throw new AppError(409, 'Composite workspace is not reprovisionable')
    // Preserve only a strictly correlated current terminal observation before replacement.
    // Legacy status/receipt-only attempts remain unknown, even when retry is allowed.
    if (placement) await this.preserveCurrentPreparationProof(tx, workspace, placement)
    const replacedAttempt = previous !== undefined || await tx.commands.hasProvisionAttempt(id)
    const commandId = await this.command(tx, worker.id, { kind: 'workspace.provision', workspace: { workspace: this.workspaceDefinition(workspace), repositories } })
    const nextPlacement: WorkspacePlacement = { workerId: worker.id, status: 'stopped', failureReason: null, location: null, provisioning: { commandId, startedAt: now(), replacedAttempt, requests: { ...previous?.requests, [requestId]: commandId } } }
    const next = this.replacePlacement(workspace, nextPlacement)
    await tx.resources.saveWorkspace(next)
    await this.audit(tx, 'workspace.reprovision', { kind: 'workspace', id })
    return { workspace: next, workerId: worker.id, commandId, created: true }
  }
  private async preserveCurrentPreparationProof(tx: ServerStoreTx, workspace: Workspace, placement: WorkspacePlacement) {
    const attempt = placement.provisioning, proof = attempt?.terminalReport
    if (!proof || (placement.status !== 'ready' && placement.status !== 'failed') || proof.status !== placement.status || proof.workerId !== placement.workerId || proof.commandId !== attempt?.commandId || typeof proof.occurredAt !== 'string' || !Number.isFinite(Date.parse(proof.occurredAt))) return null
    if (placement.location && (placement.location.workspaceId !== workspace.id || placement.location.workerId !== placement.workerId)) return null
    const command = await tx.commands.getPendingCommand(proof.commandId as CommandId)
    if (!command || command.command.kind !== 'workspace.provision' || command.command.workspace.workspace.id !== workspace.id || command.workerId !== placement.workerId) return null
    return tx.resources.recordWorkspacePreparationProof({ workspaceId: workspace.id, workerId: placement.workerId, commandId: proof.commandId, status: proof.status, occurredAt: proof.occurredAt })
  }
  private workspaceDefinition(workspace: Workspace) { return { id: workspace.id, projectId: workspace.projectId, name: workspace.name, spec: workspace.spec } }
  private replacePlacement(workspace: Workspace, placement: WorkspacePlacement): Workspace {
    const { workerId: _workerId, status: _status, failureReason: _failureReason, provisioning: _provisioning, location: _location, ...logical } = workspace
    return { ...logical, placements: [...workspace.placements.filter(value => value.workerId !== placement.workerId), placement] }
  }
  private placement(workspace: Workspace, workerId: WorkerId): WorkspacePlacement {
    const placement = workspace.placements.find(value => value.workerId === workerId)
    if (!placement) throw new AppError(409, 'Workspace is not prepared on selected Worker', 'workspace_not_ready')
    return placement
  }
  private async audit(tx: ServerStoreTx, action: string, resource: AuditResource, actor?: UserId): Promise<void> {
    await tx.audit.append({ id: newId(), actorId: actor ?? await this.operator(undefined, tx), action, resource, result: 'succeeded', occurredAt: now(), metadata: {} })
  }
  /**
   * 写操作的归属用户：集群控制面只有管理员能进来，调用方知道确切身份时用 `actor` 参数显式传入。
   * 没有管理员账号时直接失败，不再伪造 `bootstrap-admin` 这类合成用户；多管理员逐请求归属随团队授权一起做。
   * 已经在事务里的调用方必须传 `tx`，否则读到的是事务外的快照（存储层会直接报错，不静默漂移）。
   */
  private async operator(explicit?: UserId, tx?: ServerStoreTx): Promise<UserId> {
    if (explicit) return explicit
    const readers = tx ?? this.store
    const roster = [...await readers.identity.listInstanceAdministrators()].sort((a, b) => a.assignedAt.localeCompare(b.assignedAt))
    const record = roster[0]
    if (!record) throw new AppError(409, '实例还没有管理员账号：请先用部署声明的邮箱（WEMUX_ADMIN_EMAILS）注册或登录', 'administrator_not_configured')
    return record.userId
  }
  /**
   * 认领后默认环境的归属绑定：默认 Team 与 Project 仍用稳定 ID（单 Team 部署），
   * 但 owner 必须指向真实管理员，不创建合成用户。既有 Team/Project 不被改名或转移。
   */
  async ensureDefaultEnvironment(administratorUserId: UserId) {
    const at = now()
    return this.store.transaction(async tx => {
      const team = await tx.identity.getTeam(teamId)
      if (!team) {
        await tx.identity.saveTeam({ id: teamId, name: 'Default team', createdAt: at })
        await this.audit(tx, 'team.create', { kind: 'team', id: teamId })
      }
      const memberships = await tx.identity.listMemberships(administratorUserId)
      if (!memberships.some(membership => membership.teamId === teamId)) {
        await tx.identity.saveMembership({ teamId, userId: administratorUserId, role: 'owner', joinedAt: at })
      }
      let project = await tx.resources.getProject(projectId)
      if (!project) {
        project = { id: projectId, teamId, ownerId: administratorUserId, name: 'Default project', shareScope: 'owner-only', deletedAt: null }
        await tx.resources.saveProject(project)
      }
      return { team: await tx.identity.getTeam(teamId), project }
    })
  }
  async createEnrollment(input: unknown, actor?: UserId) {
    const b = object(input)
    const ttl = b.ttlSeconds === undefined ? 3600 : integer(b.ttlSeconds, 'ttlSeconds', 1, 86400)
    requireValue(await this.store.identity.getTeam(teamId), 'Bootstrap required')
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString() as Timestamp
    await this.store.transaction(async tx => {
      await tx.identity.saveEnrollmentToken({ id: newId(), teamId, createdBy: actor ?? await this.operator(undefined, tx), tokenHash: hashSecret(token), expiresAt, consumedByWorkerId: null, consumedAt: null })
      await this.audit(tx, 'enrollment-token.create', { kind: 'team', id: teamId }, actor)
    })
    return { token, expiresAt }
  }
  async enroll(input: unknown) {
    const b = object(input), token = text(b.token, 'token'), name = text(b.name, 'name', 200)
    const id = newId<'WorkerId'>(), credential = randomBytes(32).toString('base64url'), at = now()
    const worker = await this.store.transaction(async tx => {
      const enrollment = await tx.identity.consumeEnrollmentToken({ tokenHash: hashSecret(token), workerId: id, consumedAt: at })
      const worker: Worker = { id, teamId: enrollment.teamId, ownerId: enrollment.createdBy, name, shareScope: 'owner-only', connectionState: 'offline', version: null, platform: null, capabilities: [], lastSeenAt: null }
      await tx.resources.saveWorker(worker)
      await tx.identity.saveWorkerCredential({ id: newId(), workerId: id, credentialHash: hashSecret(credential), createdAt: at, revokedAt: null })
      await this.audit(tx, 'worker.enroll', { kind: 'worker', id })
      return worker
    })
    return { worker, workerId: id, credential }
  }
  async getProject(id: ProjectId, resources = this.store.resources): Promise<Project> {
    const p = requireValue(await resources.getProject(id))
    if (p.deletedAt) throw new AppError(404, 'Project deleted')
    return p
  }
  async getWorkspace(id: WorkspaceId, resources = this.store.resources): Promise<Workspace> {
    const w = requireValue(await resources.getWorkspace(id)); await this.getProject(w.projectId, resources)
    if (w.deletedAt) throw new AppError(410, 'Workspace is permanently deleted', 'workspace_deleted')
    return w
  }
  /** Actor-facing lookups authorize the raw identity before lifecycle/placement details. */
  private async authorizedWorkspaceInTx(tx: ServerStoreTx, id: WorkspaceId, actor?: UserId): Promise<Workspace> {
    const workspace = await tx.resources.getWorkspace(id)
    const hidden = () => new AppError(404, 'Workspace not found', 'workspace_not_found')
    if (!workspace) throw hidden()
    if (actor && this.projectAccess) {
      try { await this.projectAccess.requireInTx(tx, actor, workspace.projectId, 'contributor') }
      catch (error) { if (error instanceof AppError && error.status === 404) throw hidden(); throw error }
    }
    return this.getWorkspace(id, tx.resources)
  }
  private workspaceSnapshot(workspace: Workspace): Workspace & { revision: string } {
    return { ...workspace, revision: workspaceRevision(workspace) }
  }
  private async placementHealthView(workspace: Workspace, workerList?: readonly Worker[]): Promise<Workspace & { revision: string }> {
    const workers = new Map((workerList ?? await this.store.resources.listWorkers()).map(worker => [worker.id, worker]))
    const placements = workspace.placements.map(placement => {
      const worker = workers.get(placement.workerId)
      if (worker?.connectionState === 'online') return placement
      const connectivityReason = worker?.connectionState === 'revoked' ? '工作节点已撤销' : '工作节点离线'
      return { ...placement, status: 'unhealthy' as const, failureReason: placement.failureReason ? `${connectivityReason}；${placement.failureReason}` : connectivityReason }
    })
    const primary = workspace.workerId ? placements.find(placement => placement.workerId === workspace.workerId) : placements.length === 1 ? placements[0] : undefined
    return { ...workspace, revision: workspaceRevision(workspace), placements, ...(primary ? { status: primary.status, failureReason: primary.failureReason, location: primary.location } : {}) }
  }
  async workspaceView(id: WorkspaceId, actor?: UserId): Promise<Workspace & { revision: string }> {
    const workspace = requireValue(await this.store.resources.getWorkspace(id))
    if (actor && this.projectAccess) await this.projectAccess.require(actor, workspace.projectId)
    else await this.getProject(workspace.projectId)
    if (workspace.deletedAt) return { ...workspace, revision: workspaceRevision(workspace) }
    return { ...await this.placementHealthView(workspace), revision: workspaceRevision(workspace) }
  }
  /** Personal view state does not alter Workspace lifecycle or its preparation commands. */
  async workspaceVisibility(id: WorkspaceId, input: unknown, actor: UserId) {
    const body = object(input)
    if (Object.keys(body).some(key => !['hidden', 'expectedRevision', 'requestId'].includes(key)) || typeof body.hidden !== 'boolean' || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || Number(body.expectedRevision) >= Number.MAX_SAFE_INTEGER || body.requestId === undefined) throw new AppError(400, 'Workspace visibility requires hidden, expectedRevision and requestId', 'invalid_request')
    const hidden = body.hidden as boolean
    const request = createRequest(actor, 'workspace-visibility', id, body.requestId, { hidden, expectedRevision: body.expectedRevision })
    return this.store.transaction(async tx => {
      const workspace = await tx.resources.getWorkspace(id)
      if (!workspace || !this.projectAccess) throw new AppError(404, 'Workspace not found', 'workspace_not_found')
      await this.projectAccess.requireInTx(tx, actor, workspace.projectId)
      if (workspace.deletedAt) throw new AppError(404, 'Workspace not found', 'workspace_not_found')
      const previous = await replayCreate<{ workspaceId: WorkspaceId; hidden: boolean; revision: number }>(tx, request)
      if (previous) return previous
      const current = await tx.resources.getWorkspaceVisibility(actor, id)
      const revision = current?.revision ?? 0
      if (revision !== body.expectedRevision) throw new AppError(409, 'Workspace visibility changed; reload before retrying', 'workspace_visibility_conflict')
      if (current?.hidden === hidden || (!current && !hidden)) {
        const receipt = { workspaceId: id, hidden, revision }
        await recordCreate(tx, request, receipt)
        return receipt
      }
      const receipt = { workspaceId: id, hidden, revision: revision + 1 }
      await tx.resources.saveWorkspaceVisibility(actor, receipt)
      await recordCreate(tx, request, receipt)
      return receipt
    })
  }
  async listWorkspaceVisibilityViews(actor: UserId, input: { projectId?: string; teamId?: string; visibility: 'visible' | 'hidden' | 'all' }) {
    return this.store.transaction(async tx => {
      if (!this.projectAccess) throw new AppError(404, 'Not found')
      const records = new Map((await tx.resources.listWorkspaceVisibility(actor)).map(record => [record.workspaceId, record]))
      const workers = await tx.resources.listWorkers()
      const result = [] as (Workspace & { revision: string; visibilityRevision: number; visibilityHidden: boolean })[]
      for (const workspace of await tx.resources.listWorkspaces()) {
        if (workspace.deletedAt || (input.projectId && workspace.projectId !== input.projectId)) continue
        try {
          const project = await this.projectAccess.requireInTx(tx, actor, workspace.projectId)
          if (input.teamId && project.teamId !== input.teamId) continue
        } catch (error) {
          if (error instanceof AppError && error.status === 404) continue
          throw error
        }
        const visibility = records.get(workspace.id)
        const hidden = Boolean(visibility?.hidden)
        if (input.visibility !== 'all' && hidden !== (input.visibility === 'hidden')) continue
        result.push({ ...await this.placementHealthView(workspace, workers), visibilityRevision: visibility?.revision ?? 0, visibilityHidden: hidden })
      }
      return result
    })
  }
  async deleteWorkspace(id: WorkspaceId, input: unknown, actor: UserId, teamScope?: string) {
    const b = object(input)
    if (Object.keys(b).some(key => !['expectedRevision', 'requestId'].includes(key)) || typeof b.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(b.expectedRevision) || b.requestId === undefined) throw new AppError(400, 'Workspace deletion requires expectedRevision and requestId', 'invalid_request')
    const request = createRequest(actor, 'workspace-delete', id, b.requestId, { expectedRevision: b.expectedRevision })
    return this.store.transaction(async tx => {
      const workspace = requireValue(await tx.resources.getWorkspace(id))
      if (!this.projectAccess) throw new AppError(403, 'Project authorization unavailable')
      const project = await this.projectAccess.requireInTx(tx, actor, workspace.projectId, 'manager')
      if (teamScope && project.teamId !== teamScope) throw new AppError(403, 'Project Team scope mismatch', 'forbidden')
      const previous = await replayCreate<{ workspaceId: WorkspaceId; deletedAt: Timestamp }>(tx, request)
      if (previous) return previous
      if (workspace.deletedAt) throw new AppError(410, 'Workspace is permanently deleted', 'workspace_deleted')
      if (workspaceRevision(workspace) !== b.expectedRevision) throw new AppError(409, 'Workspace state changed; reload before confirming deletion', 'workspace_revision_conflict')
      const blocked = (message: string): never => { throw new AppError(409, message, 'workspace_in_use') }
      if (await tx.tasks.binding(id)) blocked('Workspace is bound to a Task; explicitly unbind it first')
      for (const project of await tx.resources.listProjects()) for (const task of await tx.tasks.list(project.id, true)) {
        if (task.assignee?.workspaceId === id || (await tx.tasks.runs(task.id)).some(run => run.snapshot.workspaceId === id)) blocked('Workspace has retained Task assignment or Run history')
      }
      if ((await tx.resources.listSessions()).some(session => session.workspaceId === id || session.binding?.workspaceId === id)) blocked('Workspace has retained Session history; safe cleanup cannot be proven. Do not delete Sessions to bypass this restriction.')
      if ((workspace.spec.kind === 'composite' && workspace.spec.memberWorkspaceIds.length) || (workspace.spec.kind === 'repository' && workspace.spec.ownership.kind === 'composite-member')) blocked('Workspace has composite membership or ownership references')
      for (const other of await tx.resources.listWorkspaces()) {
        if ((other.spec.kind === 'composite' && other.spec.memberWorkspaceIds.includes(id)) || (other.spec.kind === 'repository' && other.spec.ownership.kind === 'composite-member' && other.spec.ownership.compositeWorkspaceId === id)) blocked('Workspace is retained by a composite reference')
      }
      const commands = await tx.commands.listWorkspaceProvisions(id)
      for (const placement of workspace.placements) {
        const proof = await this.preserveCurrentPreparationProof(tx, workspace, placement)
        if (!proof || !commands.some(command => command.commandId === proof.commandId && command.workerId === placement.workerId)) blocked('Placement has no correlated terminal preparation proof')
      }
      for (const command of commands) {
        const status = (await tx.commands.get(command.commandId))?.status
        const proof = await tx.resources.getWorkspacePreparationProof({ workspaceId: id, workerId: command.workerId, commandId: command.commandId })
        if (status !== 'accepted' || command.command.kind !== 'workspace.provision' || command.command.workspace.workspace.id !== id || !proof) blocked('Preparation settlement is unproven for a current or historical command; deletion does not cancel preparation')
      }
      const deletedAt = now(), receipt = { workspaceId: id, deletedAt }
      await tx.resources.saveWorkspace({ ...workspace, deletedAt })
      await this.audit(tx, 'workspace.delete', { kind: 'workspace', id }, actor)
      await recordCreate(tx, request, receipt)
      return receipt
    })
  }
  sessionView(id: SessionId, actor?: UserId) {
    return this.store.transaction(async tx => {
      const session = actor && this.sessionAccess ? await this.sessionAccess.requireInTx(tx, actor, id) : await this.getSession(id, tx.resources)
      return { ...session, storageMode: session.storageMode ?? 'local', archivedAt: session.archivedAt ?? null, ...await this.executionState(tx, id), sendCapability: await sendCapability(tx, session) }
    })
  }
  private async executionState(tx: ServerStoreTx, id: SessionId) {
    const queued = new Map<MessageId, { commandId: CommandId; messageId: MessageId; content: string; position: number | null; sentByAccountId?: UserId }>()
    const messageActors = new Map<MessageId, UserId>()
    const observed = new Set<CommandId>(), settled = new Set<MessageId>()
    let activeTurnId: TurnId | null = null, activeTurnOwnerId: UserId | null = null
    let from = 1 as EventSeq
    for (;;) {
      const page = await tx.cache.readEvents(id, from, 500)
      for (const { payload: p } of page.events) {
        if (p.kind === 'message.queued') {
          observed.add(p.commandId)
          queued.set(p.messageId, { commandId: p.commandId, messageId: p.messageId, content: p.content, position: p.position, ...(p.sentByAccountId ? { sentByAccountId: p.sentByAccountId } : {}) })
          if (p.sentByAccountId) messageActors.set(p.messageId, p.sentByAccountId)
        }
        if (p.kind === 'message.cancelled' || p.kind === 'turn.started') {
          queued.delete(p.messageId)
          settled.add(p.messageId)
        }
        if (p.kind === 'turn.started') { activeTurnId = p.turnId; activeTurnOwnerId = messageActors.get(p.messageId) ?? null }
        if (p.kind === 'turn.finished' && activeTurnId === p.turnId) { activeTurnId = null; activeTurnOwnerId = null }
      }
      if (!page.nextSeq) break
      from = page.nextSeq
    }
    for (const pending of await tx.commands.listUnsettledEnqueues(id)) {
      const command = pending.command
      if (command.kind === 'session.enqueue' && !observed.has(pending.commandId) && !settled.has(command.message.messageId)) {
        queued.set(command.message.messageId, { commandId: pending.commandId, ...command.message, position: null })
      }
    }
    return { activeTurnId, activeTurnOwnerId, queuedMessages: [...queued.values()], freshness: await tx.cache.getFreshness(id) }
  }
  /** Fresh authorization and lifecycle snapshot for file/terminal dispatch, not durable admission.
   * Gateway I/O must run after this transaction. Trusted legacy compositions without
   * SessionAccessService retain their existing behavior; configured access fails closed.
   */
  async requireSessionEffectAccess(id: SessionId, actor: UserId | undefined, capability: 'write' | 'control', requireMutable: boolean) {
    return this.store.transaction(tx => this.requireSessionEffectAccessInTx(tx, id, actor, capability, requireMutable))
  }
  private async requireSessionEffectAccessInTx(tx: ServerStoreTx, id: SessionId, actor: UserId | undefined, capability: 'write' | 'control', requireMutable: boolean) {
    if (this.sessionAccess && !actor) throw new AppError(401, 'Authentication required')
    const session = this.sessionAccess
      ? await this.sessionAccess.requireInTx(tx, actor!, id, capability)
      : await this.getSession(id, tx.resources)
    if (requireMutable) await assertSessionTaskMutable(tx, session)
    return session
  }
  /** Stage 1 internal preparation only. No HTTP caller, notification or dispatcher. */
  async admitFileWrite(id: SessionId, actor: UserId, input: unknown) {
    if (typeof actor !== 'string' || !actor.trim()) throw new AppError(401, 'Authentication required')
    if (!this.sessionAccess) throw new AppError(403, 'Session authorization unavailable')
    const snapshot = snapshotFileWriteInput(input)
    return this.store.transaction(async tx => {
      const session = await this.requireSessionEffectAccessInTx(tx, id, actor, 'write', true)
      return admitFileWriteInTx(tx, actor, session, snapshot)
    })
  }
  /** Internal only: caller must authenticate the Worker independently of the payload.
   * Optional internal gateway only, no waiter or actor read API. Retain historical observations even
   * after access/lifecycle changes; expose the ACK only after durable commit.
   */
  async receiveFileWriteResult(authenticatedWorkerId: WorkerId, input: unknown) {
    const snapshot = snapshotFileWriteResult(input)
    const retained = await this.store.transaction(tx => tx.fileWrites.retainResult(authenticatedWorkerId, snapshot)).catch(cause => {
      if (cause instanceof FileWriteResultRejectedError) throw cause
      throw new FileWriteResultUnavailableError(cause)
    })
    return fileWriteResultAck(retained)
  }
  async requireSessionTaskMutable(id: SessionId) {
    return this.store.transaction(async tx => { const session = await this.getSession(id, tx.resources); await assertSessionTaskMutable(tx, session); return session })
  }
  async getSession(id: SessionId, resources = this.store.resources): Promise<Session> {
    const s = requireValue(await resources.getSession(id)); await this.getProject(s.projectId, resources)
    if (s.deletedAt) throw new AppError(404, 'Session deleted')
    return { ...s, storageMode: s.storageMode ?? 'local' }
  }
  async createProject(input: unknown, actor?: UserId, requireExplicitTeam = false) {
    const b = object(input)
    if (requireExplicitTeam && b.teamId === undefined) throw new AppError(400, 'teamId is required', 'invalid_request')
    const requestedTeamId = (b.teamId === undefined ? teamId : text(b.teamId, 'teamId')) as TeamId
    requireValue(await this.store.identity.getTeam(requestedTeamId), 'Team required')
    if (requireExplicitTeam && actor && !(await this.store.identity.listMemberships(actor)).some(membership => membership.teamId === requestedTeamId)) throw new AppError(403, 'Team membership required', 'team_membership_required')
    const shareScope = b.shareScope === undefined ? 'owner-only' : text(b.shareScope, 'shareScope')
    if (shareScope !== 'owner-only' && shareScope !== 'selected-members' && shareScope !== 'team') throw new AppError(400, 'Invalid shareScope')
    const project: Project = { id: newId(), teamId: requestedTeamId, ownerId: actor ?? await this.operator(), name: text(b.name, 'name', 200), shareScope, reviewPolicy: 'none', reviewPolicyVersion: 1, deletedAt: null }
    const request = createRequest(project.ownerId, 'project', requestedTeamId, b.requestId, { name: project.name, shareScope })
    return this.store.transaction(async tx => {
      const previous = await replayCreate<Project>(tx, request)
      if (previous) {
        await this.getProject(previous.id, tx.resources)
        if (this.projectAccess) await this.projectAccess.requireInTx(tx, project.ownerId, previous.id)
        return previous
      }
      await tx.resources.saveProject(project)
      await this.audit(tx, 'project.create', { kind: 'project', id: project.id }, actor)
      await recordCreate(tx, request, project)
      return project
    })
  }
  private async command(tx: ServerStoreTx, workerId: WorkerId, command: WorkerCommand, id = newId<'CommandId'>()) {
    const fingerprint = canonicalFingerprint(command)
    if (await tx.commands.getRejection(id)) throw new AppError(409, 'Conflicting commandId')
    const existing = await tx.commands.get(id)
    if (existing) {
      if (existing.workerId !== workerId || existing.payloadFingerprint !== fingerprint) throw new AppError(409, 'Conflicting commandId')
      return id
    }
    await tx.commands.insertPending({ commandId: id, workerId, command, payloadFingerprint: fingerprint, createdAt: now() })
    return id
  }
  async createWorkspace(input: unknown, actor?: UserId): Promise<{ workspace: Workspace & { revision: string }; workerId: WorkerId; commandId: CommandId } | { workspace: Workspace & { revision: string }; workerId: undefined; commandId: undefined }> {
    const result = await this.store.transaction(tx => this.createWorkspaceInTx(tx, input, actor))
    if (result.workerId) this.notifications.commands(result.workerId)
    this.notifications.project({ id: randomUUID(), projectId: result.workspace.projectId, workspaceId: result.workspace.id, type: 'workspace.provisioning' })
    return result
  }
  /** Internal composition seam: caller owns the transaction and post-commit notification. */
  async createWorkspaceInTx(tx: ServerStoreTx, input: unknown, actor?: UserId): Promise<{ workspace: Workspace & { revision: string }; workerId: WorkerId; commandId: CommandId } | { workspace: Workspace & { revision: string }; workerId: undefined; commandId: undefined }> {
    const b = object(input), projectId = text(b.projectId, 'projectId') as ProjectId
    const p = actor && this.projectAccess ? await this.projectAccess.requireInTx(tx, actor, projectId, 'contributor') : await this.getProject(projectId, tx.resources)
    const requestedWorkerId = b.workerId === undefined ? undefined : text(b.workerId, 'workerId') as WorkerId
    const worker = requestedWorkerId ? actor && this.workerAccess ? await this.workerAccess.requireInTx(tx, actor, requestedWorkerId) : requireValue(await tx.resources.getWorker(requestedWorkerId)) : null
    if (worker && (worker.teamId !== p.teamId || worker.connectionState === 'revoked')) throw new AppError(403, 'Worker not usable')
    const source = b.source === undefined ? (b.repository === undefined ? 'empty' : 'git') : text(b.source, 'source')
    if (source !== 'empty' && source !== 'git') throw new AppError(400, 'source must be empty or git')
    const repository = source === 'git' ? (() => {
      const repo = object(b.repository)
      return { id: newId<'RepositoryId'>(), projectId: p.id, name: text(repo.name ?? b.name, 'repository name', 200), gitUrl: text(repo.gitUrl, 'gitUrl'), defaultBranch: text(repo.revision ?? 'main', 'revision') }
    })() : null
    if (source === 'empty' && b.repository !== undefined) throw new AppError(400, 'Empty workspace cannot include repository')
    const workspace: Workspace = { id: newId(), projectId: p.id, name: text(b.name, 'name', 200), spec: repository ? { kind: 'repository', repositoryId: repository.id, ownership: { kind: 'standalone' } } : { kind: 'composite', memberWorkspaceIds: [] }, placements: [], deletedAt: null }
    const request = createRequest(actor ?? p.ownerId, 'workspace', p.id, b.requestId, { name: workspace.name, workerId: requestedWorkerId, source, repository: repository ? { name: repository.name, gitUrl: repository.gitUrl, revision: repository.defaultBranch } : undefined })
    const previous = await replayCreate<Awaited<ReturnType<ServerService['createWorkspaceInTx']>>>(tx, request)
    if (previous) { await this.getWorkspace(previous.workspace.id, tx.resources); return { ...previous, workspace: this.workspaceSnapshot(previous.workspace) } }
    if (repository) await tx.resources.saveRepository(repository)
    await tx.resources.saveWorkspace(workspace)
    if (!worker) {
      await this.audit(tx, 'workspace.create', { kind: 'workspace', id: workspace.id })
      const result = { workspace: this.workspaceSnapshot({ ...workspace, status: 'unplaced' as const, failureReason: null, location: null }), workerId: undefined, commandId: undefined }
      await recordCreate(tx, request, result)
      return result
    }
    const repositories = repository ? [{ repositoryId: repository.id, gitUrl: repository.gitUrl, revision: repository.defaultBranch }] : []
    const commandId = await this.command(tx, worker.id, { kind: 'workspace.provision', workspace: { workspace: this.workspaceDefinition(workspace), repositories } })
    const stopped = this.replacePlacement(workspace, { workerId: worker.id, status: 'stopped', failureReason: null, location: null, provisioning: { commandId, startedAt: now(), replacedAttempt: false, requests: {} } })
    await tx.resources.saveWorkspace(stopped)
    await this.audit(tx, 'workspace.create', { kind: 'workspace', id: workspace.id })
    const result = { workspace: this.workspaceSnapshot({ ...stopped, workerId: worker.id, status: 'stopped' as const, failureReason: null, provisioning: stopped.placements[0].provisioning, location: null }), workerId: worker.id, commandId }
    await recordCreate(tx, request, result)
    return result
  }
  async createSession(input: unknown, actor?: UserId) {
    const result = await this.store.transaction(tx => this.createSessionInTx(tx, input, actor ? { ownerId: actor } : undefined))
    if (result.created) this.notifications.commands(result.session.binding.agent.workerId)
    return result
  }
  /**
   * Lineage seam (Ticket 17): create a Fork target inside the caller's transaction so the
   * target Session, its Worker command and the Fork row commit or roll back together. The
   * Project check is here because a Fork edge must not span Projects or Teams.
   */
  async createForkTargetInTx(tx: ServerStoreTx, input: ForkTargetSessionInput) {
    const workspace = requireValue(await tx.resources.getWorkspace(input.workspaceId))
    if (this.projectAccess) await this.projectAccess.requireInTx(tx, input.ownerId, workspace.projectId, 'contributor')
    if (workspace.projectId !== input.projectId) throw new AppError(409, 'Fork target Workspace belongs to another Project', 'fork_target_scope')
    if (workspace.deletedAt !== null) throw new AppError(409, 'Fork target Workspace is deleted', 'fork_target_deleted')
    // Session 级幂等键必须与 Fork 自己的键分开命名空间，否则一个客户端用同一个 requestId
    // 创建普通 Session 时会与 Fork 目标撞车。
    const created = await this.createSessionWithLineageInTx(tx, true, { requestId: `fork:${input.requestId}`, workspaceId: input.workspaceId, workerId: input.workerId, agentKey: input.agentKey, modelId: input.modelId, title: input.title, storageMode: input.storageMode ?? 'local' }, { ownerId: input.ownerId, ...(input.taskId ? { taskId: input.taskId, runId: null } : {}) })
    // 走到这里说明 Fork 记录还不存在却已有同 requestId 的目标：宁可失败，也不能给同一个目标补第二条边。
    if (!created.created) throw new AppError(409, 'Fork target Session already exists for this requestId', 'request_id_conflict')
    return created.session
  }
  /** Internal composition seam; never opens a transaction or notifies. */
  async createSessionInTx(tx: ServerStoreTx, input: unknown, provenance?: SessionProvenance) {
    return this.createSessionWithLineageInTx(tx, false, input, provenance)
  }
  /** Only the trusted Fork composition seam may depart from a dedicated environment. */
  private async createSessionWithLineageInTx(tx: ServerStoreTx, lineage: boolean, input: unknown, provenance?: SessionProvenance) {
    const b = object(input)
    if (b.storageMode !== undefined && b.storageMode !== 'local') throw new AppError(409, 'Session storage mode is not available', 'storage_mode_unavailable')
    const workspace = await this.authorizedWorkspaceInTx(tx, text(b.workspaceId, 'workspaceId') as WorkspaceId, provenance?.ownerId)
    let source = provenance === undefined || (provenance.taskId === undefined && provenance.runId === undefined) ? undefined : { taskId: provenance.taskId ?? null, runId: provenance.runId ?? null }
    let dedicated: import('@wemux/web-contract').Task['dedicatedConversation']
    if (source?.taskId) {
      const task = await tx.tasks.get(source.taskId)
      if (!task || task.projectId !== workspace.projectId) throw new AppError(404, 'Task not found')
      if (task.deletedAt) throw new AppError(410, 'Task is permanently deleted', 'task_deleted')
      dedicated = task.dedicatedConversation
    }
    const requestedWorkerId = b.workerId === undefined ? undefined : text(b.workerId, 'workerId') as WorkerId
    const authorizedRequestedWorker = requestedWorkerId && provenance?.ownerId && this.workerAccess ? await this.workerAccess.requireInTx(tx, provenance.ownerId, requestedWorkerId) : null
    const readyPlacements = workspace.placements.filter(placement => placement.status === 'ready')
    const selected = requestedWorkerId ? readyPlacements.find(placement => placement.workerId === requestedWorkerId) : readyPlacements.length === 1 ? readyPlacements[0] : undefined
    if (!selected) throw new AppError(409, requestedWorkerId ? 'Workspace is not ready on selected Worker' : readyPlacements.length ? 'workerId is required when Workspace is ready on multiple Workers' : 'Workspace has no ready placement')
    const worker = authorizedRequestedWorker ?? (provenance?.ownerId && this.workerAccess ? await this.workerAccess.requireInTx(tx, provenance.ownerId, selected.workerId) : requireValue(await tx.resources.getWorker(selected.workerId)))
    const agentKey = text(b.agentKey, 'agentKey') as AgentKey
    // modelId is optional at the HTTP boundary: when omitted we resolve the Agent's
    // first advertised model, because the send capability and the worker protocol
    // both require a concrete modelId on the Session binding.
    const requestedModelId = b.modelId === undefined || b.modelId === null ? null : text(b.modelId, 'modelId') as ModelId
    const title = text(b.title, 'title', 200)
    if (!source && Object.keys(b).some(key => !['requestId', 'workspaceId', 'workerId', 'title', 'agentKey', 'modelId', 'shareScope', 'storageMode', 'scenario'].includes(key))) throw new AppError(400, 'Invalid Session creation request')
    if (!source && b.shareScope !== undefined && b.shareScope !== 'owner-only') throw new AppError(400, 'Invalid Session shareScope')
    // Run launch owns its own receipt; task conversation callers supply a Session receipt.
    const requestId = b.requestId === undefined ? undefined : text(b.requestId, 'requestId', 200)
    if (!source && !requestId) throw new AppError(400, 'Invalid requestId')
    const agent = worker.capabilities?.find(c => c?.agentKey === agentKey)
    if (worker.connectionState === 'revoked' || !agent || agent.mode !== 'execution' || agent.availability?.status !== 'available') throw new AppError(409, 'Agent unavailable')
    if (requestedModelId !== null && !agent.models?.some(model => model?.modelId === requestedModelId)) throw new AppError(409, 'Model unavailable')
    const modelId = requestedModelId ?? agent.models?.map(model => model?.modelId).find(id => !!id) ?? null
    if (modelId === null) throw new AppError(409, 'Agent exposes no models')
    const shareScope = dedicated ? 'owner-only' : provenance?.shareScope ?? 'owner-only'
    const ownerId = provenance?.ownerId ?? await this.operator(undefined, tx)
    if (dedicated && !lineage && (dedicated.ownerId !== ownerId || dedicated.workspaceId !== workspace.id || dedicated.workerId !== worker.id || dedicated.agentKey !== agentKey)) {
      throw new AppError(409, 'Dedicated Task requires its original user, Workspace, Worker and Agent; start a new quick conversation for another environment', 'dedicated_task_binding_mismatch')
    }
    const previous = requestId ? await tx.resources.getSessionByCreateRequest(ownerId, workspace.projectId, requestId) : null
    if (previous) {
      if (provenance?.ownerId) await this.requireSessionAccessInTx(tx, provenance.ownerId, previous.id, 'write')
      else await this.getSession(previous.id, tx.resources)
      await assertSessionTaskMutable(tx, previous)
    }
    if (!source) {
      const scenario = b.scenario ?? 'quick-chat'
      if (scenario !== 'quick-chat' && scenario !== 'agent-test') throw new AppError(400, 'Invalid conversation scenario')
      // Reconcile admitted pre-upgrade root requests without rebinding their Session.
      // Both omitted and explicit-null stored provenance used the root fingerprint.
      if (previous && previous.taskId == null && previous.runId == null) {
        const legacyFingerprint = createHash('sha256').update(canonicalCommand({ workspaceId: workspace.id, workerId: worker.id, agentKey, modelId, title, shareScope })).digest('hex')
        if (scenario !== 'quick-chat' || previous.creation?.fingerprint !== legacyFingerprint) throw new AppError(409, 'requestId already belongs to a different Session request', 'request_id_conflict')
        return { session: { ...previous, storageMode: previous.storageMode ?? 'local' }, commandId: previous.creation.commandId as CommandId, created: false }
      }
      const taskId = await dedicatedConversationTask(tx, workspace.projectId, { ownerId, workspaceId: workspace.id, workerId: worker.id, agentKey, scenario }, requestId!)
      source = { taskId, runId: null }
    }
    const fingerprint = createHash('sha256').update(canonicalCommand({ workspaceId: workspace.id, workerId: worker.id, agentKey, modelId, title, shareScope, ...(source ? { taskId: source.taskId, runId: source.runId } : {}) })).digest('hex')
    if (previous) {
      if (previous.creation?.fingerprint !== fingerprint) throw new AppError(409, 'requestId already belongs to a different Session request', 'request_id_conflict')
      return { session: { ...previous, storageMode: previous.storageMode ?? 'local' }, commandId: previous.creation.commandId as CommandId, created: false }
    }
    const sessionId = newId<'SessionId'>(), commandId = newId<'CommandId'>()
    const session: Session = { id: sessionId, projectId: workspace.projectId, ownerId, workspaceId: workspace.id, title, shareScope, storageMode: 'local', binding: { workspaceId: workspace.id, agent: { workerId: worker.id, agentKey }, modelId }, runtimeState: 'idle', archivedAt: null, deletedAt: null, ...(requestId ? { creation: { requestId, fingerprint, commandId } } : {}), ...source }
    await tx.resources.saveSession(session)
    await this.command(tx, worker.id, { kind: 'session.create', session: { sessionId: session.id, binding: session.binding, storageMode: session.storageMode ?? 'local' } }, commandId)
    await this.audit(tx, 'session.create', { kind: 'session', id: session.id })
    return { session, commandId, created: true }
  }
  async enqueue(id: SessionId, input: unknown, actor?: UserId) {
    const { workerId, ...result } = await this.store.transaction(tx => this.enqueueInTx(tx, id, input, actor))
    this.notifications.commands(workerId)
    return { ...result, status: (await this.store.commands.get(result.commandId))!.status }
  }
  /** Internal composition seam; capability preparation is local and read-only. */
  async enqueueInTx(tx: ServerStoreTx, id: SessionId, input: unknown, actor?: UserId) {
    const b = object(input), session = actor && this.sessionAccess ? await this.sessionAccess.requireInTx(tx, actor, id, 'write') : await this.getSession(id, tx.resources)
    await assertSessionTaskMutable(tx, session)
    await this.getWorkspace(session.workspaceId, tx.resources)
    const capability = await sendCapability(tx, session)
    if (!capability.allowed) throw new AppError(409, capability.reason, capability.reasonCode)
    const commandId = b.commandId === undefined ? newId<'CommandId'>() : text(b.commandId, 'commandId', 200) as CommandId
    // Stable default message identity makes commandId retries idempotent.
    const messageId = (b.messageId === undefined ? commandId : text(b.messageId, 'messageId', 200)) as unknown as MessageId
    const content = text(b.content, 'content', 100000)
    if (content.includes('\0')) throw new AppError(400, 'Message contains an unsupported NUL character')
    if (Buffer.byteLength(JSON.stringify(content)) > 200000) throw new AppError(400, 'Message exceeds the protocol byte limit')
    const capabilityActor = actor ?? session.ownerId
    const prepared = this.capabilities ? await this.capabilities.prepareTurn({ sessionId: id, turnId: newId<'TurnId'>(), actorId: capabilityActor }, tx) : null
    const command: WorkerCommand = { kind: 'session.enqueue', sessionId: id, message: { messageId, content, ...(actor ? { sentByAccountId: actor } : {}) }, ...(prepared ? { capabilities: prepared.runtime } : {}) }
    if (new TextEncoder().encode(JSON.stringify({ type: 'command', commandId, command })).byteLength > 900 * 1024) throw new AppError(413, 'Message and capability assets exceed the worker transport limit')
    await this.command(tx, session.binding.agent.workerId, command, commandId)
    await this.audit(tx, 'session.enqueue', { kind: 'session', id }, actor)
    return { commandId, messageId, workerId: session.binding.agent.workerId }
  }
  async cancelQueued(id: SessionId, submissionCommandId: CommandId, input: unknown, actor?: UserId) {
    const b = object(input)
    const commandId = b.commandId === undefined ? newId<'CommandId'>() : text(b.commandId, 'commandId', 200) as CommandId
    return this.sessionControl(id, commandId, actor, async tx => {
      const submission = await tx.commands.getPendingCommand(submissionCommandId)
      if (!submission || submission.command.kind !== 'session.enqueue' || submission.command.sessionId !== id) throw new AppError(404, 'Queued submission not found in Session')
      if (actor && submission.command.message.sentByAccountId !== actor) await this.sessionAccess?.requireInTx(tx, actor, id, 'control')
      return { kind: 'session.cancel-queued', sessionId: id, submissionCommandId }
    })
  }
  async stopTurn(id: SessionId, input: unknown, actor?: UserId) {
    const b = object(input)
    const commandId = b.commandId === undefined ? newId<'CommandId'>() : text(b.commandId, 'commandId', 200) as CommandId
    return this.sessionControl(id, commandId, actor, async tx => {
      // A retry must retain its original target, even after another Turn starts.
      const previous = await tx.commands.getPendingCommand(commandId)
      const state = await this.executionState(tx, id)
      const turnId = b.turnId === undefined
        ? previous?.command.kind === 'turn.stop' && previous.command.sessionId === id ? previous.command.turnId : state.activeTurnId
        : text(b.turnId, 'turnId', 200) as TurnId
      if (!turnId) throw new AppError(409, 'Session has no observed active Turn')
      if (!previous && turnId !== state.activeTurnId) throw new AppError(409, 'Turn is not active in Session')
      if (actor && state.activeTurnOwnerId !== actor) await this.sessionAccess?.requireInTx(tx, actor, id, 'control')
      return { kind: 'turn.stop', sessionId: id, turnId }
    })
  }
  private async sessionControl(id: SessionId, commandId: CommandId, actor: UserId | undefined, build: (tx: ServerStoreTx) => Promise<WorkerCommand | null>) {
    const workerId = await this.store.transaction(async tx => {
      const session = actor && this.sessionAccess ? await this.sessionAccess.requireInTx(tx, actor, id, 'write') : await this.getSession(id, tx.resources)
      await assertSessionTaskMutable(tx, session)
      const command = await build(tx)
      if (command === null) return null // Commit a durable non-admission fence before responding.
      const existing = await tx.commands.get(commandId)
      await this.command(tx, session.binding.agent.workerId, command, commandId)
      if (!existing) await this.audit(tx, command.kind, { kind: 'session', id }, actor)
      return session.binding.agent.workerId
    })
    if (workerId === null) throw new AppError(409, 'Model selection was not admitted; use a new request after checking model availability', 'model_not_admitted')
    this.notifications.commands(workerId)
    return { commandId }
  }
  async invokeRuntimeCommand(id: SessionId, input: unknown, actor?: UserId) {
    const b = object(input)
    const commandId = b.commandId === undefined ? newId<'CommandId'>() : text(b.commandId, 'commandId', 200) as CommandId
    const operationId = (b.operationId === undefined ? commandId : text(b.operationId, 'operationId', 200)) as RuntimeOperationId
    const name = text(b.name, 'name', 200)
    if (name !== 'compact' && name !== 'set_model' && name !== 'set_thinking_level') throw new AppError(400, 'Unsupported runtime command')
    const args = b.arguments === undefined ? {} : object(b.arguments)
    const runtimeName = name as Extract<WorkerCommand, { kind: 'runtime.command' }>['name']
    return this.sessionControl(id, commandId, actor, async tx => {
      if (runtimeName === 'set_model') {
        const modelId = text(args.modelId, 'modelId', 200) as ModelId
        const session = await this.getSession(id, tx.resources)
        const candidate: WorkerCommand = { kind: 'runtime.command', sessionId: id, operationId, name: runtimeName, arguments: args }
        const fence = await tx.commands.getRejection(commandId)
        if (fence) {
          if (fence.workerId !== session.binding.agent.workerId || fence.payloadFingerprint !== canonicalFingerprint(candidate)) throw new AppError(409, 'Conflicting commandId')
          return null
        }
        // Replay the immutable intent through the ordinary command fingerprint check.
        // Current permissions still apply, but changed capabilities must not alter a receipt.
        if (await tx.commands.get(commandId)) {
          const retained = (await tx.commands.getPendingCommand(commandId))?.command
          // Old Servers injected previousModelId into the wire identity. Compare only
          // the caller intent, then replay the retained wire without rewriting it.
          if (retained?.kind === 'runtime.command' && retained.name === 'set_model' &&
            (typeof retained.arguments.previousModelId === 'string' || retained.arguments.previousModelId === null) &&
            !Object.hasOwn(args, 'previousModelId')) {
            const { previousModelId: _previous, ...originalArgs } = retained.arguments
            const intent = { kind: 'runtime.command', sessionId: id, operationId, name: runtimeName, arguments: args }
            if (canonicalCommand({ ...retained, arguments: originalArgs }) === canonicalCommand(intent)) return retained
          }
          return { kind: 'runtime.command', sessionId: id, operationId, name: runtimeName, arguments: args }
        }
        if (Object.hasOwn(args, 'previousModelId')) throw new AppError(400, 'previousModelId is reserved')
        const worker = await tx.resources.getWorker(session.binding.agent.workerId)
        if (!worker) throw new AppError(404, 'Worker not found')
        const capability = worker.capabilities.find(item => item.agentKey === session.binding.agent.agentKey)
        if (!capability?.modelSwap || !capability.models.some(model => model.modelId === modelId)) {
          // Reserve the identity permanently, including against earlier timed-out
          // requests that have not reached admission yet. Do not throw before commit.
          await tx.commands.rejectAdmission({ commandId, workerId: session.binding.agent.workerId, payloadFingerprint: canonicalFingerprint(candidate) })
          return null
        }
        // Only the Worker's ordered model.changed Journal event updates this projection.
        // Admission cannot confirm execution or mutate an already-started Turn.
      }
      return { kind: 'runtime.command', sessionId: id, operationId, name: runtimeName, arguments: args }
    })
  }
  /** Receipt retrieval uses the same authority as sessionControl, without dispatch. */
  async authorizeRuntimeApprovalReplay(id: SessionId, projectId: ProjectId, actor: UserId): Promise<void> {
    await this.store.transaction(async tx => {
      const session = await this.requireSessionAccessInTx(tx, actor, id, 'write')
      if (session.projectId !== projectId) throw new AppError(404, 'Approval not found', 'approval_not_found')
      if (session.taskId) {
        const task = await tx.tasks.get(session.taskId)
        if (!task || task.projectId !== projectId) throw new AppError(404, 'Approval not found', 'approval_not_found')
      }
      // Root-created Sessions legitimately have no Task/Run provenance. Validate
      // recorded bindings, but do not invent one just to retrieve a receipt.
      if (session.runId) {
        const run = await tx.tasks.run(session.runId)
        if (!run || run.sessionId !== id || run.projectId !== projectId || (session.taskId && run.taskId !== session.taskId)) {
          throw new AppError(404, 'Approval not found', 'approval_not_found')
        }
      }
      await assertSessionTaskMutable(tx, session)
    })
  }

  async resolveRuntimeApproval(id: SessionId, approvalId: ApprovalId, input: unknown, actor?: UserId) {
    const b = object(input), decision = text(b.decision, 'decision')
    const turnId = text(b.turnId, 'turnId', 200) as TurnId
    if (decision !== 'approve' && decision !== 'deny') throw new AppError(400, 'decision must be approve or deny')
    const commandId = b.commandId === undefined ? newId<'CommandId'>() : text(b.commandId, 'commandId', 200) as CommandId
    return this.sessionControl(id, commandId, actor, async () => ({ kind: 'runtime.approval.resolve', sessionId: id, turnId, approvalId, decision, ...(actor ? { decidedByAccountId: actor } : {}) }))
  }
  async requireSessionAccessInTx(tx: ServerStoreTx, actor: UserId, id: SessionId, capability: import('./session-access-service.ts').SessionAccessCapability = 'read') {
    if (!this.sessionAccess) return this.getSession(id, tx.resources)
    return this.sessionAccess.requireInTx(tx, actor, id, capability)
  }
  async events(id: SessionId, from: number, limit: number, actor?: UserId) {
    if (actor && this.sessionAccess) await this.sessionAccess.require(actor, id)
    else await this.getSession(id)
    return { ...await this.store.cache.readEvents(id, integer(from, 'fromSeq', 1) as EventSeq, integer(limit, 'limit', 1, 1000)), freshness: await this.store.cache.getFreshness(id) }
  }
  async update(kind: 'projects' | 'workspaces' | 'sessions', id: string, input: unknown, actor?: UserId) {
    const b = object(input)
    return this.store.transaction(async tx => {
      if (kind === 'projects' && actor && this.projectAccess) await this.projectAccess.requireInTx(tx, actor, id as ProjectId, 'manager')
      if (kind === 'sessions' && actor && this.sessionAccess) await this.sessionAccess.requireInTx(tx, actor, id as SessionId, 'control')
      await this.audit(tx, `${kind}.update`, kind === 'projects' ? { kind: 'project', id: id as ProjectId } : kind === 'workspaces' ? { kind: 'workspace', id: id as WorkspaceId } : { kind: 'session', id: id as SessionId }, actor)
      if (kind === 'projects') { const p = { ...await this.getProject(id as ProjectId, tx.resources), name: text(b.name, 'name', 200) }; await tx.resources.saveProject(p); return p }
      if (kind === 'workspaces') { const w = { ...await this.authorizedWorkspaceInTx(tx, id as WorkspaceId, actor), name: text(b.name, 'name', 200) }; await tx.resources.saveWorkspace(w); return this.workspaceSnapshot(w) }
      if (Object.keys(b).some(key => !['title', 'archived'].includes(key)) || (b.title === undefined && b.archived === undefined)) throw new AppError(400, 'Expected title or archived')
      if (b.archived !== undefined && typeof b.archived !== 'boolean') throw new AppError(400, 'archived must be boolean')
      const session = actor && this.sessionAccess ? await this.sessionAccess.requireInTx(tx, actor, id as SessionId, 'control') : await this.getSession(id as SessionId, tx.resources)
      const s = { ...session, title: b.title === undefined ? session.title : text(b.title, 'title', 200), archivedAt: b.archived === undefined ? session.archivedAt ?? null : b.archived ? session.archivedAt ?? now() : null }
      await tx.resources.saveSession(s)
      return s
    })
  }
  async delete(kind: 'projects' | 'workspaces' | 'sessions', id: string, actor?: UserId) {

    await this.store.transaction(async tx => {
      if (kind === 'projects' && actor && this.projectAccess) await this.projectAccess.requireInTx(tx, actor, id as ProjectId, 'manager')
      if (kind === 'sessions' && actor && this.sessionAccess) await this.sessionAccess.requireInTx(tx, actor, id as SessionId, 'control')
      await this.audit(tx, `${kind}.delete`, kind === 'projects' ? { kind: 'project', id: id as ProjectId } : kind === 'workspaces' ? { kind: 'workspace', id: id as WorkspaceId } : { kind: 'session', id: id as SessionId }, actor)
      if (kind === 'projects') {
        if ((await tx.resources.listWorkspaces()).some(workspace => workspace.projectId === id)) throw new AppError(409, 'Project retains Workspace records (including deleted workspaces); deletion is unavailable', 'project_has_workspaces')
        if ((await tx.tasks.list(id, true)).length) throw new AppError(409, 'Project retains Task history; deletion is unavailable', 'project_has_tasks')
        await tx.resources.saveProject({ ...await this.getProject(id as ProjectId, tx.resources), deletedAt: now() })
      }
      else if (kind === 'sessions') {
        const session = actor && this.sessionAccess ? await this.sessionAccess.requireInTx(tx, actor, id as SessionId, 'control') : await this.getSession(id as SessionId, tx.resources)
        for (const task of await tx.tasks.list(session.projectId)) {
          if ((await tx.tasks.runs(task.id)).some(run => run.sessionId === session.id && ['pending', 'running', 'cancelling'].includes(run.status))) throw new AppError(409, 'Session has an active Run', 'run_session_protected')
        }
        const reason = await sessionIdleReason(tx, session.id)
        if (reason) throw new AppError(409, reason, 'run_session_protected')
        const deletedAt = now()
        await tx.resources.saveSession({ ...session, deletedAt })
        for (const task of await tx.tasks.list(session.projectId)) {
          if (session.taskId !== task.id && !(await tx.tasks.runs(task.id)).some(run => run.sessionId === session.id)) continue
          const detail = requireValue(await tx.tasks.get(task.id))
          await tx.tasks.save({ ...detail, lastActivityAt: deletedAt })
          await tx.tasks.append({ taskId: task.id, projectId: session.projectId, type: 'task.updated', actor: session.ownerId, requestId: `session-delete:${session.id}`, occurredAt: deletedAt, payload: { action: 'session.deleted', sessionId: session.id } }, `session-delete:${session.id}`)
        }
        await tx.cache.deleteSessionHistory(session.id)
        await this.command(tx, session.binding.agent.workerId, { kind: 'session.delete', sessionId: session.id }, `session-delete:${session.id}` as CommandId)
      }
      else {
        await this.getWorkspace(id as WorkspaceId, tx.resources)
        throw new AppError(400, 'Use confirmed Workspace deletion with expectedRevision and requestId', 'invalid_request')
      }
    })
    if (kind === 'sessions') {
      this.notifications.session(id as SessionId)
      const session = await this.store.resources.getSession(id as SessionId)
      if (session) this.notifications.commands(session.binding.agent.workerId)
    }
  }
  async listProjects(): Promise<Project[]> {
    return (await this.store.resources.listProjects()).filter(project => !project.deletedAt)
  }
  async listWorkspaces(): Promise<Workspace[]> {
    const projectIds = new Set((await this.listProjects()).map(project => project.id))
    return (await this.store.resources.listWorkspaces()).filter(
      workspace => projectIds.has(workspace.projectId) && !workspace.deletedAt,
    )
  }
  async listWorkspaceViews(): Promise<Workspace[]> {
    return Promise.all((await this.listWorkspaces()).map(workspace => this.placementHealthView(workspace)))
  }
  async listSessions(filter: { archived?: boolean } = {}): Promise<Session[]> {
    const projectIds = new Set((await this.listProjects()).map(project => project.id))
    return (await this.store.resources.listSessions()).filter(
      session => projectIds.has(session.projectId) && !session.deletedAt && (filter.archived === undefined || Boolean(session.archivedAt) === filter.archived),
    ).map(session => ({ ...session, storageMode: session.storageMode ?? 'local' }))
  }
}

function canonicalFingerprint(command: WorkerCommand): string {
  const value = command.kind === 'session.enqueue'
    ? { kind: command.kind, sessionId: command.sessionId, message: { messageId: command.message.messageId, content: command.message.content } }
    : command
  return createHash('sha256').update(canonicalCommand(value)).digest('hex')
}

export function canonicalCommand(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalCommand).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalCommand(child)}`).join(',')}}`
}
