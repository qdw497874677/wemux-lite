import type { Resource, ResourceBindingStatus, ResourceRevision, WorkerId } from '@wemux/domain'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor } from './types.ts'

const service = (context: import('./types.ts').RouteRequestContext) => {
  if (!context.resources) throw new AppError(404, 'Route not found')
  return context.resources
}
const SHA256 = /^[a-f0-9]{64}$/
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'Invalid resource request', 'invalid_request')
  return value as Record<string, unknown>
}

export const nodeResourceRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/resources', auth: 'admin', handler: context => context.json(200, { items: service(context).resources() }) },
  { method: 'POST', pattern: '/resources', auth: 'admin', handler: async context => {
    const actor = await context.operator()
    context.json(201, service(context).createResource({ ...object(await context.readBody()), createdBy: actor } as unknown as Resource))
  } },
  { method: 'GET', pattern: '/resources/:resourceId', auth: 'admin', handler: async context => {
    await context.operator()
    const resource = service(context).resource(context.params.resourceId)
    if (!resource) throw new AppError(404, 'Resource not found', 'resource_not_found')
    context.json(200, { resource, revisions: service(context).revisions(resource.id) })
  } },
  { method: 'PATCH', pattern: '/resources/:resourceId', auth: 'admin', handler: async context => {
    await context.operator()
    const resource = object(await context.readBody()) as unknown as Resource
    if (resource.id !== context.params.resourceId) throw new AppError(400, 'Resource id mismatch', 'invalid_request')
    context.json(200, service(context).updateResource(resource))
  } },
  { method: 'DELETE', pattern: '/resources/:resourceId', auth: 'admin', handler: async context => {
    await context.operator()
    service(context).deleteResource(context.params.resourceId)
    context.json(200, { ok: true })
  } },
  { method: 'POST', pattern: '/resources/:resourceId/revisions', auth: 'admin', handler: async context => {
    const actor = await context.operator()
    const revision = { ...object(await context.readBody()), createdBy: actor } as unknown as ResourceRevision
    if (revision.resourceId !== context.params.resourceId) throw new AppError(400, 'Resource id mismatch', 'invalid_request')
    context.json(201, service(context).createRevision(revision))
  } },
  { method: 'PUT', pattern: '/resource-blobs/:sha256', auth: 'admin', handler: async context => {
    await context.operator()
    if (!SHA256.test(context.params.sha256)) throw new AppError(400, 'Invalid blob hash', 'invalid_request')
    const body = object(await context.readBody())
    if (typeof body.base64Content !== 'string') throw new AppError(400, 'Missing blob content', 'invalid_request')
    const stored = await service(context).putBlob(Buffer.from(body.base64Content, 'base64'), context.params.sha256)
    context.json(stored.deduplicated ? 200 : 201, stored)
  } },
  { method: 'GET', pattern: '/resource-bindings', auth: 'admin', handler: async context => {
    await context.operator()
    const workerId = context.url.searchParams.get('workerId')
    context.json(200, { items: service(context).bindingProjections(workerId ? workerId as WorkerId : undefined) })
  } },
  { method: 'POST', pattern: '/resource-bindings', auth: 'admin', handler: async context => {
    const actor = await context.operator(), body = object(await context.readBody())
    if (typeof body.workerId !== 'string' || typeof body.resourceRevisionId !== 'string') throw new AppError(400, 'Missing binding fields', 'invalid_request')
    context.json(201, service(context).createBinding({ id: typeof body.id === 'string' ? body.id : undefined, workerId: body.workerId as WorkerId, resourceRevisionId: body.resourceRevisionId, agentKey: typeof body.agentKey === 'string' ? body.agentKey as never : null, projectId: typeof body.projectId === 'string' ? body.projectId as never : null, createdBy: actor }))
  } },
  { method: 'PATCH', pattern: '/resource-bindings/:bindingId', auth: 'admin', handler: async context => {
    await context.operator(); const body = object(await context.readBody())
    if (typeof body.status !== 'string' || typeof body.expectedRevision !== 'number') throw new AppError(400, 'Missing binding transition fields', 'invalid_request')
    context.json(200, service(context).transitionBinding(context.params.bindingId, body.status as ResourceBindingStatus, body.expectedRevision))
  } },
  { method: 'GET', pattern: '/workers/:workerId/resource-set', auth: 'admin', handler: async context => {
    await context.operator()
    context.json(200, service(context).desiredSet(context.params.workerId as WorkerId))
  } },
]
