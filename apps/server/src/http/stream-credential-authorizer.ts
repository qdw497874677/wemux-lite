import type { UserId } from '@wemux/domain'
import type { RequestAccess } from '../application/auth.ts'
import { AppError } from '../application/errors.ts'
import { readCookie } from './cookies.ts'
import type { RouteRequestContext } from './routes/types.ts'

/** Pin the opening credential, never touch its lifetime or fall back to another kind. */
export function createStreamCredentialAuthorizer(context: RouteRequestContext, expectedActor: UserId, requiredAccess: RequestAccess, administrator = false): () => Promise<void> {
  const { auth, identity, bearer } = context
  const cookie = Boolean(context.loginSession)
  const token = cookie && identity ? readCookie(context.request.headers.cookie, identity.cookieName) : undefined
  return async () => {
    const loginSession = cookie && identity ? await identity.resolveSession(token) : null
    if (cookie && !loginSession) throw new AppError(401, 'Unauthorized')
    const credential = cookie ? { loginSession } : { bearer }
    const current = await auth.taskActor(credential, requiredAccess)
    if (current !== expectedActor) throw new AppError(401, 'Unauthorized')
    if (administrator) await auth.authenticateAdmin(credential)
  }
}
