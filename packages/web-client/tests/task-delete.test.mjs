import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient } from '@wemux/web-client'
test('Task deletion sends atomic version and retained requestId with scoped DELETE', async () => {
  const calls = []
  const client = createClusterClient({ username: 'test', teamId: 'team', csrfToken: 'csrf', email: null, instanceAdministrator: false }, () => {}, { origin: 'http://private.test', fetcher: async (url, init) => { calls.push({ url: new URL(url), method: init.method, body: JSON.parse(init.body) }); return Response.json({ taskId: 't', version: 5, deletedAt: '2026-10-02T00:00:00Z' }) } })
  await client.deleteTask('p', 't', 4, 'same-intent'); await client.deleteTask('p', 't', 4, 'same-intent')
  assert.equal(calls[0].method, 'DELETE'); assert.equal(calls[0].url.pathname, '/api/projects/p/tasks/t')
  assert.equal(calls[0].url.searchParams.get('teamId'), 'team')
  assert.deepEqual(calls[0].body, { version: 4, requestId: 'same-intent' }); assert.deepEqual(calls[0].body, calls[1].body)
  client.dispose()
})
