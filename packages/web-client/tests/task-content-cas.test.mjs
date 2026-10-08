import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient, ApiError } from '@wemux/web-client'
test('versioned content preserves version, dirty-only multiline/null body and public conflict code without retry', async () => {
  const calls = []
  const api = createClusterClient({ teamId: 't', username: 'fixture', csrfToken: 'csrf', email: null, instanceAdministrator: false }, () => {}, { origin: 'http://private.test', fetcher: async (url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ error: { code: 'version_conflict', message: 'Task changed', details: { currentVersion: 9 } } }, { status: 409 }) } })
  await assert.rejects(api.patchTask('p', 'task', { description: 'line one\nline two\n', acceptanceCriteria: null, version: 8 }), error => error instanceof ApiError && error.status === 409 && error.code === 'version_conflict')
  assert.deepEqual(calls, [{ description: 'line one\nline two\n', acceptanceCriteria: null, version: 8 }])
  api.dispose()
})
