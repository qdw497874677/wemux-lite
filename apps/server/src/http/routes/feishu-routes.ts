import type { ChannelId } from '@wemux/connector'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor } from './types.ts'

export const feishuRoutes: readonly RouteDescriptor[] = [
  { method: 'POST', pattern: '/hooks/feishu/:channelId', auth: 'public', handler: async context => {
    if (!context.feishu || !context.channelRouter) throw new AppError(404, 'Not found')
    const raw = await context.readRawBody(1024 * 1024)
    const result = await context.feishu.handleInbound({ channelId: context.params.channelId as ChannelId, headers: headers(context.request.headers), body: raw })
    context.json(result.status, result.body)
    if (result.afterAck) setImmediate(() => { void result.afterAck!().catch(error => console.error('[wemux] 飞书 ACK 后维护失败', error)) })
    if (result.accepted?.kind === 'accepted' && result.accepted.delivery.status === 'accepted') setImmediate(() => void context.channelRouter!.drain().catch(() => undefined))
  } },
]
function headers(input: import('node:http').IncomingHttpHeaders): Record<string, string | undefined> { const result: Record<string, string | undefined> = {}; for (const [key, value] of Object.entries(input)) result[key] = typeof value === 'string' ? value : undefined; return result }
