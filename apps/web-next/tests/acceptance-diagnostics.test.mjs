import test from 'node:test'
import assert from 'node:assert/strict'
import { expectedAcceptanceAbort as classify } from './acceptance-diagnostics.mjs'
const event = { method: 'GET', path: '/api/sessions/s1/events', status: 200, contentType: 'application/json', aborted: true, startEpoch: 2 }
const navigation = { confirmed: true, requestWasPending: true, method: 'reload', fromEpoch: 2, toEpoch: 3 }
test('same-epoch JSON events and unknown-status events cancellation stay unexpected', () => {
  assert.equal(classify(event), false)
  assert.equal(classify({ ...event, status: undefined }), false)
  assert.equal(classify({ ...event, currentEpoch: 3 }), false)
  assert.equal(classify({ ...event, status: undefined, navigation }), false)
})
test('only evidenced navigation of a pending known read with a response is expected', () => {
  assert.equal(classify({ ...event, navigation }), true)
  assert.equal(classify({ ...event, path: '/api/projects/p/events', contentType: 'text/event-stream', navigation }), true)
  for (const patch of [{ method: 'POST' }, { path: '/unknown/events' }, { contentType: 'text/html' }, { navigation: { ...navigation, requestWasPending: false } }, { navigation: { ...navigation, confirmed: false } }, { navigation: { ...navigation, toEpoch: 4 } }]) assert.equal(classify({ ...event, navigation, ...patch }), false)
})
test('exact Session SSE stream cancellation requires complete navigation evidence', () => {
  const stream = { ...event, path: '/api/sessions/s1/stream', contentType: 'text/event-stream; charset=utf-8', navigation }
  assert.equal(classify(stream), true)
  for (const patch of [
    { navigation: { ...navigation, toEpoch: 2 } },
    { navigation: { ...navigation, confirmed: false } },
    { navigation: { ...navigation, requestWasPending: false } },
    { status: undefined },
    { status: 401 },
    { method: 'POST' },
    { contentType: 'application/json' },
    { path: '/unknown/stream' },
    { path: '/api/sessions/s1/extra/stream' },
  ]) assert.equal(classify({ ...stream, ...patch }), false)
})
test('identity retirement requires exact account request and proven identity lifecycle', () => {
  const identity = { confirmed: true, reason: 'revoked-current-login' }
  assert.equal(classify({ ...event, path: '/api/auth/me', status: 401, identity }), true)
  assert.equal(classify({ ...event, path: '/api/auth/me', status: 401 }), false)
  assert.equal(classify({ ...event, status: 401, identity }), false)
})
test('favicon cancellation is not excused by a 200 response, ERR_ABORTED or same-epoch navigation', () => {
  const favicon = { ...event, path: '/favicon.svg', contentType: 'image/svg+xml', navigation }
  assert.equal(classify(favicon), false)
  assert.equal(classify({ ...favicon, status: undefined }), false)
  assert.equal(classify({ ...favicon, status: 404 }), false)
  assert.equal(classify({ ...favicon, aborted: false }), false)
  assert.equal(classify({ ...favicon, navigation: { ...navigation, fromEpoch: 1, toEpoch: 2, requestWasPending: false } }), false)
})

test('client signal abort and a nearby SPA or identity transition alone never excuse private reads', () => {
  for (const path of ['/api/projects/p/activity', '/api/projects/p/tasks/t', '/api/workspaces', '/api/sessions/s1/events', '/api/sessions/s1/stream']) {
    for (const status of [undefined, 200, 401]) assert.equal(classify({ ...event, path, status,
      clientSignalAborted: true, spaRouteChanged: true,
      identity: { confirmed: true, reason: 'revoked-current-login' },
    }), false)
  }
})
