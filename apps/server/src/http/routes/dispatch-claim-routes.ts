import type { WorkerId } from '@wemux/domain'
import { AppError } from '../../application/errors.ts'
import { TaskError } from '../../application/task-service.ts'
import type { RouteDescriptor, RouteRequestContext } from './types.ts'

/**
 * Worker 以自身身份申领与释放执行意图。身份只来自 Worker 凭证，绝不来自路径或请求体：
 * 路径上的 workerId 只用于让凭证与之核对，不一致直接 403，Worker 无法替别的机器抢占执行。
 */
const workerIdentity = async (context: RouteRequestContext): Promise<WorkerId> => {
  const header = context.request.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  const workerId = await context.auth.authenticateWorker(token)
  if (workerId !== context.params.workerId) throw new AppError(403, 'Forbidden')
  return workerId
}

const workerDispatch = (handler: (context: RouteRequestContext, workerId: WorkerId, tasks: NonNullable<RouteRequestContext['tasks']>) => Promise<void>): RouteDescriptor['handler'] => async context => {
  try {
    if (!context.tasks) throw new TaskError('not_found', 'Route not found')
    await handler(context, await workerIdentity(context), context.tasks)
  } catch (error) {
    if (!(error instanceof TaskError)) throw error
    context.json(error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } })
  }
}

export const dispatchClaimRoutes: readonly RouteDescriptor[] = [
  { method: 'POST', pattern: '/workers/:workerId/dispatch-claims', auth: 'worker', handler: workerDispatch(async (context, workerId, tasks) => context.json(200, await tasks.claimDispatch(workerId, await context.readBody()))) },
  { method: 'DELETE', pattern: '/workers/:workerId/dispatch-claims/:claimId', auth: 'worker', handler: workerDispatch(async (context, workerId, tasks) => context.json(200, await tasks.releaseDispatch(workerId, { ...(await context.readBody() as object), claimId: context.params.claimId }))) },
]
