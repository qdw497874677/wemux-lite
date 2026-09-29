import type { IncomingMessage, ServerResponse } from 'node:http'
import { CapabilityError } from '../application/capability-service.ts'
import { CapabilityTokenError } from '../application/capability-token-service.ts'
import { AppError } from '../application/errors.ts'
import { isWebConsoleAuthPath } from '../application/web-console-routes.ts'
import { readCookie } from './cookies.ts'
import { assertCookieWriteAllowed } from './routes-auth.ts'
import { routes } from './routes/index.ts'
import { requiredPatAccess } from './routes/access.ts'
import { findRoute } from './routes/registry.ts'
import type { HttpHandlerOptions, RouteRequestContext } from './routes/types.ts'
import { serveStaticSite } from './static.ts'

async function rawBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); size += buffer.length
    if (size > maximumBytes) throw new AppError(413, 'Request too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
async function body(request: IncomingMessage): Promise<unknown> {
  const maximumBytes = request.method === 'POST' && /^\/api\/sessions\/[^/]+\/fs\/write\/?$/.test(request.url?.split('?')[0] ?? '') ? 14 * 1024 * 1024
    : request.method === 'PUT' && /^\/api\/resource-blobs\/[a-f0-9]{64}\/?$/.test(request.url?.split('?')[0] ?? '') ? 2 * 1024 * 1024
      : 1024 * 1024
  const raw = await rawBody(request, maximumBytes)
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {} }
  catch { throw new AppError(400, 'Invalid JSON') }
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(data))
}

export type { HttpHandlerOptions, WorkerControl } from './routes/types.ts'

/** Thin HTTP adapter: normalize the URL, resolve credentials, then dispatch through the domain route table. */
export function httpHandler(options: HttpHandlerOptions) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const rawPath = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '')
      // The web console calls same-origin "/api/*" paths; accept the prefix directly so
      // single-origin deployments (server hosting the built web bundle) work without a proxy.
      const path = rawPath === '/api' || rawPath.startsWith('/api/') ? (rawPath.slice(4) || '/') : rawPath
      const method = request.method
      // API 命名空间不参与 SPA 回退。邮件链接目标是 Web 页面，仍允许静态站点接管。
      const apiNamespace = rawPath === '/api' || rawPath.startsWith('/api/') || ((rawPath === '/auth' || rawPath.startsWith('/auth/')) && !isWebConsoleAuthPath(rawPath))
      if (options.staticSite && method === 'GET' && !apiNamespace && await serveStaticSite(response, path, request.headers.accept, options.staticSite)) return

      const matched = findRoute(routes, method, path)
      if (!matched) throw new AppError(404, 'Not found')

      const header = request.headers.authorization
      const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
      // 浏览器会话与 Bearer 凭证互不冒充：Cookie 只在同源请求携带，且不可用于升级为代理令牌。
      const resolved = options.identity ? await options.identity.resolveSession(readCookie(request.headers.cookie, options.identity.cookieName)) : null
      const loginSession = resolved && options.identity ? await options.identity.touch(resolved) : null
      const credential = { bearer, loginSession }
      const unsafe = method !== 'GET' && method !== 'HEAD'
      if (matched.route.auth !== 'public' && unsafe && loginSession) assertCookieWriteAllowed(options.identity ?? null, request, loginSession)

      let requestActor: Awaited<ReturnType<typeof options.auth.actor>> | null = null
      let requestAccess: import('../application/auth.ts').RequestAccess | null = null
      if (matched.route.auth !== 'public' && matched.route.auth !== 'worker' && matched.route.auth !== 'capability' && matched.route.auth !== 'task' && bearer && !loginSession) {
        requestAccess = requiredPatAccess(path, method)
        try { requestActor = await options.auth.actor(credential, requestAccess) }
        catch (error) {
          if (error instanceof AppError && error.code === 'pat_scope_required' && options.personalAccessTokens) await options.personalAccessTokens.recordFailedAuthentication({ bearer, requiredScope: requestAccess, reason: error.code })
          throw error
        }
      }
      response.once('finish', () => {
        if (requestActor && requestAccess && response.statusCode < 400) void options.auth.recordPatUse(requestActor, requestAccess).catch(() => undefined)
      })

      const context: RouteRequestContext = {
        ...options, request, response, url, rawPath, path, method, bearer, loginSession, credential, params: matched.params,
        readBody: () => body(request),
        readRawBody: maximumBytes => rawBody(request, maximumBytes ?? 1024 * 1024),
        json: (status, data) => json(response, status, data),
        noContent: () => { response.writeHead(204).end() },
        actor: access => options.auth.taskActor(credential, access ?? requiredPatAccess(path, method)),
        operator: async () => {
          await options.auth.authenticateAdmin(credential)
          return options.auth.taskActor(credential)
        },
      }
      await matched.route.handler(context)
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return }
      const status = error instanceof AppError ? error.status : error instanceof CapabilityTokenError ? 401 : error instanceof CapabilityError ? error.code === 'forbidden' ? 403 : error.code === 'not-found' ? 404 : 400 : 500
      json(response, status, { error: error instanceof AppError ? { code: error.code ?? 'error', message: error.message } : error instanceof Error ? { code: 'internal_error', message: error.message } : { code: 'internal_error', message: 'Internal server error' } })
    })
  }
}
