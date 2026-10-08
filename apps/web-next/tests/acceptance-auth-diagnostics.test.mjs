import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { observeAcceptanceAuthDiagnostics } from './acceptance-auth-diagnostics.mjs'

const base = 'https://acceptance.invalid'
const anonymous = Object.freeze({ confirmed: true, reason: 'anonymous' })
const authenticated = Object.freeze({ confirmed: false, reason: 'authenticated' })
const revoking = Object.freeze({ confirmed: false, reason: 'revoking-current-login' })
const revoked = Object.freeze({ confirmed: true, reason: 'revoked-current-login' })
function fixture(identity = revoked, step = 'revoked') {
  const page = new EventEmitter(), diagnostics = [], correlatedRequests = []
  let current = identity
  const observer = observeAcceptanceAuthDiagnostics(page, { base, getIdentity: () => current, getStep: () => step, report: (item, request) => { diagnostics.push(item); correlatedRequests.push(request) } })
  const request = (path = '/api/auth/me', method = 'GET', origin = base) => {
    const value = { url: () => origin + path, method: () => method }
    page.emit('request', value)
    return value
  }
  const response = (value, status = 401) => page.emit('response', { request: () => value, status: () => status })
  const consoleError = (url, text = 'Failed to load resource: the server responded with a status of 401 (Unauthorized)') => page.emit('console', { type: () => 'error', location: () => ({ url }), text: () => text, args: () => [] })
  return { page, diagnostics, correlatedRequests, observer, request, response, consoleError, setIdentity: value => { current = value } }
}

for (const [name, identity, url, text] of [
  ['before revocation confirmation', revoking, base + '/api/auth/me'],
  ['foreign origin', revoked, 'https://foreign.invalid/api/auth/me'],
  ['non-allowlisted private read', revoked, base + '/api/workers'],
  ['401 only in message body', revoked, base + '/api/auth/me', 'Application error: 401 records could not be rendered'],
  ['anonymous login stage is not response identity', anonymous, base + '/api/projects'],
]) test(`console error stays unexpected: ${name}`, () => {
  const f = fixture(identity, identity === anonymous ? 'old-login' : 'revoked')
  f.consoleError(url, text)
  assert.deepEqual(f.diagnostics, [{ type: 'console', expected: false }])
})

test('even an exact URL with a real allowed 401 does not correlate a ConsoleMessage to that response', () => {
  const f = fixture()
  f.response(f.request())
  f.consoleError(base + '/api/auth/me')
  assert.equal(f.diagnostics.find(item => item.type === 'console')?.expected, false)
})

test('normally completed private HTTP401 is diagnosed without console or requestfailed', () => {
  for (const path of ['/api/workers', '/api/workspaces', '/api/projects/p/activity', '/api/sessions/s/events', '/api/auth/sessions']) {
    const f = fixture()
    const request = f.request(path)
    f.response(request)
    f.page.emit('requestfinished', request)
    assert.equal(f.diagnostics.length, 1, path)
    assert.deepEqual(f.diagnostics[0], { type: 'http401', expected: false, status: 401, method: 'GET', requestKind: 'other' })
  }
})

test('only real same-origin exact account GET401 in an unchanged confirmed lifecycle is expected', () => {
  for (const identity of [anonymous, revoked]) for (const path of ['/api/auth/me', '/api/projects']) {
    const f = fixture(identity)
    const request = f.request(path)
    f.response(request)
    f.page.emit('requestfinished', request)
    assert.equal(f.diagnostics.length, 1)
    assert.equal(f.diagnostics[0].expected, true)
    assert.equal(f.observer.identityFor(request).reason, identity.reason)
  }
})

test('foreign, non-GET, inexact endpoint and non-401 responses cannot use the account exception', () => {
  for (const [path, method, origin] of [
    ['/api/auth/me', 'GET', 'https://foreign.invalid'],
    ['/api/projects', 'POST', base],
    ['/api/projects/p', 'GET', base],
    ['/api/auth/me/extra', 'GET', base],
  ]) {
    const f = fixture()
    f.response(f.request(path, method, origin))
    assert.equal(f.diagnostics.length, 1)
    assert.equal(f.diagnostics[0].expected, false)
  }
  for (const status of [200, 500]) {
    const f = fixture()
    f.response(f.request(), status)
    f.consoleError(base + '/api/auth/me')
    assert.deepEqual(f.diagnostics, [{ type: 'console', expected: false }])
  }
})

test('unconfirmed identity and requests crossing login/revocation boundaries stay unexpected', () => {
  for (const [before, after] of [[revoking, revoking], [revoking, revoked], [authenticated, revoked], [anonymous, authenticated], [anonymous, revoked], [authenticated, authenticated]]) {
    const f = fixture(before)
    const request = f.request()
    f.setIdentity(after)
    f.response(request)
    assert.equal(f.diagnostics.length, 1)
    assert.equal(f.diagnostics[0].expected, false)
    assert.notEqual(f.observer.identityFor(request)?.confirmed, true)
  }
})

test('request object identity, not a matching URL or later lifecycle, binds the response', () => {
  const f = fixture(authenticated)
  const original = f.request()
  f.setIdentity(revoked)
  const later = f.request()
  f.response(original)
  f.response(later)
  const unobserved = { url: original.url, method: original.method }
  f.response(unobserved)
  assert.deepEqual(f.correlatedRequests, [original, later, unobserved])
  assert.deepEqual(f.diagnostics.map(item => item.expected), [false, true, false])
  assert.notEqual(f.observer.identityFor(original)?.confirmed, true)
})

test('diagnostics do not retain URL, console body, query, headers or request handles', () => {
  const f = fixture()
  f.response(f.request('/api/projects/private-value?token=private-value'))
  f.consoleError(base + '/api/projects?token=private-value', 'private-value 401')
  assert.equal(f.diagnostics.length, 2)
  assert.equal(JSON.stringify(f.diagnostics).includes('private-value'), false)
})
