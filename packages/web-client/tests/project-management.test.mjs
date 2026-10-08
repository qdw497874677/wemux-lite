import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient } from '@wemux/web-client'

test('project operations preserve explicit creation identity and authoritative scope/CAS contracts', async () => {
  const calls = []
  const client = createClusterClient({ teamId: 'team-scope', username: 'synthetic', csrfToken: 'csrf', email: null, instanceAdministrator: false }, () => {}, { origin: 'http://private.test', fetcher: async (url, init) => { calls.push({ url: new URL(url), ...init, body: init.body ? JSON.parse(init.body) : undefined }); return Response.json({ items: [] }) } })
  await client.createTask('project/a', { title: 'Task', requestId: 'retained-intent' })
  await client.createTask('project/a', { title: 'Task', requestId: 'retained-intent' })
  assert.deepEqual(calls[0].body, calls[1].body)
  assert.equal(calls[0].url.pathname, '/api/projects/project%2Fa/tasks')
  assert.equal(calls[0].url.searchParams.get('teamId'), 'team-scope')
  assert.equal(calls[0].headers['X-CSRF-Token'], 'csrf')
  await client.patchTask('p', 't', { status: 'todo', version: 7 })
  assert.deepEqual(calls.at(-1).body, { status: 'todo', version: 7 })
  await client.assignTask('p', 't', null, 8)
  assert.equal(calls.at(-1).method, 'DELETE')
  assert.deepEqual(calls.at(-1).body, { version: 8 })
  await client.unbindTaskWorkspace('p', 't', 'w', 9)
  assert.deepEqual(calls.at(-1).body, { version: 9 })
  await client.workspaces('p')
  assert.equal(calls.at(-1).url.pathname, '/api/workspaces')
  assert.equal(calls.at(-1).url.searchParams.get('projectId'), 'p')
  client.dispose()
  await assert.rejects(client.tasks('p'))
  assert.equal(calls.length, 6)
})

test('human review attention uses only bounded pages, encoded cursor/scope and abort signal', async () => {
  const calls = []
  const client = createClusterClient({ teamId: 'team', username: 'synthetic', csrfToken: 'csrf', email: null, instanceAdministrator: false }, () => {}, { origin: 'http://private.test', fetcher: async (url, init) => { calls.push({ url: new URL(url), ...init }); return Response.json({ items: [], nextCursor: null, generatedAt: '2026-04-03T00:00:00Z' }) } })
  const controller = new AbortController()
  const page = await client.attentionPages({ kind: 'approval', projectId: 'project/a', limit: 1, cursor: 'opaque+cursor' }, controller.signal)
  assert.deepEqual(page.items, [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.pathname, '/api/attention/pages')
  assert.equal(calls[0].url.searchParams.get('kind'), 'approval')
  assert.equal(calls[0].url.searchParams.get('projectId'), 'project/a')
  assert.equal(calls[0].url.searchParams.get('cursor'), 'opaque+cursor')
  assert.equal(calls[0].url.searchParams.get('limit'), '1')
  assert.equal(calls[0].signal.aborted, false)
  controller.abort()
  assert.equal(calls[0].signal.aborted, true)
  client.dispose()
})
