import type { ChannelId } from '@wemux/connector'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor } from './types.ts'

export const genericWebhookRoutes: readonly RouteDescriptor[] = [
  { method: 'POST', pattern: '/hooks/generic/:channelId', auth: 'public', handler: async context => {
    if (!context.genericWebhook || !context.channelRouter) throw new AppError(404, 'Not found')
    const raw = await context.readRawBody(1024 * 1024)
    const authorizationValues = context.request.headersDistinct?.authorization ?? (context.request.headers.authorization ? [context.request.headers.authorization] : [])
    const authorization = authorizationValues.length === 1 ? authorizationValues[0] : undefined
    const result = await context.genericWebhook.accept({ channelId: context.params.channelId as ChannelId, authorization, deliveryId: single(context.request.headers['x-wemux-delivery-id']), timestamp: single(context.request.headers['x-wemux-timestamp']), body: raw })
    context.json(202, { accepted: true, duplicate: result.kind === 'duplicate', deliveryId: result.delivery.id })
    if (result.kind === 'accepted') setImmediate(() => void context.channelRouter!.drain().catch(() => undefined))
  } },
]
function single(value: string | string[] | undefined): string | undefined { return typeof value === 'string' ? value : undefined }
