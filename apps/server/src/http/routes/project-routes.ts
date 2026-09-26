import { randomUUID } from 'node:crypto'
import type { ProjectId, SessionId } from '@wemux/domain'
import { AppError } from '../../application/errors.js'
import { TaskError } from '../../application/task-service.js'
import type { RouteDescriptor } from './types.js'

export const projectRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/projects/:projectId/events', auth: 'task', handler: async context => {
    if (!context.tasks || !context.projectStreams) throw new AppError(404, 'Not found')
    const actor = await context.actor()
    const authorizeCredential = async () => { if (context.bearer && !context.loginSession) await context.auth.actor(context.credential, 'read') }
    const authorize = async () => context.tasks!.authorizeProject(context.params.projectId, { actor, requestId: randomUUID(), teamId: context.url.searchParams.get('teamId') ?? undefined })
    try { await authorize() }
    catch (error) {
      if (error instanceof TaskError || error instanceof AppError) {
        context.json(error.status, { error: { code: error instanceof TaskError ? error.code : 'unauthorized', message: error.message } }); return
      }
      throw error
    }
    context.projectStreams.open(context.response, context.params.projectId, actor, authorize, authorizeCredential)
  } },
  { method: 'GET', pattern: '/projects', auth: 'authenticated', handler: async context => {
    if (!context.projects) throw new AppError(404, 'Not found')
    context.json(200, { items: await context.projects.list(await context.actor(), context.url.searchParams.get('teamId') ?? undefined) })
  } },
  { method: 'GET', pattern: '/projects/:projectId', auth: 'authenticated', handler: async context => {
    if (!context.projects) throw new AppError(404, 'Not found')
    context.json(200, await context.projects.require(await context.actor(), context.params.projectId as ProjectId))
  } },
  { method: 'PATCH', pattern: '/projects/:projectId/access', auth: 'authenticated', handler: async context => {
    if (!context.projects) throw new AppError(404, 'Not found')
    context.json(200, await context.projects.updateShareScope(await context.actor(), context.params.projectId as ProjectId, await context.readBody()))
  } },
  { method: 'GET', pattern: '/projects/:projectId/grants', auth: 'authenticated', handler: async context => {
    if (!context.projects) throw new AppError(404, 'Not found')
    context.json(200, { items: await context.projects.grants(await context.actor(), context.params.projectId as ProjectId) })
  } },
  { method: 'POST', pattern: '/projects/:projectId/grants', auth: 'authenticated', handler: async context => {
    if (!context.projects) throw new AppError(404, 'Not found')
    context.json(201, await context.projects.grant(await context.actor(), context.params.projectId as ProjectId, await context.readBody()))
  } },
  { method: 'DELETE', pattern: '/projects/:projectId/grants/:grantId', auth: 'authenticated', handler: async context => {
    if (!context.projects) throw new AppError(404, 'Not found')
    await context.projects.revoke(await context.actor(), context.params.projectId as ProjectId, context.params.grantId as never); context.noContent()
  } },
  { method: 'POST', pattern: '/projects/:projectId/session-forks', auth: 'admin', handler: async context => {
    if (!context.lineage) throw new AppError(404, 'Not found')
    context.json(201, await context.lineage.fork({ operator: await context.operator(), projectId: context.params.projectId as ProjectId, command: await context.readBody() }))
  } },
  { method: 'GET', pattern: '/projects/:projectId/session-graph', auth: 'admin', handler: async context => {
    if (!context.lineage) throw new AppError(404, 'Not found')
    const rootSessionId = context.url.searchParams.get('rootSessionId'), depth = context.url.searchParams.get('depth'), nodeLimit = context.url.searchParams.get('nodeLimit')
    context.json(200, { graph: await context.lineage.getGraph({ operator: await context.operator(), query: {
      projectId: context.params.projectId as ProjectId,
      ...(rootSessionId === null ? {} : { rootSessionId: rootSessionId as SessionId }),
      ...(depth === null ? {} : { depth: Number(depth) }),
      ...(nodeLimit === null ? {} : { nodeLimit: Number(nodeLimit) }),
    } }) })
  } },
  { method: 'GET', pattern: '/projects/:projectId/capability-assets', auth: 'admin', handler: async context => {
    if (!context.capabilities) throw new AppError(404, 'Not found')
    context.json(200, { items: await context.capabilities.listProjectAssets(context.params.projectId as ProjectId) })
  } },
  { method: 'PUT', pattern: '/projects/:projectId/capability-assets', auth: 'admin', handler: async context => {
    if (!context.capabilities) throw new AppError(404, 'Not found')
    const input = await context.readBody() as { items?: unknown }
    if (!Array.isArray(input.items)) throw new AppError(400, 'items must be an array')
    context.json(200, { items: await context.capabilities.replaceProjectAssets(context.params.projectId as ProjectId, input.items as any[]) })
  } },
]
