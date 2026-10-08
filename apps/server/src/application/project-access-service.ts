import { randomUUID } from 'node:crypto'
import type { ProjectId, UserId } from '@wemux/domain'
import type { Project, ProjectGrant, ProjectGrantRole, ResourceShareScope } from '@wemux/server-domain'
import { AppError } from './errors.ts'
import type { ServerStore, ServerStoreTx } from './ports/server-store.ts'
import type { Notifications } from './notifications.ts'

export type ProjectAccessRole = 'owner' | ProjectGrantRole
const rank: Record<ProjectAccessRole, number> = { viewer: 1, contributor: 2, manager: 3, owner: 4 }

export class ProjectAccessService {
  private readonly store: ServerStore
  private readonly notifications?: Notifications
  constructor(store: ServerStore, notifications?: Notifications) { this.store = store; this.notifications = notifications;}

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
    const affected = new Set((await this.store.identity.listTeamMemberships(project.teamId)).map(value => value.userId))
    for (const grant of await this.store.identity.listProjectGrants(projectId)) affected.add(grant.userId)
    const updated = await this.store.transaction(async tx => {
      const current = await this.requireInTx(tx, actor, projectId, 'manager')
      await tx.resources.saveProject({ ...current, shareScope })
      await this.audit(tx, actor, 'project.access.update', current, { shareScope })
      return { ...current, shareScope }
    })
    for (const userId of affected) this.notifications?.authorization(userId)
    return updated
  }

  /** The review default is project-scoped, manager-controlled and independently CAS protected. */
  async updateReviewPolicy(actor: UserId, projectId: ProjectId, input: unknown): Promise<Project & { accessRole: ProjectAccessRole }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Invalid Project review policy request', 'invalid_request')
    const body = input as Record<string, unknown>
    if (Object.keys(body).some(key => key !== 'reviewPolicy' && key !== 'version') ||
      typeof body.reviewPolicy !== 'string' || !['none', 'agent', 'human', 'multi-stage'].includes(body.reviewPolicy) ||
      !Number.isSafeInteger(body.version) || Number(body.version) < 1) throw new AppError(400, 'Review policy and positive version required', 'invalid_request')
    return this.store.transaction(async tx => {
      const project = await this.requireInTx(tx, actor, projectId, 'manager')
      const currentVersion = project.reviewPolicyVersion ?? 1
      if (body.version !== currentVersion) throw new AppError(409, 'Project review policy changed; refresh before updating', 'project_review_policy_conflict')
      const reviewPolicy = body.reviewPolicy as NonNullable<Project['reviewPolicy']>
      if ((project.reviewPolicy ?? 'none') === reviewPolicy) return project
      // Legacy active Tasks may predate first-Run policy snapshots. Preserve
      // their old effective requirement before changing this Project default.
      for (const summary of await tx.tasks.list(projectId)) {
        const runs = await tx.tasks.runs(summary.id)
        if ((summary.status === 'backlog' || summary.status === 'todo') && !runs.length) continue
        const task = await tx.tasks.get(summary.id)
        if (!task || task.metadataJson.values.reviewPolicy !== undefined) continue
        // Historical execution without a snapshot cannot prove the former
        // requirement. Pin the conservative human policy rather than making
        // a later Project-default change a completion bypass.
        const inheritedPolicy = runs.length ? 'human' : project.reviewPolicy ?? 'none'
        await tx.tasks.save({ ...task, metadataJson: { schemaVersion: 1, values: { ...task.metadataJson.values, reviewPolicy: inheritedPolicy, reviewPolicyFrozen: true } } })
      }
      const next: Project = { ...project, reviewPolicy, reviewPolicyVersion: currentVersion + 1 }
      await tx.resources.saveProject(next)
      await this.audit(tx, actor, 'project.review-policy.update', project, { reviewPolicy, previousPolicy: project.reviewPolicy ?? 'none', version: String(next.reviewPolicyVersion) })
      return { ...next, accessRole: project.accessRole }
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
    this.notifications?.authorization(value.userId)
    return { projectId, ...value }
  }

  async revoke(actor: UserId, projectId: ProjectId, userId: UserId): Promise<void> {
    const project = await this.requireManager(actor, projectId)
    await this.store.transaction(async tx => {
      await tx.identity.removeProjectGrant(projectId, userId)
      await this.audit(tx, actor, 'project.grant.revoke', project, { userId })
    })
    this.notifications?.authorization(userId)
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
