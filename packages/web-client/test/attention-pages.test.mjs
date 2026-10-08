import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterTransport } from '../src/cluster-transport.ts'
import { projectManagementOperations } from '../src/project-management.ts'

function fixture(fetcher) {
  const transport = createClusterTransport({ teamId: 'team-scope', username: 'reader', csrfToken: '', email: null, instanceAdministrator: false }, () => {}, { origin: 'http://private.test', fetcher })
  return { api: projectManagementOperations(transport), transport }
}

test('attention pages use bounded GETs, encode opaque cursors/project scope, and retain the legacy method', async () => {
  const calls = [], page = { items: [], nextCursor: 'opaque/+=&?', generatedAt: '2026-06-01T00:00:00Z' }
  const { api, transport } = fixture(async (url, init) => { calls.push({ url: new URL(url), init }); return Response.json(page) })
  try {
    assert.deepEqual(await api.attentionPages({ kind: 'run_problem' }), page)
    assert.equal(calls[0].url.pathname, '/api/attention/pages')
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { kind: 'run_problem', limit: '50', teamId: 'team-scope' })
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[0].init.body, undefined)
    await api.attentionPages({ kind: 'channel_dead_letter', projectId: 'p/=&?', cursor: page.nextCursor, limit: 100 })
    assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), { kind: 'channel_dead_letter', limit: '100', projectId: 'p/=&?', cursor: page.nextCursor, teamId: 'team-scope' })
    await api.attention()
    assert.equal(calls[2].url.pathname, '/api/attention')
    assert.equal(calls.length, 3)
  } finally { transport.dispose() }
})

test('attention pages preserve permission failures without falling back to global attention', async () => {
  const calls = []
  const { api, transport } = fixture(async url => { calls.push(new URL(url).pathname); return Response.json({ error: { message: 'forbidden' } }, { status: 403 }) })
  try {
    await assert.rejects(api.attentionPages({ kind: 'channel_dead_letter' }), error => error.status === 403)
    assert.deepEqual(calls, ['/api/attention/pages'])
  } finally { transport.dispose() }
})

test('attention pages forward caller cancellation and reject stale successful responses', async () => {
  let release, signal
  const { api, transport } = fixture(async (_url, init) => { signal = init.signal; return new Promise(resolve => { release = resolve }) })
  try {
    const controller = new AbortController()
    const pending = api.attentionPages({ kind: 'run_problem' }, controller.signal)
    controller.abort()
    assert.equal(signal.aborted, true)
    release(Response.json({ items: [], nextCursor: null, generatedAt: 'now' }))
    await assert.rejects(pending, error => error.name === 'AbortError')
  } finally { transport.dispose() }
})
