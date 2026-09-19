import { sessionIdleReason } from './session-idle.js'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AgentKey, ApprovalId, CommandId, EventSeq, Id, MessageId, ModelId, ProjectId, RuntimeOperationId, SessionId, TeamId, Timestamp, TurnId, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import type { AuditResource, CommandProjection, Project, Session, Worker, Workspace, WorkspacePlacement } from '@wemux/server-domain'
import type { WorkerCommand } from '@wemux/wire-protocol'
import type { ServerStore, ServerStoreTx } from './ports/server-store.js'
import { AppError, requireValue } from './errors.js'
import { hashSecret } from './auth.js'
import { sendCapability } from './action-capabilities.js'
import type { CapabilityService } from './capability-service.js'
import { Notifications } from './notifications.js'
import { integer, object, text } from './validation.js'

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
}

/** Inputs the Session Lineage module may set on a Fork target; binding validation stays here. */
export interface ForkTargetSessionInput {
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly agentKey: AgentKey
  readonly modelId: ModelId | null
  readonly title: string
  readonly ownerId: UserId
  /** 发起 Fork 的 requestId；目标 Session 的创建身份由它派生，不另开一套幂等键。 */
  readonly requestId: string
}

export class ServerService {
  constructor(private readonly store: ServerStore, readonly notifications: Notifications, private readonly capabilities?: CapabilityService) {}
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
      const current = requireValue(await tx.commands.get(id))
      if (await tx.tasks.runByCommand(id)) throw new AppError(409, 'protected_command: Run commands cannot be cancelled; Run cancellation is not implemented')
      if (['pending', 'accepted'].includes(current.status)) {
        const protectedWorkspace = (await tx.resources.listWorkspaces()).find(workspace => workspace.placements.some(placement => placement.provisioning?.commandId === id && ['pending', 'provisioning'].includes(placement.status)))
        if (protectedWorkspace) throw new AppError(409, 'protected_command: current Workspace provision command cannot be cancelled')
      }
      if (!await tx.commands.cancelPending(id, now())) return false
      await this.audit(tx, 'command.cancel', { kind: 'worker', id: command.workerId })
      return true
    })
    if (!cancelled) throw new AppError(409, 'Only pending commands can be cancelled')
    this.notifications.commands(command.workerId)
    return await this.getCommand(id)
  }
  async revokeWorker(id: WorkerId, disconnect: (workerId: WorkerId) => void) {
    return this.revokeWorkerAs(id, disconnect, 'worker.revoke')
  }
  async leaveWorker(id: WorkerId, disconnect: (workerId: WorkerId) => void) {
    return this.revokeWorkerAs(id, disconnect, 'worker.leave')
  }
  private async revokeWorkerAs(id: WorkerId, disconnect: (workerId: WorkerId) => void, action: 'worker.revoke' | 'worker.leave') {
    const worker = await this.getWorker(id)
    if (worker.connectionState === 'revoked') return worker
    await this.store.transaction(async tx => {
      await tx.resources.saveWorker({ ...worker, connectionState: 'revoked', lastSeenAt: now() })
      await tx.identity.revokeWorkerCredential(id, now())
      await this.audit(tx, action, { kind: 'worker', id })
    })
    disconnect(id)
    for (const session of await this.store.resources.listSessions()) if (session.binding.agent.workerId === id) this.notifications.session(session.id)
    return await this.getWorker(id)
  }
  async reprovisionWorkspace(id: WorkspaceId, requestId: string = randomUUID(), workerId?: WorkerId, actor?: UserId) {
    const result = await this.store.transaction(async tx => {
      const result = await this.reprovisionWorkspaceInTx(tx, id, requestId, workerId)
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
  async reprovisionWorkspaceInTx(tx: ServerStoreTx, id: WorkspaceId, requestId: string, requestedWorkerId?: WorkerId) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw new AppError(400, 'Invalid retry requestId')
    const workspace = await this.getWorkspace(id, tx.resources)
    const legacyWorkerId = (workspace as Workspace & { workerId?: WorkerId }).workerId
    const workerId = requestedWorkerId ?? workspace.placements.find(placement => placement.status === 'failed' || placement.status === 'pending')?.workerId ?? legacyWorkerId
    if (!workerId) throw new AppError(400, 'workerId is required when Workspace has no retryable placement')
    const worker = requireValue(await tx.resources.getWorker(workerId))
    if (worker.teamId !== (await this.getProject(workspace.projectId, tx.resources)).teamId || worker.connectionState === 'revoked') throw new AppError(403, 'Worker not usable')
    const placement = workspace.placements.find(value => value.workerId === worker.id)
    const previous = placement?.provisioning
    if (previous && Object.hasOwn(previous.requests, requestId)) {
      const commandId = previous.requests[requestId]
      if (typeof commandId === 'string' && commandId.trim()) return { workspace, workerId: worker.id, commandId, created: false }
    }
    if (placement && previous && (placement.status === 'pending' || placement.status === 'provisioning')) {
      const nextPlacement = { ...placement, provisioning: { ...previous, requests: { ...previous.requests, [requestId]: previous.commandId } } }
      const next = this.replacePlacement(workspace, nextPlacement)
      await tx.resources.saveWorkspace(next)
      return { workspace: next, workerId: worker.id, commandId: previous.commandId, created: false }
    }
    if (placement && placement.status !== 'failed' && placement.status !== 'pending') throw new AppError(409, 'Only absent, pending or failed Workspace placements can be provisioned')
    const repositories = workspace.spec.kind === 'repository'
      ? [requireValue(await tx.resources.getRepository(workspace.spec.repositoryId))].map(repository => ({ repositoryId: repository.id, gitUrl: repository.gitUrl, revision: repository.defaultBranch })) : []
    if (workspace.spec.kind === 'composite' && workspace.spec.memberWorkspaceIds.length) throw new AppError(409, 'Composite workspace is not reprovisionable')
    const replacedAttempt = previous !== undefined || await tx.commands.hasProvisionAttempt(id)
    const commandId = await this.command(tx, worker.id, { kind: 'workspace.provision', workspace: { workspace: this.workspaceDefinition(workspace), repositories } })
    const nextPlacement: WorkspacePlacement = { workerId: worker.id, status: 'pending', failureReason: null, location: null, provisioning: { commandId, startedAt: now(), replacedAttempt, requests: { ...previous?.requests, [requestId]: commandId } } }
    const next = this.replacePlacement(workspace, nextPlacement)
    await tx.resources.saveWorkspace(next)
    await this.audit(tx, 'workspace.reprovision', { kind: 'workspace', id })
    return { workspace: next, workerId: worker.id, commandId, created: true }
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
    if (w.deletedAt) throw new AppError(404, 'Workspace deleted')
    return w
  }
  sessionView(id: SessionId) {
    return this.store.transaction(async tx => {
      const session = await this.getSession(id, tx.resources)
      return { ...session, archivedAt: session.archivedAt ?? null, ...await this.executionState(tx, id), sendCapability: await sendCapability(tx, session) }
    })
  }
  private async executionState(tx: ServerStoreTx, id: SessionId) {
    const queued = new Map<MessageId, { commandId: CommandId; messageId: MessageId; content: string; position: number | null }>()
    const observed = new Set<CommandId>(), settled = new Set<MessageId>()
    let activeTurnId: TurnId | null = null
    let from = 1 as EventSeq
    for (;;) {
      const page = await tx.cache.readEvents(id, from, 500)
      for (const { payload: p } of page.events) {
        if (p.kind === 'message.queued') {
          observed.add(p.commandId)
          queued.set(p.messageId, { commandId: p.commandId, messageId: p.messageId, content: p.content, position: p.position })
        }
        if (p.kind === 'message.cancelled' || p.kind === 'turn.started') {
          queued.delete(p.messageId)
          settled.add(p.messageId)
        }
        if (p.kind === 'turn.started') activeTurnId = p.turnId
        if (p.kind === 'turn.finished' && activeTurnId === p.turnId) activeTurnId = null
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
    return { activeTurnId, queuedMessages: [...queued.values()], freshness: await tx.cache.getFreshness(id) }
  }
  async getSession(id: SessionId, resources = this.store.resources): Promise<Session> {
    const s = requireValue(await resources.getSession(id)); await this.getProject(s.projectId, resources)
    if (s.deletedAt) throw new AppError(404, 'Session deleted')
    return s
  }
  async createProject(input: unknown, actor?: UserId) {
    const b = object(input)
    requireValue(await this.store.identity.getTeam(teamId), 'Bootstrap required')
    const project: Project = { id: newId(), teamId, ownerId: actor ?? await this.operator(), name: text(b.name, 'name', 200), shareScope: 'owner-only', deletedAt: null }
    await this.store.transaction(async tx => { await tx.resources.saveProject(project); await this.audit(tx, 'project.create', { kind: 'project', id: project.id }, actor) })
    return project
  }
  private async command(tx: ServerStoreTx, workerId: WorkerId, command: WorkerCommand, id = newId<'CommandId'>()) {
    const fingerprint = canonicalFingerprint(command)
    const existing = await tx.commands.get(id)
    if (existing) {
      if (existing.workerId !== workerId || existing.payloadFingerprint !== fingerprint) throw new AppError(409, 'Conflicting commandId')
      return id
    }
    await tx.commands.insertPending({ commandId: id, workerId, command, payloadFingerprint: fingerprint, createdAt: now() })
    return id
  }
  async createWorkspace(input: unknown): Promise<{ workspace: Workspace; workerId: WorkerId; commandId: CommandId } | { workspace: Workspace; workerId: undefined; commandId: undefined }> {
    const result = await this.store.transaction(tx => this.createWorkspaceInTx(tx, input))
    if (result.workerId) this.notifications.commands(result.workerId)
    this.notifications.project({ id: randomUUID(), projectId: result.workspace.projectId, workspaceId: result.workspace.id, type: 'workspace.provisioning' })
    return result
  }
  /** Internal composition seam: caller owns the transaction and post-commit notification. */
  async createWorkspaceInTx(tx: ServerStoreTx, input: unknown): Promise<{ workspace: Workspace; workerId: WorkerId; commandId: CommandId } | { workspace: Workspace; workerId: undefined; commandId: undefined }> {
    const b = object(input), p = await this.getProject(text(b.projectId, 'projectId') as ProjectId, tx.resources)
    const requestedWorkerId = b.workerId === undefined ? undefined : text(b.workerId, 'workerId') as WorkerId
    const worker = requestedWorkerId ? requireValue(await tx.resources.getWorker(requestedWorkerId)) : null
    if (worker && (worker.teamId !== p.teamId || worker.connectionState === 'revoked')) throw new AppError(403, 'Worker not usable')
    const source = b.source === undefined ? (b.repository === undefined ? 'empty' : 'git') : text(b.source, 'source')
    if (source !== 'empty' && source !== 'git') throw new AppError(400, 'source must be empty or git')
    const repository = source === 'git' ? (() => {
      const repo = object(b.repository)
      return { id: newId<'RepositoryId'>(), projectId: p.id, name: text(repo.name ?? b.name, 'repository name', 200), gitUrl: text(repo.gitUrl, 'gitUrl'), defaultBranch: text(repo.revision ?? 'main', 'revision') }
    })() : null
    if (source === 'empty' && b.repository !== undefined) throw new AppError(400, 'Empty workspace cannot include repository')
    const workspace: Workspace = { id: newId(), projectId: p.id, name: text(b.name, 'name', 200), spec: repository ? { kind: 'repository', repositoryId: repository.id, ownership: { kind: 'standalone' } } : { kind: 'composite', memberWorkspaceIds: [] }, placements: [], deletedAt: null }
    if (repository) await tx.resources.saveRepository(repository)
    await tx.resources.saveWorkspace(workspace)
    if (!worker) {
      await this.audit(tx, 'workspace.create', { kind: 'workspace', id: workspace.id })
      return { workspace: { ...workspace, status: 'unplaced' as const, failureReason: null, location: null }, workerId: undefined, commandId: undefined }
    }
    const repositories = repository ? [{ repositoryId: repository.id, gitUrl: repository.gitUrl, revision: repository.defaultBranch }] : []
    const commandId = await this.command(tx, worker.id, { kind: 'workspace.provision', workspace: { workspace: this.workspaceDefinition(workspace), repositories } })
    const pending = this.replacePlacement(workspace, { workerId: worker.id, status: 'pending', failureReason: null, location: null, provisioning: { commandId, startedAt: now(), replacedAttempt: false, requests: {} } })
    await tx.resources.saveWorkspace(pending)
    await this.audit(tx, 'workspace.create', { kind: 'workspace', id: workspace.id })
    return { workspace: { ...pending, workerId: worker.id, status: 'pending' as const, failureReason: null, provisioning: pending.placements[0].provisioning, location: null }, workerId: worker.id, commandId }
  }
  async createSession(input: unknown) {
    const result = await this.store.transaction(tx => this.createSessionInTx(tx, input))
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
    if (workspace.projectId !== input.projectId) throw new AppError(409, 'Fork target Workspace belongs to another Project', 'fork_target_scope')
    if (workspace.deletedAt !== null) throw new AppError(409, 'Fork target Workspace is deleted', 'fork_target_deleted')
    // Session 级幂等键必须与 Fork 自己的键分开命名空间，否则一个客户端用同一个 requestId
    // 创建普通 Session 时会与 Fork 目标撞车。
    const created = await this.createSessionInTx(tx, { requestId: `fork:${input.requestId}`, workspaceId: input.workspaceId, workerId: input.workerId, agentKey: input.agentKey, modelId: input.modelId, title: input.title }, { ownerId: input.ownerId })
    // 走到这里说明 Fork 记录还不存在却已有同 requestId 的目标：宁可失败，也不能给同一个目标补第二条边。
    if (!created.created) throw new AppError(409, 'Fork target Session already exists for this requestId', 'request_id_conflict')
    return created.session
  }
  /** Internal composition seam; never opens a transaction or notifies. */
  async createSessionInTx(tx: ServerStoreTx, input: unknown, provenance?: SessionProvenance) {
    const b = object(input), workspace = await this.getWorkspace(text(b.workspaceId, 'workspaceId') as WorkspaceId, tx.resources)
    const source = provenance === undefined || (provenance.taskId === undefined && provenance.runId === undefined) ? undefined : { taskId: provenance.taskId ?? null, runId: provenance.runId ?? null }
    const requestedWorkerId = b.workerId === undefined ? undefined : text(b.workerId, 'workerId') as WorkerId
    const readyPlacements = workspace.placements.filter(placement => placement.status === 'ready')
    const selected = requestedWorkerId ? readyPlacements.find(placement => placement.workerId === requestedWorkerId) : readyPlacements.length === 1 ? readyPlacements[0] : undefined
    if (!selected) throw new AppError(409, requestedWorkerId ? 'Workspace is not ready on selected Worker' : readyPlacements.length ? 'workerId is required when Workspace is ready on multiple Workers' : 'Workspace has no ready placement')
    const worker = requireValue(await tx.resources.getWorker(selected.workerId))
    const agentKey = text(b.agentKey, 'agentKey') as AgentKey
    // modelId is optional at the HTTP boundary: when omitted we resolve the Agent's
    // first advertised model, because the send capability and the worker protocol
    // both require a concrete modelId on the Session binding.
    const requestedModelId = b.modelId === undefined || b.modelId === null ? null : text(b.modelId, 'modelId') as ModelId
    const title = text(b.title, 'title', 200)
    if (!source && Object.keys(b).some(key => !['requestId', 'workspaceId', 'workerId', 'title', 'agentKey', 'modelId', 'shareScope'].includes(key))) throw new AppError(400, 'Invalid Session creation request')
    if (!source && b.shareScope !== undefined && b.shareScope !== 'owner-only') throw new AppError(400, 'Invalid Session shareScope')
    const requestId = source || b.requestId === undefined ? undefined : text(b.requestId, 'requestId', 200)
    if (!source && !requestId) throw new AppError(400, 'Invalid requestId')
    const agent = worker.capabilities?.find(c => c?.agentKey === agentKey)
    if (worker.connectionState === 'revoked' || !agent || agent.mode !== 'execution' || agent.availability?.status !== 'available') throw new AppError(409, 'Agent unavailable')
    if (requestedModelId !== null && !agent.models?.some(model => model?.modelId === requestedModelId)) throw new AppError(409, 'Model unavailable')
    const modelId = requestedModelId ?? agent.models?.map(model => model?.modelId).find(id => !!id) ?? null
    if (modelId === null) throw new AppError(409, 'Agent exposes no models')
    const fingerprint = createHash('sha256').update(canonicalCommand({ workspaceId: workspace.id, workerId: worker.id, agentKey, modelId, title, shareScope: 'owner-only' })).digest('hex')
    const ownerId = provenance?.ownerId ?? await this.operator(undefined, tx)
    if (requestId) {
      const previous = await tx.resources.getSessionByCreateRequest(ownerId, workspace.projectId, requestId)
      if (previous) {
        if (previous.creation?.fingerprint !== fingerprint) throw new AppError(409, 'requestId already belongs to a different Session request', 'request_id_conflict')
        return { session: previous, commandId: previous.creation.commandId as CommandId, created: false }
      }
    }
    const sessionId = newId<'SessionId'>(), commandId = newId<'CommandId'>()
    const session: Session = { id: sessionId, projectId: workspace.projectId, ownerId, workspaceId: workspace.id, title, shareScope: 'owner-only', binding: { workspaceId: workspace.id, agent: { workerId: worker.id, agentKey }, modelId }, runtimeState: 'idle', archivedAt: null, deletedAt: null, ...(requestId ? { creation: { requestId, fingerprint, commandId } } : {}), ...source }
    await tx.resources.saveSession(session)
    await this.command(tx, worker.id, { kind: 'session.create', session: { sessionId: session.id, binding: session.binding } }, commandId)
    await this.audit(tx, 'session.create', { kind: 'session', id: session.id })
    return { session, commandId, created: true }
  }
  async enqueue(id: SessionId, input: unknown) {
    const { workerId, ...result } = await this.store.transaction(tx => this.enqueueInTx(tx, id, input))
    this.notifications.commands(workerId)
    return { ...result, status: (await this.store.commands.get(result.commandId))!.status }
  }
  /** Internal composition seam; capability preparation is local and read-only. */
  async enqueueInTx(tx: ServerStoreTx, id: SessionId, input: unknown) {
    const b = object(input), session = await this.getSession(id, tx.resources)
    await this.getWorkspace(session.workspaceId, tx.resources)
    const capability = await sendCapability(tx, session)
    if (!capability.allowed) throw new AppError(409, capability.reason, capability.reasonCode)
    const commandId = b.commandId === undefined ? newId<'CommandId'>() : text(b.commandId, 'commandId', 200) as CommandId
    // Stable default message identity makes commandId retries idempotent.
    const messageId = (b.messageId === undefined ? commandId : text(b.messageId, 'messageId', 200)) as unknown as MessageId
    const content = text(b.content, 'content', 100000)
    if (content.includes('\0')) throw new AppError(400, 'Message contains an unsupported NUL character')
    if (Buffer.byteLength(JSON.stringify(content)) > 200000) throw new AppError(400, 'Message exceeds the protocol byte limit')
    const prepared = this.capabilities ? await this.capabilities.prepareTurn({ sessionId: id, turnId: newId<'TurnId'>() }, tx.resources) : null
    const command: WorkerCommand = { kind: 'session.enqueue', sessionId: id, message: { messageId, content }, ...(prepared ? { capabilities: prepared.runtime } : {}) }
    if (new TextEncoder().encode(JSON.stringify({ type: 'command', commandId, command })).byteLength > 900 * 1024) throw new AppError(413, 'Message and capability assets exceed the worker transport limit')
    await this.command(tx, session.binding.agent.workerId, command, commandId)
    await this.audit(tx, 'session.enqueue', { kind: 'session', id })
    return { commandId, messageId, workerId: session.binding.agent.workerId }
  }
  async cancelQueued(id: SessionId, submissionCommandId: CommandId, input: unknown) {
    const b = object(input)
    const commandId = b.commandId === undefined ? newId<'CommandId'>() : text(b.commandId, 'commandId', 200) as CommandId
    return this.sessionControl(id, commandId, async tx => {
      const submission = await tx.commands.getPendingCommand(submissionCommandId)
      if (!submission || submission.command.kind !== 'session.enqueue' || submission.command.sessionId !== id) throw new AppError(404, 'Queued submission not found in Session')
      return { kind: 'session.cancel-queued', sessionId: id, submissionCommandId }
    })
  }
  async stopTurn(id: SessionId, input: unknown) {
    const b = object(input)
    const commandId = b.commandId === undefined ? newId<'CommandId'>() : text(b.commandId, 'commandId', 200) as CommandId
    return this.sessionControl(id, commandId, async tx => {
      // A retry must retain its original target, even after another Turn starts.
      const previous = await tx.commands.getPendingCommand(commandId)
      const turnId = b.turnId === undefined
        ? previous?.command.kind === 'turn.stop' && previous.command.sessionId === id ? previous.command.turnId : (await this.executionState(tx, id)).activeTurnId
        : text(b.turnId, 'turnId', 200) as TurnId
      if (!turnId) throw new AppError(409, 'Session has no observed active Turn')
      if (!previous && turnId !== (await this.executionState(tx, id)).activeTurnId) throw new AppError(409, 'Turn is not active in Session')
      return { kind: 'turn.stop', sessionId: id, turnId }
    })
  }
  private async sessionControl(id: SessionId, commandId: CommandId, build: (tx: ServerStoreTx) => Promise<WorkerCommand>) {
    const workerId = await this.store.transaction(async tx => {
      const session = await this.getSession(id, tx.resources)
      const command = await build(tx)
      const existing = await tx.commands.get(commandId)
      await this.command(tx, session.binding.agent.workerId, command, commandId)
      if (!existing) await this.audit(tx, command.kind, { kind: 'session', id })
      return session.binding.agent.workerId
    })
    this.notifications.commands(workerId)
    return { commandId }
  }
  async invokeRuntimeCommand(id: SessionId, input: unknown) {
    const b = object(input)
    const commandId = b.commandId === undefined ? newId<'CommandId'>() : text(b.commandId, 'commandId', 200) as CommandId
    const operationId = (b.operationId === undefined ? commandId : text(b.operationId, 'operationId', 200)) as RuntimeOperationId
    const name = text(b.name, 'name', 200)
    if (name !== 'compact' && name !== 'set_model' && name !== 'set_thinking_level') throw new AppError(400, 'Unsupported runtime command')
    const args = b.arguments === undefined ? {} : object(b.arguments)
    const runtimeName = name as Extract<WorkerCommand, { kind: 'runtime.command' }>['name']
    return this.sessionControl(id, commandId, async () => ({ kind: 'runtime.command', sessionId: id, operationId, name: runtimeName, arguments: args }))
  }
  async resolveRuntimeApproval(id: SessionId, approvalId: ApprovalId, input: unknown) {
    const b = object(input), decision = text(b.decision, 'decision')
    if (decision !== 'approve' && decision !== 'deny') throw new AppError(400, 'decision must be approve or deny')
    const commandId = b.commandId === undefined ? newId<'CommandId'>() : text(b.commandId, 'commandId', 200) as CommandId
    return this.sessionControl(id, commandId, async () => ({ kind: 'runtime.approval.resolve', sessionId: id, approvalId, decision }))
  }
  async events(id: SessionId, from: number, limit: number) {
    await this.getSession(id)
    return { ...await this.store.cache.readEvents(id, integer(from, 'fromSeq', 1) as EventSeq, integer(limit, 'limit', 1, 1000)), freshness: await this.store.cache.getFreshness(id) }
  }
  async update(kind: 'projects' | 'workspaces' | 'sessions', id: string, input: unknown) {
    const b = object(input)
    return this.store.transaction(async tx => {
      await this.audit(tx, `${kind}.update`, kind === 'projects' ? { kind: 'project', id: id as ProjectId } : kind === 'workspaces' ? { kind: 'workspace', id: id as WorkspaceId } : { kind: 'session', id: id as SessionId })
      if (kind === 'projects') { const p = { ...await this.getProject(id as ProjectId, tx.resources), name: text(b.name, 'name', 200) }; await tx.resources.saveProject(p); return p }
      if (kind === 'workspaces') { const w = { ...await this.getWorkspace(id as WorkspaceId, tx.resources), name: text(b.name, 'name', 200) }; await tx.resources.saveWorkspace(w); return w }
      if (Object.keys(b).some(key => !['title', 'archived'].includes(key)) || (b.title === undefined && b.archived === undefined)) throw new AppError(400, 'Expected title or archived')
      if (b.archived !== undefined && typeof b.archived !== 'boolean') throw new AppError(400, 'archived must be boolean')
      const session = await this.getSession(id as SessionId, tx.resources)
      const s = { ...session, title: b.title === undefined ? session.title : text(b.title, 'title', 200), archivedAt: b.archived === undefined ? session.archivedAt ?? null : b.archived ? session.archivedAt ?? now() : null }
      await tx.resources.saveSession(s)
      return s
    })
  }
  async delete(kind: 'projects' | 'workspaces' | 'sessions', id: string) {
    if (kind === 'projects') {
      const project = await this.getProject(id as ProjectId)
      if ((await this.store.resources.listWorkspaces()).some(workspace => workspace.projectId === project.id && !workspace.deletedAt)) throw new AppError(409, 'Delete workspaces first')
    }
    await this.store.transaction(async tx => {
      await this.audit(tx, `${kind}.delete`, kind === 'projects' ? { kind: 'project', id: id as ProjectId } : kind === 'workspaces' ? { kind: 'workspace', id: id as WorkspaceId } : { kind: 'session', id: id as SessionId })
      if (kind === 'projects') await tx.resources.saveProject({ ...await this.getProject(id as ProjectId, tx.resources), deletedAt: now() })
      else if (kind === 'sessions') {
        const session = await this.getSession(id as SessionId, tx.resources)
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
        throw new AppError(501, 'Workspace deletion is not supported in this MVP')
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
  async listSessions(filter: { archived?: boolean } = {}): Promise<Session[]> {
    const projectIds = new Set((await this.listProjects()).map(project => project.id))
    return (await this.store.resources.listSessions()).filter(
      session => projectIds.has(session.projectId) && !session.deletedAt && (filter.archived === undefined || Boolean(session.archivedAt) === filter.archived),
    )
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
