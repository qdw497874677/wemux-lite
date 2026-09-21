import { randomUUID } from 'node:crypto'
import type { ProjectId, SessionId, UserId } from '@wemux/domain'
import type { ProjectAccessRole } from './project-access-service.js'
import type { Session, SessionGrant, SessionShareScope } from '@wemux/server-domain'
import { AppError } from './errors.js'
import type { ServerStore, ServerStoreTx } from './ports/server-store.js'
import type { ProjectAccessService } from './project-access-service.js'
import type { Notifications } from './notifications.js'

export type SessionAccessCapability = 'read' | 'write' | 'control'
export interface SessionAccessView {
  readonly canRead: boolean
  readonly canWrite: boolean
  readonly canControl: boolean
  readonly projectRole: ProjectAccessRole
}

const projectRank: Record<ProjectAccessRole, number> = { viewer: 1, contributor: 2, manager: 3, owner: 4 }

export class SessionAccessService {
  constructor(private readonly store: ServerStore, private readonly projects: ProjectAccessService, private readonly notifications?: Notifications) {}

  async list(actor: UserId): Promise<readonly (Session & { access: SessionAccessView })[]> {
    const visible = await Promise.all((await this.store.resources.listSessions()).filter(session => !session.deletedAt).map(async session => {
      try { return { ...session, access: await this.access(actor, session) } }
      catch (error) { if (error instanceof AppError && error.status === 404) return null; throw error }
    }))
    return visible.filter((session): session is Session & { access: SessionAccessView } => session !== null)
  }

  async require(actor: UserId, sessionId: SessionId, capability: SessionAccessCapability = 'read') {
    return this.requireFrom(this.store, actor, sessionId, capability)
  }

  async requireInTx(tx: ServerStoreTx, actor: UserId, sessionId: SessionId, capability: SessionAccessCapability = 'read') {
    return this.requireFrom(tx, actor, sessionId, capability)
  }

  private async requireFrom(readers: Pick<ServerStore, 'identity' | 'resources'> | ServerStoreTx, actor: UserId, sessionId: SessionId, capability: SessionAccessCapability) {
    const session = await readers.resources.getSession(sessionId)
    if (!session || session.deletedAt) throw notFound()
    const access = await this.accessFrom(readers, actor, session)
    if (capability === 'write' && !access.canWrite) throw new AppError(403, 'Session 只读', 'session_write_required')
    if (capability === 'control' && !access.canControl) throw new AppError(403, '需要 Session owner 或 Project manager 权限', 'session_control_required')
    return { ...session, access }
  }

  async access(actor: UserId, session: Session): Promise<SessionAccessView> {
    return this.accessFrom(this.store, actor, session)
  }

  async accessInTx(tx: ServerStoreTx, actor: UserId, session: Session): Promise<SessionAccessView> {
    return this.accessFrom(tx, actor, session)
  }

  private async accessFrom(readers: Pick<ServerStore, 'identity' | 'resources'> | ServerStoreTx, actor: UserId, session: Session): Promise<SessionAccessView> {
    const project = readers === this.store
      ? await this.projects.require(actor, session.projectId)
      : await this.projects.requireInTx(readers as ServerStoreTx, actor, session.projectId)
    const projectRole = project.accessRole
    const owner = session.ownerId === actor
    const grant = owner ? null : (await readers.identity.getIdentityRecords({ userId: actor, teamId: project.teamId, projectId: project.id, sessionId: session.id })).sessionGrant
    const canRead = owner || session.shareScope === 'project' || (session.shareScope === 'selected-members' && grant !== null)
    if (!canRead) throw notFound()
    return {
      canRead: true,
      canWrite: owner || projectRank[projectRole] >= projectRank.contributor,
      canControl: owner || projectRank[projectRole] >= projectRank.manager,
      projectRole,
    }
  }

  async updateShareScope(actor: UserId, sessionId: SessionId, input: unknown) {
    const session = await this.require(actor, sessionId, 'control')
    const shareScope = parseScope(input)
    const project = await this.store.resources.getProject(session.projectId)
    const affected = new Set(project ? (await this.store.identity.listTeamMemberships(project.teamId)).map(value => value.userId) : [])
    for (const grant of await this.store.identity.listSessionGrants(sessionId)) affected.add(grant.userId)
    const updated = await this.store.transaction(async tx => {
      const current = await this.requireInTx(tx, actor, sessionId, 'control')
      const changed: Session = { ...current, shareScope }
      await tx.resources.saveSession(changed)
      await this.audit(tx, actor, 'session.access.update', sessionId, { shareScope })
      return { ...changed, access: await this.accessFrom(tx, actor, changed) }
    })
    for (const userId of affected) this.notifications?.authorization(userId)
    return updated
  }

  async grants(actor: UserId, sessionId: SessionId): Promise<readonly SessionGrant[]> {
    await this.require(actor, sessionId, 'control')
    return this.store.identity.listSessionGrants(sessionId)
  }

  async grant(actor: UserId, sessionId: SessionId, input: unknown): Promise<SessionGrant> {
    const session = await this.require(actor, sessionId, 'control')
    const userId = parseUserId(input)
    const project = await this.projects.require(actor, session.projectId, 'manager')
    if (userId === session.ownerId) throw new AppError(409, 'Session owner 不需要额外 Grant', 'session_owner_grant')
    try { await this.projects.require(userId, project.id as ProjectId) }
    catch (error) { if (error instanceof AppError && error.status === 404) throw new AppError(409, 'Session Grant 不能绕过 Project 权限', 'session_grant_outside_project'); throw error }
    const grant = { sessionId, userId }
    await this.store.transaction(async tx => {
      await tx.identity.saveSessionGrant(grant)
      await this.audit(tx, actor, 'session.grant.save', sessionId, { userId })
    })
    return grant
  }

  async revoke(actor: UserId, sessionId: SessionId, userId: UserId): Promise<void> {
    await this.require(actor, sessionId, 'control')
    await this.store.transaction(async tx => {
      await tx.identity.removeSessionGrant(sessionId, userId)
      await this.audit(tx, actor, 'session.grant.revoke', sessionId, { userId })
    })
    this.notifications?.authorization(userId)
  }

  private async audit(tx: ServerStoreTx, actorId: UserId, action: string, sessionId: SessionId, metadata: Record<string, string>): Promise<void> {
    await tx.audit.append({ id: randomUUID() as never, actorId, action, resource: { kind: 'session', id: sessionId }, result: 'succeeded', occurredAt: new Date().toISOString() as never, metadata })
  }
}

function parseScope(input: unknown): SessionShareScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Invalid Session access request', 'invalid_request')
  const value = (input as Record<string, unknown>).shareScope
  if (value !== 'owner-only' && value !== 'selected-members' && value !== 'project') throw new AppError(400, 'Invalid shareScope', 'invalid_request')
  return value
}
function parseUserId(input: unknown): UserId {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as Record<string, unknown>).userId !== 'string' || !(input as Record<string, unknown>).userId) throw new AppError(400, 'Invalid Session Grant', 'invalid_request')
  return (input as Record<string, unknown>).userId as UserId
}
function notFound(): AppError { return new AppError(404, 'Session not found', 'session_not_found') }
