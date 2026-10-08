import assert from 'node:assert/strict'
import test from 'node:test'
import type { RouteRequestContext } from '../http/routes/types.ts'
import { attentionRoutes } from '../http/routes/attention-routes.ts'

const route = attentionRoutes.find(item => item.pattern === '/attention/pages')!

test('attention pages route is additive and forwards authenticated read actor/admin state, not client flags', async () => {
  assert.equal(route.method, 'GET')
  assert.equal(route.auth, 'task')
  assert.ok(attentionRoutes.some(item => item.pattern === '/attention' && item.method === 'GET'))
  const calls: unknown[] = []
  const result = { items: [], nextCursor: null, generatedAt: '2026-04-04T00:00:00.000Z' }
  await route.handler({
    url: new URL('http://localhost/api/attention/pages?kind=run_problem&projectId=project&cursor=opaque&limit=12&actorId=forged&isAdministrator=true'),
    actor: async (access: string) => { assert.equal(access, 'read'); return 'authenticated-user' },
    auth: { isAdministrator: async (actor: string) => { assert.equal(actor, 'authenticated-user'); return false } },
    attention: { pages: async (...args: unknown[]) => { calls.push(args); return result }, query: () => { throw new Error('legacy route invoked') } },
    json: (status: number, data: unknown) => { assert.equal(status, 200); assert.equal(data, result) },
  } as unknown as RouteRequestContext)
  assert.deepEqual(calls, [['authenticated-user', false, { kind: 'run_problem', projectId: 'project', cursor: 'opaque', limit: 12 }]])
})
