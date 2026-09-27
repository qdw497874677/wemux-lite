import type { WorkerId } from '@wemux/domain'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor } from './types.ts'

const access = <T>(value: T | null | undefined): T => {
  if (!value) throw new AppError(404, 'Not found')
  return value
}

export const workerRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/workers', auth: 'authenticated', handler: async context => context.json(200, { items: await access(context.workerAccess).list(await context.actor()) }) },
  { method: 'GET', pattern: '/workers/:workerId', auth: 'authenticated', handler: async context => context.json(200, await access(context.workerAccess).require(await context.actor(), context.params.workerId as WorkerId)) },
  { method: 'GET', pattern: '/workers/:workerId/capabilities', auth: 'authenticated', handler: async context => {
    const workerId = context.params.workerId as WorkerId
    const worker = await access(context.workerAccess).require(await context.actor(), workerId)
    context.json(200, { workerId, capabilities: worker.capabilities })
  } },
  { method: 'PATCH', pattern: '/workers/:workerId/access', auth: 'authenticated', handler: async context => context.json(200, await access(context.workerAccess).updateShareScope(await context.actor(), context.params.workerId as WorkerId, await context.readBody())) },
  { method: 'GET', pattern: '/workers/:workerId/grants', auth: 'authenticated', handler: async context => context.json(200, { items: await access(context.workerAccess).grants(await context.actor(), context.params.workerId as WorkerId) }) },
  { method: 'POST', pattern: '/workers/:workerId/grants', auth: 'authenticated', handler: async context => context.json(201, await access(context.workerAccess).grant(await context.actor(), context.params.workerId as WorkerId, await context.readBody())) },
  { method: 'DELETE', pattern: '/workers/:workerId/grants/:grantId', auth: 'authenticated', handler: async context => { await access(context.workerAccess).revoke(await context.actor(), context.params.workerId as WorkerId, context.params.grantId as never); context.noContent() } },
  { method: 'POST', pattern: '/workers/:workerId/revoke', auth: 'authenticated', handler: async context => {
    const workerId = context.params.workerId as WorkerId, actor = await context.actor()
    await access(context.workerAccess).require(actor, workerId, 'manage')
    context.json(200, await context.service.revokeWorker(workerId, id => context.control?.disconnectWorker(id), actor))
  } },
]
