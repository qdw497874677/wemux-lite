import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LoginSession } from '@wemux/server-domain'
import type { RegistrationPolicy } from '@wemux/server-domain'
import type { AuthenticationService, RequestCredential } from '../application/auth.js'
import type { IdentityService, IssuedLoginSession, LoginSessionView } from '../application/identity-service.js'
import type { ServerService } from '../application/server-service.js'
import type { EmailRegistrationService } from '../application/email-registration.js'
import type { GoogleAuthenticationService } from '../application/google-authentication.js'
import type { InstanceSettingsService } from '../application/instance-settings.js'
import { AppError } from '../application/errors.js'
import { clearedSessionCookie, isSecureRequest, readCookie, sessionCookie } from './cookies.js'

/**
 * 浏览器账号 HTTP 契约（Ticket 04）。只包含 Cookie 会话的建立、读取与撤销；
 * 认证判定仍由 `AuthenticationService` 与 `IdentityService` 负责，路由不复制策略。
 * 旧 `POST /auth/session` 明确退役，避免浏览器继续持有代理令牌（设计第 5 节）。
 * Ticket 05 在同一模块里挂上邮箱注册、验证与找回：它们共享同一套 Cookie 与限流约定。
 * Ticket 07 加上 Google 登录：start 返回授权地址并把一次性 state 写进短时 Cookie，
 * callback 校验后签发同一套 Cookie 会话；失败一律重定向回登录页带错误码，不返回 JSON。
 */
export interface AuthRouteContext {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly path: string
  readonly method: string | undefined
  readonly readBody: () => Promise<unknown>
  readonly auth: AuthenticationService
  readonly identity: IdentityService | null
  readonly service: ServerService
  readonly loginSession: LoginSession | null
  readonly bearer: string | undefined
  readonly registration?: EmailRegistrationService | null
  readonly settings?: InstanceSettingsService | null
  readonly google?: GoogleAuthenticationService | null
}

/** 一次性 state 的 Cookie 名：与发起浏览器绑定，回调后立即清除。 */
export const oauthStateCookieName = 'wemux_oauth_state'

interface AccountPayload {
  readonly user: IssuedLoginSession['user']
  readonly teamId: IssuedLoginSession['teamId']
  /** 只暴露可安全展示的会话视图：绝不返回令牌或其哈希。 */
  readonly session: LoginSessionView
  readonly expiresAt: string
  readonly csrfToken: string
  readonly instanceAdministrator: boolean
}

const requireIdentity = (identity: IdentityService | null): IdentityService => {
  if (!identity) throw new AppError(503, '账号功能未启用', 'identity_disabled')
  return identity
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Cookie 会话的写保护：由 `IdentityService` 判定，路由只负责收集输入。 */
export function assertCookieWriteAllowed(identity: IdentityService | null, request: IncomingMessage, session: LoginSession | null): void {
  if (!identity || !session) return
  identity.assertUnsafeCookieRequestAllowed(session, {
    csrfToken: header(request, 'x-csrf-token'),
    origin: header(request, 'origin'),
    host: header(request, 'host'),
  })
}

const writeSessionCookies = (response: ServerResponse, request: IncomingMessage, identity: IdentityService, issued: IssuedLoginSession): void => {
  response.setHeader('Set-Cookie', [sessionCookie({ name: identity.cookieName, value: issued.token, expiresAt: issued.expiresAt, secure: isSecureRequest(request) })])
}

/**
 * 声明管理员首次建立会话时补齐默认环境：默认 Team 与 Project 的 owner 指向真实管理员。
 * 只对部署声明的管理员生效，普通成员不会因此凭空得到团队；重复调用是幂等的。
 */
const ensureAdministratorEnvironment = async (context: AuthRouteContext, identity: IdentityService, userId: IssuedLoginSession['user']['id']): Promise<IssuedLoginSession['teamId']> => {
  if (!await identity.isAdministrator(userId)) return null
  const environment = await context.service.ensureDefaultEnvironment(userId)
  return environment.team?.id ?? null
}

const accountPayload = async (context: AuthRouteContext, identity: IdentityService, issued: IssuedLoginSession, teamId: IssuedLoginSession['teamId']): Promise<AccountPayload> => {
  const ensured = await ensureAdministratorEnvironment(context, identity, issued.user.id)
  return {
    user: issued.user, teamId: teamId ?? ensured, session: identity.view(issued.session, issued.session.id), expiresAt: issued.expiresAt, csrfToken: issued.csrfToken,
    instanceAdministrator: await identity.isAdministrator(issued.user.id),
  }
}

const asText = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

const requireRegistration = (registration: EmailRegistrationService | null | undefined): EmailRegistrationService => {
  if (!registration) throw new AppError(503, '邮箱注册未启用', 'registration_disabled')
  return registration
}

const requireGoogle = (google: GoogleAuthenticationService | null | undefined): GoogleAuthenticationService => {
  if (!google) throw new AppError(404, '本实例未配置 Google 登录', 'google_unconfigured')
  return google
}

/**
 * OAuth state 的短时 Cookie：Path=/ 是为了兼容反向代理下的 API 前缀差异，
 * 安全性由 HttpOnly + SameSite=Lax + 5 分钟有效期 + 一次性事务共同保证。
 */
const oauthStateCookie = (input: { value: string; expiresAt: string; secure: boolean }): string => {
  const attributes = [`${oauthStateCookieName}=${encodeURIComponent(input.value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${new Date(input.expiresAt).toUTCString()}`]
  if (input.secure) attributes.push('Secure')
  return attributes.join('; ')
}

/**
 * 限流键：IP 限单机刷量，邮箱限定向轰炸，两条都进服务层的滑动窗口。
 * 键里用规范化邮箱，避免大小写变体绕过限流。
 */
const throttleKeys = (context: AuthRouteContext, email: unknown): string[] => [
  `ip:${context.request.socket.remoteAddress ?? 'unknown'}`,
  `email:${typeof email === 'string' ? email.trim().toLowerCase() : 'unknown'}`,
]

export async function handleAuthRoute(context: AuthRouteContext): Promise<boolean> {
  const { request, response, path, method } = context
  const respond = (status: number, data: unknown): boolean => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(data))
    return true
  }
  // 实例注册策略：管理员可改，公开只读（通过 /auth/options）。
  if (path === '/settings/registration-policy') {
    const settings = context.settings
    if (!settings) throw new AppError(503, '实例设置未启用', 'settings_disabled')
    const credential: RequestCredential = { bearer: context.bearer, loginSession: context.loginSession }
    await context.auth.authenticateAdmin(credential)
    // 读策略是安全读：Cookie 会话不该被要求带 CSRF 头，否则页面永远读不出策略。
    if (method === 'GET') return respond(200, await settings.view())
    if (method !== 'PATCH') throw new AppError(404, 'Route not found')
    assertCookieWriteAllowed(context.identity, request, context.loginSession)
    const input = await context.readBody() as { policy?: unknown }
    const actor = await context.auth.taskActor(credential)
    return respond(200, await settings.setPolicy(input.policy as RegistrationPolicy, actor))
  }
  if (!path.startsWith('/auth/')) return false
  // 未登录可用的账号入口：注册、重发验证、验证邮箱、找回与重置密码。
  // 它们不读取 Cookie 会话，也不接受 Bearer 代理令牌，全部走限流与审计。
  if (method === 'GET' && path === '/auth/options') {
    const base = await requireIdentity(context.identity).options()
    const registration = context.registration ? await context.registration.capabilities() : null
    // 未配置时如实报告原因，前端据此不渲染假按钮（设计第 2.2 节）。
    const google = context.google ? context.google.capability() : { enabled: false, reason: '本实例未配置 Google 登录' }
    return respond(200, { ...base, registration, google })
  }
  if (method === 'POST' && path === '/auth/oauth/google/start') {
    const google = requireGoogle(context.google)
    const input = await context.readBody() as { returnTo?: unknown }
    const started = await google.start({ returnTo: input.returnTo })
    response.setHeader('Set-Cookie', [oauthStateCookie({ value: started.state, expiresAt: started.expiresAt, secure: isSecureRequest(request) })])
    return respond(202, { authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt })
  }
  if (method === 'GET' && path === '/auth/oauth/google/callback') {
    const google = requireGoogle(context.google)
    const identity = requireIdentity(context.identity)
    const query = new URL(request.url ?? '/', 'http://localhost').searchParams
    let location = '/'
    try {
      const finished = await google.finish({
        code: query.get('code') ?? undefined, state: query.get('state') ?? undefined,
        cookieState: readCookie(request.headers.cookie, oauthStateCookieName),
        client: header(request, 'user-agent'), supersede: context.loginSession,
      })
      response.setHeader('Set-Cookie', [
        sessionCookie({ name: identity.cookieName, value: finished.issued.token, expiresAt: finished.issued.expiresAt, secure: isSecureRequest(request) }),
        clearedSessionCookie({ name: oauthStateCookieName, secure: isSecureRequest(request) }),
      ])
      location = finished.returnTo ?? '/'
    } catch (error) {
      // 浏览器流不能把 JSON 错误当页面：清掉 state 后回登录页，错误码由前端翻译成人话。
      if (!(error instanceof AppError)) throw error
      response.setHeader('Set-Cookie', [clearedSessionCookie({ name: oauthStateCookieName, secure: isSecureRequest(request) })])
      location = `/?oauth_error=${encodeURIComponent(error.code ?? 'oauth_failed')}`
    }
    // 302 而非 307：回调是 GET 且目标由服务端决定，不携带原始查询与授权码。
    response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
    response.end()
    return true
  }
  if (method === 'POST' && path === '/auth/register') {
    const registration = requireRegistration(context.registration)
    const input = await context.readBody() as { email?: unknown; displayName?: unknown; password?: unknown }
    const outcome = await registration.register({ email: input.email, displayName: input.displayName, password: input.password, throttleKeys: throttleKeys(context, input.email) })
    return respond(202, outcome)
  }
  if (method === 'POST' && path === '/auth/register/resend') {
    const registration = requireRegistration(context.registration)
    const input = await context.readBody() as { email?: unknown }
    return respond(202, await registration.resend({ email: input.email, throttleKeys: throttleKeys(context, input.email) }))
  }
  if (method === 'POST' && path === '/auth/email/verify') {
    const identity = requireIdentity(context.identity)
    const input = await context.readBody() as { token?: unknown }
    const outcome = await requireRegistration(context.registration).verify({ token: input.token, client: header(request, 'user-agent') })
    // 验证成功即等于一次受信任的登录：直接签发 Cookie 会话，用户不必再输密码。
    if (outcome.status === 'verified') {
      writeSessionCookies(response, request, identity, outcome.issued)
      return respond(200, { status: outcome.status, ...await accountPayload(context, identity, outcome.issued, outcome.issued.teamId) })
    }
    return respond(200, outcome)
  }
  if (method === 'POST' && path === '/auth/password/forgot') {
    const registration = requireRegistration(context.registration)
    const input = await context.readBody() as { email?: unknown }
    return respond(202, await registration.forgotPassword({ email: input.email, throttleKeys: throttleKeys(context, input.email) }))
  }
  if (method === 'POST' && path === '/auth/password/reset') {
    const registration = requireRegistration(context.registration)
    const input = await context.readBody() as { token?: unknown; password?: unknown }
    const outcome = await registration.resetPassword({ token: input.token, password: input.password })
    // 重置会撤销全部会话：当前浏览器若有旧 Cookie 也一并清掉。
    response.setHeader('Set-Cookie', [clearedSessionCookie({ name: requireIdentity(context.identity).cookieName, secure: isSecureRequest(request) })])
    return respond(200, outcome)
  }
  if (method === 'POST' && path === '/auth/session') {
    throw new AppError(410, '旧登录入口已退役：浏览器请使用 POST /auth/login', 'retired_endpoint')
  }
  if (method === 'POST' && path === '/auth/login') {
    const identity = requireIdentity(context.identity)
    const input = await context.readBody() as { login?: unknown; username?: unknown; password?: unknown }
    const login = asText(input.login) ?? asText(input.username)
    if (!login) throw new AppError(400, '请提供账号或邮箱', 'invalid_request')
    const issued = await identity.login({
      login, password: asText(input.password) ?? '', client: header(request, 'user-agent'),
      throttleKey: request.socket.remoteAddress ?? 'unknown', supersede: context.loginSession,
    })
    writeSessionCookies(response, request, identity, issued)
    // 首个管理员会话顺带补齐默认环境：teamId 直接出现在登录响应里，不靠下一次刷新补。
    return respond(200, await accountPayload(context, identity, issued, issued.teamId))
  }
  const session = context.loginSession
  if (!session) throw new AppError(401, 'Unauthorized')
  const identity = requireIdentity(context.identity)
  if (method === 'GET' && path === '/auth/me') {
    const user = await identity.user(session.userId)
    // Google 回调只设 Cookie 不返回 JSON：管理员首次从 Google 进来的默认环境在这里补齐。
    await ensureAdministratorEnvironment(context, identity, user.id)
    const rotated = await identity.ensureCsrfToken(session, header(request, 'x-csrf-token'))
    if (rotated.csrfToken) {
      // 轮换后浏览器尚未持有新令牌，本次请求同时返回明文（只此一次）。
      const account = await identity.account(user, rotated.session, rotated.csrfToken)
      return respond(200, account)
    }
    return respond(200, await identity.account(user, rotated.session))
  }
  if (method === 'GET' && path === '/auth/sessions') return respond(200, { items: await identity.listSessions(session.userId, session.id) })
  if (method === 'POST' && path === '/auth/logout') {
    assertCookieWriteAllowed(identity, request, session)
    await identity.logout(session)
    response.setHeader('Set-Cookie', [clearedSessionCookie({ name: identity.cookieName, secure: isSecureRequest(request) })])
    response.writeHead(204).end()
    return true
  }
  if (method === 'POST' && path === '/auth/logout-all') {
    assertCookieWriteAllowed(identity, request, session)
    const revoked = await identity.logoutAll(session.userId, session)
    return respond(200, { revoked })
  }
  const target = path.match(/^\/auth\/sessions\/([^/]+)$/)
  if (method === 'DELETE' && target) {
    assertCookieWriteAllowed(identity, request, session)
    const revokeAllButCurrent = new URL(request.url ?? '/', 'http://localhost').searchParams.get('allButCurrent') === 'true'
    if (revokeAllButCurrent) {
      const revoked = await identity.logoutAll(session.userId, session)
      return respond(200, { revoked })
    }
    await identity.revokeSession(session.userId, decodeURIComponent(target[1]!))
    if (target[1] === session.id) response.setHeader('Set-Cookie', [clearedSessionCookie({ name: identity.cookieName, secure: isSecureRequest(request) })])
    response.writeHead(204).end()
    return true
  }
  throw new AppError(404, 'Route not found')
}