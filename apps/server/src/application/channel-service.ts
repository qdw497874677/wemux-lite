import { randomBytes, randomUUID } from 'node:crypto'
import type { ProjectId, Timestamp, UserId } from '@wemux/domain'
import type { Channel, ChannelBinding, ChannelBindingId, ChannelId, ConnectorCredentialId, GenericWebhookChannel } from '@wemux/connector'
import { stableFingerprint, type SecretCodec } from '@wemux/connector'
import type { ChannelBindingMutationResult, ChannelBindingView, ChannelMutationResult, OutboundDelivery } from '@wemux/server-domain'
import { AppError } from './errors.ts'
import type { ProjectAccessService } from './project-access-service.ts'
import type { SessionAccessService } from './session-access-service.ts'
import type { WorkerAccessService } from './worker-access-service.ts'
import type { ChannelBindingRecord, ChannelRepository, ChannelRequestRecord } from './ports/channel-repository.ts'

interface WriteInput { readonly projectId: ProjectId; readonly requestId: string; readonly fingerprint: string }

export class ChannelService {
    private readonly repository: ChannelRepository
  private readonly codec: SecretCodec | null
  private readonly projects: ProjectAccessService
  private readonly sessions: SessionAccessService
  private readonly workers: WorkerAccessService
constructor(
    repository: ChannelRepository,
    codec: SecretCodec | null,
    projects: ProjectAccessService,
    sessions: SessionAccessService,
    workers: WorkerAccessService
  ) {
    this.repository = repository; this.codec = codec; this.projects = projects; this.sessions = sessions; this.workers = workers;}

  async list(actorId: UserId, projectId: ProjectId): Promise<readonly Channel[]> { await this.projects.require(actorId, projectId, 'viewer'); return this.repository.listChannels(projectId) }
  async bindings(actorId: UserId, projectId: ProjectId, channelId?: ChannelId): Promise<readonly ChannelBindingView[]> { await this.projects.require(actorId, projectId, 'viewer'); return this.repository.listBindings(projectId, channelId) }
  async deliveries(actorId: UserId, projectId: ProjectId): Promise<{ inbound: readonly import('@wemux/server-domain').InboundDelivery[]; outbound: readonly OutboundDelivery[] }> { await this.projects.require(actorId, projectId, 'viewer'); return { inbound: await this.repository.listInbound(projectId, 100), outbound: await this.repository.listOutbound(projectId, 100) } }

  async create(actorId: UserId, input: WriteInput & { readonly name: string; readonly callbackUrl: string | null; readonly sourceCidrs: readonly string[] }): Promise<ChannelMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    const name = required(input.name, 200, 'name'), callbackUrl = input.callbackUrl === null ? null : httpUrl(input.callbackUrl), sourceCidrs = input.sourceCidrs.map(value => required(value, 100, 'sourceCidrs'))
    const fingerprint = this.identity(input, { operation: 'create', name, callbackUrl, sourceCidrs })
    const replay = await this.replayExisting<ChannelMutationResult>(input, fingerprint)
    if (replay) return replay
    if (!this.codec?.encrypted) throw new AppError(503, 'Channel credential encryption is unavailable', 'credential_unavailable')
    const at = now(), id = randomUUID() as ChannelId, credentialId = randomUUID() as ConnectorCredentialId, token = randomBytes(32).toString('base64url')
    const channel: GenericWebhookChannel = { id, projectId: input.projectId, name, kind: 'generic_webhook', credentialRef: credentialId, credentialAvailability: 'available', enabled: true, revision: 1, config: { tokenVersion: 1, previousTokenValidUntil: null, replayWindowSeconds: 300, sourceCidrs }, createdAt: at, updatedAt: at }
    const ciphertext = await this.codec.encode(token, { owner: { kind: 'channel', id }, credentialId, authType: 'api_key', revision: 1 })
    const storedResult: ChannelMutationResult = { channel, replayed: false }
    await this.repository.createChannel(channel, { credentialId, channelId: id, ciphertext, revision: 1, createdAt: at, updatedAt: at }, callbackUrl, request(input, fingerprint, 'create', storedResult))
    return { ...storedResult, issuedToken: token }
  }

  async setEnabled(actorId: UserId, input: WriteInput & { readonly channelId: ChannelId; readonly expectedRevision: number; readonly enabled: boolean }): Promise<ChannelMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    const current = await this.requireChannel(input.channelId, input.projectId)
    const operation = input.enabled ? 'enable' : 'disable', fingerprint = this.identity(input, { operation, channelId: input.channelId, expectedRevision: input.expectedRevision })
    const replay = await this.replayExisting<ChannelMutationResult>(input, fingerprint); if (replay) return replay
    if (current.revision !== input.expectedRevision) throw revisionConflict()
    const channel = { ...current, enabled: input.enabled, revision: current.revision + 1, updatedAt: now() }
    const result = { channel, replayed: false }
    if (!await this.repository.updateChannel(channel, input.expectedRevision, request(input, fingerprint, operation, result), !input.enabled)) throw revisionConflict()
    return result
  }

  async createBinding(actorId: UserId, input: WriteInput & { readonly channelId: ChannelId; readonly externalConversationKey: string; readonly sessionId: import('@wemux/domain').SessionId; readonly callbackUrl: string; readonly senderAllowlist: readonly string[] }): Promise<ChannelBindingMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    const channel = await this.requireChannel(input.channelId, input.projectId)
    const session = await this.sessions.require(actorId, input.sessionId, 'control')
    if (session.projectId !== channel.projectId) throw new AppError(409, 'Channel and Session Project mismatch', 'scope_denied')
    await this.workers.require(actorId, session.binding.agent.workerId, 'use')
    const externalConversationKey = required(input.externalConversationKey, 500, 'externalConversationKey'), callbackUrl = httpUrl(input.callbackUrl), senderAllowlist = input.senderAllowlist.map(value => required(value, 200, 'senderAllowlist'))
    const fingerprint = this.identity(input, { operation: 'binding.create', channelId: input.channelId, externalConversationKey, sessionId: input.sessionId, callbackUrl, senderAllowlist })
    const replay = await this.replayExisting<ChannelBindingMutationResult>(input, fingerprint); if (replay) return replay
    const at = now(), id = randomUUID() as ChannelBindingId
    const binding: ChannelBinding = { id, projectId: input.projectId, channelId: input.channelId, externalConversationKey, sessionId: input.sessionId, workerId: session.binding.agent.workerId, triggerPolicy: { kind: 'always' }, senderAllowlist, revision: 1, enabled: true, createdAt: at, updatedAt: at }
    const result = { binding, callbackUrl, replayed: false }
    await this.repository.createBinding({ binding, callbackUrl, createdBy: actorId }, request(input, fingerprint, 'binding.create', result))
    return result
  }

  async setBindingEnabled(actorId: UserId, input: WriteInput & { readonly bindingId: ChannelBindingId; readonly expectedRevision: number; readonly enabled: boolean }): Promise<ChannelBindingMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    const current = await this.repository.getBinding(input.bindingId)
    if (!current || current.binding.projectId !== input.projectId) throw new AppError(404, 'Channel binding not found', 'channel_binding_not_found')
    await this.sessions.require(actorId, current.binding.sessionId, 'control'); await this.workers.require(actorId, current.binding.workerId, 'use')
    const operation = input.enabled ? 'binding.enable' : 'binding.disable', fingerprint = this.identity(input, { operation, bindingId: input.bindingId, expectedRevision: input.expectedRevision })
    const replay = await this.replayExisting<ChannelBindingMutationResult>(input, fingerprint); if (replay) return replay
    if (current.binding.revision !== input.expectedRevision) throw revisionConflict()
    const record: ChannelBindingRecord = { ...current, binding: { ...current.binding, enabled: input.enabled, revision: current.binding.revision + 1, updatedAt: now() } }
    const result = { binding: record.binding, callbackUrl: record.callbackUrl, replayed: false }
    if (!await this.repository.updateBinding(record, input.expectedRevision, request(input, fingerprint, operation, result))) throw revisionConflict()
    return result
  }

  async replay(actorId: UserId, projectId: ProjectId, deliveryId: string, reason: string, input: WriteInput): Promise<OutboundDelivery> {
    await this.projects.require(actorId, projectId, 'manager')
    const current = await this.repository.getOutbound(deliveryId); if (!current || current.projectId !== projectId) throw new AppError(404, 'Outbound delivery not found', 'delivery_not_found')
    const binding = await this.repository.getBinding(current.bindingId); if (!binding || !binding.binding.enabled) throw new AppError(409, 'Channel binding is unavailable', 'scope_denied')
    await this.sessions.require(actorId, binding.binding.sessionId, 'control'); await this.workers.require(actorId, binding.binding.workerId, 'use')
    const replayReason = required(reason, 500, 'reason'), fingerprint = this.identity(input, { operation: 'outbound.replay', deliveryId, reason: replayReason })
    const replay = await this.replayExisting<OutboundDelivery>(input, fingerprint); if (replay) return replay
    const value = await this.repository.replayOutbound(deliveryId, now(), request(input, fingerprint, 'outbound.replay', current)); if (!value) throw new AppError(404, 'Outbound delivery not found', 'delivery_not_found')
    return value
  }

  private async requireChannel(id: ChannelId, projectId: ProjectId): Promise<Channel> { const channel = await this.repository.getChannel(id); if (!channel || channel.projectId !== projectId) throw new AppError(404, 'Channel not found', 'channel_not_found'); return channel }
  private identity(input: WriteInput, value: unknown): string { if (!input.requestId || Buffer.byteLength(input.requestId) > 200) throw new AppError(400, 'Invalid requestId'); const computed = stableFingerprint(value); if (computed !== input.fingerprint) throw new AppError(400, 'Invalid fingerprint', 'invalid_fingerprint'); return computed }
  private async replayExisting<T>(input: WriteInput, fingerprint: string): Promise<T | null> { const existing = await this.repository.getRequest(input.projectId, input.requestId); if (!existing) return null; if (existing.fingerprint !== fingerprint) throw new AppError(409, 'requestId fingerprint conflict', 'idempotency_conflict'); const result = existing.result as T & { replayed?: boolean }; return { ...result, replayed: true } }
}

const now = (): Timestamp => new Date().toISOString() as Timestamp
function request(input: WriteInput, fingerprint: string, operation: ChannelRequestRecord['operation'], result: unknown): ChannelRequestRecord { return { projectId: input.projectId, requestId: input.requestId, fingerprint, operation, result, createdAt: now() } }
function required(value: string, max: number, field: string): string { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > max) throw new AppError(400, `Invalid ${field}`); return value.trim() }
function httpUrl(value: string): string { const url = new URL(required(value, 2000, 'callbackUrl')); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new AppError(400, 'Invalid callbackUrl'); return url.toString() }
function revisionConflict(): AppError { return new AppError(409, 'Channel revision conflict', 'revision_conflict') }
