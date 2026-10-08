import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient } from '@wemux/web-client'
test('Workspace logical deletion uses opaque state confirmation and stable request identity, never Task version', async () => {
  const calls = []
  const api = createClusterClient({ teamId: 'team', username: 'fixture', csrfToken: 'csrf', email: null, instanceAdministrator: false }, () => {}, { origin: 'http://private.test', fetcher: async (url, init) => { calls.push({ url: new URL(url), method: init.method, body: init.body ? JSON.parse(init.body) : null }); return Response.json({ workspaceId: 'w', deletedAt: '2026-10-02T00:00:00Z' }) } })
  await api.deleteWorkspace('w', 'a'.repeat(64), 'retained'); await api.deleteWorkspace('w', 'a'.repeat(64), 'retained')
  assert.deepEqual(calls[0].body, { expectedRevision: 'a'.repeat(64), requestId: 'retained' }); assert.deepEqual(calls[0].body, calls[1].body)
  assert.equal(calls[0].method, 'DELETE'); assert.equal(calls[0].url.pathname, '/api/workspaces/w'); assert.equal(calls[0].url.searchParams.get('teamId'), 'team')
  await api.workspace('w'); assert.equal(calls.at(-1).method, 'GET')
  api.dispose()
})
