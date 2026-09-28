import type { ProjectId } from '@wemux/domain'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor } from './types.ts'

export const canvasRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/projects/:projectId/canvas-layout', auth: 'authenticated', handler: async context => {
    if (!context.canvasLayouts) throw new AppError(404, 'Not found')
    context.json(200, await context.canvasLayouts.get(await context.actor('read'), context.params.projectId as ProjectId, context.url.searchParams.get('scope')))
  } },
  { method: 'PUT', pattern: '/projects/:projectId/canvas-layout', auth: 'authenticated', handler: async context => {
    if (!context.canvasLayouts) throw new AppError(404, 'Not found')
    const input = await context.readBody() as Record<string, unknown>
    context.json(200, await context.canvasLayouts.save(await context.actor(), context.params.projectId as ProjectId, input))
  } },
  { method: 'GET', pattern: '/projects/:projectId/canvas/collaboration/events', auth: 'authenticated', handler: async context => {
    if (!context.canvasCollaborationStreams) throw new AppError(404, 'Not found')
    const lastEventId = context.request.headers['last-event-id']
    if (lastEventId !== undefined && (typeof lastEventId !== 'string' || !/^\d+$/.test(lastEventId))) throw new AppError(400, 'Invalid Last-Event-ID')
    const after = Number(lastEventId ?? context.url.searchParams.get('after') ?? 0)
    await context.canvasCollaborationStreams.open(context.response, await context.actor(), context.params.projectId as ProjectId, after)
  } },
  { method: 'GET', pattern: '/projects/:projectId/canvas/collaboration', auth: 'authenticated', handler: async context => {
    if (!context.canvasCollaboration) throw new AppError(404, 'Not found')
    context.json(200, await context.canvasCollaboration.snapshot(await context.actor(), context.params.projectId as ProjectId))
  } },
  { method: 'PUT', pattern: '/projects/:projectId/canvas/collaboration/presence', auth: 'authenticated', handler: async context => {
    if (!context.canvasCollaboration) throw new AppError(404, 'Not found')
    const input = await context.readBody() as Record<string, unknown>
    context.json(200, await context.canvasCollaboration.updatePresence(await context.actor(), context.params.projectId as ProjectId, { displayName: String(input.displayName ?? '协作者'), activeSessionId: typeof input.activeSessionId === 'string' ? input.activeSessionId : null, typing: input.typing === true }))
  } },
]
