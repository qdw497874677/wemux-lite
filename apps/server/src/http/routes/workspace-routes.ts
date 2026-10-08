import type { WorkspaceId, WorkerId } from '@wemux/domain'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor } from './types.ts'

export const workspaceRoutes: readonly RouteDescriptor[] = [
  { method: 'DELETE', pattern: '/workspaces/:workspaceId', auth: 'authenticated', handler: async context => {
    context.json(200, await context.service.deleteWorkspace(context.params.workspaceId as WorkspaceId, await context.readBody(), await context.actor(), context.url.searchParams.get('teamId') ?? undefined))
  } },
  { method: 'GET', pattern: '/workspaces', auth: 'authenticated', handler: async context => {
    const visibility = context.url.searchParams.get('visibility') ?? 'visible'
    if (visibility !== 'visible' && visibility !== 'hidden' && visibility !== 'all') throw new AppError(400, 'Unknown Workspace visibility', 'invalid_request')
    const items = await context.service.listWorkspaceVisibilityViews(await context.actor(), {
      projectId: context.url.searchParams.get('projectId') ?? undefined,
      teamId: context.url.searchParams.get('teamId') ?? undefined,
      visibility,
    })
    context.json(200, { items })
  } },
  { method: 'PUT', pattern: '/workspaces/:workspaceId/visibility', auth: 'authenticated', handler: async context => {
    context.json(200, await context.service.workspaceVisibility(context.params.workspaceId as WorkspaceId, await context.readBody(), await context.actor()))
  } },
  { method: 'POST', pattern: '/workspaces', auth: 'authenticated', handler: async context => {
    if (!context.projects || !context.workerAccess) throw new AppError(404, 'Not found')
    context.json(201, await context.service.createWorkspace(await context.readBody(), await context.actor()))
  } },
  { method: 'GET', pattern: '/workspaces/:workspaceId', auth: 'authenticated', handler: async context => {
    if (!context.projects) throw new AppError(404, 'Not found')
    context.json(200, await context.service.workspaceView(context.params.workspaceId as WorkspaceId, await context.actor()))
  } },
  { method: 'POST', pattern: '/workspaces/:workspaceId/reprovision', auth: 'admin', handler: async context => {
    const input = await context.readBody() as { requestId?: unknown; workerId?: unknown }
    if (input.requestId !== undefined && typeof input.requestId !== 'string') throw new AppError(400, 'Invalid retry requestId')
    if (input.workerId !== undefined && typeof input.workerId !== 'string') throw new AppError(400, 'Invalid workerId')
    context.json(200, await context.service.reprovisionWorkspace(context.params.workspaceId as WorkspaceId, input.requestId, input.workerId as WorkerId | undefined, await context.operator()))
  } },
]
