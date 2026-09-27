import type { ApprovalId, CommandId, SessionForkId, SessionId } from '@wemux/domain'
import { AppError } from '../../application/errors.js'
import { integer, object } from '../../application/validation.js'
import type { RouteDescriptor, RouteRequestContext } from './types.js'

const eventCursor = (context: RouteRequestContext): number => {
  const lastId = context.request.headers['last-event-id']
  if (lastId !== undefined && (typeof lastId !== 'string' || !/^\d+$/.test(lastId))) throw new AppError(400, 'Invalid Last-Event-ID')
  return integer(Number(context.url.searchParams.get('fromSeq') ?? (lastId === undefined ? 1 : Number(lastId) + 1)), 'fromSeq', 1)
}

export const sessionRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/sessions', auth: 'authenticated', handler: async context => {
    const archived = context.url.searchParams.get('archived')
    if (archived !== null && archived !== 'true' && archived !== 'false') throw new AppError(400, 'archived must be true or false')
    if (!context.projects || !context.sessionAccess) {
      await context.operator()
      const projectId = context.url.searchParams.get('projectId'), workspaceId = context.url.searchParams.get('workspaceId')
      const items = await Promise.all((await context.service.listSessions({ archived: archived === null ? undefined : archived === 'true' })).map(session => context.service.sessionView(session.id)))
      context.json(200, { items: workspaceId ? items.filter(item => item.workspaceId === workspaceId) : projectId ? items.filter(item => item.projectId === projectId) : items }); return
    }
    const actor = await context.actor(), authorized = await context.projects.list(actor, context.url.searchParams.get('teamId') ?? undefined)
    const allowed = new Set(authorized.map(project => project.id))
    const items = (await context.sessionAccess.list(actor)).filter(item => allowed.has(item.projectId) && (archived === null || Boolean(item.archivedAt) === (archived === 'true')))
    context.json(200, { items: await Promise.all(items.map(item => context.service.sessionView(item.id, actor))) })
  } },
  { method: 'POST', pattern: '/sessions', auth: 'authenticated', handler: async context => {
    const actor = context.projects && context.workerAccess ? await context.actor() : await context.operator()
    context.json(201, await context.service.createSession(await context.readBody(), actor))
  } },
  { method: 'GET', pattern: '/sessions/:sessionId', auth: 'authenticated', handler: async context => {
    const id = context.params.sessionId as SessionId
    if (!context.sessionAccess) { await context.operator(); context.json(200, await context.service.sessionView(id)); return }
    const actor = await context.actor(); await context.sessionAccess.require(actor, id)
    context.json(200, await context.service.sessionView(id, actor))
  } },
  { method: 'PATCH', pattern: '/sessions/:sessionId/access', auth: 'authenticated', handler: async context => {
    if (!context.sessionAccess) { await context.operator(); throw new AppError(404, 'Not found') }
    context.json(200, await context.sessionAccess.updateShareScope(await context.actor(), context.params.sessionId as SessionId, await context.readBody()))
  } },
  { method: 'GET', pattern: '/sessions/:sessionId/grants', auth: 'authenticated', handler: async context => {
    if (!context.sessionAccess) { await context.operator(); throw new AppError(404, 'Not found') }
    context.json(200, { items: await context.sessionAccess.grants(await context.actor(), context.params.sessionId as SessionId) })
  } },
  { method: 'POST', pattern: '/sessions/:sessionId/grants', auth: 'authenticated', handler: async context => {
    if (!context.sessionAccess) { await context.operator(); throw new AppError(404, 'Not found') }
    context.json(201, await context.sessionAccess.grant(await context.actor(), context.params.sessionId as SessionId, await context.readBody()))
  } },
  { method: 'DELETE', pattern: '/sessions/:sessionId/grants/:grantId', auth: 'authenticated', handler: async context => {
    if (!context.sessionAccess) { await context.operator(); throw new AppError(404, 'Not found') }
    await context.sessionAccess.revoke(await context.actor(), context.params.sessionId as SessionId, context.params.grantId as never); context.noContent()
  } },
  { method: 'POST', pattern: '/sessions/:sessionId/fs/list', auth: 'authenticated', handler: async context => {
    if (!context.sessionFiles) throw new AppError(404, 'Not found')
    const id = context.params.sessionId as SessionId
    if (context.sessionAccess) await context.sessionAccess.require(await context.actor(), id); else await context.operator()
    const body = object(await context.readBody()), subpath = body.subpath === undefined ? '' : body.subpath
    if (typeof subpath !== 'string' || subpath.length > 4096 || subpath.includes('\0')) throw new AppError(400, 'Invalid subpath')
    context.json(200, await context.sessionFiles.list(id, subpath))
  } },
  { method: 'POST', pattern: '/sessions/:sessionId/fs/read', auth: 'authenticated', handler: async context => {
    if (!context.sessionFiles) throw new AppError(404, 'Not found')
    const id = context.params.sessionId as SessionId
    if (context.sessionAccess) await context.sessionAccess.require(await context.actor(), id); else await context.operator()
    const body = object(await context.readBody()), subpath = body.subpath
    if (typeof subpath !== 'string' || !subpath || subpath.length > 4096 || subpath.includes('\0')) throw new AppError(400, 'Invalid subpath')
    const maxBytes = body.maxBytes === undefined ? 1024 * 1024 : integer(body.maxBytes, 'maxBytes', 1, 1024 * 1024)
    context.json(200, await context.sessionFiles.read(id, subpath, maxBytes))
  } },
  { method: 'POST', pattern: '/sessions/:sessionId/messages', auth: 'authenticated', handler: async context => {
    const actor = context.sessionAccess ? await context.actor() : (await context.operator(), undefined)
    context.json(202, await context.service.enqueue(context.params.sessionId as SessionId, await context.readBody(), actor))
  } },
  { method: 'POST', pattern: '/sessions/:sessionId/messages/:commandId/cancel', auth: 'authenticated', handler: async context => {
    const actor = context.sessionAccess ? await context.actor() : (await context.operator(), undefined)
    context.json(202, await context.service.cancelQueued(context.params.sessionId as SessionId, context.params.commandId as CommandId, await context.readBody(), actor))
  } },
  { method: 'POST', pattern: '/sessions/:sessionId/turn/stop', auth: 'authenticated', handler: async context => {
    const actor = context.sessionAccess ? await context.actor() : (await context.operator(), undefined)
    context.json(202, await context.service.stopTurn(context.params.sessionId as SessionId, await context.readBody(), actor))
  } },
  { method: 'POST', pattern: '/sessions/:sessionId/runtime/commands', auth: 'authenticated', handler: async context => {
    const actor = context.sessionAccess ? await context.actor() : (await context.operator(), undefined)
    context.json(202, await context.service.invokeRuntimeCommand(context.params.sessionId as SessionId, await context.readBody(), actor))
  } },
  { method: 'POST', pattern: '/sessions/:sessionId/runtime/approvals/:approvalId', auth: 'authenticated', handler: async context => {
    const actor = context.sessionAccess ? await context.actor() : (await context.operator(), undefined)
    context.json(202, await context.service.resolveRuntimeApproval(context.params.sessionId as SessionId, context.params.approvalId as ApprovalId, await context.readBody(), actor))
  } },
  { method: 'GET', pattern: '/sessions/:sessionId/events', auth: 'authenticated', handler: async context => {
    const id = context.params.sessionId as SessionId
    const actor = context.sessionAccess ? await context.actor() : (await context.operator(), undefined)
    if (context.sessionAccess) await context.sessionAccess.require(actor!, id)
    context.json(200, await context.service.events(id, eventCursor(context), Number(context.url.searchParams.get('limit') ?? 100), actor))
  } },
  { method: 'GET', pattern: '/sessions/:sessionId/stream', auth: 'authenticated', handler: async context => {
    const id = context.params.sessionId as SessionId
    const actor = context.sessionAccess ? await context.actor() : (await context.operator(), undefined)
    if (context.sessionAccess) await context.sessionAccess.require(actor!, id); else await context.service.getSession(id)
    context.streams.open(context.response, id, eventCursor(context), actor, actor && context.bearer && !context.loginSession ? () => context.auth.actor(context.credential, 'read') : undefined)
  } },
  { method: 'GET', pattern: '/sessions/:sessionId/lineage', auth: 'admin', handler: async context => {
    if (!context.lineage) throw new AppError(404, 'Not found')
    context.json(200, await context.lineage.lineage({ operator: await context.operator(), sessionId: context.params.sessionId as SessionId }))
  } },
  { method: 'GET', pattern: '/session-forks/:forkId', auth: 'admin', handler: async context => {
    if (!context.lineage) throw new AppError(404, 'Not found')
    context.json(200, await context.lineage.getForkPoint({ operator: await context.operator(), forkId: context.params.forkId as SessionForkId }))
  } },
]
