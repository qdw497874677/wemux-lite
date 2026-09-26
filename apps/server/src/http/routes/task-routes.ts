import { randomUUID } from 'node:crypto'
import { AppError } from '../../application/errors.js'
import { TaskError } from '../../application/task-service.js'
import { requiredPatAccess } from './access.js'
import type { RouteDescriptor, RouteRequestContext } from './types.js'

const taskContext = async (context: RouteRequestContext) => {
  if (!context.tasks) throw new TaskError('not_found', 'Route not found')
  const required = requiredPatAccess(context.path, context.method)
  const authenticated = context.bearer && !context.loginSession ? await context.auth.actor(context.credential, required) : null
  const actor = authenticated?.userId ?? await context.actor(required)
  context.response.once('finish', () => {
    if (authenticated && context.response.statusCode < 400) void context.auth.recordPatUse(authenticated, required).catch(() => undefined)
  })
  const requestId = context.request.headers['x-request-id'] ?? randomUUID()
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw new TaskError('invalid_request', 'Invalid request ID')
  context.response.setHeader('X-Request-ID', requestId)
  return { tasks: context.tasks, taskContext: { actor, requestId, teamId: context.url.searchParams.get('teamId') ?? undefined } }
}

type TaskRequestContext = { actor: Awaited<ReturnType<RouteRequestContext['actor']>>; requestId: string; teamId: string | undefined }

const taskHandler = (handler: (context: RouteRequestContext, tasks: NonNullable<RouteRequestContext['tasks']>, requestContext: TaskRequestContext) => Promise<void>): RouteDescriptor['handler'] => async context => {
  try {
    const resolved = await taskContext(context)
    await handler(context, resolved.tasks, resolved.taskContext)
  } catch (error) {
    if (context.bearer && !context.loginSession && error instanceof AppError && error.code === 'pat_scope_required' && context.personalAccessTokens) {
      await context.personalAccessTokens.recordFailedAuthentication({ bearer: context.bearer, requiredScope: requiredPatAccess(context.path, context.method), reason: error.code })
    }
    const failure = error instanceof TaskError ? error : error instanceof AppError ? new TaskError(error.status === 401 ? 'unauthorized' : error.status === 403 ? 'forbidden' : error.status === 404 ? 'not_found' : error.status === 409 ? 'runtime_unavailable' : 'invalid_request', error.message) : null
    if (!failure) throw error
    context.json(failure.status, { error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } })
  }
}

export const taskRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/projects/:projectId/activity', auth: 'task', handler: taskHandler(async (context, tasks, task) => {
    const after = context.url.searchParams.get('after') ?? '0'
    if (!/^\d+$/.test(after)) throw new TaskError('invalid_request', 'Invalid after cursor')
    context.json(200, { items: await tasks.projectActivity(context.params.projectId, Number(after), task) })
  }) },
  { method: 'GET', pattern: '/projects/:projectId/reviews', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, { items: await tasks.pendingReviews(context.params.projectId, task) })) },
  { method: 'GET', pattern: '/projects/:projectId/tasks', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, { items: await tasks.list(context.params.projectId, task) })) },
  { method: 'POST', pattern: '/projects/:projectId/tasks', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(201, await tasks.create(context.params.projectId, await context.readBody(), task))) },
  { method: 'GET', pattern: '/projects/:projectId/tasks/:taskId', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.get(context.params.projectId, context.params.taskId, task))) },
  { method: 'PATCH', pattern: '/projects/:projectId/tasks/:taskId', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.patch(context.params.projectId, context.params.taskId, await context.readBody(), task))) },
  { method: 'POST', pattern: '/projects/:projectId/tasks/:taskId/transition', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.patch(context.params.projectId, context.params.taskId, await context.readBody(), task))) },
  { method: 'POST', pattern: '/projects/:projectId/tasks/:taskId/move', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.patch(context.params.projectId, context.params.taskId, await context.readBody(), task))) },
  { method: 'GET', pattern: '/projects/:projectId/tasks/:taskId/activity', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, { items: await tasks.activity(context.params.projectId, context.params.taskId, Number(context.url.searchParams.get('after') ?? 0), task) })) },
  { method: 'POST', pattern: '/projects/:projectId/tasks/:taskId/links', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.link(context.params.projectId, context.params.taskId, await context.readBody(), undefined, task))) },
  { method: 'DELETE', pattern: '/projects/:projectId/tasks/:taskId/links/:linkId', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.link(context.params.projectId, context.params.taskId, {}, context.params.linkId, task))) },
  { method: 'GET', pattern: '/projects/:projectId/tasks/:taskId/workspaces', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, { items: (await tasks.get(context.params.projectId, context.params.taskId, task)).workspaces })) },
  { method: 'POST', pattern: '/projects/:projectId/tasks/:taskId/workspaces', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(201, await tasks.createWorkspace(context.params.projectId, context.params.taskId, await context.readBody(), task))) },
  { method: 'PUT', pattern: '/projects/:projectId/tasks/:taskId/workspaces/:workspaceId', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.bind(context.params.projectId, context.params.taskId, context.params.workspaceId, task))) },
  { method: 'DELETE', pattern: '/projects/:projectId/tasks/:taskId/workspaces/:workspaceId', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.unbind(context.params.projectId, context.params.taskId, context.params.workspaceId, await context.readBody(), task))) },
  { method: 'POST', pattern: '/projects/:projectId/tasks/:taskId/workspaces/:workspaceId/retry', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.retryWorkspace(context.params.projectId, context.params.taskId, context.params.workspaceId, await context.readBody(), task))) },
  { method: 'PUT', pattern: '/projects/:projectId/tasks/:taskId/assignment', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.assignment(context.params.projectId, context.params.taskId, await context.readBody(), false, task))) },
  { method: 'DELETE', pattern: '/projects/:projectId/tasks/:taskId/assignment', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.assignment(context.params.projectId, context.params.taskId, await context.readBody(), true, task))) },
  { method: 'GET', pattern: '/projects/:projectId/tasks/:taskId/runs', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, { items: await tasks.runs(context.params.projectId, context.params.taskId, task) })) },
  { method: 'GET', pattern: '/projects/:projectId/tasks/:taskId/runs/:runId', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.run(context.params.projectId, context.params.taskId, context.params.runId, task))) },
  { method: 'POST', pattern: '/projects/:projectId/tasks/:taskId/runs/:runId/cancel', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.cancelRun(context.params.projectId, context.params.taskId, context.params.runId, await context.readBody(), task))) },
  { method: 'GET', pattern: '/projects/:projectId/tasks/:taskId/runs/:runId/review', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, { review: await tasks.review(context.params.projectId, context.params.taskId, context.params.runId, task) })) },
  { method: 'POST', pattern: '/projects/:projectId/tasks/:taskId/runs/:runId/review', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.reviewAction(context.params.projectId, context.params.taskId, context.params.runId, await context.readBody(), task))) },
  { method: 'POST', pattern: '/projects/:projectId/tasks/:taskId/launch', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(200, await tasks.launch(context.params.projectId, context.params.taskId, await context.readBody(), task))) },
  { method: 'POST', pattern: '/projects/:projectId/tasks/:taskId/sessions', auth: 'task', handler: taskHandler(async (context, tasks, task) => context.json(201, await tasks.createSession(context.params.projectId, context.params.taskId, await context.readBody(), task))) },
]
