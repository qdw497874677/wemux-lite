import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { acceptanceRequestKind, installFetchLifecycle, observeFetchLifecycle } from './acceptance-fetch-lifecycle.mjs'

function fixture(fetch) {
  const records = [], listeners = new Map(), location = { origin: 'https://fixture.invalid', href: 'https://fixture.invalid/start', pathname: '/start' }
  const window = { fetch, __acceptanceFetchLifecycle: async record => records.push(record), addEventListener: (name, fn) => listeners.set(name, fn) }
  const history = Object.fromEntries(['pushState', 'replaceState'].map(name => [name, (_state, _unused, path) => { location.pathname = path }]))
  const context = vm.createContext({ window, history, location, URL, Request, performance: { timeOrigin: 1234, now: () => records.length } })
  vm.runInContext(`(${installFetchLifecycle.toString()})()`, context)
  return { window, records, history, listeners }
}

test('fetch observer preserves response/body and observes explicit SSE signal abort after headers', async () => {
  const response = new Response('data: fixture\n\n', { headers: { 'content-type': 'text/event-stream' } })
  const controller = new AbortController()
  const f = fixture(async (_input, init) => { assert.equal(init.signal, controller.signal); return response })
  const actual = await f.window.fetch('/api/projects/private-id/events?private-query', { signal: controller.signal })
  assert.equal(actual, response)
  assert.equal(response.bodyUsed, false)
  controller.abort()
  assert.equal(f.records.find(record => record.event === 'fetch-response').stream, true)
  assert.equal(f.records.find(record => record.event === 'signal-abort').requestId, 1)
  assert.doesNotMatch(JSON.stringify(f.records), /private-query/)
})

test('fetch rejection preserves the original error and timeout is not relabeled AbortError', async () => {
  const error = Object.assign(Error('PRIVATE_MESSAGE'), { name: 'TimeoutError' })
  const controller = new AbortController()
  const f = fixture(async () => { throw error })
  await assert.rejects(f.window.fetch('/api/projects', { signal: controller.signal, body: 'PRIVATE_BODY', headers: { Cookie: 'PRIVATE_COOKIE' }, method: 'POST' }), cause => cause === error)
  controller.abort(error)
  assert.equal(f.records.find(record => record.event === 'fetch-rejected').reason, 'TimeoutError')
  assert.equal(f.records.find(record => record.event === 'signal-abort').reason, 'TimeoutError')
  assert.doesNotMatch(JSON.stringify(f.records), /PRIVATE_/)
})

test('document and SPA lifecycle use local sequence without retaining route paths', () => {
  const f = fixture(async () => new Response())
  f.history.pushState({}, '', '/private-route')
  f.history.replaceState({}, '', '/private-route')
  f.listeners.get('popstate')()
  f.listeners.get('pagehide')()
  assert.deepEqual(f.records.map(record => record.event), ['document-start', 'spa-route', 'spa-route', 'pagehide'])
  assert.deepEqual(f.records.map(record => record.routeRevision), [0, 1, 2, 2])
  assert.doesNotMatch(JSON.stringify(f.records), /private-route/)
})

test('binding persists only closed request kinds and page-local document IDs, not private paths', async () => {
  let binding, installed
  const records = []
  await observeFetchLifecycle({ exposeBinding: async (_name, fn) => { binding = fn }, addInitScript: async fn => { installed = fn } }, record => records.push(record))
  assert.equal(installed, installFetchLifecycle)
  for (const [document, path] of [[1000, '/api/projects/PRIVATE_ID/activity'], [1000, '/private/PRIVATE_ID'], [2000, '/api/sessions/PRIVATE_ID/stream']]) {
    binding({}, { document, path, requestId: 1, event: 'fetch-start' })
  }
  assert.deepEqual(records.map(record => record.documentId), [1, 1, 2])
  assert.deepEqual(records.map(record => record.requestKind), ['project-activity', 'other', 'session-stream'])
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|1000|2000|path/)
  assert.equal(acceptanceRequestKind('/api/projects/p/extra/activity'), 'other')
})
