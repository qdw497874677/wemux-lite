import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient, createClusterTransport, createLocalIdentityClient, discoverHost, ApiError, classifyClientError, randomId, copyText, selectElementText } from '@wemux/web-client'

const origin = 'http://192.0.2.1:8010'
const session = { teamId: 'team', csrfToken: 'initial', username: 'user', email: null, instanceAdministrator: false }
const account = { user: { id: 'u', username: 'user', email: null }, teamId: 'team', csrfToken: 'rotated', instanceAdministrator: false }

test('both hosts are discovered; SPA HTML and incompatible contracts fail closed', async () => {
  for (const hostKind of ['cluster', 'local-worker']) {
    const result = await discoverHost(undefined, async (url, init) => {
      assert.equal(url, '/api/host'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store')
      return Response.json({ hostKind, contractVersion: 1, capabilities: [] })
    })
    assert.equal(result.hostKind, hostKind)
  }
  await assert.rejects(discoverHost(undefined, async () => new Response('<html/>')), error => classifyClientError(error) === 'contract')
  await assert.rejects(discoverHost(undefined, async () => Response.json({ hostKind: 'cluster', contractVersion: 9, capabilities: [] })), /版本/)
})

test('public cluster login, restoration, authorized projects and logout use Cookie and scoped CSRF', async () => {
  const calls = []
  const client = createClusterClient({ ...session, csrfToken: '' }, () => {}, { origin, fetcher: async (url, init) => {
    calls.push({ url: new URL(url), init })
    if (url.pathname === '/api/projects') return Response.json({ items: [{ id: 'visible-project' }] })
    if (url.pathname === '/api/auth/logout') return new Response(null, { status: 204 })
    return Response.json(account)
  } })
  await client.login('user', 'password')
  await client.currentAccount()
  assert.deepEqual(await client.projects(), [{ id: 'visible-project' }])
  await client.logout()
  assert.ok(calls.every(({ url, init }) => url.origin === origin && init.credentials === 'same-origin' && init.redirect === 'error' && !('Authorization' in init.headers)))
  assert.equal(calls[2].url.searchParams.get('teamId'), 'team')
  assert.equal(calls[3].init.headers['X-CSRF-Token'], 'rotated')
  assert.ok(!('X-CSRF-Token' in calls[1].init.headers))
})

test('403 writes refresh CSRF once; GET forbidden is not retried or treated as signed out', async () => {
  let writes = 0; let refreshes = 0; let invalidated = 0
  const client = createClusterTransport(session, () => invalidated++, { origin, fetcher: async (url, init) => {
    if (url.pathname === '/api/auth/me') { refreshes++; return Response.json(account) }
    if (init.method === 'GET') return Response.json({ message: 'forbidden' }, { status: 403 })
    writes++
    if (writes === 1) return new Response(null, { status: 403 })
    assert.equal(init.headers['X-CSRF-Token'], 'rotated')
    return Response.json({ accepted: true })
  } })
  assert.deepEqual(await client.request('/api/projects', {}), { accepted: true })
  await assert.rejects(client.request('/api/projects'), error => error.status === 403 && classifyClientError(error) === 'forbidden')
  assert.equal(refreshes, 1); assert.equal(invalidated, 0)
})

test('401 invalidates once and cancels concurrent and future requests', async () => {
  let invalidated = 0; let requests = 0; let pendingSignal
  const client = createClusterTransport(session, () => invalidated++, { origin, fetcher: async (url, init) => {
    requests++
    if (url.pathname === '/api/pending') { pendingSignal = init.signal; return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) }
    return new Response(null, { status: 401 })
  } })
  const pending = assert.rejects(client.request('/api/pending'), error => classifyClientError(error) === 'cancelled')
  await assert.rejects(client.request('/api/projects'), error => error.status === 401)
  await pending
  assert.equal(pendingSignal.aborted, true)
  await assert.rejects(client.request('/api/projects'), error => classifyClientError(error) === 'cancelled')
  assert.equal(invalidated, 1); assert.equal(requests, 2)
})

test('401 during CSRF refresh invalidates instead of hiding expiration behind 403', async () => {
  let invalidated = 0
  const client = createClusterTransport(session, () => invalidated++, { origin, fetcher: async url => new Response(null, { status: url.pathname === '/api/auth/me' ? 401 : 403 }) })
  await assert.rejects(client.request('/api/projects', {}), error => error.status === 401)
  assert.equal(invalidated, 1)
})

test('dispose and caller abort remain cancellations, including late JSON completion', async () => {
  let release
  const client = createClusterTransport(session, () => {}, { origin, fetcher: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: () => new Promise(resolve => { release = resolve }) }) })
  const result = assert.rejects(client.request('/api/projects'), error => classifyClientError(error) === 'cancelled')
  await new Promise(resolve => setImmediate(resolve))
  client.dispose(); release({ items: ['stale'] }); await result
  const controller = new AbortController(); controller.abort()
  const other = createClusterTransport(session, () => {}, { origin, fetcher: async (url, init) => { init.signal.throwIfAborted() } })
  await assert.rejects(other.request('/api/projects', undefined, controller.signal), error => classifyClientError(error) === 'cancelled')
})

test('cluster transport rejects off-origin and local credential destinations before fetch', async () => {
  let calls = 0
  const client = createClusterTransport(session, () => {}, { origin, fetcher: async () => { calls++; return Response.json({}) } })
  for (const path of ['https://other.example/api/projects', '//other.example/api/projects', '/api/local/status', '/api/x/../local/status', '/api/%6cocal/status']) {
    await assert.rejects(client.request(path, {}), error => classifyClientError(error) === 'contract')
  }
  assert.equal(calls, 0)
})

test('local identity uses only Worker cookie and CSRF, not cluster account credentials', async () => {
  const calls = []
  const client = createLocalIdentityClient(async (url, init) => {
    calls.push({ url, init })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({ csrf: 'local-only', capabilities: [], installation: { name: 'Worker', installationId: 'one' }, cluster: { enrolled: false, connection: null } })
  })
  await client.login('local-user', 'password'); await client.logout()
  assert.ok(calls.every(({ url, init }) => url.startsWith('/api/local/') && init.credentials === 'same-origin' && !('X-CSRF-Token' in init.headers)))
  assert.equal(calls.at(-1).init.headers['x-wemux-csrf'], 'local-only')
})

test('error classification distinguishes missing, forbidden, network, API, contract and render failures', () => {
  for (const [error, kind] of [[new ApiError('missing', 404), 'not-found'], [new ApiError('denied', 403), 'forbidden'], [new ApiError('expired', 401), 'unauthorized'], [new ApiError('server', 500), 'server'], [new ApiError('offline', undefined, 'network'), 'network'], [new ApiError('invalid', undefined, 'contract'), 'contract'], [new Error('render'), 'unexpected']]) assert.equal(classifyClientError(error), kind)
})

test('HTTP IDs and clipboard failure fall back honestly to manual selection', async t => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const oldWindow = globalThis.window; const oldDocument = globalThis.document
  t.after(() => { Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); globalThis.window = oldWindow; globalThis.document = oldDocument })
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: crypto.getRandomValues.bind(crypto) } })
  const ids = Array.from({ length: 100 }, randomId)
  assert.equal(new Set(ids).size, 100)
  assert.ok(ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)))
  globalThis.window = { isSecureContext: false }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })
  assert.equal(await copyText('text'), false)
  globalThis.navigator.clipboard = { writeText: async () => { throw new Error('denied') } }
  globalThis.window.isSecureContext = true
  assert.equal(await copyText('text'), false)
  globalThis.navigator.clipboard.writeText = async () => {}
  assert.equal(await copyText('text'), true)
  const element = {}; let selected; let added; let cleared = false
  const range = { selectNodeContents: value => { selected = value } }
  globalThis.document = { createRange: () => range, getSelection: () => ({ removeAllRanges: () => { cleared = true }, addRange: value => { added = value } }) }
  selectElementText(element); assert.equal(selected, element); assert.equal(added, range); assert.equal(cleared, true)
})

test('public identity projection preserves cluster role without exposing a login token', async () => {
  const { anonymousSession, isSignedIn, toAccountSession } = await import('@wemux/web-client')
  assert.equal(isSignedIn(anonymousSession()), false)
  const projected = toAccountSession({ ...account, teamId: null, csrfToken: undefined })
  assert.deepEqual(projected, { teamId: '', csrfToken: '', username: 'user', email: null, instanceAdministrator: false })
  assert.equal(isSignedIn(projected), true)
})

test('persistent forbidden writes retry only once without signing out', async () => {
  let writes = 0; let invalidated = 0
  const client = createClusterTransport(session, () => invalidated++, { origin, fetcher: async url => {
    if (url.pathname === '/api/auth/me') return Response.json(account)
    writes++
    return Response.json({ message: 'permission denied' }, { status: 403 })
  } })
  await assert.rejects(client.request('/api/projects', {}), error => error.status === 403 && error.message.includes('permission denied'))
  assert.equal(writes, 2); assert.equal(invalidated, 0)
})

test('network and malformed list failures never become successful empty projects', async () => {
  const unavailable = createClusterClient(session, () => {}, { origin, fetcher: async () => { throw new TypeError('offline') } })
  await assert.rejects(unavailable.projects(), error => classifyClientError(error) === 'network')
  for (const response of [Response.json({ projects: [] }), new Response('not-json', { headers: { 'content-type': 'application/json' } })]) {
    const malformed = createClusterClient(session, () => {}, { origin, fetcher: async () => response })
    await assert.rejects(malformed.projects(), error => classifyClientError(error) === 'contract')
  }
})
