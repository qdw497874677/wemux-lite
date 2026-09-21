import { createHash, randomUUID } from 'node:crypto'
import type { AuditEntryId, CommandId, EventSeq, MessageId, SessionId, Timestamp, TurnId, UserId, WorkerId } from '@wemux/domain'
import type { AuditPage, AuditQuery, User, UserStatus } from '@wemux/server-domain'
import type { AdministratorDirectory } from './administrator-directory.js'
import { AppError } from './errors.js'
import type { Clock, IdentityService } from './identity-service.js'
import { systemClock } from './identity-service.js'
import type { Notifications } from './notifications.js'
import type { ServerStore, ServerStoreTx } from './ports/server-store.js'

export interface AccountLifecycleView {
  readonly status: UserStatus
  readonly statusChangedAt: Timestamp | null
  readonly blockers: readonly string[]
}

const statusOf = (user: User): UserStatus => user.status ?? 'active'
const versionOf = (user: User): number => user.authVersion ?? 0
const at = (clock: Clock): Timestamp => clock.now().toISOString() as Timestamp

export class AccountLifecycleService {
  constructor(
    private readonly store: ServerStore,
    private readonly administrators: AdministratorDirectory,
    private readonly identity: IdentityService,
    private readonly notifications?: Notifications,
    private readonly clock: Clock = systemClock,
  ) {}

  async view(actorId: UserId): Promise<AccountLifecycleView> {
    const user = await this.requireUser(actorId)
    return { status: statusOf(user), statusChangedAt: user.statusChangedAt ?? null, blockers: await this.blockers(actorId) }
  }

  async exportAudit(actorId: UserId, input: Omit<AuditQuery, 'cursor' | 'limit'>): Promise<readonly import('@wemux/server-domain').AuditEntry[]> {
    const items: import('@wemux/server-domain').AuditEntry[] = []
    let cursor: string | undefined
    do {
      const page = await this.audit(actorId, { ...input, cursor, limit: 200 })
      items.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return items
  }

  async users(actorId: UserId): Promise<readonly { id: UserId; username: string; email: string | null; status: UserStatus; statusChangedAt: Timestamp | null }[]> {
    await this.requireAdministrator(actorId)
    return (await this.store.identity.listUsers()).map(user => ({ id: user.id, username: user.username, email: user.email, status: statusOf(user), statusChangedAt: user.statusChangedAt ?? null }))
  }

  async audit(actorId: UserId, input: AuditQuery): Promise<AuditPage> {
    if (!await this.identity.isAdministrator(actorId)) {
      if (input.actorId && input.actorId !== actorId) throw new AppError(403, '普通用户只能查询自己的安全审计', 'audit_scope_forbidden')
      if (input.resourceId && input.resourceId !== actorId) throw new AppError(403, '普通用户只能查询自己的安全审计', 'audit_scope_forbidden')
      return this.store.identity.queryAudit({ ...input, actorId: undefined, subjectUserId: actorId })
    }
    return this.store.identity.queryAudit(input)
  }

  async disable(actorId: UserId, targetId: UserId): Promise<void> {
    await this.requireAdministrator(actorId)
    if (actorId === targetId) throw new AppError(409, '不能停用当前管理员账号；请先使用另一名实例管理员', 'self_disable_forbidden')
    const target = await this.requireUser(targetId)
    if (statusOf(target) === 'deleted') throw new AppError(409, '账号已删除', 'account_deleted')
    if (statusOf(target) === 'disabled') return
    await this.assertAdministratorPreserved(targetId)
    const changedAt = at(this.clock)
    const workers = await this.store.transaction(async tx => {
      const stopWorkers = await this.revokeExecution(tx, targetId, 'disable', changedAt)
      await tx.identity.saveUser({ ...target, status: 'disabled', authVersion: versionOf(target) + 1, statusChangedAt: changedAt })
      const revokedSessions = await tx.identity.revokeLoginSessions(targetId, changedAt)
      const revokedTokens = await tx.identity.revokePersonalAccessTokens(targetId, changedAt)
      await this.append(tx, actorId, 'account.disabled', targetId, changedAt, { revokedSessions, revokedTokens, stopCommands: stopWorkers.size })
      return stopWorkers
    })
    this.notify(targetId, workers)
  }

  async restore(actorId: UserId, targetId: UserId): Promise<void> {
    await this.requireAdministrator(actorId)
    const target = await this.requireUser(targetId)
    if (statusOf(target) !== 'disabled') throw new AppError(409, '只有已停用账号可以恢复', 'account_not_disabled')
    const changedAt = at(this.clock)
    await this.store.transaction(async tx => {
      await tx.identity.saveUser({ ...target, status: 'active', authVersion: versionOf(target) + 1, statusChangedAt: changedAt })
      await this.append(tx, actorId, 'account.restored', targetId, changedAt, {})
    })
    this.notifications?.authorization(targetId)
  }

  async requestDeletion(actorId: UserId, targetId = actorId): Promise<AccountLifecycleView> {
    if (actorId !== targetId) await this.requireAdministrator(actorId)
    const target = await this.requireUser(targetId)
    if (statusOf(target) === 'deleted') throw new AppError(409, '账号已删除', 'account_deleted')
    await this.assertAdministratorPreserved(targetId)
    const blockers = await this.blockers(targetId)
    if (blockers.length) throw new AppError(409, `销号前必须处理所有权：${blockers.join('、')}`, 'account_deletion_blocked')
    const changedAt = at(this.clock)
    const workers = await this.store.transaction(async tx => {
      const stopWorkers = await this.revokeExecution(tx, targetId, 'delete', changedAt)
      await tx.identity.saveUser({ ...target, status: 'deletion_pending', authVersion: versionOf(target) + 1, statusChangedAt: changedAt })
      const revokedSessions = await tx.identity.revokeLoginSessions(targetId, changedAt)
      const revokedTokens = await tx.identity.revokePersonalAccessTokens(targetId, changedAt)
      await this.append(tx, actorId, 'account.deletion_requested', targetId, changedAt, { revokedSessions, revokedTokens, stopCommands: stopWorkers.size })
      return stopWorkers
    })
    this.notify(targetId, workers)
    return { status: 'deletion_pending', statusChangedAt: changedAt, blockers: [] }
  }

  async confirmDeletion(actorId: UserId, targetId = actorId): Promise<void> {
    if (actorId !== targetId) await this.requireAdministrator(actorId)
    const target = await this.requireUser(targetId)
    const currentStatus = statusOf(target)
    if (currentStatus !== 'deletion_pending' && currentStatus !== 'active') throw new AppError(409, '账号当前不能删除', 'account_not_deletion_pending')
    if (currentStatus === 'active') await this.assertAdministratorPreserved(targetId)
    const blockers = await this.blockers(targetId)
    if (blockers.length) throw new AppError(409, `销号前必须处理所有权：${blockers.join('、')}`, 'account_deletion_blocked')
    const changedAt = at(this.clock)
    const identities = await this.store.identity.listLoginIdentities(targetId)
    const tombstone = `已删除账号 ${String(targetId).slice(0, 8)}`
    await this.store.transaction(async tx => {
      const projects = await tx.resources.listProjects(), workers = await tx.resources.listWorkers(), sessions = await tx.resources.listSessions()
      for (const project of projects) await tx.identity.removeProjectGrant(project.id, targetId)
      for (const worker of workers) await tx.identity.removeWorkerGrant(worker.id, targetId)
      for (const session of sessions) await tx.identity.removeSessionGrant(session.id, targetId)
      for (const membership of await tx.identity.listMemberships(targetId)) await tx.identity.removeMembership(membership.teamId, targetId)
      // 外部身份绑定行作为墓碑保留，避免同一 issuer+subject 被新账号接管；登录会因目标 User=deleted 被拒绝。
      await tx.identity.deleteLocalAccountCredential(targetId)
      await tx.identity.deleteUserEmailByUserId(targetId)
      await tx.identity.saveUser({ ...target, username: tombstone, email: null, status: 'deleted', authVersion: versionOf(target) + 1, statusChangedAt: changedAt, deletedAt: changedAt })
      await this.append(tx, actorId, 'account.deleted', targetId, changedAt, { identitiesReserved: identities.length, profileAnonymized: true })
      for (const identity of identities) await tx.audit.append({
        id: randomUUID() as AuditEntryId, actorId, action: 'account.identity_tombstoned', resource: { kind: 'user', id: targetId }, result: 'succeeded', occurredAt: changedAt,
        metadata: { provider: identity.provider, identityFingerprint: createHash('sha256').update(`${identity.issuer}\u0000${identity.subject}`).digest('hex').slice(0, 24) },
      })
    })
    this.notifications?.authorization(targetId)
  }

  private async requireUser(userId: UserId): Promise<User> {
    const user = await this.store.identity.getUser(userId)
    if (!user) throw new AppError(404, '账号不存在', 'account_not_found')
    return user
  }

  private async requireAdministrator(actorId: UserId): Promise<void> {
    if (!await this.identity.isAdministrator(actorId)) throw new AppError(403, '需要实例管理员权限', 'admin_required')
  }

  private async assertAdministratorPreserved(userId: UserId): Promise<void> {
    if (!(await this.store.identity.findInstanceAdministrator(userId))) return
    const active = []
    for (const record of await this.store.identity.listInstanceAdministrators()) {
      const user = await this.store.identity.getUser(record.userId)
      if (user && statusOf(user) === 'active') active.push(user)
    }
    if (active.length <= 1) throw new AppError(409, '必须保留至少一个可用的实例管理员', 'last_instance_administrator')
  }

  private async blockers(userId: UserId): Promise<string[]> {
    const blockers: string[] = []
    const ownedTeams = new Set<string>()
    for (const membership of await this.store.identity.listMemberships(userId)) if (membership.role === 'owner') { blockers.push(`Team ${membership.teamId}`); ownedTeams.add(membership.teamId) }
    for (const project of await this.store.resources.listProjects()) if (!project.deletedAt && project.ownerId === userId && !ownedTeams.has(project.teamId)) blockers.push(`Project ${project.name}`)
    for (const worker of await this.store.resources.listWorkers()) if (worker.ownerId === userId && !ownedTeams.has(worker.teamId)) blockers.push(`Worker ${worker.name}`)
    for (const session of await this.store.resources.listSessions()) if (!session.deletedAt && session.ownerId === userId) {
      const project = await this.store.resources.getProject(session.projectId)
      if (!project || !ownedTeams.has(project.teamId)) blockers.push(`Session ${session.title}`)
    }
    return blockers
  }

  private async revokeExecution(tx: ServerStoreTx, userId: UserId, reason: string, createdAt: Timestamp): Promise<Set<WorkerId>> {
    const workerIds = new Set<WorkerId>()
    for (const session of await tx.resources.listSessions()) {
      if (session.deletedAt) continue
      const active = await activeExecutionOwnedBy(tx, session.id, userId)
      if (!active) continue
      const commandId = `account-${reason}:${userId}:${session.id}:${active.turnId}` as CommandId
      const command = { kind: 'turn.stop' as const, sessionId: session.id, turnId: active.turnId }
      if (!await tx.commands.get(commandId)) await tx.commands.insertPending({ commandId, workerId: session.binding.agent.workerId, command, payloadFingerprint: createHash('sha256').update(JSON.stringify(command)).digest('hex'), createdAt })
      workerIds.add(session.binding.agent.workerId)
    }
    return workerIds
  }

  private notify(userId: UserId, workers: Set<WorkerId>): void {
    this.notifications?.authorization(userId)
    for (const workerId of workers) this.notifications?.commands(workerId)
  }

  private async append(tx: ServerStoreTx, actorId: UserId, action: string, targetId: UserId, occurredAt: Timestamp, metadata: Record<string, string | number | boolean | null>): Promise<void> {
    await tx.audit.append({ id: randomUUID() as AuditEntryId, actorId, action, resource: { kind: 'user', id: targetId }, result: 'succeeded', occurredAt, metadata })
  }
}

async function activeExecutionOwnedBy(tx: ServerStoreTx, sessionId: SessionId, userId: UserId): Promise<{ turnId: TurnId } | null> {
  const actors = new Map<MessageId, UserId>()
  let active: { turnId: TurnId; ownerId: UserId | null } | null = null
  let from = 1 as EventSeq
  for (;;) {
    const page = await tx.cache.readEvents(sessionId, from, 500)
    for (const { payload } of page.events) {
      if (payload.kind === 'message.queued' && payload.sentByAccountId) actors.set(payload.messageId, payload.sentByAccountId)
      if (payload.kind === 'turn.started') active = { turnId: payload.turnId, ownerId: actors.get(payload.messageId) ?? null }
      if (payload.kind === 'turn.finished' && active?.turnId === payload.turnId) active = null
    }
    if (!page.nextSeq) break
    from = page.nextSeq
  }
  return active?.ownerId === userId ? { turnId: active.turnId } : null
}
