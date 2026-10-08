import type { ProjectId } from '@wemux/domain'
import type { ChannelBindingMutationResult, ChannelBindingView, ChannelMutationResult, InboundDelivery, OutboundDelivery } from '@wemux/server-domain'
import type { ChannelBindingDTO, ChannelDTO, CreatedChannelDTO, InboundDeliveryDTO, OutboundDeliveryDTO } from '@wemux/web-contract'
import type { ChannelBindingId, ChannelId } from '@wemux/connector'
import { stableFingerprint } from '@wemux/connector'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor, RouteRequestContext } from './types.ts'

const service = (context: RouteRequestContext) => { if (!context.channels) throw new AppError(404, 'Not found'); return context.channels }
const input = async (context: RouteRequestContext): Promise<Record<string, unknown>> => { const value = await context.readBody(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'Invalid request body'); return value as Record<string, unknown> }
const requestId = (body: Record<string, unknown>): string => { if (typeof body.requestId !== 'string' || !body.requestId || Buffer.byteLength(body.requestId) > 200) throw new AppError(400, 'Invalid requestId'); return body.requestId }
const fingerprint = (value: unknown): string => stableFingerprint(value)
const revision = (body: Record<string, unknown>): number => { if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw new AppError(400, 'Invalid expectedRevision'); return Number(body.expectedRevision) }
const strings = (value: unknown, field: string): string[] => { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new AppError(400, `Invalid ${field}`); return value as string[] }

export const channelRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/projects/:projectId/channels', auth: 'authenticated', handler: async context => {
    const actor = await context.actor('read'), projectId = context.params.projectId as ProjectId
    const deliveries = await service(context).deliveries(actor, projectId)
    context.json(200, { items: (await service(context).list(actor, projectId)).map(channel => channelView(channel, context)), bindings: (await service(context).bindings(actor, projectId)).map(bindingView), inbound: deliveries.inbound.map(inboundDeliveryView), outbound: deliveries.outbound.map(outboundDeliveryView) })
  } },
  { method: 'POST', pattern: '/projects/:projectId/channels', auth: 'authenticated', handler: async context => {
    const body = await input(context), kind = body.kind === 'feishu' ? 'feishu' : body.kind === 'dingtalk' ? 'dingtalk' : 'generic_webhook'
    const value = kind === 'feishu'
      ? { operation: 'create', kind, name: body.name, appId: body.appId, appSecret: body.appSecret, verificationToken: body.verificationToken, encryptKey: body.encryptKey ?? null }
      : kind === 'dingtalk'
        ? { operation: 'create', kind, name: body.name, clientId: body.clientId, clientSecret: body.clientSecret, robotCode: body.robotCode }
        : { operation: 'create', name: body.name, callbackUrl: body.callbackUrl ?? null, sourceCidrs: body.sourceCidrs ?? [] }
    const common = { projectId: context.params.projectId as ProjectId, requestId: requestId(body), fingerprint: fingerprint(value), name: String(body.name ?? '') }
    const result = kind === 'feishu'
      ? await service(context).create(await context.actor('write'), { ...common, kind, appId: String(body.appId ?? ''), appSecret: String(body.appSecret ?? ''), verificationToken: String(body.verificationToken ?? ''), encryptKey: body.encryptKey === null || body.encryptKey === undefined ? null : String(body.encryptKey) })
      : kind === 'dingtalk'
        ? await service(context).create(await context.actor('write'), { ...common, kind, clientId: String(body.clientId ?? ''), clientSecret: String(body.clientSecret ?? ''), robotCode: String(body.robotCode ?? '') })
        : await service(context).create(await context.actor('write'), { ...common, kind, callbackUrl: body.callbackUrl === null || body.callbackUrl === undefined ? null : String(body.callbackUrl), sourceCidrs: strings(body.sourceCidrs ?? [], 'sourceCidrs') })
    context.json(201, channelMutationView(result, context))
  } },
  { method: 'POST', pattern: '/projects/:projectId/channels/:channelId/test', auth: 'authenticated', handler: async context => { const actor = await context.actor('write'), projectId = context.params.projectId as ProjectId, channelId = context.params.channelId as ChannelId; const channel = (await service(context).list(actor, projectId)).find(item => item.id === channelId); if (!channel) throw new AppError(404, 'Channel not found'); if (channel.kind === 'feishu' && context.feishu) return context.json(200, await context.feishu.testConnection(channelId)); if (channel.kind === 'dingtalk' && context.dingTalk) return context.json(200, await context.dingTalk.testConnection(channelId)); throw new AppError(404, 'Channel connection test unavailable') } },
  { method: 'POST', pattern: '/projects/:projectId/channels/:channelId/enabled', auth: 'authenticated', handler: async context => { const body = await input(context), expectedRevision = revision(body), channelId = context.params.channelId as ChannelId; if (typeof body.enabled !== 'boolean') throw new AppError(400, 'Invalid enabled'); const value = { operation: body.enabled ? 'enable' : 'disable', channelId, expectedRevision }; context.json(200, channelMutationView(await service(context).setEnabled(await context.actor('write'), { projectId: context.params.projectId as ProjectId, channelId, expectedRevision, enabled: body.enabled, requestId: requestId(body), fingerprint: fingerprint(value) }), context)) } },
  { method: 'POST', pattern: '/projects/:projectId/channels/:channelId/token/rotate', auth: 'authenticated', handler: async context => { const body = await input(context), expectedRevision = revision(body), channelId = context.params.channelId as ChannelId, value = { operation: 'rotate_token', channelId, expectedRevision }; context.json(200, channelMutationView(await service(context).rotateToken(await context.actor('write'), { projectId: context.params.projectId as ProjectId, channelId, expectedRevision, requestId: requestId(body), fingerprint: fingerprint(value) }), context)) } },
  { method: 'DELETE', pattern: '/projects/:projectId/channels/:channelId', auth: 'authenticated', handler: async context => { const body = await input(context), expectedRevision = revision(body), channelId = context.params.channelId as ChannelId, value = { operation: 'delete', channelId, expectedRevision }; context.json(200, await service(context).delete(await context.actor('write'), { projectId: context.params.projectId as ProjectId, channelId, expectedRevision, requestId: requestId(body), fingerprint: fingerprint(value) })) } },
  { method: 'POST', pattern: '/projects/:projectId/channel-bindings', auth: 'authenticated', handler: async context => { const body = await input(context), value = { operation: 'binding.create', channelId: body.channelId, externalConversationKey: body.externalConversationKey, sessionId: body.sessionId, callbackUrl: body.callbackUrl ?? '', senderAllowlist: body.senderAllowlist ?? [] }; context.json(201, bindingMutationView(await service(context).createBinding(await context.actor('write'), { projectId: context.params.projectId as ProjectId, channelId: String(body.channelId) as ChannelId, externalConversationKey: String(body.externalConversationKey ?? ''), sessionId: String(body.sessionId) as never, callbackUrl: String(body.callbackUrl ?? ''), senderAllowlist: strings(body.senderAllowlist ?? [], 'senderAllowlist'), requestId: requestId(body), fingerprint: fingerprint(value) }))) } },
  { method: 'POST', pattern: '/projects/:projectId/channel-bindings/:bindingId/enabled', auth: 'authenticated', handler: async context => { const body = await input(context), expectedRevision = revision(body), bindingId = context.params.bindingId as ChannelBindingId; if (typeof body.enabled !== 'boolean') throw new AppError(400, 'Invalid enabled'); const value = { operation: body.enabled ? 'binding.enable' : 'binding.disable', bindingId, expectedRevision }; context.json(200, bindingMutationView(await service(context).setBindingEnabled(await context.actor('write'), { projectId: context.params.projectId as ProjectId, bindingId, expectedRevision, enabled: body.enabled, requestId: requestId(body), fingerprint: fingerprint(value) }))) } },
  { method: 'GET', pattern: '/projects/:projectId/channel-deliveries/:deliveryId', auth: 'authenticated', handler: async context => { context.json(200, outboundDeliveryView(await service(context).delivery(await context.actor('read'), context.params.projectId as ProjectId, context.params.deliveryId))) } },
  { method: 'POST', pattern: '/projects/:projectId/channel-deliveries/:deliveryId/replay', auth: 'authenticated', handler: async context => { const body = await input(context), reason = String(body.reason ?? ''), value = { operation: 'outbound.replay', deliveryId: context.params.deliveryId, reason }; context.json(200, outboundDeliveryView(await service(context).replay(await context.actor('write'), context.params.projectId as ProjectId, context.params.deliveryId, reason, { projectId: context.params.projectId as ProjectId, requestId: requestId(body), fingerprint: fingerprint(value) }))) } },
]
// Authorization filters whole records before projection: delivery IDs can embed Session IDs.
function outboundDeliveryView(delivery: OutboundDelivery): OutboundDeliveryDTO {
  return {
    id: delivery.id, channelId: delivery.channelId, bindingId: delivery.bindingId, sessionId: delivery.sessionId,
    status: delivery.status, attempt: delivery.attempt, responseStatus: delivery.responseStatus, diagnostic: delivery.diagnostic,
    ...(delivery.channelDeleted ? { channelDeleted: true as const } : {}),
    createdAt: delivery.createdAt, updatedAt: delivery.updatedAt, deliveredAt: delivery.deliveredAt,
  }
}
function inboundDeliveryView(delivery: InboundDelivery): InboundDeliveryDTO {
  return {
    id: delivery.id, channelId: delivery.channelId, status: delivery.status, identityStrength: delivery.identityStrength,
    externalConversationKey: delivery.externalConversationKey, senderId: delivery.senderId, sessionId: delivery.sessionId,
    diagnostic: delivery.diagnostic, ...(delivery.channelDeleted ? { channelDeleted: true as const } : {}),
    receivedAt: delivery.receivedAt, updatedAt: delivery.updatedAt,
  }
}
function bindingView({ binding, callbackUrl }: Pick<ChannelBindingView, 'binding' | 'callbackUrl'>): ChannelBindingDTO {
  return {
    id: binding.id, channelId: binding.channelId, projectId: binding.projectId,
    externalConversationKey: binding.externalConversationKey, sessionId: binding.sessionId, workerId: binding.workerId,
    callbackUrl, senderAllowlist: binding.senderAllowlist, revision: binding.revision, enabled: binding.enabled,
    createdAt: binding.createdAt, updatedAt: binding.updatedAt,
  }
}
function bindingMutationView(result: ChannelBindingMutationResult) {
  return { binding: bindingView(result), callbackUrl: result.callbackUrl, replayed: result.replayed }
}
function channelMutationView(result: ChannelMutationResult, context: RouteRequestContext): CreatedChannelDTO {
  return { channel: channelView(result.channel, context), replayed: result.replayed, ...(result.issuedToken === undefined ? {} : { issuedToken: result.issuedToken }) }
}
function channelView(channel: import('@wemux/connector').Channel, context: RouteRequestContext): ChannelDTO {
  const base = {
    id: channel.id, projectId: channel.projectId, name: channel.name, enabled: channel.enabled,
    revision: channel.revision, credentialAvailability: channel.credentialAvailability,
    createdAt: channel.createdAt, updatedAt: channel.updatedAt,
  }
  if (channel.kind === 'generic_webhook') return { ...base, kind: channel.kind, webhookPath: `/hooks/generic/${channel.id}`, tokenVersion: channel.config.tokenVersion, sourceCidrs: channel.config.sourceCidrs }
  if (channel.kind === 'feishu') return { ...base, kind: channel.kind, webhookPath: `/hooks/feishu/${channel.id}`, appIdHint: channel.config.appIdHint, verificationMode: channel.config.verificationMode, acceptEventSchema: channel.config.acceptEventSchema, tenantKey: channel.config.tenantKey }
  const status = context.dingTalk?.status(channel.id) ?? { state: 'offline' as const, reconnectAttempt: 0 }
  const connection = {
    state: status.state === 'error' ? 'offline' as const : status.state === 'reconnecting' ? 'connecting' as const : status.state,
    reconnectAttempt: status.reconnectAttempt,
    ...(status.connectedAt === undefined ? {} : { connectedAt: status.connectedAt }),
    ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
  }
  return { ...base, kind: channel.kind, webhookPath: null, clientIdHint: channel.config.clientIdHint, robotCode: channel.config.robotCode, connection }
}
