import { randomUUID } from 'node:crypto'
import type { ProjectId, UserId } from '@wemux/domain'
import type { Project, ProjectGrant, ProjectGrantRole, ResourceShareScope } from '@wemux/server-domain'
import { AppError } from './errors.js'
import type { ServerStore, ServerStoreTx } from './ports/server-store.js'

export type ProjectAccessRole = 'owner' | ProjectGrantRole
const rank: Record<ProjectAccessRole, number> = { viewer: 1, contributor: 2, manager: 3, owner: 4 }

export class ProjectAccessService {
  constructor(private readonly store: ServerStore) {}

  async list(actor: UserId, teamId?: string): Promise<readonly (Project & { accessRole: ProjectAccessRole })[]> {
    const projects = (await this.store.resources.listProjects()).filter(project => !project.deletedAt && (!teamId || project.teamId === teamId))
    const visible = await Promise.all(projects.map(async project => {
      const role = await this.role(actor, project)
      return role ? { ...project, accessRole: role } : null
    }))
    return visible.filter((project): project is Project & { accessRole: ProjectAccessRole } => project !== null)
  }

  async require(actor: UserId, projectId: ProjectId, minimum: ProjectAccessRole = 'viewer'): Promise<Project & { accessRole: ProjectAccessRole }> {
    return this.requireFrom(this.store, actor, projectId, minimum)
  }

  async requireInTx(tx: ServerStoreTx, actor: UserId, projectId: ProjectId, minimum: ProjectAccessRole = 'viewer'): Promise<Project & { accessRole: ProjectAccessRole }> {
    return this.requireFrom(tx, actor, projectId, minimum)
  }

  private async requireFrom(readers: Pick<ServerStore, 'identity' | 'resources'> | ServerStoreTx, actor: UserId, projectId: ProjectId, minimum: ProjectAccessRole) {
    const project = await readers.resources.getProject(projectId)
    if (!project || project.deletedAt) throw new AppError(404, 'Project not found', 'project_not_found')
    const role = await this.roleFrom(readers.identity, actor, project)
    if (!role || rank[role] < rank[minimum]) throw new AppError(404, 'Project not found', 'project_not_found')
    return { ...project, accessRole: role }
  }

  async updateShareScope(actor: UserId, projectId: ProjectId, input: unknown) {
    const project = await this.requireManager(actor, projectId)
    const shareScope = parseScope(input)
    return this.store.transaction(async tx => {
      await tx.resources.saveProject({ ...project, shareScope })
      await this.audit(tx, actor, 'project.access.update', project, { shareScope })
      return { ...project, shareScope }
    })
  }

  async grants(actor: UserId, projectId: ProjectId): Promise<readonly ProjectGrant[]> {
    await this.requireManager(actor, projectId)
    return this.store.identity.listProjectGrants(projectId)
  }

  async grant(actor: UserId, projectId: ProjectId, input: unknown): Promise<ProjectGrant> {
    const project = await this.requireManager(actor, projectId)
    const value = parseGrant(input)
    const membership = (await this.store.identity.listTeamMemberships(project.teamId)).find(item => item.userId === value.userId)
    if (!membership) throw new AppError(409, 'Project Grant 不能跨 Team', 'project_grant_cross_team')
    if (value.userId === project.ownerId) throw new AppError(409, 'Project owner 不需要额外 Grant', 'project_owner_grant')
    await this.store.transaction(async tx => {
      await tx.identity.saveProjectGrant({ projectId, ...value })
      await this.audit(tx, actor, 'project.grant.save', project, { userId: value.userId, role: value.role })
    })
    return { projectId, ...value }
  }

  async revoke(actor: UserId, projectId: ProjectId, userId: UserId): Promise<void> {
    const project = await this.requireManager(actor, projectId)
    await this.store.transaction(async tx => {
      await tx.identity.removeProjectGrant(projectId, userId)
      await this.audit(tx, actor, 'project.grant.revoke', project, { userId })
    })
  }

  private async requireManager(actor: UserId, projectId: ProjectId): Promise<Project & { accessRole: ProjectAccessRole }> {
    const project = await this.store.resources.getProject(projectId)
    if (!project || project.deletedAt) throw new AppError(404, 'Project not found', 'project_not_found')
    const role = await this.role(actor, project)
    if (!role) throw new AppError(404, 'Project not found', 'project_not_found')
    if (rank[role] < rank.manager) throw new AppError(403, '需要 Project manager 权限', 'project_manager_required')
    return { ...project, accessRole: role }
  }

  async role(actor: UserId, project: Project): Promise<ProjectAccessRole | null> {
    return this.roleFrom(this.store.identity, actor, project)
  }

  private async roleFrom(identity: ServerStore['identity'] | ServerStoreTx['identity'], actor: UserId, project: Project): Promise<ProjectAccessRole | null> {
    if (project.ownerId === actor) return 'owner'
    const records = await identity.getIdentityRecords({ userId: actor, teamId: project.teamId, projectId: project.id })
    if (!records.membership) return null
    if (records.projectGrant) return records.projectGrant.role
    return project.shareScope === 'team' ? 'viewer' : null
  }

  private async audit(tx: ServerStoreTx, actorId: UserId, action: string, project: Project, metadata: Record<string, string>): Promise<void> {
    await tx.audit.append({ id: randomUUID() as never, actorId, action, resource: { kind: 'project', id: project.id }, result: 'succeeded', occurredAt: new Date().toISOString() as never, metadata })
  }
}
function parseScope(input: unknown): ResourceShareScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Invalid Project access request', 'invalid_request')
  const value = (input as Record<string, unknown>).shareScope
  if (value !== 'owner-only' && value !== 'selected-members' && value !== 'team') throw new AppError(400, 'Invalid shareScope', 'invalid_request')
  return value
}
function parseGrant(input: unknown): { userId: UserId; role: ProjectGrantRole } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Invalid Project Grant', 'invalid_request')
  const record = input as Record<string, unknown>
  if (typeof record.userId !== 'string' || !record.userId || (record.role !== 'viewer' && record.role !== 'contributor' && record.role !== 'manager')) throw new AppError(400, 'Invalid Project Grant', 'invalid_request')
  return { userId: record.userId as UserId, role: record.role }
}
