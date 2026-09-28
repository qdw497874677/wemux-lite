import assert from 'node:assert/strict'
import test from 'node:test'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, administratorToken, seedLocalAccount, seedOperator } from './fixtures/administrator.ts'

async function call(base: string, path: string, init: { readonly method?: string; readonly body?: unknown; readonly csrf?: string } = {}) {
  const response = await fetch(`${base}/api${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${administratorToken}`, 'content-type': 'application/json', ...(init.csrf ? { 'x-csrf-token': init.csrf } : {}) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
  return { status: response.status, data: await response.json() as Record<string, unknown> }
}

test('projection routes return cursor pages, validate pagination, and protect decisions with CSRF', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  await seedOperator(app.store, app.service)
  const base = await app.listen(0)
  t.after(() => app.close())

  const approvals = await call(base, '/approvals?limit=1')
  assert.equal(approvals.status, 200)
  assert.deepEqual(Object.keys(approvals.data).sort(), ['items', 'nextCursor'])
  assert.ok(Array.isArray(approvals.data.items))
  const timeline = await call(base, '/timeline?limit=1')
  assert.equal(timeline.status, 200)
  assert.deepEqual(Object.keys(timeline.data).sort(), ['items', 'nextCursor'])
  assert.equal((await call(base, '/approvals?limit=0')).status, 400)
  assert.equal((await call(base, '/timeline?cursor=not-a-cursor')).status, 400)

  await seedLocalAccount(app.store, { username: 'cookie-user', email: 'cookie@example.com', password: 'correct horse battery staple' })
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ login: 'cookie-user', password: 'correct horse battery staple' }) })
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('wemux_login_session='))?.split(';')[0]
  assert.ok(cookie)
  const response = await fetch(`${base}/api/approvals/missing/decisions`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', requestId: 'route-csrf', sourceRevision: '1' }) })
  assert.equal(response.status, 403)
})
