import type { AttentionItemKind } from '@wemux/server-domain'
import type { ProjectId } from '@wemux/domain'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor } from './types.ts'

const kinds = new Set<AttentionItemKind>(['approval', 'task_assignment', 'run_problem', 'channel_dead_letter'])

export const attentionRoutes: readonly RouteDescriptor[] = [
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
