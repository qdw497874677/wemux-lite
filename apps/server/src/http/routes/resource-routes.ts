import type { ProjectId, SessionId, WorkspaceId } from '@wemux/domain'
import type { RouteDescriptor } from './types.ts'

export const resourceRoutes: readonly RouteDescriptor[] = [
  { method: 'POST', pattern: '/projects', auth: 'admin', handler: async context => context.json(201, await context.service.createProject(await context.readBody(), await context.operator())) },
  { method: 'PATCH', pattern: '/projects/:projectId', auth: 'admin', handler: async context => { const actor = await context.operator(); context.json(200, await context.service.update('projects', context.params.projectId as ProjectId, await context.readBody(), actor)) } },
  { method: 'DELETE', pattern: '/projects/:projectId', auth: 'admin', handler: async context => { const actor = await context.operator(); await context.service.delete('projects', context.params.projectId as ProjectId, actor); context.noContent() } },
  { method: 'PATCH', pattern: '/workspaces/:workspaceId', auth: 'admin', handler: async context => context.json(200, await context.service.update('workspaces', context.params.workspaceId as WorkspaceId, await context.readBody(), await context.operator())) },
  { method: 'PATCH', pattern: '/sessions/:sessionId', auth: 'admin', handler: async context => { const actor = await context.operator(); context.json(200, await context.service.update('sessions', context.params.sessionId as SessionId, await context.readBody(), actor)) } },
  { method: 'DELETE', pattern: '/sessions/:sessionId', auth: 'admin', handler: async context => { const actor = await context.operator(); await context.service.delete('sessions', context.params.sessionId as SessionId, actor); context.noContent() } },
]
