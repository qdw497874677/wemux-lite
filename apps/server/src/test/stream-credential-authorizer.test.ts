import assert from 'node:assert/strict'
import test from 'node:test'
import type { UserId } from '@wemux/domain'
import type { RouteRequestContext } from '../http/routes/types.ts'
import { createStreamCredentialAuthorizer } from '../http/stream-credential-authorizer.ts'

test('pins original Cookie token, rejects changed actor and missing Cookie without Bearer fallback', async () => {
  let user: string | null = 'original', bearerCalls = 0
  const tokens: unknown[] = []
  const context = {
    loginSession: { userId: 'original' }, bearer: 'valid-pat', request: { headers: { cookie: 'login=original-token' } },
    identity: { cookieName: 'login', resolveSession: async (token: unknown) => { tokens.push(token); return user ? { userId: user } : null } },
    auth: { taskActor: async (credential: { loginSession?: { userId: string }; bearer?: string }) => { if (credential.bearer) bearerCalls++; return credential.loginSession?.userId ?? 'original' } },
  }
  const authorize = createStreamCredentialAuthorizer(context as unknown as RouteRequestContext, 'original' as UserId, 'read')
  await authorize()
  context.request.headers.cookie = 'login=replacement-token'
  user = 'replacement'
  await assert.rejects(authorize(), { status: 401 })
  user = null
  await assert.rejects(authorize(), { status: 401 })
  assert.deepEqual(tokens, ['original-token', 'original-token', 'original-token'])
  assert.equal(bearerCalls, 0)
})

test('operator compatibility mode revalidates administrator authority using the fresh credential', async () => {
  let allowed = true, calls = 0
  const context = { bearer: 'original-pat', auth: { taskActor: async () => 'original', authenticateAdmin: async () => { calls++; if (!allowed) throw new Error('administrator removed') } } }
  const authorize = createStreamCredentialAuthorizer(context as unknown as RouteRequestContext, 'original' as UserId, 'read', true)
  await authorize(); allowed = false
  await assert.rejects(authorize(), /administrator removed/)
  assert.equal(calls, 2)
})
