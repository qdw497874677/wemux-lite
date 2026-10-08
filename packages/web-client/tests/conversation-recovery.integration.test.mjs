// Node HTTP/SSE response fixture through the real public client, not browser/Runtime acceptance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createClusterClient, createConversationController, appendConversationEvents, projectConversationEvents, ConversationProjectionError } from '@wemux/web-client'

const scope = { accountId: 'owner', teamId: 'team', projectId: 'p', taskId: 't', sessionId: 's' }
const account = { username: 'owner', teamId: 'team', csrfToken: 'fixture', email: null, instanceAdministrator: false }
const freshness = seq => ({ sessionId: 's', contiguousSeq: seq, workerLastSeq: seq, status: 'synced' })
const event = (seq, text = String(seq)) => ({ sessionId: 's', seq, occurredAt: '2026-06-01T00:00:00.000Z', payload: { kind: 'assistant.text.delta', turnId: 'turn', text } })
const view = seq => ({ id: 's', projectId: 'p', taskId: 't', runId: null, ownerId: 'owner', workspaceId: 'w', title: '会话', shareScope: 'project', binding: { workspaceId: 'w', agent: { workerId: 'worker', agentKey: 'test' }, modelId: 'model' }, runtimeState: 'idle', deletedAt: null, access: { canRead: true, canWrite: false, canControl: false, projectRole: 'viewer' }, activeTurnId: null, activeTurnOwnerId: null, queuedMessages: [], freshness: freshness(seq), sendCapability: { allowed: false, reasonCode: 'runtime_unavailable', reason: '不可用' } })
function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
async function until(predicate, label) {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`)
    await delay(1)
  }
}
function fixture(t, { events = [event(1)], options } = {}) {
  const calls = [], streams = [], encoder = new TextEncoder()
  const f = { events, historyOverride: null, streamOverride: null, calls, streams }
  const client = createClusterClient(account, () => assert.fail('403 must not invalidate the account'), {
    origin: 'http://recovery.test',
    async fetcher(url, init) {
      calls.push({ url, init })
      assert.equal(url.origin, 'http://recovery.test')
      assert.equal(url.searchParams.get('teamId'), 'team')
      assert.equal(init.method, 'GET')
      assert.equal(init.credentials, 'same-origin')
      assert.equal(init.redirect, 'error')
      assert.equal(init.cache, 'no-store')
      if (url.pathname === '/api/sessions/s/stream') {
        if (f.streamOverride) return f.streamOverride(url, init)
        const stream = { cancelled: false, signal: init.signal }
        const body = new ReadableStream({ start(controller) { stream.controller = controller }, cancel() { stream.cancelled = true } })
        stream.send = (text = 'id: 900000\nevent: session.event\ndata: not-journal-json\n\n') => stream.controller.enqueue(encoder.encode(text))
        streams.push(stream)
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.pathname === '/api/sessions/s') return Response.json(view(f.events.at(-1)?.seq ?? 0))
      assert.equal(url.pathname, '/api/sessions/s/events')
      if (f.historyOverride) return f.historyOverride(url, init)
      const fromSeq = Number(url.searchParams.get('fromSeq')), limit = Number(url.searchParams.get('limit'))
      const selected = f.events.filter(e => e.seq >= fromSeq).slice(0, limit)
      const last = selected.at(-1)?.seq ?? fromSeq - 1, frontier = f.events.at(-1)?.seq ?? 0
      return Response.json({ events: selected, nextSeq: selected.length === limit && last < frontier ? last + 1 : null, freshness: freshness(frontier) })
    },
  })
  const controller = createConversationController(scope, client, options)
  t.after(() => { controller.dispose(); client.dispose() })
  return Object.assign(f, { client, controller,
    histories: () => calls.filter(c => c.url.pathname.endsWith('/events')),
    watches: () => calls.filter(c => c.url.pathname.endsWith('/stream')),
  })
}
const readyAt = (f, seq) => f.controller.getSnapshot().status === 'ready' && f.controller.getSnapshot().projection.lastAppliedSeq === seq && !f.controller.getSnapshot().needsRefresh

test('public client/controller/projector load paginated HTTP history, catch missed events and ignore SSE replay identities', async t => {
  const f = fixture(t, { events: [event(1, '你'), event(2, '好')], options: { pageSize: 1 } })
  await until(() => readyAt(f, 2), 'initial history')
  assert.deepEqual(f.calls.slice(0, 2).map(c => c.url.pathname), ['/api/sessions/s/stream', '/api/sessions/s'])
  assert.deepEqual(f.histories().map(c => c.url.searchParams.get('fromSeq')), ['1', '2'])
  assert.equal(f.controller.getSnapshot().projection.textSegments[0].text, '你好')
  assert.equal(f.controller.getSnapshot().session.runtimeState, 'idle')
  assert.equal(f.controller.getSnapshot().freshness.contiguousSeq, 2)

  // These events have no individual SSE notifications. One invalidation catches both via HTTP.
  f.events.push(event(3, '，'), event(4, '世界'))
  f.streams[0].send()
  await until(() => readyAt(f, 4), 'missed events recovered')
  const applied = f.controller.getSnapshot().projection
  assert.equal(applied.textSegments[0].text, '你好，世界')
  assert.deepEqual(applied.timeline.map(e => e.seq), [1, 2, 3, 4])
  assert.deepEqual(f.histories().map(c => c.url.searchParams.get('fromSeq')), ['1', '2', '3', '4'])

  // Replay is only invalidation at the SSE boundary, never direct transcript application.
  const before = f.histories().length
  f.streams[0].send('id: 1\nevent: session.event\ndata: {"kind":"assistant.text.delta","text":"DUPLICATE"}\n\n')
  await until(() => f.histories().length > before && readyAt(f, 4), 'replayed notification refresh')
  assert.equal(f.histories().at(-1).url.searchParams.get('fromSeq'), '5')
  assert.equal(f.controller.getSnapshot().projection, applied)
  // The separately exported pure API also preserves identity on an actual Journal replay.
  assert.equal(appendConversationEvents(applied, f.events), applied)
  assert.deepEqual(projectConversationEvents('s', f.events), applied)
  assert.throws(() => appendConversationEvents(applied, [event(1, 'conflict')]), ConversationProjectionError)

  // Real watch reconnect uses the controller's validated cursor, not the forged/replayed SSE IDs.
  f.streams[0].controller.close()
  await until(() => f.streams.length === 2, 'bounded transport reconnect')
  assert.deepEqual(f.watches().map(c => c.url.searchParams.get('fromSeq')), ['1', '5'])
  f.streams[1].send('id: 900001\nevent: freshness\ndata: {}\n\n')
  await until(() => f.histories().length === before + 2 && readyAt(f, 4), 'reconnect replay')
  assert.equal(f.controller.getSnapshot().projection.textSegments[0].text, '你好，世界')
  assert.equal(f.controller.getSnapshot().projection.timeline.length, 4)
})

test('held old HTTP response cannot restore disposed scope or notify its listeners', async t => {
  const f = fixture(t)
  await until(() => readyAt(f, 1), 'initial history')
  const held = deferred()
  let heldSignal, notifications = 0
  f.controller.subscribe(() => { notifications++ })
  f.events.push(event(2, 'old-scope-secret'))
  f.historyOverride = (_url, init) => { heldSignal = init.signal; return held.promise }
  f.streams[0].send()
  await until(() => !!heldSignal, 'held HTTP request')
  f.controller.dispose()
  const stable = notifications, disposed = f.controller.getSnapshot()
  assert.equal(heldSignal.aborted, true)
  held.resolve(Response.json({ events: [event(2, 'old-scope-secret')], nextSeq: null, freshness: freshness(2) }))
  await delay(20)
  assert.equal(f.controller.getSnapshot(), disposed)
  assert.equal(disposed.status, 'disposed')
  assert.equal(disposed.session, null)
  assert.equal(disposed.freshness, null)
  assert.deepEqual(disposed.projection.timeline, [])
  assert.equal(notifications, stable)
  assert.equal(f.streams[0].cancelled, true)
  assert.equal(f.streams[0].signal.aborted, true)
  assert.equal(f.histories().length, 2)
})

test('terminal stream 403 after loaded history blocks, scrubs data and never retries', async t => {
  const f = fixture(t)
  await until(() => readyAt(f, 1), 'initial history')
  const denied = deferred()
  f.streamOverride = () => denied.promise
  f.streams[0].controller.close()
  await until(() => f.watches().length === 2, 'reconnect headers held')
  denied.resolve(Response.json({ error: { code: 'private-code', message: 'private-body' } }, { status: 403 }))
  await until(() => f.controller.getSnapshot().status === 'blocked', '403 terminal block')
  const snapshot = f.controller.getSnapshot(), count = f.calls.length
  assert.deepEqual(snapshot.error, { source: 'subscription', code: 'permission-denied' })
  assert.equal(snapshot.subscription, 'disposed')
  assert.equal(snapshot.session, null)
  assert.equal(snapshot.freshness, null)
  assert.deepEqual(snapshot.projection.timeline, [])
  assert.ok(!JSON.stringify(snapshot).includes('private-'))
  f.controller.retry(); f.controller.refresh()
  // Longer than the existing 1000ms watch retry delay: no hidden retry or account/CSRF read.
  await delay(1100)
  assert.equal(f.calls.length, count)
})

test('known malformed Journal payload passes envelopes but fails projection atomically and recovers at the same HTTP cursor', async t => {
  const f = fixture(t)
  await until(() => readyAt(f, 1), 'initial history')
  const previous = f.controller.getSnapshot().projection
  f.events.push(event(2, 'valid-but-not-committed'), { ...event(3), payload: { kind: 'tool.started' } })
  f.streams[0].send()
  await until(() => f.controller.getSnapshot().status === 'error', 'malformed variant error')
  const failed = f.controller.getSnapshot(), count = f.histories().length
  assert.deepEqual(failed.error, { source: 'history', code: 'invalid-event' })
  assert.equal(failed.projection, previous)
  assert.equal(failed.freshness.contiguousSeq, 1)
  assert.equal(failed.needsRefresh, true)
  assert.equal(failed.subscription, 'watching')
  await delay(20)
  assert.equal(f.histories().length, count)
  f.events[2] = event(3, ' recovered')
  f.controller.refresh()
  await until(() => readyAt(f, 3), 'explicit recovery')
  assert.deepEqual(f.histories().map(c => c.url.searchParams.get('fromSeq')), ['1', '2', '2'])
  assert.equal(f.controller.getSnapshot().projection.textSegments[0].text, '1valid-but-not-committed recovered')
  assert.equal(f.controller.getSnapshot().error, null)
})
