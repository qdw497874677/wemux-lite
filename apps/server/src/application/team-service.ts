import { randomBytes, randomUUID } from 'node:crypto'
import type { AuditEntryId, TeamId, Timestamp, UserId } from '@wemux/domain'
import type { Membership, Team, TeamInvitation, TeamInvitationStatus, TeamRole, User } from '@wemux/server-domain'
import { hashSecret } from './auth.js'
import { normalizeEmail } from './email-address.js'
import { AppError } from './errors.js'
import type { ServerStore, ServerStoreTx } from './ports/server-store.js'

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
  constructor(private readonly store: ServerStore) {}

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
