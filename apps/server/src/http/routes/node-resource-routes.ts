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

const presetConflict = new Set(['preset_revision_conflict', 'preset_application_request_conflict', 'resource_set_revision_conflict', 'preset_binding_conflict'])
const presetInvalid = new Set(['invalid_preset', 'invalid_preset_entry', 'invalid_preset_application', 'preset_auto_apply_unavailable', 'preset_revision_not_published', 'invalid_runtime_binding', 'preset_resource_kind_unavailable', 'duplicate_preset_entry'])
function presetError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error('Preset operation failed')
  if (error.message === 'preset_not_found') return new AppError(404, 'Preset revision not found', error.message)
  if (presetConflict.has(error.message)) return new AppError(409, 'Preset or Worker resources have changed; refresh and retry', error.message)
  if (presetInvalid.has(error.message)) return new AppError(400, 'Invalid Preset request', error.message)
  return error
}

export const nodeResourceRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/resource-presets', auth: 'admin', handler: async context => { await context.operator(); context.json(200, { items: service(context).presets() }) } },
  { method: 'POST', pattern: '/resource-presets', auth: 'admin', handler: async context => {
    const actor = await context.operator(), body = object(await context.readBody())
    try {
      context.json(201, service(context).createPreset({ id: body.id as string | undefined, name: body.name as string, description: body.description as string, entries: body.entries as never, expectedRevision: body.expectedRevision as number, autoApply: body.autoApply as never, createdBy: actor }))
    } catch (error) { throw presetError(error) }
  } },
  { method: 'GET', pattern: '/resource-preset-applications', auth: 'admin', handler: async context => {
    await context.operator()
    const workerId = context.url.searchParams.get('workerId')
    context.json(200, { items: service(context).presetApplications(workerId ? workerId as WorkerId : undefined) })
  } },
  { method: 'POST', pattern: '/resource-presets/:presetId/applications', auth: 'admin', handler: async context => {
    const actor = await context.operator(), body = object(await context.readBody())
    if (typeof body.workerId !== 'string' || typeof body.requestId !== 'string') throw new AppError(400, 'Missing preset application fields', 'invalid_request')
    await context.service.getWorker(body.workerId as WorkerId)
    try {
      context.json(201, await service(context).applyPreset({ presetId: context.params.presetId, presetRevision: body.presetRevision as number, workerId: body.workerId as WorkerId, requestId: body.requestId, expectedSetRevision: body.expectedSetRevision as number, createdBy: actor }))
    } catch (error) { throw presetError(error) }
  } },
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
