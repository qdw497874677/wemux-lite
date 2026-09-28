import { randomBytes, randomUUID } from 'node:crypto'
import type { ProjectId, Timestamp, UserId } from '@wemux/domain'
import type { Channel, ChannelBinding, ChannelBindingId, ChannelId, ConnectorCredentialId, DingTalkChannel, FeishuChannel, GenericWebhookChannel } from '@wemux/connector'
import { stableFingerprint, type SecretCodec } from '@wemux/connector'
import type { ChannelBindingMutationResult, ChannelBindingView, ChannelMutationResult, OutboundDelivery } from '@wemux/server-domain'
import { AppError } from './errors.ts'
import type { ProjectAccessService } from './project-access-service.ts'
import type { SessionAccessService } from './session-access-service.ts'
import type { WorkerAccessService } from './worker-access-service.ts'
import type { ChannelBindingRecord, ChannelRepository, ChannelRequestRecord } from './ports/channel-repository.ts'
import type { ChannelAdapter } from '../channels/channel-adapter.ts'

interface WriteInput { readonly projectId: ProjectId; readonly requestId: string; readonly fingerprint: string }

export class ChannelService {
    private readonly repository: ChannelRepository
  private readonly codec: SecretCodec | null
  private readonly projects: ProjectAccessService
  private readonly sessions: SessionAccessService
  private readonly workers: WorkerAccessService
  private readonly adapterFor?: (kind: Channel['kind']) => ChannelAdapter | undefined
constructor(
    repository: ChannelRepository,
    codec: SecretCodec | null,
    projects: ProjectAccessService,
    sessions: SessionAccessService,
    workers: WorkerAccessService,
    adapterFor?: (kind: Channel['kind']) => ChannelAdapter | undefined
  ) {
    this.repository = repository; this.codec = codec; this.projects = projects; this.sessions = sessions; this.workers = workers; this.adapterFor = adapterFor;}

  async list(actorId: UserId, projectId: ProjectId): Promise<readonly Channel[]> { await this.projects.require(actorId, projectId, 'viewer'); return this.repository.listChannels(projectId) }
  async bindings(actorId: UserId, projectId: ProjectId, channelId?: ChannelId): Promise<readonly ChannelBindingView[]> { await this.projects.require(actorId, projectId, 'viewer'); return this.repository.listBindings(projectId, channelId) }
  async deliveries(actorId: UserId, projectId: ProjectId): Promise<{ inbound: readonly import('@wemux/server-domain').InboundDelivery[]; outbound: readonly OutboundDelivery[] }> { await this.projects.require(actorId, projectId, 'viewer'); return { inbound: await this.repository.listInbound(projectId, 100), outbound: await this.repository.listOutbound(projectId, 100) } }

  async create(actorId: UserId, input: WriteInput & ({ readonly kind?: 'generic_webhook'; readonly name: string; readonly callbackUrl: string | null; readonly sourceCidrs: readonly string[] } | { readonly kind: 'feishu'; readonly name: string; readonly appId: string; readonly appSecret: string; readonly verificationToken: string; readonly encryptKey: string | null } | { readonly kind: 'dingtalk'; readonly name: string; readonly clientId: string; readonly clientSecret: string; readonly robotCode: string })): Promise<ChannelMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    if (!this.codec?.encrypted) throw new AppError(503, 'Channel credential encryption is unavailable', 'credential_unavailable')
    const name = required(input.name, 200, 'name')
    if (input.kind === 'dingtalk') {
      const clientId = required(input.clientId, 200, 'clientId'), clientSecret = required(input.clientSecret, 500, 'clientSecret'), robotCode = required(input.robotCode, 200, 'robotCode')
      const fingerprint = this.identity(input, { operation: 'create', kind: 'dingtalk', name, clientId, clientSecret, robotCode })
      const replay = await this.replayExisting<ChannelMutationResult>(input, fingerprint); if (replay) return replay
      const at = now(), id = randomUUID() as ChannelId, credentialId = randomUUID() as ConnectorCredentialId
      const channel: DingTalkChannel = { id, projectId: input.projectId, name, kind: 'dingtalk', credentialRef: credentialId, credentialAvailability: 'available', enabled: true, revision: 1, config: { clientIdHint: hint(clientId), robotCode, streamMode: true, messageTopic: '/v1.0/im/bot/messages/get' }, createdAt: at, updatedAt: at }
      const ciphertext = await this.codec.encode(JSON.stringify({ clientId, clientSecret, robotCode }), { owner: { kind: 'channel', id }, credentialId, authType: 'custom_credential', revision: 1 })
      const result: ChannelMutationResult = { channel, replayed: false }
      await this.repository.createChannel(channel, { credentialId, channelId: id, ciphertext, revision: 1, expiresAt: null, createdAt: at, updatedAt: at }, null, request(input, fingerprint, 'create', result))
      const adapter = this.adapterFor?.('dingtalk')
      if (adapter) await adapter.enable(id)
      return result
    }
    if (input.kind === 'feishu') {
      const appId = required(input.appId, 200, 'appId'), appSecret = required(input.appSecret, 500, 'appSecret'), verificationToken = required(input.verificationToken, 500, 'verificationToken'), encryptKey = input.encryptKey === null || !input.encryptKey.trim() ? null : required(input.encryptKey, 500, 'encryptKey')
      const fingerprint = this.identity(input, { operation: 'create', kind: 'feishu', name, appId, appSecret, verificationToken, encryptKey })
      const replay = await this.replayExisting<ChannelMutationResult>(input, fingerprint); if (replay) return replay
      const at = now(), id = randomUUID() as ChannelId, credentialId = randomUUID() as ConnectorCredentialId
      const channel: FeishuChannel = { id, projectId: input.projectId, name, kind: 'feishu', credentialRef: credentialId, credentialAvailability: 'available', enabled: true, revision: 1, config: { appIdHint: appId.length > 8 ? `${appId.slice(0, 4)}…${appId.slice(-4)}` : appId, verificationMode: encryptKey ? 'encrypted' : 'verification_token', acceptEventSchema: '2.0', tenantKey: null }, createdAt: at, updatedAt: at }
      const ciphertext = await this.codec.encode(JSON.stringify({ appId, appSecret, verificationToken, encryptKey }), { owner: { kind: 'channel', id }, credentialId, authType: 'custom_credential', revision: 1 })
      const result: ChannelMutationResult = { channel, replayed: false }
      await this.repository.createChannel(channel, { credentialId, channelId: id, ciphertext, revision: 1, expiresAt: null, createdAt: at, updatedAt: at }, null, request(input, fingerprint, 'create', result))
      return result
    }
    const callbackUrl = input.callbackUrl === null ? null : httpUrl(input.callbackUrl), sourceCidrs = input.sourceCidrs.map(value => required(value, 100, 'sourceCidrs'))
    const fingerprint = this.identity(input, { operation: 'create', name, callbackUrl, sourceCidrs })
    const replay = await this.replayExisting<ChannelMutationResult>(input, fingerprint); if (replay) return replay
    const at = now(), id = randomUUID() as ChannelId, credentialId = randomUUID() as ConnectorCredentialId, token = randomBytes(32).toString('base64url')
    const channel: GenericWebhookChannel = { id, projectId: input.projectId, name, kind: 'generic_webhook', credentialRef: credentialId, credentialAvailability: 'available', enabled: true, revision: 1, config: { tokenVersion: 1, previousTokenValidUntil: null, replayWindowSeconds: 300, sourceCidrs }, createdAt: at, updatedAt: at }
    const ciphertext = await this.codec.encode(token, { owner: { kind: 'channel', id }, credentialId, authType: 'api_key', revision: 1 })
    const storedResult: ChannelMutationResult = { channel, replayed: false }
    await this.repository.createChannel(channel, { credentialId, channelId: id, ciphertext, revision: 1, expiresAt: null, createdAt: at, updatedAt: at }, callbackUrl, request(input, fingerprint, 'create', storedResult))
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
    const adapter = this.adapterFor?.(channel.kind)
    if (adapter) {
      try { if (input.enabled) await adapter.enable(channel.id); else await adapter.disable(channel.id) }
      catch (error) {
        if (input.enabled) {
          const rollback: Channel = { ...channel, enabled: false, revision: channel.revision + 1, updatedAt: now() }
          await this.repository.updateChannel(rollback, channel.revision, request({ ...input, requestId: `${input.requestId}:rollback` }, stableFingerprint({ operation: 'disable', channelId: channel.id, expectedRevision: channel.revision }), 'disable', { channel: rollback, replayed: false }), true)
        }
        throw error
      }
    }
    return result
  }

  async rotateToken(actorId: UserId, input: WriteInput & { readonly channelId: ChannelId; readonly expectedRevision: number }): Promise<ChannelMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    if (!this.codec?.encrypted) throw new AppError(503, 'Channel credential encryption is unavailable', 'credential_unavailable')
    const fingerprint = this.identity(input, { operation: 'rotate_token', channelId: input.channelId, expectedRevision: input.expectedRevision })
    const replay = await this.replayExisting<ChannelMutationResult>(input, fingerprint); if (replay) return replay
    const current = await this.requireChannel(input.channelId, input.projectId)
    if (current.kind !== 'generic_webhook') throw new AppError(409, 'Channel token rotation is unavailable', 'channel_kind_unsupported')
    if (current.revision !== input.expectedRevision) throw revisionConflict()
    const latest = await this.repository.getSecret(current.id)
    if (!latest) throw new AppError(503, 'Channel credential unavailable', 'credential_unavailable')
    const at = now(), previousTokenValidUntil = new Date(Date.parse(at) + 15 * 60_000).toISOString() as Timestamp
    const credentialId = randomUUID() as ConnectorCredentialId, credentialRevision = latest.revision + 1, token = randomBytes(32).toString('base64url')
    const channel: GenericWebhookChannel = { ...current, credentialRef: credentialId, revision: current.revision + 1, config: { ...current.config, tokenVersion: current.config.tokenVersion + 1, previousTokenValidUntil }, updatedAt: at }
    const ciphertext = await this.codec.encode(token, { owner: { kind: 'channel', id: channel.id }, credentialId, authType: 'api_key', revision: credentialRevision })
    const storedResult: ChannelMutationResult = { channel, replayed: false }
    if (!await this.repository.rotateChannelSecret(channel, input.expectedRevision, { credentialId, channelId: channel.id, ciphertext, revision: credentialRevision, expiresAt: null, createdAt: at, updatedAt: at }, previousTokenValidUntil, request(input, fingerprint, 'rotate_token', storedResult))) throw revisionConflict()
    return { ...storedResult, issuedToken: token }
  }

  async delete(actorId: UserId, input: WriteInput & { readonly channelId: ChannelId; readonly expectedRevision: number }): Promise<{ readonly channelId: ChannelId; readonly replayed: boolean }> {
    await this.projects.require(actorId, input.projectId, 'manager')
    const fingerprint = this.identity(input, { operation: 'delete', channelId: input.channelId, expectedRevision: input.expectedRevision })
    const replay = await this.replayExisting<{ readonly channelId: ChannelId; readonly replayed: boolean }>(input, fingerprint); if (replay) return replay
    const current = await this.requireChannel(input.channelId, input.projectId)
    if (current.revision !== input.expectedRevision) throw revisionConflict()
    if (current.enabled) throw new AppError(409, 'Channel must be disabled before deletion', 'channel_enabled')
    const result = { channelId: current.id, replayed: false }
    // We reject while any 60-second sending lease is active instead of introducing a pending-delete state.
    const deleted = await this.repository.deleteChannel(current.id, input.projectId, input.expectedRevision, now(), request(input, fingerprint, 'delete', result))
    if (deleted === 'active_lease') throw new AppError(409, 'Channel has an active sending lease', 'channel_active_lease')
    if (deleted === 'revision_conflict') throw revisionConflict()
    const adapter = this.adapterFor?.(current.kind)
    if (adapter) await adapter.disable(current.id)
    return result
  }

  async createBinding(actorId: UserId, input: WriteInput & { readonly channelId: ChannelId; readonly externalConversationKey: string; readonly sessionId: import('@wemux/domain').SessionId; readonly callbackUrl: string; readonly senderAllowlist: readonly string[] }): Promise<ChannelBindingMutationResult> {
    await this.projects.require(actorId, input.projectId, 'manager')
    const channel = await this.requireChannel(input.channelId, input.projectId)
    const session = await this.sessions.require(actorId, input.sessionId, 'control')
    if (session.projectId !== channel.projectId) throw new AppError(409, 'Channel and Session Project mismatch', 'scope_denied')
    await this.workers.require(actorId, session.binding.agent.workerId, 'use')
    const usesProviderDestination = channel.kind === 'feishu' || channel.kind === 'dingtalk'
    const externalConversationKey = required(input.externalConversationKey, 500, 'externalConversationKey'), requestedCallbackUrl = usesProviderDestination ? input.callbackUrl.trim() : httpUrl(input.callbackUrl), callbackUrl = channel.kind === 'feishu' ? externalConversationKey : channel.kind === 'dingtalk' ? requestedCallbackUrl : requestedCallbackUrl, senderAllowlist = input.senderAllowlist.map(value => required(value, 200, 'senderAllowlist'))
    const fingerprint = this.identity(input, { operation: 'binding.create', channelId: input.channelId, externalConversationKey, sessionId: input.sessionId, callbackUrl: requestedCallbackUrl, senderAllowlist })
    const replay = await this.replayExisting<ChannelBindingMutationResult>(input, fingerprint); if (replay) return replay
    const at = now(), id = randomUUID() as ChannelBindingId
    const binding: ChannelBinding = { id, projectId: input.projectId, channelId: input.channelId, externalConversationKey, sessionId: input.sessionId, workerId: session.binding.agent.workerId, triggerPolicy: channel.kind === 'feishu' || channel.kind === 'dingtalk' ? { kind: 'private_chat_or_mention' } : { kind: 'always' }, senderAllowlist, revision: 1, enabled: true, createdAt: at, updatedAt: at }
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
function hint(value: string): string { return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value }
