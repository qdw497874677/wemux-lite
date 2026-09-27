import { randomUUID } from 'node:crypto'
import type { CommandId, ProjectId, Timestamp, UserId, WorkerId } from '@wemux/domain'
import type { ConnectorDefinition, ConnectorId, HttpConnectorDefinition } from '@wemux/connector'
import { stableFingerprint } from '@wemux/connector'
import type { ConnectorMutationResult, ConnectorTestResult } from '@wemux/server-domain'
import type { ConnectorRevisionReport, WorkerCommand } from '@wemux/wire-protocol'
import { AppError } from './errors.ts'
import type { Notifications } from './notifications.ts'
import type { ProjectAccessService } from './project-access-service.ts'
import type { WorkerAccessService } from './worker-access-service.ts'
import type { ServerStore } from './ports/server-store.ts'
import type { ConnectorRepository, ConnectorRequestRecord } from './ports/connector-repository.ts'

interface WriteInput { readonly projectId: ProjectId; readonly requestId: string; readonly fingerprint: string }
interface DefinitionInput extends WriteInput { readonly definition: unknown }

export class ConnectorService {
  private readonly repository: ConnectorRepository
  private readonly store: ServerStore
  private readonly projects: ProjectAccessService
  private readonly workers: WorkerAccessService
  private readonly notifications: Notifications

  constructor(
    repository: ConnectorRepository,
    store: ServerStore,
    projects: ProjectAccessService,
    workers: WorkerAccessService,
    notifications: Notifications,
  ) {
    this.repository = repository
    this.store = store
    this.projects = projects
    this.workers = workers
    this.notifications = notifications
  }

  async list(actorId: UserId, projectId: ProjectId): Promise<readonly ConnectorDefinition[]> {
    await this.projects.require(actorId, projectId, 'viewer')
    return this.repository.list(projectId)
  }

  async create(actorId: UserId, input: DefinitionInput): Promise<ConnectorMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    const parsed = parseDefinition(input.definition, input.projectId)
    const fingerprint = this.identity(input, { operation: 'create', definition: parsed })
    const replay = await this.replay<ConnectorMutationResult>(input, fingerprint)
    if (replay) return replay
    const at = now(), id = randomUUID() as ConnectorId
    const definition = { ...parsed, id, projectId: input.projectId, revision: 1, credentialAvailability: parsed.config.authentication === 'none' ? 'not_required' : 'unconfigured', createdAt: at, updatedAt: at } satisfies HttpConnectorDefinition
    const result: ConnectorMutationResult = { definition, replayed: false, commandIds: [] }
    await this.repository.create(definition, request(input, fingerprint, 'create', id, result))
    return this.distributeNewRevision(actorId, input, definition, result, 'create')
  }

  async update(actorId: UserId, input: DefinitionInput & { connectorId: ConnectorId; expectedRevision: number }): Promise<ConnectorMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    const current = await this.requireDefinition(input.connectorId, input.projectId)
    const parsed = parseDefinition(input.definition, input.projectId)
    const fingerprint = this.identity(input, { operation: 'update', connectorId: input.connectorId, expectedRevision: input.expectedRevision, definition: parsed })
    const replay = await this.replay<ConnectorMutationResult>(input, fingerprint)
    if (replay) return replay
    if (current.revision !== input.expectedRevision) throw new AppError(409, 'Connector revision conflict', 'revision_conflict')
    const definition = { ...parsed, id: current.id, projectId: current.projectId, revision: current.revision + 1, credentialAvailability: current.credentialAvailability, createdAt: current.createdAt, updatedAt: now() } satisfies HttpConnectorDefinition
    const result: ConnectorMutationResult = { definition, replayed: false, commandIds: [] }
    if (!await this.repository.update(definition, input.expectedRevision, request(input, fingerprint, 'update', definition.id, result))) throw new AppError(409, 'Connector revision conflict', 'revision_conflict')
    return this.distributeNewRevision(actorId, input, definition, result, 'update')
  }

  async setEnabled(actorId: UserId, input: WriteInput & { connectorId: ConnectorId; expectedRevision: number; enabled: boolean }): Promise<ConnectorMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    const current = await this.requireDefinition(input.connectorId, input.projectId)
    const fingerprint = this.identity(input, { operation: input.enabled ? 'enable' : 'disable', connectorId: input.connectorId, expectedRevision: input.expectedRevision })
    const replay = await this.replay<ConnectorMutationResult>(input, fingerprint)
    if (replay) return replay
    if (current.revision !== input.expectedRevision) throw new AppError(409, 'Connector revision conflict', 'revision_conflict')
    const definition = { ...current, enabled: input.enabled, revision: current.revision + 1, updatedAt: now() }
    const operation = input.enabled ? 'enable' : 'disable'
    const result: ConnectorMutationResult = { definition, replayed: false, commandIds: [] }
    if (!await this.repository.update(definition, input.expectedRevision, request(input, fingerprint, operation, definition.id, result))) throw new AppError(409, 'Connector revision conflict', 'revision_conflict')
    return this.distributeNewRevision(actorId, input, definition, result, operation)
  }

  async distribute(actorId: UserId, input: WriteInput & { connectorId: ConnectorId; expectedRevision: number; workerIds?: readonly WorkerId[] }): Promise<ConnectorMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    const definition = await this.requireDefinition(input.connectorId, input.projectId)
    if (definition.revision !== input.expectedRevision) throw new AppError(409, 'Connector revision conflict', 'revision_conflict')
    const fingerprint = this.identity(input, { operation: 'distribute', connectorId: input.connectorId, expectedRevision: input.expectedRevision, workerIds: input.workerIds ?? null })
    const replay = await this.replay<ConnectorMutationResult>(input, fingerprint)
    if (replay) return replay
    const result = await this.enqueueDefinition(actorId, input.requestId, definition, input.workerIds)
    await this.repository.saveRequest(request(input, fingerprint, 'distribute', definition.id, result))
    return result
  }

  async test(actorId: UserId, input: WriteInput & { connectorId: ConnectorId; workerId: WorkerId; expectedRevision: number }): Promise<ConnectorTestResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    await this.workers.require(actorId, input.workerId, 'use')
    const definition = await this.requireDefinition(input.connectorId, input.projectId)
    if (!definition.enabled) throw new AppError(409, 'Connector is disabled', 'connector_disabled')
    if (definition.revision !== input.expectedRevision) throw new AppError(409, 'Connector revision conflict', 'revision_conflict')
    if (definition.allowedWorkerIds.length && !definition.allowedWorkerIds.includes(input.workerId)) throw new AppError(403, 'Worker is outside Connector scope', 'scope_denied')
    const fingerprint = this.identity(input, { operation: 'test', connectorId: input.connectorId, workerId: input.workerId, expectedRevision: input.expectedRevision })
    const replay = await this.replay<ConnectorTestResult>(input, fingerprint)
    if (replay) return replay
    const commandId = await this.enqueue(input.workerId, { kind: 'connector.test', requestId: input.requestId, connectorId: definition.id, projectId: definition.projectId, workerId: input.workerId, connectorRevision: definition.revision })
    const result: ConnectorTestResult = { connectorId: definition.id, workerId: input.workerId, revision: definition.revision, requestId: input.requestId, commandId, replayed: false }
    await this.repository.saveRequest(request(input, fingerprint, 'test', definition.id, result))
    this.notifications.commands(input.workerId)
    return result
  }

  async report(workerId: WorkerId, report: ConnectorRevisionReport): Promise<void> {
    if (report.workerId !== workerId) throw new AppError(403, 'Connector report Worker mismatch')
    await this.repository.applyReport({ ...report, connectorId: report.connectorId, workerId, requestId: report.requestId, message: report.message.slice(0, 512), updatedAt: report.occurredAt })
  }

  private async distributeNewRevision(actorId: UserId, input: WriteInput, definition: ConnectorDefinition, original: ConnectorMutationResult, operation: ConnectorRequestRecord['operation']): Promise<ConnectorMutationResult> {
    const distributed = await this.enqueueDefinition(actorId, input.requestId, definition)
    // The durable mutation already owns request identity. Distribution records preserve stable commands.
    return { ...original, commandIds: distributed.commandIds }
  }
  private async enqueueDefinition(actorId: UserId, requestId: string, definition: ConnectorDefinition, selected?: readonly WorkerId[]): Promise<ConnectorMutationResult> {
    const ids = selected ?? (definition.allowedWorkerIds.length ? definition.allowedWorkerIds : (await this.store.resources.listWorkers()).map(worker => worker.id))
    const unique = [...new Set(ids)]
    const commandIds: string[] = []
    for (const workerId of unique) {
      await this.workers.require(actorId, workerId, 'use')
      const commandRequestId = `${requestId}:${workerId}`
      const commandId = await this.enqueue(workerId, { kind: 'connector.definition.sync', requestId: commandRequestId, definition })
      commandIds.push(commandId)
      await this.repository.saveDistribution({ connectorId: definition.id, workerId, revision: definition.revision, requestId: commandRequestId, commandId, status: 'pending', credentialAvailability: definition.credentialAvailability, message: null, updatedAt: now() })
      this.notifications.commands(workerId)
    }
    return { definition, replayed: false, commandIds }
  }
  private async enqueue(workerId: WorkerId, command: WorkerCommand): Promise<string> {
    const commandId = randomUUID() as CommandId, payloadFingerprint = stableFingerprint(command)
    await this.store.transaction(async tx => { await tx.commands.insertPending({ commandId, workerId, command, payloadFingerprint, createdAt: now() }) })
    return commandId
  }
  private identity(input: WriteInput, value: unknown): string {
    if (!input.requestId || input.requestId.length > 200) throw new AppError(400, 'Invalid requestId')
    const computed = stableFingerprint(value)
    if (input.fingerprint !== computed) throw new AppError(400, 'Invalid fingerprint', 'invalid_fingerprint')
    return computed
  }
  private async replay<T>(input: WriteInput, fingerprint: string): Promise<T | null> {
    const existing = await this.repository.getRequest(input.projectId, input.requestId)
    if (!existing) return null
    if (existing.fingerprint !== fingerprint) throw new AppError(409, 'requestId fingerprint conflict', 'idempotency_conflict')
    const result = existing.result as T & { replayed?: boolean }
    return { ...result, replayed: true }
  }
  private async requireDefinition(id: ConnectorId, projectId: ProjectId): Promise<ConnectorDefinition> {
    const definition = await this.repository.get(id)
    if (!definition || definition.projectId !== projectId) throw new AppError(404, 'Connector not found', 'connector_not_found')
    return definition
  }
}

const now = (): Timestamp => new Date().toISOString() as Timestamp
function request(input: WriteInput, fingerprint: string, operation: ConnectorRequestRecord['operation'], connectorId: ConnectorId, result: unknown): ConnectorRequestRecord { return { projectId: input.projectId, requestId: input.requestId, fingerprint, operation, connectorId, result, createdAt: now() } }
function parseDefinition(value: unknown, projectId: ProjectId): Omit<HttpConnectorDefinition, 'id' | 'projectId' | 'revision' | 'credentialAvailability' | 'createdAt' | 'updatedAt'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'Invalid Connector definition')
  const v = value as Record<string, unknown>
  const allowed = ['kind','name','description','enabled','allowedWorkerIds','credentialRef','riskDefaults','config']
  if (Object.keys(v).some(key => !allowed.includes(key))) throw new AppError(400, 'Unknown Connector field')
  if (v.kind !== 'http' || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 200 || (v.description !== null && typeof v.description !== 'string') || typeof v.enabled !== 'boolean' || !Array.isArray(v.allowedWorkerIds) || !v.riskDefaults || !v.config) throw new AppError(400, 'Invalid HTTP Connector definition')
  const config = v.config as Record<string, unknown>, url = new URL(String(config.baseUrl))
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new AppError(400, 'Invalid baseUrl')
  if (!Array.isArray(config.allowedOperations) || !config.allowedOperations.length || config.allowedOperations.length > 128) throw new AppError(400, 'Invalid allowedOperations')
  return { kind: 'http', name: v.name.trim(), description: v.description as string | null, enabled: v.enabled, allowedWorkerIds: [...new Set(v.allowedWorkerIds.map(String))] as WorkerId[], credentialRef: v.credentialRef === null ? null : String(v.credentialRef) as never, riskDefaults: v.riskDefaults as never, config: { baseUrl: url.toString(), allowedOperations: config.allowedOperations as never, authentication: config.authentication as never, publicHeaders: config.publicHeaders as never, allowPrivateNetwork: config.allowPrivateNetwork as never } }
}
