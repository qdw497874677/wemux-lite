import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient, createClusterTransport, ApiError } from '@wemux/web-client'

const origin = 'http://conversation.test'
const account = { username: 'owner', teamId: 'team', csrfToken: 'csrf', email: null, instanceAdministrator: false }
const stamp = '2026-06-01T00:00:00.000Z'
const fresh = (seq = 0) => ({ sessionId: 's', contiguousSeq: seq, workerLastSeq: seq, status: 'synced' })
const event = seq => ({ sessionId: 's', seq, occurredAt: stamp, payload: { kind: 'assistant.text.delta', turnId: 'turn', text: '你好' } })
const page = () => ({ events: [event(1), event(2)], nextSeq: null, freshness: fresh(2) })
const view = () => ({ id: 's', projectId: 'p', taskId: 't', runId: null, ownerId: 'owner', workspaceId: 'w', title: '会话', shareScope: 'project', binding: { workspaceId: 'w', agent: { workerId: 'worker', agentKey: 'test' }, modelId: 'model' }, runtimeState: 'idle', deletedAt: null, access: { canRead: true, canWrite: true, canControl: false, projectRole: 'contributor' }, activeTurnId: null, activeTurnOwnerId: null, queuedMessages: [], freshness: fresh(), sendCapability: { allowed: true, reasonCode: 'allowed', reason: '' } })
const receipt = () => ({ commandId: 'c/x', workerId: 'worker', payloadFingerprint: 'fp', status: 'accepted', createdAt: stamp, updatedAt: stamp })
const client = (fetcher, unauthorized = () => {}) => createClusterClient(account, unauthorized, { origin, fetcher })
const contractError = e => e instanceof ApiError && e.kind === 'contract'
const encoder = new TextEncoder()
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function stream(parts, { close = true, onCancel = () => {} } = {}) {
  let controller
  const body = new ReadableStream({ start(c) { controller = c; for (const p of parts) c.enqueue(typeof p === 'string' ? encoder.encode(p) : p); if (close) c.close() }, cancel: onCancel })
  return { body, controller, response: new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }) }
}
const watchOptions = extra => ({ fromSeq: () => 1, onInvalidate: () => {}, maxReconnects: 0, reconnectDelayMs: 10, ...extra })

test('conversation HTTP operations preserve routes, team policy, exact caller-owned wire fields and receipts', async () => {
  const calls = [], sent = { commandId: 'c', messageId: 'm', content: '  原文\n你好  ' }
  const api = client(async (url, init) => {
    calls.push({ url, init })
    if (url.pathname.endsWith('/messages')) return Response.json({ commandId: 'c', messageId: 'm', status: 'pending' }, { status: 202 })
    if (url.pathname.endsWith('/events')) return Response.json(page())
    if (url.pathname.startsWith('/api/commands')) return Response.json(receipt())
    return Response.json(view())
  })
  assert.deepEqual(await api.getSession('s'), view())
  assert.deepEqual(await api.sessionHistory('s'), page())
  assert.deepEqual(await api.sendMessage('s/x', { ...sent, requestId: 'must-not-send' }), { commandId: 'c', messageId: 'm', status: 'pending' })
  assert.deepEqual(await api.commandReceipt('c/x'), receipt())
  assert.deepEqual(calls.map(c => c.url.pathname), ['/api/sessions/s', '/api/sessions/s/events', '/api/sessions/s%2Fx/messages', '/api/commands/c%2Fx'])
  assert.equal(calls[1].url.searchParams.get('fromSeq'), '1'); assert.equal(calls[1].url.searchParams.get('limit'), '500')
  assert.deepEqual(JSON.parse(calls[2].init.body), sent)
  assert.equal(calls[2].init.headers['X-CSRF-Token'], 'csrf')
  for (const { url, init } of calls) {
    assert.equal(url.origin, origin); assert.equal(url.searchParams.get('teamId'), 'team')
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
    assert.ok(!('Authorization' in init.headers))
  }
})

test('Session and command observation reject wrong identities and malformed views', async () => {
  for (const change of [v => { v.id = 'other' }, v => { v.freshness.sessionId = 'other' }, v => { v.binding.workspaceId = 'other' }, v => { v.access.canRead = 'yes' }, v => { v.queuedMessages = [{}] }, v => { v.sendCapability.allowed = 'yes' }, v => { v.activeTurnId = 4 }, v => { v.freshness.contiguousSeq = -1 }]) {
    const v = view(); change(v)
    await assert.rejects(client(async () => Response.json(v)).getSession('s'), contractError)
  }
  for (const v of [{}, { ...receipt(), commandId: 'other' }, { ...receipt(), status: 'queued' }, { ...receipt(), updatedAt: 'bad' }]) await assert.rejects(client(async () => Response.json(v)).commandReceipt('c/x'), contractError)
  const legacy = { ...view(), taskId: null }; assert.deepEqual(await client(async () => Response.json(legacy)).getSession('s'), legacy)
})

test('history validates contiguous envelopes, cache frontier, inclusive cursors and page bounds, without pretending to project payloads', async () => {
  for (const change of [
    p => { p.events[0].sessionId = 'other' }, p => { p.events[1].seq = 3 }, p => { p.events[1].seq = 1 },
    p => { p.nextSeq = 1 }, p => { p.nextSeq = 4 }, p => { p.nextSeq = 3 }, p => { delete p.nextSeq },
    p => { p.freshness.sessionId = 'other' }, p => { p.freshness.contiguousSeq = 1 },
    p => { p.events[0].occurredAt = 'bad' }, p => { p.events[0].payload = null }, p => { p.events[0].payload.kind = 5 },
    p => { p.events = []; p.nextSeq = 2 }, p => { p.freshness.workerLastSeq = -1 },
  ]) {
    const p = page(); change(p)
    await assert.rejects(client(async () => Response.json(p)).sessionHistory('s', 1, 2), contractError)
  }
  let calls = 0
  const api = client(async () => { calls++; return Response.json(page()) })
  for (const args of [[0, 10], [1.5, 10], [Number.MAX_SAFE_INTEGER, 1], [1, 0], [1, 1001]]) await assert.rejects(api.sessionHistory('s', ...args), contractError)
  assert.equal(calls, 0)
  const first = { events: [event(2)], nextSeq: 3, freshness: { ...fresh(3), status: 'offline', workerLastSeq: null } }
  assert.deepEqual(await client(async () => Response.json(first)).sessionHistory('s', 2, 1), first)
  const empty = { events: [], nextSeq: null, freshness: fresh(2) }
  assert.deepEqual(await client(async () => Response.json(empty)).sessionHistory('s', 3), empty)
  const newerFreshness = { ...page(), freshness: fresh(3) }
  assert.deepEqual(await client(async () => Response.json(newerFreshness)).sessionHistory('s'), newerFreshness)
  const future = page(); future.events[0].payload = { kind: 'future.uninterpreted', raw: { foo: 'bar' } }
  assert.deepEqual(await client(async () => Response.json(future)).sessionHistory('s'), future)
})

test('send identity is never generated, receipt mismatches fail closed and uncertain POST is not retried', async () => {
  const body = { commandId: 'c', messageId: 'm', content: 'hello' }
  for (const v of [{}, { ...body, status: 'pending', commandId: 'other' }, { ...body, status: 'pending', messageId: 'other' }, { ...body, status: 'queued' }, { ...body, status: ['accepted'] }]) await assert.rejects(client(async () => Response.json(v)).sendMessage('s', body), contractError)
  let count = 0
  const api = client(async () => { count++; throw Error('response lost after admission') })
  for (const bad of [{ content: 'hello' }, { ...body, content: '' }, { ...body, content: 'a\0b' }]) await assert.rejects(api.sendMessage('s', bad), contractError)
  assert.equal(count, 0)
  await assert.rejects(api.sendMessage('s', body), e => e.kind === 'network')
  assert.equal(count, 1); assert.deepEqual(body, { commandId: 'c', messageId: 'm', content: 'hello' })
})

test('CSRF retry uses a frozen exact send body even when caller mutates it during refresh', async () => {
  const body = { commandId: 'c', messageId: 'm', content: 'first' }, calls = []; let writes = 0
  const api = client(async (url, init) => {
    if (url.pathname === '/api/auth/me') { body.commandId = 'changed'; body.content = 'changed'; return Response.json({ csrfToken: 'rotated' }) }
    writes++; calls.push(init.body)
    if (writes === 1) return Response.json({ message: 'csrf' }, { status: 403 })
    assert.equal(init.headers['X-CSRF-Token'], 'rotated')
    return Response.json({ commandId: 'c', messageId: 'm', status: 'accepted' })
  })
  await api.sendMessage('s', body)
  assert.equal(writes, 2); assert.equal(calls[0], calls[1]); assert.deepEqual(JSON.parse(calls[1]), { commandId: 'c', messageId: 'm', content: 'first' })
})

test('HTTP status/reason survives send, history, command permission errors and no forbidden GET refresh occurs', async () => {
  for (const [status, call] of [[409, a => a.sendMessage('s', { commandId: 'c', messageId: 'm', content: 'hi' })], [403, a => a.commandReceipt('c')], [404, a => a.sessionHistory('s')]]) {
    let calls = 0, invalidated = 0
    const api = client(async () => { calls++; return Response.json({ error: { code: 'reason_code', message: 'specific reason' } }, { status }) }, () => invalidated++)
    await assert.rejects(call(api), e => e.status === status && e.code === 'reason_code' && e.message.includes('specific reason'))
    assert.equal(calls, 1); assert.equal(invalidated, 0)
  }
})

test('stream uses transport origin/API allowlist and snapshots team identity', async () => {
  const mutable = { ...account }, calls = []
  const transport = createClusterTransport(mutable, () => {}, { origin, fetcher: async (url, init) => { calls.push({ url, init }); return stream([]).response } })
  mutable.teamId = 'different'
  for (const path of ['https://other.test/api/sessions/s/stream', '/api/local/sessions/s/stream', '/not-api', '/api/%6cocal/sessions']) await assert.rejects(transport.stream(path, () => {}), contractError)
  assert.equal(calls.length, 0)
  await transport.stream('/api/sessions/s/stream?teamId=untrusted', () => {})
  assert.equal(calls[0].url.searchParams.get('teamId'), 'team')
  assert.equal(calls[0].init.headers.Accept, 'text/event-stream')
  assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.cache, 'no-store')
  assert.ok(!('X-CSRF-Token' in calls[0].init.headers))
})

test('SSE bytewise UTF-8/CRLF splits, multiline data and comments produce invalidations only', async () => {
  const bytes = encoder.encode(': heartbeat\r\nid: 99999999999999999999\r\nevent: session.event\r\ndata: 你好\r\ndata: not JSON\r\n\r\nevent: freshness\ndata: {}\n\nevent: ignored\ndata: x\n\nevent: session.event\ndata: incomplete')
  let count = 0
  const s = stream([...bytes].map(b => Uint8Array.of(b)))
  const watch = client(async () => s.response).watchSession('s', watchOptions({ onInvalidate: (...args) => { assert.deepEqual(args, []); count++ } }))
  await assert.rejects(watch.done, e => e.kind === 'network')
  assert.equal(count, 2); assert.equal(s.body.locked, false)
})

test('watch reconnects only within budget using caller history position, never SSE IDs', async () => {
  let cursor = 1, count = 0
  const positions = []
  const api = client(async url => {
    positions.push(url.searchParams.get('fromSeq')); assert.equal(url.searchParams.get('teamId'), 'team')
    if (positions.length === 1) return stream(['id: 999999\nevent: session.event\ndata: {}\n\n']).response
    if (positions.length === 2) { cursor = 3; throw Error('disconnected') }
    return stream([]).response
  })
  const watch = api.watchSession('s', watchOptions({ fromSeq: () => cursor, maxReconnects: 2, onInvalidate: () => count++ }))
  await assert.rejects(watch.done, e => e.kind === 'network')
  assert.deepEqual(positions, ['1', '1', '3']); assert.equal(count, 1)
  const invalid = api.watchSession('s', watchOptions({ fromSeq: () => 0 }))
  await assert.rejects(invalid.done, contractError); assert.equal(positions.length, 3)
})

test('stream permission/contract failures are terminal; 401 invalidates concurrent scope exactly once', async () => {
  for (const status of [401, 403, 404, 500]) {
    let calls = 0, invalidated = 0
    const api = client(async () => { calls++; return Response.json({ error: { code: 'denied', message: 'no permission' } }, { status }) }, () => invalidated++)
    const watch = api.watchSession('s', watchOptions({ maxReconnects: 3 }))
    await assert.rejects(watch.done, e => e.status === status && (status === 401 || e.code === 'denied'))
    assert.equal(calls, 1); assert.equal(invalidated, status === 401 ? 1 : 0)
    if (status === 401) await assert.rejects(api.getSession('s'), e => e.name === 'AbortError')
  }
  let cancelled = 0, count = 0
  const s = stream([], { close: false, onCancel: () => cancelled++ })
  const api = client(async url => url.pathname.endsWith('/stream') ? s.response : new Response(null, { status: 401 }))
  const watch = api.watchSession('s', watchOptions({ onInvalidate: () => count++ }))
  await tick(); await assert.rejects(api.getSession('s'), e => e.status === 401); await watch.done
  assert.equal(cancelled, 1); assert.equal(count, 0); assert.equal(s.body.locked, false)
})

test('oversized frame, malformed UTF-8 and wrong content type fail closed and release readers', async () => {
  for (const parts of [['data: ' + 'x'.repeat(1024 * 1024)], ['data: x\n' + ':ignored\n'.repeat(140000)], [Uint8Array.of(0xff)]]) {
    let cancelled = 0
    const s = stream(parts, { close: false, onCancel: () => cancelled++ })
    const watch = client(async () => s.response).watchSession('s', watchOptions({ maxReconnects: 3, onInvalidate: () => assert.fail('no complete event') }))
    await assert.rejects(watch.done, contractError)
    assert.equal(cancelled, 1); assert.equal(s.body.locked, false)
  }
  await assert.rejects(client(async () => Response.json({})).watchSession('s', watchOptions()).done, contractError)
})

test('abort/dispose cancels pending reads, suppresses same-chunk callbacks and stops reconnect timer', async () => {
  for (const mode of ['watch', 'scope', 'signal']) {
    let cancelled = 0, count = 0
    const abort = new AbortController(), s = stream([], { close: false, onCancel: () => cancelled++ })
    const api = client(async () => s.response)
    const watch = api.watchSession('s', watchOptions({ signal: abort.signal, onInvalidate: () => count++ }))
    await tick()
    if (mode === 'watch') watch.dispose(); else if (mode === 'scope') api.dispose(); else abort.abort()
    await watch.done; assert.equal(cancelled, 1); assert.equal(count, 0); assert.equal(s.body.locked, false)
  }
  let watch, count = 0
  watch = client(async () => stream(['event: session.event\ndata: x\n\nevent: session.event\ndata: y\n\n']).response).watchSession('s', watchOptions({ onInvalidate: () => { count++; watch.dispose() } }))
  await watch.done; assert.equal(count, 1)
  let calls = 0
  const retry = client(async () => { calls++; return stream([]).response }).watchSession('s', watchOptions({ maxReconnects: 3, reconnectDelayMs: 100 }))
  await tick(); retry.dispose(); await retry.done; assert.equal(calls, 1)
})

test('late stream and JSON responses from a disposed identity never escape into the new identity', async () => {
  let releaseStream, releaseJSON, count = 0, cancelled = 0
  const old = client(async url => new Promise(resolve => { if (url.pathname.endsWith('/stream')) releaseStream = resolve; else releaseJSON = resolve }))
  const watch = old.watchSession('s', watchOptions({ onInvalidate: () => count++ }))
  const read = old.getSession('s'); const rejected = assert.rejects(read, e => e.name === 'AbortError')
  old.dispose()
  const s = stream(['event: session.event\ndata: late\n\n'], { close: false, onCancel: () => cancelled++ })
  releaseStream(s.response); releaseJSON(Response.json(view()))
  await watch.done; await rejected; assert.equal(count, 0); assert.equal(cancelled, 1)
  assert.deepEqual(await client(async () => Response.json(view())).getSession('s'), view())
})


test('body-read failure reconnects; preaborted scope never fetches and explicit same-identity retry is caller-owned', async () => {
  let calls = 0, invalidations = 0
  const api = client(async () => {
    calls++
    if (calls === 1) return new Response(new ReadableStream({ start(c) { c.error(Error('read lost')) } }), { headers: { 'content-type': 'text/event-stream' } })
    return stream([': heartbeat\n\n']).response
  })
  await assert.rejects(api.watchSession('s', watchOptions({ maxReconnects: 1, onInvalidate: () => invalidations++ })).done, e => e.kind === 'network')
  assert.equal(calls, 2); assert.equal(invalidations, 0)
  const abort = new AbortController(); abort.abort()
  await api.watchSession('s', watchOptions({ signal: abort.signal })).done
  assert.equal(calls, 2)
  const bodies = [], body = { commandId: 'same-c', messageId: 'same-m', content: 'same text' }
  const sender = client(async (_url, init) => { bodies.push(init.body); if (bodies.length === 1) throw Error('lost'); return Response.json({ ...body, status: 'accepted' }) })
  await assert.rejects(sender.sendMessage('s', body), e => e.kind === 'network')
  await sender.sendMessage('s', body)
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1])
})

for (const omitted of [['taskId', 'runId'], ['taskId'], ['runId']]) {
  test(`review P1: getSession normalizes omitted ${omitted.join('/')} without changing present provenance`, async () => {
    const value = { ...view(), runId: 'run' }
    for (const key of omitted) delete value[key]
    const actual = await client(async () => Response.json(value)).getSession('s')
    assert.deepEqual(actual, { ...value, taskId: value.taskId ?? null, runId: value.runId ?? null })
    for (const key of omitted) assert.ok(Object.hasOwn(actual, key))
  })
}

test('review P1: getSession preserves valid nullable provenance and rejects malformed values independently', async () => {
  for (const taskId of ['task', null]) for (const runId of ['run', null]) {
    const value = { ...view(), taskId, runId }
    assert.deepEqual(await client(async () => Response.json(value)).getSession('s'), value)
  }
  for (const key of ['taskId', 'runId']) for (const bad of ['', ' ', 0, false, [], {}, ['id']]) {
    const value = { ...view(), [key]: bad }
    await assert.rejects(client(async () => Response.json(value)).getSession('s'), contractError)
  }
})

// Flush promise continuations without advancing the controlled timeout clock.
const flushPromises = () => new Promise(resolve => setImmediate(resolve))
function stalledError(status = 403) {
  let controller, cancelled = 0
  const body = new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode('{"error":')) }, cancel() { cancelled++ } })
  return { body, controller, get cancelled() { return cancelled }, response: new Response(body, { status, headers: { 'content-type': 'application/json' } }) }
}

test('review P2: received stream 403 survives stalled error-detail timeout, never retries and cleans reader', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0, outcome
  const bodies = []
  const api = client(async (_url, init) => {
    requests++
    const stalled = stalledError(); bodies.push(stalled)
    // Emulate native fetch: body read rejects when its connection signal aborts.
    init.signal.addEventListener('abort', () => { if (!stalled.cancelled) stalled.controller.error(init.signal.reason) }, { once: true })
    return stalled.response
  })
  const watch = api.watchSession('s', watchOptions({ maxReconnects: 3 }))
  const settled = watch.done.then(() => { outcome = 'resolved' }, e => { outcome = e })
  await flushPromises()
  t.mock.timers.tick(15000); await flushPromises()
  try {
    assert.equal(outcome?.status, 403)
    assert.equal(outcome.kind, 'forbidden')
    t.mock.timers.tick(60000); await flushPromises()
    assert.equal(requests, 1)
    assert.equal(bodies[0].body.locked, false)
    assert.equal(bodies[0].cancelled, 1)
  } finally {
    watch.dispose(); await settled
  }
})

test('review P2: optional HTTP error details are bounded even when injected fetch ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const operation of ['stream', 'json']) {
    const stalled = stalledError(503)
    let requests = 0, outcome
    const transport = createClusterTransport(account, () => {}, { origin, fetcher: async () => { requests++; return stalled.response } })
    const pending = operation === 'stream' ? transport.stream('/api/sessions/s/stream', () => {}) : transport.request('/api/sessions/s')
    const settled = pending.then(() => { outcome = 'resolved' }, e => { outcome = e })
    await flushPromises(); t.mock.timers.tick(15000); await flushPromises()
    try {
      assert.equal(outcome?.status, 503)
      assert.equal(requests, 1); assert.equal(stalled.cancelled, 1); assert.equal(stalled.body.locked, false)
    } finally {
      transport.dispose()
      if (!outcome) stalled.controller.close()
      await settled
    }
  }
})

for (const mode of ['caller', 'account']) {
  test(`review P2: ${mode} cancellation wins during stalled HTTP error details and cleans reader`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const stalled = stalledError(), abort = new AbortController()
    let outcome, requests = 0
    const transport = createClusterTransport(account, () => {}, { origin, fetcher: async () => { requests++; return stalled.response } })
    const settled = transport.stream('/api/sessions/s/stream', () => assert.fail('error is not an event'), abort.signal).then(() => { outcome = 'resolved' }, e => { outcome = e })
    await flushPromises()
    if (mode === 'caller') abort.abort(); else transport.dispose()
    await flushPromises()
    try {
      assert.equal(outcome?.name, 'AbortError')
      assert.equal(stalled.cancelled, 1); assert.equal(stalled.body.locked, false)
      t.mock.timers.tick(60000); await flushPromises(); assert.equal(requests, 1)
    } finally {
      if (!outcome) stalled.controller.close()
      await settled
    }
  })
}

test('review P2: failed, malformed and oversized optional details preserve received HTTP status', async () => {
  for (const mode of ['failed', 'malformed', 'oversized']) {
    let cancelled = 0
    const body = new ReadableStream({ start(c) {
      if (mode === 'failed') c.error(Error('lost error body'))
      else { c.enqueue(encoder.encode(mode === 'oversized' ? 'x'.repeat(65537) : '{')); if (mode === 'malformed') c.close() }
    }, cancel() { cancelled++ } })
    const transport = createClusterTransport(account, () => {}, { origin, fetcher: async () => new Response(body, { status: 403 }) })
    await assert.rejects(transport.stream('/api/sessions/s/stream', () => assert.fail('not an event')), e => e.status === 403 && e.kind === 'forbidden')
    assert.equal(body.locked, false)
    if (mode === 'oversized') assert.equal(cancelled, 1)
  }
})

test('review P2: slow cancellation cleanup cannot hide 403 and late rejection is handled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let rejectCleanup, cancelled = 0, outcome
  const body = new ReadableStream({ cancel() { cancelled++; return new Promise((_, reject) => { rejectCleanup = reject }) } })
  const transport = createClusterTransport(account, () => {}, { origin, fetcher: async () => new Response(body, { status: 403 }) })
  const settled = transport.stream('/api/sessions/s/stream', () => {}).then(() => { outcome = 'resolved' }, e => { outcome = e })
  await flushPromises(); t.mock.timers.tick(15000); await flushPromises()
  assert.equal(outcome?.status, 403); assert.equal(body.locked, false); assert.equal(cancelled, 1)
  await settled
  rejectCleanup(Error('late underlying cleanup failure'))
  await flushPromises() // node:test also fails on an unhandled rejection after the test.
})
