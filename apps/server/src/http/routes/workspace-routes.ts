import type { WorkspaceId, WorkerId } from '@wemux/domain'
import { AppError } from '../../application/errors.js'
import type { RouteDescriptor } from './types.js'

export const workspaceRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/workspaces', auth: 'authenticated', handler: async context => {
    if (!context.projects) throw new AppError(404, 'Not found')
    const authorized = await context.projects.list(await context.actor(), context.url.searchParams.get('teamId') ?? undefined)
    const allowed = new Set(authorized.map(project => project.id))
    const items = (await context.service.listWorkspaceViews()).filter(item => allowed.has(item.projectId))
    const projectId = context.url.searchParams.get('projectId')
    context.json(200, { items: projectId ? items.filter(item => item.projectId === projectId) : items })
  } },
  { method: 'POST', pattern: '/workspaces', auth: 'authenticated', handler: async context => {
    if (!context.projects || !context.workerAccess) throw new AppError(404, 'Not found')
    context.json(201, await context.service.createWorkspace(await context.readBody(), await context.actor()))
  } },
  { method: 'GET', pattern: '/workspaces/:workspaceId', auth: 'authenticated', handler: async context => {
    if (!context.projects) throw new AppError(404, 'Not found')
    const workspace = await context.service.getWorkspace(context.params.workspaceId as WorkspaceId)
    await context.projects.require(await context.actor(), workspace.projectId)
    context.json(200, await context.service.workspaceView(context.params.workspaceId as WorkspaceId))
  } },
  { method: 'POST', pattern: '/workspaces/:workspaceId/reprovision', auth: 'admin', handler: async context => {
    const input = await context.readBody() as { requestId?: unknown; workerId?: unknown }
    if (input.requestId !== undefined && typeof input.requestId !== 'string') throw new AppError(400, 'Invalid retry requestId')
    if (input.workerId !== undefined && typeof input.workerId !== 'string') throw new AppError(400, 'Invalid workerId')
    context.json(200, await context.service.reprovisionWorkspace(context.params.workspaceId as WorkspaceId, input.requestId, input.workerId as WorkerId | undefined, await context.operator()))
  } },
]
