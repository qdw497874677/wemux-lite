import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient } from '@wemux/web-client'

const inventory = {
  generatedAt: '2026-05-01T00:00:00.000Z',
  workers: [], agents: [], models: [], skills: [], presets: [], providers: [],
}

test('resource inventory is a single administrator read with credentials, scope and abort signal', async () => {
  const calls = []
  const client = createClusterClient(
    { teamId: 'team-scope', username: 'administrator', csrfToken: 'csrf', email: null, instanceAdministrator: true },
    () => {},
    { origin: 'http://private.test', fetcher: async (url, init) => { calls.push({ url: new URL(url), ...init }); return Response.json(inventory) } },
  )
  const controller = new AbortController()
  const result = await client.resourceInventory(controller.signal)
  assert.deepEqual(result, inventory)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url.pathname, '/api/resource-inventory')
  assert.equal(calls[0].url.search, '?teamId=team-scope')
  assert.equal(calls[0].url.searchParams.get('teamId'), 'team-scope')
  assert.equal(calls[0].signal.aborted, false)
  controller.abort()
  assert.equal(calls[0].signal.aborted, true)
  client.dispose()
})

test('the management surface exposes no write path of its own', async () => {
  const calls = []
  const client = createClusterClient(
    { teamId: 'team', username: 'administrator', csrfToken: 'csrf', email: null, instanceAdministrator: true },
    () => {},
    { origin: 'http://private.test', fetcher: async (url, init) => { calls.push({ url: new URL(url).pathname, ...init }); return Response.json(inventory) } },
  )
  await client.resourceInventory()
  client.dispose()
  assert.deepEqual(calls.map(call => [call.method ?? 'GET', call.url]), [['GET', '/api/resource-inventory']])
})
