import { randomUUID } from 'node:crypto'
import { TaskError, type TaskService } from '../application/task-service.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CapabilityToolName } from '@wemux/domain'
import type { ApprovalId, CommandId, ProjectId, SessionForkId, SessionId, WorkerId, WorkspaceId } from '@wemux/domain'
import { AuthenticationService } from '../application/auth.js'
import { CapabilityError, CapabilityService } from '../application/capability-service.js'
import { CapabilityTokenError } from '../application/capability-token-service.js'
import { AppError } from '../application/errors.js'
import { ServerService } from '../application/server-service.js'
import { integer } from '../application/validation.js'
import { isWebConsoleAuthPath } from '../application/web-console-routes.js'
import { readTailnetSelf } from '../application/tailnet-info.js'
import { SessionStreams } from './sse.js'
import type { ProjectStreams } from './project-sse.js'
import { serveWorkerDownload, type WorkerDownloads } from './worker-downloads.js'
import { serveStaticSite, type StaticSite } from './static.js'
import { assertCookieWriteAllowed, handleAuthRoute } from './routes-auth.js'
import type { IdentityService } from '../application/identity-service.js'
import type { EmailRegistrationService } from '../application/email-registration.js'
import type { GoogleAuthenticationService } from '../application/google-authentication.js'
import type { InstanceSettingsService } from '../application/instance-settings.js'
import type { SessionLineageService } from '../application/session-lineage-service.js'
import { readCookie } from './cookies.js'
import type { RequestCredential } from '../application/auth.js'

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); size += buffer.length
    if (size > 1024 * 1024) throw new AppError(413, 'Request too large')
    chunks.push(buffer)
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }
  catch { throw new AppError(400, 'Invalid JSON') }
}
function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(data))
}

export interface WorkerControl { disconnectWorker(workerId: import('@wemux/domain').WorkerId): void }

export function httpHandler(service: ServerService, auth: AuthenticationService, streams: SessionStreams, capabilities?: CapabilityService, downloads?: WorkerDownloads, control?: WorkerControl, staticSite?: StaticSite, _adminSessionTtlMs = 7 * 24 * 60 * 60 * 1000, tasks?: TaskService, projectStreams?: ProjectStreams, identity?: IdentityService | null, registration?: EmailRegistrationService | null, settings?: InstanceSettingsService | null, google?: GoogleAuthenticationService | null, lineage?: SessionLineageService | null) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost'), rawPath = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '')
      // The web console calls same-origin "/api/*" paths; accept the prefix directly so
      // single-origin deployments (server hosting the built web bundle) work without a proxy.
      const path = rawPath === '/api' || rawPath.startsWith('/api/') ? (rawPath.slice(4) || '/') : rawPath, method = request.method
      // API 命名空间不参与 SPA 回退：GET 回调（如 Google OAuth 302 目标）必须到路由，
      // 不能被 index.html 截走。例外是邮件链接目标（`/auth/verify-email`、`/auth/password/reset`）：
      // 它们是 Web 控制台的页面，一律当 API 处理会让收件人看到 401 JSON。
      const apiNamespace = rawPath === '/api' || rawPath.startsWith('/api/') || ((rawPath === '/auth' || rawPath.startsWith('/auth/')) && !isWebConsoleAuthPath(rawPath))
      if (method === 'GET' && path === '/health') { json(response, 200, { status: 'ok' }); return }
      if (method === 'GET' && await serveWorkerDownload(response, path, downloads)) return
      if (method === 'POST' && path === '/workers/enroll') { json(response, 201, await service.enroll(await body(request))); return }
      const workerLeave = path.match(/^\/workers\/([^/]+)\/enrollment$/)
      if (method === 'DELETE' && workerLeave) {
        const header = request.headers.authorization
        const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
        const workerId = await auth.authenticateWorker(token)
        if (workerId !== workerLeave[1]) throw new AppError(403, 'Forbidden')
        await service.leaveWorker(workerId, id => control?.disconnectWorker(id))
        response.writeHead(204).end(); return
      }
      if (staticSite && method === 'GET' && !apiNamespace && await serveStaticSite(response, path, request.headers.accept, staticSite)) return
      if (method === 'POST' && path.startsWith('/agent-capabilities/')) {
        if (!capabilities) throw new AppError(503, 'Agent capabilities are disabled')
        const header = request.headers.authorization
        const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
        if (!token) throw new AppError(401, 'Missing capability token')
        const operation = path.slice('/agent-capabilities/'.length) as CapabilityToolName
        const input = await body(request) as any
        const claims = await capabilities.verify(token, operation)
        const result = operation === 'session.info' ? await capabilities.sessionInfo(claims)
          : operation === 'agent.list' ? await capabilities.listAgents(claims)
          : operation === 'agent.send' ? await capabilities.sendAgentMessage(claims, input)
          : operation === 'agent.inbox.list' ? await capabilities.listInbox(claims, input)
          : operation === 'agent.inbox.read' ? await capabilities.readInbox(claims, input)
          : (() => { throw new AppError(404, 'Capability not found') })()
        json(response, 200, result); return
      }
      const header = request.headers.authorization
      const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
      const adminToken = bearer
      // 浏览器会话与 Bearer 凭证互不冒充：Cookie 只在同源请求携带，且不可用于升级为代理令牌。
      const resolved = identity ? await identity.resolveSession(readCookie(request.headers.cookie, identity.cookieName)) : null
      const loginSession = resolved && identity ? await identity.touch(resolved) : null
      const credential: RequestCredential = { bearer, loginSession }
      if (await handleAuthRoute({ request, response, path, method, readBody: () => body(request), auth, identity: identity ?? null, service, loginSession, bearer, registration, settings, google })) return
      const unsafe = method !== 'GET' && method !== 'HEAD'
      if (unsafe && loginSession) assertCookieWriteAllowed(identity ?? null, request, loginSession)
      const projectEvents = path.match(/^\/projects\/([^/]+)\/events$/)
      if (tasks && projectStreams && projectEvents && method === 'GET') {
        const authorize = async () => tasks.authorizeProject(projectEvents[1], { actor: await auth.taskActor(credential), requestId: randomUUID(), teamId: url.searchParams.get('teamId') ?? undefined })
        try { await authorize() }
        catch (error) {
          if (error instanceof TaskError || error instanceof AppError) {
            json(response, error.status, { error: { code: error instanceof TaskError ? error.code : 'unauthorized', message: error.message } }); return
          }
          throw error
        }
        projectStreams.open(response, projectEvents[1], authorize); return
      }
      const projectReader = path.match(/^\/projects\/([^/]+)\/(activity|reviews)$/)
      if (tasks && (projectReader || /^\/projects\/[^/]+\/tasks(?:\/|$)/.test(path))) {
        const match = path.match(/^\/projects\/([^/]+)\/tasks(?:\/([^/]+)(?:\/(transition|move|activity|links|workspaces|assignment|runs|launch|sessions)(?:\/([^/]+)(?:\/(retry|cancel|review))?)?)?)?$/)
        try {
          const actor = await auth.taskActor(credential)
          if (!match && !projectReader) throw new TaskError('not_found', 'Route not found')
          const [, projectId, taskId, action, linkId, retry] = match ?? ['', projectReader![1]]
          const requestId = request.headers['x-request-id'] ?? randomUUID()
          if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw new TaskError('invalid_request', 'Invalid request ID')
          const context = { actor, requestId, teamId: url.searchParams.get('teamId') ?? undefined }
          response.setHeader('X-Request-ID', requestId)
          if (projectReader) {
            if (method !== 'GET') throw new TaskError('not_found', 'Route not found')
            const after = url.searchParams.get('after') ?? '0'
            if (projectReader[2] === 'activity' && !/^\d+$/.test(after)) throw new TaskError('invalid_request', 'Invalid after cursor')
            json(response, 200, { items: projectReader[2] === 'activity' ? await tasks.projectActivity(projectId, Number(after), context) : await tasks.pendingReviews(projectId, context) }); return
          }
          if (taskId && action === 'runs' && linkId && retry === 'review') {
            if (method === 'GET') { json(response, 200, { review: await tasks.review(projectId, taskId, linkId, context) }); return }
            if (method === 'POST') { json(response, 200, await tasks.reviewAction(projectId, taskId, linkId, await body(request), context)); return }
          }
          if (!taskId && method === 'GET') { json(response, 200, { items: await tasks.list(projectId, context) }); return }
          if (!taskId && method === 'POST') { json(response, 201, await tasks.create(projectId, await body(request), context)); return }
          if (taskId && !action && method === 'GET') { json(response, 200, await tasks.get(projectId, taskId, context)); return }
          if (taskId && ((!action && method === 'PATCH') || (['transition', 'move'].includes(action) && method === 'POST'))) { json(response, 200, await tasks.patch(projectId, taskId, await body(request), context)); return }
          if (taskId && action === 'sessions' && !linkId && method === 'POST') { json(response, 201, await tasks.createSession(projectId, taskId, await body(request), context)); return }
          if (taskId && action === 'launch' && !linkId && method === 'POST') { json(response, 200, await tasks.launch(projectId, taskId, await body(request), context)); return }
          if (taskId && action === 'runs' && linkId && retry === 'cancel' && method === 'POST') { json(response, 200, await tasks.cancelRun(projectId, taskId, linkId, await body(request), context)); return }
          if (taskId && action === 'runs' && !retry && method === 'GET') { json(response, 200, linkId ? await tasks.run(projectId, taskId, linkId, context) : { items: await tasks.runs(projectId, taskId, context) }); return }
          if (taskId && action === 'activity' && method === 'GET' && !linkId) { json(response, 200, { items: await tasks.activity(projectId, taskId, Number(url.searchParams.get('after') ?? 0), context) }); return }
          if (taskId && action === 'links' && ((method === 'POST' && !linkId) || (method === 'DELETE' && linkId))) { json(response, 200, await tasks.link(projectId, taskId, method === 'POST' ? await body(request) : {}, linkId, context)); return }
          if (taskId && action === 'assignment' && !linkId && (method === 'PUT' || method === 'DELETE')) { json(response, 200, await tasks.assignment(projectId, taskId, await body(request), method === 'DELETE', context)); return }
          if (retry === 'retry' && taskId && action === 'workspaces' && linkId && method === 'POST') { json(response, 200, await tasks.retryWorkspace(projectId, taskId, linkId, await body(request), context)); return }
          if (retry) throw new TaskError('not_found', 'Route not found')
          if (taskId && action === 'workspaces') {
            if (!linkId && method === 'GET') { json(response, 200, { items: (await tasks.get(projectId, taskId, context)).workspaces }); return }
            if (!linkId && method === 'POST') { json(response, 201, await tasks.createWorkspace(projectId, taskId, await body(request), context)); return }
            if (linkId && method === 'PUT') { json(response, 200, await tasks.bind(projectId, taskId, linkId, context)); return }
            if (linkId && method === 'DELETE') { json(response, 200, await tasks.unbind(projectId, taskId, linkId, await body(request), context)); return }
          }
          throw new TaskError('not_found', 'Route not found')
        } catch (error) {
          const failure = error instanceof TaskError ? error : error instanceof AppError ? new TaskError(error.status === 401 ? 'unauthorized' : error.status === 403 ? 'forbidden' : error.status === 404 ? 'not_found' : error.status === 409 ? 'runtime_unavailable' : 'invalid_request', error.message) : null
          if (!failure) throw error
          json(response, failure.status, { error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } }); return
        }
      }
      await auth.authenticateAdmin(credential)
      // 集群控制面的写操作归属真实用户：优先 Cookie 会话，其次该 PAT 的归属用户。
      const operator = await auth.taskActor(credential)
      // 默认环境不再由合成用户拥有：由当前管理员会话就地建立（幂等）。
      if (method === 'POST' && path === '/bootstrap') { json(response, 200, await service.ensureDefaultEnvironment(operator)); return }
      if (method === 'POST' && path === '/enrollment-tokens') { json(response, 201, await service.createEnrollment(await body(request), operator)); return }
      if (method === 'GET' && path === '/workers') { json(response, 200, { items: await service.listWorkers() }); return }
      if (method === 'GET' && path === '/cluster/tailnet') { json(response, 200, await readTailnetSelf()); return }
      const projectAssets = path.match(/^\/projects\/([^/]+)\/capability-assets$/)
      if (projectAssets && capabilities) {
        const projectId = projectAssets[1] as ProjectId
        if (method === 'GET') { json(response, 200, { items: await capabilities.listProjectAssets(projectId) }); return }
        if (method === 'PUT') {
          const input = await body(request) as { items?: unknown }
          if (!Array.isArray(input.items)) throw new AppError(400, 'items must be an array')
          json(response, 200, { items: await capabilities.replaceProjectAssets(projectId, input.items as any[]) }); return
        }
      }
      const worker = path.match(/^\/workers\/([^/]+)(\/capabilities)?$/)
      if (method === 'GET' && worker) {
        const value = await service.getWorker(worker[1] as WorkerId)
        json(response, 200, worker[2] ? { workerId: value.id, capabilities: value.capabilities } : value); return
      }
      const command = path.match(/^\/commands\/([^/]+)$/)
      if (method === 'GET' && command) { json(response, 200, await service.getCommand(command[1] as CommandId)); return }
      if (method === 'DELETE' && command) { json(response, 200, await service.cancelCommand(command[1] as CommandId)); return }
      if (method === 'GET' && path === '/commands') {
        json(response, 200, { items: await service.listCommands({ workerId: url.searchParams.get('workerId') ?? undefined, status: url.searchParams.get('status') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 100) }) }); return
      }
      const revoke = path.match(/^\/workers\/([^/]+)\/revoke$/)
      if (method === 'POST' && revoke) { json(response, 200, await service.revokeWorker(revoke[1] as WorkerId, id => control?.disconnectWorker(id))); return }
      const reprovision = path.match(/^\/workspaces\/([^/]+)\/reprovision$/)
      if (method === 'POST' && reprovision) {
        const input = await body(request) as { requestId?: unknown; workerId?: unknown }
        if (input.requestId !== undefined && typeof input.requestId !== 'string') throw new AppError(400, 'Invalid retry requestId')
        if (input.workerId !== undefined && typeof input.workerId !== 'string') throw new AppError(400, 'Invalid workerId')
        json(response, 200, await service.reprovisionWorkspace(reprovision[1] as WorkspaceId, input.requestId, input.workerId as WorkerId | undefined, operator)); return
      }
      const cancelQueued = path.match(/^\/sessions\/([^/]+)\/messages\/([^/]+)\/cancel$/)
      if (method === 'POST' && cancelQueued) { json(response, 202, await service.cancelQueued(cancelQueued[1] as SessionId, cancelQueued[2] as CommandId, await body(request))); return }
      const stopTurn = path.match(/^\/sessions\/([^/]+)\/turn\/stop$/)
      if (method === 'POST' && stopTurn) { json(response, 202, await service.stopTurn(stopTurn[1] as SessionId, await body(request))); return }
      const runtimeCommand = path.match(/^\/sessions\/([^/]+)\/runtime\/commands$/)
      if (method === 'POST' && runtimeCommand) { json(response, 202, await service.invokeRuntimeCommand(runtimeCommand[1] as SessionId, await body(request))); return }
      const runtimeApproval = path.match(/^\/sessions\/([^/]+)\/runtime\/approvals\/([^/]+)$/)
      if (method === 'POST' && runtimeApproval) { json(response, 202, await service.resolveRuntimeApproval(runtimeApproval[1] as SessionId, runtimeApproval[2] as ApprovalId, await body(request))); return }
      const sessions = path.match(/^\/sessions\/([^/]+)\/(messages|events|stream)$/)
      if (sessions) {
        const id = sessions[1] as SessionId
        if (method === 'POST' && sessions[2] === 'messages') { json(response, 202, await service.enqueue(id, await body(request))); return }
        if (method === 'GET' && (sessions[2] === 'events' || sessions[2] === 'stream')) {
          const lastId = request.headers['last-event-id']
          if (lastId !== undefined && (typeof lastId !== 'string' || !/^\d+$/.test(lastId))) throw new AppError(400, 'Invalid Last-Event-ID')
          const from = integer(Number(url.searchParams.get('fromSeq') ?? (lastId === undefined ? 1 : Number(lastId) + 1)), 'fromSeq', 1)
          if (sessions[2] === 'events') json(response, 200, await service.events(id, from, Number(url.searchParams.get('limit') ?? 100)))
          else { await service.getSession(id); streams.open(response, id, from) }
          return
        }
      }
      // 血缘与 Fork：C1 的写入口只有一条（POST session-forks），画布连线不参与领域写入。
      const forkTarget = path.match(/^\/projects\/([^/]+)\/session-forks$/)
      if (lineage && forkTarget && method === 'POST') {
        json(response, 201, await lineage.fork({ operator: await auth.taskActor(credential), projectId: forkTarget[1] as ProjectId, command: await body(request) })); return
      }
      const sessionGraph = path.match(/^\/projects\/([^/]+)\/session-graph$/)
      if (lineage && sessionGraph && method === 'GET') {
        const rootSessionId = url.searchParams.get('rootSessionId'), depth = url.searchParams.get('depth'), nodeLimit = url.searchParams.get('nodeLimit')
        json(response, 200, { graph: await lineage.getGraph({ operator: await auth.taskActor(credential), query: {
          projectId: sessionGraph[1] as ProjectId,
          ...(rootSessionId === null ? {} : { rootSessionId: rootSessionId as SessionId }),
          ...(depth === null ? {} : { depth: Number(depth) }),
          ...(nodeLimit === null ? {} : { nodeLimit: Number(nodeLimit) }),
        } }) }); return
      }
      const sessionLineage = path.match(/^\/sessions\/([^/]+)\/lineage$/)
      if (lineage && sessionLineage && method === 'GET') {
        json(response, 200, await lineage.lineage({ operator: await auth.taskActor(credential), sessionId: sessionLineage[1] as SessionId })); return
      }
      const forkPoint = path.match(/^\/session-forks\/([^/]+)$/)
      if (lineage && forkPoint && method === 'GET') {
        json(response, 200, await lineage.getForkPoint({ operator: await auth.taskActor(credential), forkId: forkPoint[1] as SessionForkId })); return
      }
      const resource = path.match(/^\/(projects|workspaces|sessions)(?:\/([^/]+))?$/)
      if (resource) {
        const kind = resource[1] as 'projects' | 'workspaces' | 'sessions', id = resource[2]
        if (!id && method === 'GET') {
          const projectId = url.searchParams.get('projectId')
          const workspaceId = url.searchParams.get('workspaceId')
          if (kind === 'projects') {
            json(response, 200, { items: await service.listProjects() })
          } else if (kind === 'workspaces') {
            const items = await service.listWorkspaces()
            json(response, 200, { items: projectId ? items.filter(item => item.projectId === projectId) : items })
          } else {
            const archived = url.searchParams.get('archived')
            if (archived !== null && archived !== 'true' && archived !== 'false') throw new AppError(400, 'archived must be true or false')
            const items = await Promise.all((await service.listSessions({ archived: archived === null ? undefined : archived === 'true' })).map(session => service.sessionView(session.id)))
            json(response, 200, {
              items: workspaceId
                ? items.filter(item => item.workspaceId === workspaceId)
                : projectId
                  ? items.filter(item => item.projectId === projectId)
                  : items,
            })
          }
          return
        }
        if (!id && method === 'POST') {
          const input = await body(request)
          json(response, 201, kind === 'projects' ? await service.createProject(input, operator) : kind === 'workspaces' ? await service.createWorkspace(input) : await service.createSession(input)); return
        }
        if (id && method === 'GET') { json(response, 200, kind === 'projects' ? await service.getProject(id as ProjectId) : kind === 'workspaces' ? await service.getWorkspace(id as WorkspaceId) : await service.sessionView(id as SessionId)); return }
        if (id && method === 'PATCH') { json(response, 200, await service.update(kind, id, await body(request))); return }
        if (id && method === 'DELETE') { await service.delete(kind, id); response.writeHead(204); response.end(); return }
      }
      throw new AppError(404, 'Not found')
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return }
      const status = error instanceof AppError ? error.status : error instanceof CapabilityTokenError ? 401 : error instanceof CapabilityError ? error.code === 'forbidden' ? 403 : error.code === 'not-found' ? 404 : 400 : 500
      json(response, status, { error: error instanceof AppError ? { code: error.code ?? 'error', message: error.message } : error instanceof Error ? { code: 'internal_error', message: error.message } : { code: 'internal_error', message: 'Internal server error' } })
    })
  }
}
