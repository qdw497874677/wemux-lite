import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient } from '@wemux/web-client'
test('task-local create and retry retain scope, explicit identity, assignment CAS and placement Worker', async () => {
  const calls = []
  const api = createClusterClient({ teamId: 'team', username: 'test', csrfToken: 'csrf', email: null, instanceAdministrator: false }, () => {}, { origin: 'http://private.test', fetcher: async (url, init) => { calls.push({ url: new URL(url), body: JSON.parse(init.body) }); return Response.json({}) } })
  const body = { name: 'Workspace', workerId: 'w', source: 'empty', requestId: 'same-intent', assignment: { agentKey: 'test', modelId: 'test' }, version: 7 }
  await api.createTaskWorkspace('p', 't', body); await api.createTaskWorkspace('p', 't', body)
  assert.equal(calls[0].url.pathname, '/api/projects/p/tasks/t/workspaces')
  assert.equal(calls[0].url.searchParams.get('teamId'), 'team')
  assert.deepEqual(calls[0].body, body); assert.deepEqual(calls[1].body, body)
  await api.retryTaskWorkspace('p', 't', 'workspace', 'second-worker', 'retry-intent')
  assert.equal(calls[2].url.pathname, '/api/projects/p/tasks/t/workspaces/workspace/retry')
  assert.deepEqual(calls[2].body, { workerId: 'second-worker', requestId: 'retry-intent' })
  api.dispose()
})
