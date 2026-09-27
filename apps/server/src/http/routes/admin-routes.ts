import type { CommandId } from '@wemux/domain'
import { AppError } from '../../application/errors.ts'
import { readTailnetSelf } from '../../application/tailnet-info.ts'
import type { RouteDescriptor } from './types.ts'

export const adminRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/', auth: 'admin', handler: async context => { await context.operator(); throw new AppError(404, 'Not found') } },
  { method: 'POST', pattern: '/bootstrap', auth: 'admin', handler: async context => context.json(200, await context.service.ensureDefaultEnvironment(await context.operator())) },
  { method: 'POST', pattern: '/enrollment-tokens', auth: 'admin', handler: async context => context.json(201, await context.service.createEnrollment(await context.readBody(), await context.operator())) },
  { method: 'GET', pattern: '/cluster/tailnet', auth: 'admin', handler: async context => context.json(200, await readTailnetSelf()) },
  { method: 'GET', pattern: '/commands', auth: 'admin', handler: async context => context.json(200, { items: await context.service.listCommands({ workerId: context.url.searchParams.get('workerId') ?? undefined, status: context.url.searchParams.get('status') ?? undefined, limit: Number(context.url.searchParams.get('limit') ?? 100) }) }) },
  { method: 'GET', pattern: '/commands/:commandId', auth: 'admin', handler: async context => context.json(200, await context.service.getCommand(context.params.commandId as CommandId)) },
  { method: 'DELETE', pattern: '/commands/:commandId', auth: 'admin', handler: async context => context.json(200, await context.service.cancelCommand(context.params.commandId as CommandId)) },
]
