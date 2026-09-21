import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AuditEntryId, CommandId, EventSeq, MessageId, SessionId, TeamId, Timestamp, TurnId, UserId, WorkerId } from '@wemux/domain'
import type { Membership, Team, TeamInvitation, TeamInvitationStatus, TeamRole, User } from '@wemux/server-domain'
import { hashSecret } from './auth.js'
import { normalizeEmail } from './email-address.js'
import { AppError } from './errors.js'
import type { ServerStore, ServerStoreTx } from './ports/server-store.js'
import type { Notifications } from './notifications.js'

const now = (): Timestamp => new Date().toISOString() as Timestamp
const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000

export interface TeamSummary {
  readonly id: TeamId
  readonly name: string
  readonly role: TeamRole
  readonly memberCount: number
}

export interface TeamInvitationView {
  readonly id: string
  readonly teamId: TeamId
  readonly email: string
  readonly role: Exclude<TeamRole, 'owner'>
  readonly status: TeamInvitationStatus
  readonly invitedBy: UserId
  readonly createdAt: Timestamp
  readonly expiresAt: Timestamp
}

export class TeamService {
  constructor(private readonly store: ServerStore, private readonly notifications?: Notifications) {}

  async create(actorId: UserId, input: unknown): Promise<TeamSummary> {
    const name = teamName(input)
    const team: Team = { id: randomUUID() as TeamId, name, createdAt: now() }
    const membership: Membership = { teamId: team.id, userId: actorId, role: 'owner', joinedAt: team.createdAt }
    await this.store.transaction(async tx => {
      await tx.identity.saveTeam(team)
      await tx.identity.saveMembership(membership)
      await audit(tx, actorId, 'team.create', team.id, team.createdAt, { name })
    })
    return { id: team.id, name: team.name, role: membership.role, memberCount: 1 }
  }

  async list(actorId: UserId): Promise<readonly TeamSummary[]> {
    const memberships = await this.store.identity.listMemberships(actorId)
    const summaries = await Promise.all(memberships.map(async membership => {
      const team = await this.store.identity.getTeam(membership.teamId)
      if (!team) throw new AppError(409, 'Team membership points to a missing Team', 'team_membership_corrupt')
      return { id: team.id, name: team.name, role: membership.role, memberCount: (await this.store.identity.listTeamMemberships(team.id)).length } satisfies TeamSummary
    }))
    return summaries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id))
  }

  async members(actorId: UserId, teamId: TeamId): Promise<readonly { user: User; role: TeamRole; joinedAt: Timestamp }[]> {
    await this.requireMember(actorId, teamId)
    const memberships = await this.store.identity.listTeamMemberships(teamId)
    return Promise.all(memberships.map(async membership => {
      const user = await this.store.identity.getUser(membership.userId)
      if (!user) throw new AppError(409, 'Team membership points to a missing User', 'team_membership_corrupt')
      return { user, role: membership.role, joinedAt: membership.joinedAt }
    }))
  }

  async updateMemberRole(actorId: UserId, teamId: TeamId, userId: UserId, input: unknown): Promise<{ user: User; role: TeamRole; joinedAt: Timestamp }> {
    const role = memberRole(input)
    const updated = await this.store.transaction(async tx => {
      const memberships = await tx.identity.listTeamMemberships(teamId)
      const actor = memberships.find(value => value.userId === actorId)
      if (actor?.role !== 'owner') throw new AppError(403, '只有 Team owner 可以调整治理角色', 'team_owner_required')
      const target = memberships.find(value => value.userId === userId)
      if (!target) throw new AppError(404, '目标成员不存在', 'team_member_not_found')
      if (target.role === 'owner') throw new AppError(409, 'Team owner 必须通过显式所有权转移变更', 'ownership_transfer_required')
      if (role === 'member') await assertInstanceAdministratorPreserved(tx, userId)
      const user = await tx.identity.getUser(userId)
      if (!user) throw new AppError(409, 'Team membership points to a missing User', 'team_membership_corrupt')
      const membership = { ...target, role }
      await tx.identity.saveMembership(membership)
      await audit(tx, actorId, 'team.member.role.update', teamId, now(), { userId, previousRole: target.role, role })
      return { user, role: membership.role, joinedAt: membership.joinedAt }
    })
    this.notifications?.authorization(userId)
    return updated
  }

  async removeMember(actorId: UserId, teamId: TeamId, userId: UserId): Promise<void> {
    const cancellationWorkers = await this.store.transaction(async tx => {
      const memberships = await tx.identity.listTeamMemberships(teamId)
      const actor = memberships.find(value => value.userId === actorId)
      if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) throw new AppError(403, '需要团队管理员权限', 'team_admin_required')
      const target = memberships.find(value => value.userId === userId)
      if (!target) throw new AppError(404, '目标成员不存在', 'team_member_not_found')
      if (target.role === 'owner') throw new AppError(409, 'Team owner 必须先显式转移所有权', 'ownership_transfer_required')
      if (actor.role === 'admin' && target.role !== 'member') throw new AppError(403, 'Team admin 只能移除普通成员', 'team_owner_required')
      await assertInstanceAdministratorPreserved(tx, userId)

      const projects = (await tx.resources.listProjects()).filter(project => project.teamId === teamId && !project.deletedAt)
      const workers = (await tx.resources.listWorkers()).filter(worker => worker.teamId === teamId)
      const projectIds = new Set(projects.map(project => project.id))
      const sessions = (await tx.resources.listSessions()).filter(session => projectIds.has(session.projectId) && !session.deletedAt)
      const owned = [
        ...projects.filter(project => project.ownerId === userId).map(project => `project:${project.id}`),
        ...workers.filter(worker => worker.ownerId === userId).map(worker => `worker:${worker.id}`),
        ...sessions.filter(session => session.ownerId === userId).map(session => `session:${session.id}`),
      ]
      if (owned.length > 0) throw new AppError(409, '该成员仍拥有团队资源，请先转移所有权', 'member_owns_resources')

      const cancellationWorkers = new Set<WorkerId>()
      let stopCommands = 0
      for (const session of sessions) {
        const execution = await activeExecutionOwnedBy(tx, session.id, userId)
        if (!execution) continue
        const commandId = `membership-revocation:${teamId}:${userId}:${session.id}:${execution.turnId}` as CommandId
        const command = { kind: 'turn.stop' as const, sessionId: session.id, turnId: execution.turnId }
        const existing = await tx.commands.get(commandId)
        if (existing) {
          if (existing.workerId !== session.binding.agent.workerId || existing.payloadFingerprint !== commandFingerprint(command)) throw new AppError(409, '撤权停止命令冲突', 'revocation_command_conflict')
        } else {
          await tx.commands.insertPending({ commandId, workerId: session.binding.agent.workerId, command, payloadFingerprint: commandFingerprint(command), createdAt: now() })
          stopCommands++
        }
        cancellationWorkers.add(session.binding.agent.workerId)
      }

      let projectGrants = 0, workerGrants = 0, sessionGrants = 0
      for (const project of projects) {
        if ((await tx.identity.listProjectGrants(project.id)).some(grant => grant.userId === userId)) projectGrants++
        await tx.identity.removeProjectGrant(project.id, userId)
      }
      for (const worker of workers) {
        if ((await tx.identity.listWorkerGrants(worker.id)).some(grant => grant.userId === userId)) workerGrants++
        await tx.identity.removeWorkerGrant(worker.id, userId)
      }
      for (const session of sessions) {
        if ((await tx.identity.listSessionGrants(session.id)).some(grant => grant.userId === userId)) sessionGrants++
        await tx.identity.removeSessionGrant(session.id, userId)
      }
      await tx.identity.removeMembership(teamId, userId)
      await audit(tx, actorId, 'team.member.remove', teamId, now(), {
        userId,
        previousRole: target.role,
        projectGrants: String(projectGrants),
        workerGrants: String(workerGrants),
        sessionGrants: String(sessionGrants),
        stopCommands: String(stopCommands),
      })
      return [...cancellationWorkers]
    })
    this.notifications?.authorization(userId)
    for (const workerId of cancellationWorkers) this.notifications?.commands(workerId)
  }

  async transferOwnership(actorId: UserId, teamId: TeamId, input: unknown): Promise<{ teamId: TeamId; ownerId: UserId; previousOwnerId: UserId }> {
    const { userId, confirmation } = ownershipTransfer(input)
    return this.store.transaction(async tx => {
      const team = await tx.identity.getTeam(teamId)
      if (!team) throw new AppError(404, '团队不存在', 'team_not_found')
      if (confirmation !== team.name) throw new AppError(400, '请输入完整团队名称确认转移', 'ownership_confirmation_mismatch')
      const memberships = await tx.identity.listTeamMemberships(teamId)
      const currentOwner = memberships.find(value => value.userId === actorId)
      if (currentOwner?.role !== 'owner') throw new AppError(403, '只有 Team owner 可以转移所有权', 'team_owner_required')
      if (userId === actorId) throw new AppError(409, '目标成员已经是 Team owner', 'ownership_target_is_owner')
      const successor = memberships.find(value => value.userId === userId)
      if (!successor) throw new AppError(404, '目标成员不存在', 'team_member_not_found')
      const transferredAt = now()
      await tx.identity.saveMembership({ ...currentOwner, role: 'admin' })
      await tx.identity.saveMembership({ ...successor, role: 'owner' })
      await audit(tx, actorId, 'team.ownership.transfer', teamId, transferredAt, { ownerId: userId, previousOwnerId: actorId })
      return { teamId, ownerId: userId, previousOwnerId: actorId }
    })
  }

  async invite(actorId: UserId, teamId: TeamId, input: unknown): Promise<TeamInvitationView & { token: string; existingAccount: boolean }> {
    await this.requireManager(actorId, teamId)
    const { normalized, display } = invitationEmail(input)
    const existingAccount = await this.store.identity.getUserByLogin(normalized) !== null
    const existing = (await this.store.identity.listTeamInvitations(teamId)).find(value => value.emailNormalized === normalized && invitationStatus(value) === 'pending')
    if (existing) throw new AppError(409, '该邮箱已有待处理邀请', 'invitation_pending')
    const token = randomBytes(32).toString('base64url')
    const createdAt = now()
    const invitation: TeamInvitation = {
      id: randomUUID(), teamId, emailNormalized: normalized, emailDisplay: display, role: 'member', tokenHash: hashSecret(token), invitedBy: actorId,
      createdAt, expiresAt: new Date(Date.parse(createdAt) + invitationLifetimeMs).toISOString() as Timestamp, consumedAt: null, revokedAt: null,
    }
    await this.store.transaction(async tx => {
      await tx.identity.saveTeamInvitation(invitation)
      await audit(tx, actorId, 'team.invitation.create', teamId, createdAt, { invitationId: invitation.id, email: normalized, role: invitation.role })
    })
    return { ...invitationView(invitation), token, existingAccount }
  }

  async invitations(actorId: UserId, teamId: TeamId): Promise<readonly TeamInvitationView[]> {
    await this.requireManager(actorId, teamId)
    return (await this.store.identity.listTeamInvitations(teamId)).map(invitationView)
  }

  async revoke(actorId: UserId, teamId: TeamId, invitationId: string): Promise<TeamInvitationView> {
    await this.requireManager(actorId, teamId)
    const invitation = (await this.store.identity.listTeamInvitations(teamId)).find(value => value.id === invitationId)
    if (!invitation) throw new AppError(404, '邀请不存在', 'invitation_not_found')
    const status = invitationStatus(invitation)
    if (status !== 'pending') throw terminalInvitationError(status)
    const revokedAt = now()
    return this.store.transaction(async tx => {
      const revoked = await tx.identity.revokeTeamInvitation(invitationId, revokedAt)
      if (!revoked) throw new AppError(409, '邀请已不再可撤销', 'invitation_not_pending')
      await audit(tx, actorId, 'team.invitation.revoke', teamId, revokedAt, { invitationId })
      return invitationView(revoked)
    })
  }

  async preview(token: string): Promise<{ team: { id: TeamId; name: string }; email: string; role: Exclude<TeamRole, 'owner'>; status: TeamInvitationStatus }> {
    const invitation = await this.lookup(token)
    const team = await this.store.identity.getTeam(invitation.teamId)
    if (!team) throw new AppError(404, '邀请不存在', 'invitation_not_found')
    return { team: { id: team.id, name: team.name }, email: invitation.emailNormalized, role: invitation.role, status: invitationStatus(invitation) }
  }

  async accept(actorId: UserId, token: string): Promise<{ teamId: TeamId; role: TeamRole }> {
    return this.store.transaction(tx => this.acceptWithin(tx, actorId, token))
  }

  async assertInvitableRegistration(token: string, expectedEmail: string): Promise<void> {
    const invitation = await this.lookup(token)
    const status = invitationStatus(invitation)
    if (status !== 'pending') throw terminalInvitationError(status)
    const email = normalizeEmail(expectedEmail)?.normalized
    if (!email || email !== invitation.emailNormalized) throw new AppError(403, '注册邮箱与邀请目标不匹配', 'invitation_email_mismatch')
    await this.requireActiveInviter(invitation, this.store)
  }

  tokenHash(token: string): string {
    if (!token || token.length > 200) throw new AppError(404, '邀请不存在', 'invitation_not_found')
    return hashSecret(token)
  }

  async acceptWithin(tx: ServerStoreTx, actorId: UserId, token: string, expectedEmail?: string): Promise<{ teamId: TeamId; role: TeamRole }> {
    return this.acceptByHashWithin(tx, actorId, this.tokenHash(token), expectedEmail)
  }

  async acceptByHashWithin(tx: ServerStoreTx, actorId: UserId, tokenHash: string, expectedEmail?: string): Promise<{ teamId: TeamId; role: TeamRole }> {
    const invitation = await tx.identity.findTeamInvitationByTokenHash(tokenHash)
    if (!invitation) throw new AppError(404, '邀请不存在', 'invitation_not_found')
    const status = invitationStatus(invitation)
    if (status !== 'pending') throw terminalInvitationError(status)
    const email = expectedEmail ? normalizeEmail(expectedEmail)?.normalized : (await tx.identity.getUserEmail(actorId))?.emailNormalized
    if (!email || email !== invitation.emailNormalized) throw new AppError(403, '当前账号邮箱与邀请目标不匹配', 'invitation_email_mismatch')
    const acceptedAt = now()
    await this.requireActiveInviter(invitation, tx)
    const existing = (await tx.identity.listTeamMemberships(invitation.teamId)).find(value => value.userId === actorId)
    if (existing) {
      await tx.identity.consumeTeamInvitation({ tokenHash: invitation.tokenHash, consumedAt: acceptedAt })
      return { teamId: invitation.teamId, role: existing.role }
    }
    const consumed = await tx.identity.consumeTeamInvitation({ tokenHash: invitation.tokenHash, consumedAt: acceptedAt })
    if (!consumed) throw new AppError(409, '邀请已被使用', 'invitation_consumed')
    await tx.identity.saveMembership({ teamId: invitation.teamId, userId: actorId, role: invitation.role, joinedAt: acceptedAt })
    await audit(tx, actorId, 'team.invitation.accept', invitation.teamId, acceptedAt, { invitationId: invitation.id, role: invitation.role })
    return { teamId: invitation.teamId, role: invitation.role }
  }

  private async lookup(token: string, store: ServerStore | ServerStoreTx = this.store): Promise<TeamInvitation> {
    const invitation = await store.identity.findTeamInvitationByTokenHash(this.tokenHash(token))
    if (!invitation) throw new AppError(404, '邀请不存在', 'invitation_not_found')
    return invitation
  }

  private async requireActiveInviter(invitation: TeamInvitation, store: ServerStore | ServerStoreTx): Promise<void> {
    const manager = (await store.identity.listTeamMemberships(invitation.teamId)).find(value => value.userId === invitation.invitedBy)
    if (!manager || (manager.role !== 'owner' && manager.role !== 'admin')) throw new AppError(409, '邀请者已无权管理该团队', 'inviter_no_longer_authorized')
  }

  private async requireMember(actorId: UserId, teamId: TeamId): Promise<Membership> {
    const membership = (await this.store.identity.listTeamMemberships(teamId)).find(value => value.userId === actorId)
    if (!membership) throw new AppError(403, '不是该团队成员', 'team_membership_required')
    return membership
  }

  private async requireManager(actorId: UserId, teamId: TeamId): Promise<Membership> {
    const membership = await this.requireMember(actorId, teamId)
    if (membership.role !== 'owner' && membership.role !== 'admin') throw new AppError(403, '需要团队管理员权限', 'team_admin_required')
    return membership
  }
}

function invitationStatus(value: TeamInvitation): TeamInvitationStatus {
  if (value.consumedAt !== null) return 'accepted'
  if (value.revokedAt !== null) return 'revoked'
  if (Date.parse(value.expiresAt) <= Date.now()) return 'expired'
  return 'pending'
}
function invitationView(value: TeamInvitation): TeamInvitationView {
  return { id: value.id, teamId: value.teamId, email: value.emailNormalized, role: value.role, status: invitationStatus(value), invitedBy: value.invitedBy, createdAt: value.createdAt, expiresAt: value.expiresAt }
}
function terminalInvitationError(status: TeamInvitationStatus): AppError {
  if (status === 'accepted') return new AppError(409, '邀请已被使用', 'invitation_consumed')
  if (status === 'revoked') return new AppError(409, '邀请已被撤销', 'invitation_revoked')
  return new AppError(410, '邀请已过期', 'invitation_expired')
}
function teamName(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, '请输入团队名称', 'invalid_team_name')
  const record = input as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'name')) throw new AppError(400, '团队创建参数不合法', 'invalid_request')
  if (typeof record.name !== 'string') throw new AppError(400, '请输入团队名称', 'invalid_team_name')
  const name = record.name.trim()
  if (!name) throw new AppError(400, '请输入团队名称', 'invalid_team_name')
  if (name.length > 80) throw new AppError(400, '团队名称不能超过 80 个字符', 'invalid_team_name')
  return name
}
async function activeExecutionOwnedBy(tx: ServerStoreTx, sessionId: SessionId, userId: UserId): Promise<{ turnId: TurnId } | null> {
  const messageActors = new Map<MessageId, UserId>()
  let active: { turnId: TurnId; ownerId: UserId | null } | null = null
  let from = 1 as EventSeq
  for (;;) {
    const page = await tx.cache.readEvents(sessionId, from, 500)
    for (const { payload } of page.events) {
      if (payload.kind === 'message.queued' && payload.sentByAccountId) messageActors.set(payload.messageId, payload.sentByAccountId)
      if (payload.kind === 'turn.started') active = { turnId: payload.turnId, ownerId: messageActors.get(payload.messageId) ?? null }
      if (payload.kind === 'turn.finished' && active?.turnId === payload.turnId) active = null
    }
    if (!page.nextSeq) break
    from = page.nextSeq
  }
  return active?.ownerId === userId ? { turnId: active.turnId } : null
}
function commandFingerprint(command: { kind: 'turn.stop'; sessionId: SessionId; turnId: TurnId }): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex')
}
async function assertInstanceAdministratorPreserved(tx: ServerStoreTx, userId: UserId): Promise<void> {
  if (!(await tx.identity.findInstanceAdministrator(userId))) return
  const administrators = await tx.identity.listInstanceAdministrators()
  if (administrators.length <= 1) throw new AppError(409, '必须保留至少一个实例恢复管理员', 'last_instance_administrator')
}
function memberRole(input: unknown): Exclude<TeamRole, 'owner'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, '成员角色参数不合法', 'invalid_request')
  const record = input as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'role') || (record.role !== 'admin' && record.role !== 'member')) throw new AppError(400, '角色只能是 admin 或 member', 'invalid_team_role')
  return record.role
}
function ownershipTransfer(input: unknown): { userId: UserId; confirmation: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, '所有权转移参数不合法', 'invalid_request')
  const record = input as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'userId' && key !== 'confirmation')) throw new AppError(400, '所有权转移参数不合法', 'invalid_request')
  if (typeof record.userId !== 'string' || !record.userId || typeof record.confirmation !== 'string') throw new AppError(400, '所有权转移参数不合法', 'invalid_request')
  return { userId: record.userId as UserId, confirmation: record.confirmation }
}
function invitationEmail(input: unknown): { normalized: string; display: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, '请输入邀请邮箱', 'invalid_email')
  const record = input as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'email')) throw new AppError(400, '邀请参数不合法', 'invalid_request')
  if (typeof record.email !== 'string') throw new AppError(400, '请输入邀请邮箱', 'invalid_email')
  const parsed = normalizeEmail(record.email)
  if (!parsed) throw new AppError(400, '邮箱地址格式不正确', 'invalid_email')
  return { normalized: parsed.normalized, display: parsed.display }
}
async function audit(tx: ServerStoreTx, actorId: UserId, action: string, teamId: TeamId, occurredAt: Timestamp, metadata: Record<string, string>): Promise<void> {
  await tx.audit.append({ id: randomUUID() as AuditEntryId, actorId, action, resource: { kind: 'team', id: teamId }, result: 'succeeded', occurredAt, metadata })
}
