import { randomUUID } from 'node:crypto'
import type { UserId, WorkerId } from '@wemux/domain'
import type { ResourceShareScope, Worker, WorkerGrant, WorkerGrantRole } from '@wemux/server-domain'
import { AppError } from './errors.js'
import type { ServerStore, ServerStoreTx } from './ports/server-store.js'
import type { Notifications } from './notifications.js'

export type WorkerAccessRole = 'owner' | WorkerGrantRole
const rank: Record<WorkerAccessRole, number> = { use: 1, manage: 2, owner: 3 }

export class WorkerAccessService {
  constructor(private readonly store: ServerStore, private readonly notifications?: Notifications) {}

  async list(actor: UserId): Promise<readonly (Worker & { accessRole: WorkerAccessRole })[]> {
    const visible = await Promise.all((await this.store.resources.listWorkers()).map(async worker => {
      const role = await this.role(actor, worker)
      return role ? { ...worker, accessRole: role } : null
    }))
    return visible.filter((worker): worker is Worker & { accessRole: WorkerAccessRole } => worker !== null)
  }

  async require(actor: UserId, workerId: WorkerId, minimum: WorkerAccessRole = 'use'): Promise<Worker & { accessRole: WorkerAccessRole }> {
    return this.requireFrom(this.store, actor, workerId, minimum)
  }

  async requireInTx(tx: ServerStoreTx, actor: UserId, workerId: WorkerId, minimum: WorkerAccessRole = 'use'): Promise<Worker & { accessRole: WorkerAccessRole }> {
    return this.requireFrom(tx, actor, workerId, minimum)
  }

  private async requireFrom(readers: Pick<ServerStore, 'identity' | 'resources'> | ServerStoreTx, actor: UserId, workerId: WorkerId, minimum: WorkerAccessRole) {
    const worker = await readers.resources.getWorker(workerId)
    if (!worker) throw new AppError(404, 'Worker not found', 'worker_not_found')
    const role = await this.roleFrom(readers.identity, actor, worker)
    if (!role) throw new AppError(404, 'Worker not found', 'worker_not_found')
    if (rank[role] < rank[minimum]) throw new AppError(403, '需要 Worker 管理权限', 'worker_manage_required')
    return { ...worker, accessRole: role }
  }

  async updateShareScope(actor: UserId, workerId: WorkerId, input: unknown) {
    const worker = await this.require(actor, workerId, 'manage')
    const shareScope = parseScope(input)
    const affected = new Set((await this.store.identity.listTeamMemberships(worker.teamId)).map(value => value.userId))
    for (const grant of await this.store.identity.listWorkerGrants(workerId)) affected.add(grant.userId)
    const updated = await this.store.transaction(async tx => {
      await tx.resources.saveWorker({ ...worker, shareScope })
      await this.audit(tx, actor, 'worker.access.update', worker, { shareScope })
      return { ...worker, shareScope }
    })
    for (const userId of affected) this.notifications?.authorization(userId)
    return updated
  }

  async grants(actor: UserId, workerId: WorkerId): Promise<readonly WorkerGrant[]> {
    await this.require(actor, workerId, 'manage')
    return this.store.identity.listWorkerGrants(workerId)
  }

  async grant(actor: UserId, workerId: WorkerId, input: unknown): Promise<WorkerGrant> {
    const worker = await this.require(actor, workerId, 'manage')
    const value = parseGrant(input)
    const membership = (await this.store.identity.listTeamMemberships(worker.teamId)).find(item => item.userId === value.userId)
    if (!membership) throw new AppError(409, 'Worker Grant 不能跨 Team', 'worker_grant_cross_team')
    if (value.userId === worker.ownerId) throw new AppError(409, 'Worker owner 不需要额外 Grant', 'worker_owner_grant')
    await this.store.transaction(async tx => {
      await tx.identity.saveWorkerGrant({ workerId, ...value })
      await this.audit(tx, actor, 'worker.grant.save', worker, { userId: value.userId, role: value.role })
    })
    return { workerId, ...value }
  }

  async revoke(actor: UserId, workerId: WorkerId, userId: UserId): Promise<void> {
    const worker = await this.require(actor, workerId, 'manage')
    await this.store.transaction(async tx => {
      await tx.identity.removeWorkerGrant(workerId, userId)
      await this.audit(tx, actor, 'worker.grant.revoke', worker, { userId })
    })
    this.notifications?.authorization(userId)
  }

  async role(actor: UserId, worker: Worker): Promise<WorkerAccessRole | null> {
    return this.roleFrom(this.store.identity, actor, worker)
  }

  private async roleFrom(identity: ServerStore['identity'] | ServerStoreTx['identity'], actor: UserId, worker: Worker): Promise<WorkerAccessRole | null> {
    if (worker.ownerId === actor) return 'owner'
    const records = await identity.getIdentityRecords({ userId: actor, teamId: worker.teamId, workerId: worker.id })
    if (!records.membership) return null
    if (records.workerGrant) return records.workerGrant.role
    return worker.shareScope === 'team' ? 'use' : null
  }

  private async audit(tx: ServerStoreTx, actorId: UserId, action: string, worker: Worker, metadata: Record<string, string>): Promise<void> {
    await tx.audit.append({ id: randomUUID() as never, actorId, action, resource: { kind: 'worker', id: worker.id }, result: 'succeeded', occurredAt: new Date().toISOString() as never, metadata })
  }
}

function parseScope(input: unknown): ResourceShareScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Invalid Worker access request', 'invalid_request')
  const value = (input as Record<string, unknown>).shareScope
  if (value !== 'owner-only' && value !== 'selected-members' && value !== 'team') throw new AppError(400, 'Invalid shareScope', 'invalid_request')
  return value
}
function parseGrant(input: unknown): { userId: UserId; role: WorkerGrantRole } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Invalid Worker Grant', 'invalid_request')
  const record = input as Record<string, unknown>
  if (typeof record.userId !== 'string' || !record.userId || (record.role !== 'use' && record.role !== 'manage')) throw new AppError(400, 'Invalid Worker Grant', 'invalid_request')
  return { userId: record.userId as UserId, role: record.role }
}
