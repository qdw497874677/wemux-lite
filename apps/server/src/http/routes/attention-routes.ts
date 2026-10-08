import type { AttentionItemKind, AttentionPagesKind } from '@wemux/server-domain'
import type { ProjectId } from '@wemux/domain'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor } from './types.ts'

const kinds = new Set<AttentionItemKind>(['approval', 'task_assignment', 'run_problem', 'channel_dead_letter'])

export const attentionRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/attention/pages', auth: 'task', handler: async context => {
    if (!context.attention) throw new AppError(404, 'Route not found')
    const actorId = await context.actor('read')
    const limit = context.url.searchParams.get('limit')
    if (limit !== null && !/^\d+$/.test(limit)) throw new AppError(400, 'Invalid limit', 'invalid_limit')
    context.json(200, await context.attention.pages(actorId, await context.auth.isAdministrator(actorId), {
      kind: context.url.searchParams.get('kind') as AttentionPagesKind,
      projectId: context.url.searchParams.get('projectId') as ProjectId | null ?? undefined,
      cursor: context.url.searchParams.get('cursor') ?? undefined,
      limit: limit === null ? undefined : Number(limit),
    }))
  } },
  { method: 'GET', pattern: '/attention', auth: 'task', handler: async context => {
    if (!context.attention) throw new AppError(404, 'Route not found')
    const actorId = await context.actor('read')
    const kindValue = context.url.searchParams.get('kind')
    if (kindValue && !kinds.has(kindValue as AttentionItemKind)) throw new AppError(400, 'Invalid attention kind', 'invalid_request')
    context.json(200, await context.attention.query(actorId, await context.auth.isAdministrator(actorId), {
      actorId,
      projectId: context.url.searchParams.get('projectId') as ProjectId | null ?? undefined,
      kind: kindValue as AttentionItemKind | null ?? undefined,
    }))
  } },
]
