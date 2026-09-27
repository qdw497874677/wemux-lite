import type { ConnectorId } from '@wemux/connector'
import { stableFingerprint } from '@wemux/connector'
import type { ProjectId, WorkerId } from '@wemux/domain'
import { AppError } from '../../application/errors.js'
import type { RouteDescriptor, RouteRequestContext } from './types.js'

const service = (context: RouteRequestContext) => {
  if (!context.connectors) throw new AppError(404, 'Not found')
  return context.connectors
}
const input = async (context: RouteRequestContext): Promise<Record<string, unknown>> => {
  const value = await context.readBody()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'Invalid request body')
  return value as Record<string, unknown>
}
const requestId = (body: Record<string, unknown>): string => {
  if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 200) throw new AppError(400, 'Invalid requestId')
  return body.requestId
}
const fingerprint = (body: Record<string, unknown>, value: unknown): string => {
  if (body.fingerprint !== undefined && (typeof body.fingerprint !== 'string' || !body.fingerprint)) throw new AppError(400, 'Invalid fingerprint')
  return typeof body.fingerprint === 'string' ? body.fingerprint : stableFingerprint(value)
}
const revision = (body: Record<string, unknown>): number => {
  if (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw new AppError(400, 'Invalid expectedRevision')
  return Number(body.expectedRevision)
}

export const connectorRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/projects/:projectId/connectors', auth: 'authenticated', handler: async context => {
    context.json(200, { items: await service(context).list(await context.actor('read'), context.params.projectId as ProjectId) })
  } },
  { method: 'POST', pattern: '/projects/:projectId/connectors', auth: 'authenticated', handler: async context => {
    const body = await input(context), value = { operation: 'create', definition: body.definition }
    context.json(201, await service(context).create(await context.actor('write'), { projectId: context.params.projectId as ProjectId, requestId: requestId(body), fingerprint: fingerprint(body, value), definition: body.definition }))
  } },
  { method: 'PUT', pattern: '/projects/:projectId/connectors/:connectorId', auth: 'authenticated', handler: async context => {
    const body = await input(context), expectedRevision = revision(body), connectorId = context.params.connectorId as ConnectorId
    const value = { operation: 'update', connectorId, expectedRevision, definition: body.definition }
    context.json(200, await service(context).update(await context.actor('write'), { projectId: context.params.projectId as ProjectId, connectorId, expectedRevision, requestId: requestId(body), fingerprint: fingerprint(body, value), definition: body.definition }))
  } },
  { method: 'POST', pattern: '/projects/:projectId/connectors/:connectorId/enabled', auth: 'authenticated', handler: async context => {
    const body = await input(context), expectedRevision = revision(body), connectorId = context.params.connectorId as ConnectorId
    if (typeof body.enabled !== 'boolean') throw new AppError(400, 'Invalid enabled')
    const value = { operation: body.enabled ? 'enable' : 'disable', connectorId, expectedRevision }
    context.json(200, await service(context).setEnabled(await context.actor('write'), { projectId: context.params.projectId as ProjectId, connectorId, expectedRevision, enabled: body.enabled, requestId: requestId(body), fingerprint: fingerprint(body, value) }))
  } },
  { method: 'POST', pattern: '/projects/:projectId/connectors/:connectorId/distribution', auth: 'authenticated', handler: async context => {
    const body = await input(context), expectedRevision = revision(body), connectorId = context.params.connectorId as ConnectorId
    if (body.workerIds !== undefined && (!Array.isArray(body.workerIds) || body.workerIds.some(value => typeof value !== 'string'))) throw new AppError(400, 'Invalid workerIds')
    const workerIds = body.workerIds as WorkerId[] | undefined
    const value = { operation: 'distribute', connectorId, expectedRevision, workerIds: workerIds ?? null }
    context.json(202, await service(context).distribute(await context.actor('write'), { projectId: context.params.projectId as ProjectId, connectorId, expectedRevision, workerIds, requestId: requestId(body), fingerprint: fingerprint(body, value) }))
  } },
  { method: 'POST', pattern: '/projects/:projectId/connectors/:connectorId/test', auth: 'authenticated', handler: async context => {
    const body = await input(context), expectedRevision = revision(body), connectorId = context.params.connectorId as ConnectorId
    if (typeof body.workerId !== 'string' || !body.workerId) throw new AppError(400, 'Invalid workerId')
    const workerId = body.workerId as WorkerId, value = { operation: 'test', connectorId, workerId, expectedRevision }
    context.json(202, await service(context).test(await context.actor('execute'), { projectId: context.params.projectId as ProjectId, connectorId, expectedRevision, workerId, requestId: requestId(body), fingerprint: fingerprint(body, value) }))
  } },
]
