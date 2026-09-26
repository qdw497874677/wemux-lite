import { AppError } from '../../application/errors.js'
import { handleAuthRoute } from '../routes-auth.js'
import type { HttpMethod, RouteDescriptor, RouteRequestContext } from './types.js'

const handle = async (context: RouteRequestContext): Promise<void> => {
  const handled = await handleAuthRoute({
    request: context.request, response: context.response, path: context.path, method: context.method,
    readBody: context.readBody, auth: context.auth, identity: context.identity ?? null, service: context.service,
    loginSession: context.loginSession, bearer: context.bearer, registration: context.registration,
    settings: context.settings, google: context.google, security: context.security, teams: context.teams,
    personalAccessTokens: context.personalAccessTokens, lifecycle: context.lifecycle,
  })
  if (!handled) throw new AppError(404, 'Route not found')
}

const route = (method: HttpMethod, pattern: string): RouteDescriptor => ({ method, pattern, auth: 'public', handler: handle })

export const authRoutes: readonly RouteDescriptor[] = [
  route('GET', '/settings/registration-policy'), route('PATCH', '/settings/registration-policy'),
  route('GET', '/auth/options'), route('POST', '/auth/oauth/google/start'), route('GET', '/auth/oauth/google/callback'),
  route('POST', '/auth/register'), route('POST', '/auth/register/resend'), route('POST', '/auth/email/verify'),
  route('POST', '/auth/password/forgot'), route('POST', '/auth/password/reset'), route('POST', '/auth/email/change/confirm'),
  route('POST', '/auth/session'), route('POST', '/auth/login'), route('GET', '/auth/me'), route('GET', '/auth/sessions'),
  route('GET', '/auth/personal-access-tokens'), route('POST', '/auth/personal-access-tokens'),
  route('DELETE', '/auth/personal-access-tokens/:tokenId'), route('POST', '/auth/personal-access-tokens/:tokenId/rotate'),
  route('POST', '/auth/logout'), route('POST', '/auth/logout-all'), route('DELETE', '/auth/sessions/:sessionId'),
  route('GET', '/auth/account/security'), route('GET', '/auth/account/lifecycle'), route('POST', '/auth/account/lifecycle'),
  route('GET', '/auth/account/audit'), route('GET', '/auth/account/audit/export'), route('GET', '/auth/account/users'),
  route('POST', '/auth/account/users/:userId/disable'), route('POST', '/auth/account/users/:userId/restore'),
  route('POST', '/auth/account/users/:userId/request-deletion'), route('POST', '/auth/account/users/:userId/confirm-deletion'),
  route('POST', '/auth/password/change'), route('POST', '/auth/email/change'), route('POST', '/auth/identities/google/start'),
  route('DELETE', '/auth/identities/:methodId'),
  // Preserve the legacy auth namespace behavior: anonymous unknown auth paths fail authentication,
  // while authenticated callers receive the route-level 404 from handleAuthRoute.
  route('GET', '/auth/:unknown'), route('POST', '/auth/:unknown'), route('PUT', '/auth/:unknown'),
  route('PATCH', '/auth/:unknown'), route('DELETE', '/auth/:unknown'),
]
