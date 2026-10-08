import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationController } from '../src/conversation-controller.ts'
import { ApiError } from '../src/errors.ts'

const scope = (extra = {}) => ({ accountId: 'account', teamId: 'team', projectId: 'project', taskId: 'task', sessionId: 's', ...extra })
const freshness = (seq = 0, id = 's', status = 'synced') => ({ sessionId: id, contiguousSeq: seq, workerLastSeq: seq, status })
const session = (seq = 0, id = 's', extra = {}) => ({ id, projectId: 'project', taskId: 'task', ownerId: 'account', runId: null, workspaceId: 'w', title: '会话', shareScope: 'project', binding: { workspaceId: 'w', agent: { workerId: 'worker', agentKey: 'test' }, modelId: 'model' }, runtimeState: 'idle', deletedAt: null, access: { canRead: true, canWrite: false, canControl: false, projectRole: 'viewer' }, activeTurnId: null, activeTurnOwnerId: null, queuedMessages: [], freshness: freshness(seq, id), sendCapability: { allowed: false, reasonCode: 'runtime_unavailable', reason: '不可用' }, ...extra })
const event = (seq, id = 's', payload = { kind: 'assistant.text.delta', turnId: 'turn', text: String(seq) }) => ({ sessionId: id, seq, occurredAt: '2026-06-01T00:00:00.000Z', payload })
const page = (events = [], seq = events.at(-1)?.seq ?? 0, nextSeq = null, id = 's') => ({ events, freshness: freshness(seq, id), nextSeq })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
// Each turn is explicitly driven by a deferred port response or by draining the microtask queue.
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve() }
function fixture(t, { identity = scope(), options, watchError } = {}) {
  const reads = [], histories = [], watches = [], order = []
  const port = {
    getSession(id, signal) { const d = deferred(); reads.push({ id, signal, ...d }); order.push('session'); return d.promise },
    sessionHistory(id, fromSeq, limit, signal) { const d = deferred(); histories.push({ id, fromSeq, limit, signal, ...d }); order.push('history'); return d.promise },
    watchSession(id, options) { const d = deferred(); const w = { id, options, ...d, disposals: 0 }; watches.push(w); order.push('watch'); if (watchError) d.reject(watchError); return { done: d.promise, dispose() { w.disposals++; d.resolve() } } },
  }
  const controller = createConversationController(identity, port, options)
  t.after(() => controller.dispose())
  return { controller, reads, histories, watches, order, port }
}
async function load(f, metadata = session(), history = page()) {
  await settle()
  f.reads.at(-1).resolve(metadata)
  await settle()
  f.histories.at(-1).resolve(history)
  await settle()
}

test('initial load subscribes before metadata/history, applies serial pages and reconnect uses HTTP cursor only', async t => {
  const f = fixture(t, { options: { pageSize: 2 } }), c = f.controller
  assert.equal(c.getSnapshot().status, 'loading')
  assert.equal(c.getSnapshot().subscription, 'starting')
  await settle()
  assert.deepEqual(f.order, ['watch', 'session'])
  assert.equal(f.watches[0].options.fromSeq(), 1)
  f.reads[0].resolve(session(3)); await settle()
  assert.equal(f.histories.length, 1)
  assert.equal(f.histories[0].fromSeq, 1)
  assert.equal(f.histories[0].limit, 2)
  f.histories[0].resolve(page([event(1), event(2)], 3, 3)); await settle()
  assert.equal(c.getSnapshot().projection.lastAppliedSeq, 2)
  assert.equal(f.watches[0].options.fromSeq(), 3)
  assert.equal(f.histories[1].fromSeq, 3)
  f.histories[1].resolve(page([event(3)])); await settle()
  assert.equal(c.getSnapshot().projection.textSegments[0].text, '123')
  assert.equal(c.getSnapshot().status, 'ready')
  assert.equal(c.getSnapshot().needsRefresh, false)
  // Even an injected SSE-like argument is an invalidation, never a history cursor.
  f.watches[0].options.onInvalidate({ id: '9000' }); await settle()
  f.reads[1].resolve(session(3)); await settle()
  assert.equal(f.histories[2].fromSeq, 4)
  f.histories[2].resolve(page([], 3)); await settle()
  assert.equal(f.watches[0].options.fromSeq(), 4)
})

test('coalesces bursts and preserves invalidations during both metadata and history reads', async t => {
  const f = fixture(t)
  await settle()
  for (let i = 0; i < 20; i++) f.watches[0].options.onInvalidate()
  assert.equal(f.reads.length, 1)
  f.reads[0].resolve(session()); await settle()
  f.watches[0].options.onInvalidate()
  f.histories[0].resolve(page()); await settle()
  assert.equal(f.reads.length, 2)
  await load(f)
  assert.equal(f.reads.length, 2)
  assert.equal(f.histories.length, 2)
  assert.equal(f.controller.getSnapshot().needsRefresh, false)
})

test('bounded pagination preserves pending catch-up and explicit refresh resumes from applied cursor', async t => {
  const f = fixture(t, { options: { pageSize: 1, maxPagesPerRefresh: 2 } })
  await load(f, session(3), page([event(1)], 3, 2))
  f.histories[1].resolve(page([event(2)], 3, 3)); await settle()
  assert.equal(f.histories.length, 2)
  assert.equal(f.controller.getSnapshot().needsRefresh, true)
  f.controller.refresh(); await settle()
  f.reads[1].resolve(session(3)); await settle()
  assert.equal(f.histories[2].fromSeq, 3)
  f.histories[2].resolve(page([event(3)])); await settle()
  assert.equal(f.controller.getSnapshot().needsRefresh, false)
})

test('separate history/freshness race never spins on an exhausted page and later invalidation catches up', async t => {
  const f = fixture(t)
  await load(f, session(0), page([], 1))
  assert.equal(f.controller.getSnapshot().projection.lastAppliedSeq, 0)
  assert.equal(f.controller.getSnapshot().freshness.contiguousSeq, 1)
  assert.equal(f.controller.getSnapshot().needsRefresh, true)
  await settle(); assert.equal(f.histories.length, 1)
  f.watches[0].options.onInvalidate()
  await load(f, session(1), page([event(1)]))
  assert.equal(f.controller.getSnapshot().needsRefresh, false)
})

test('invalidation also refreshes honest metadata runtime/queue without rewriting Journal facts', async t => {
  const f = fixture(t)
  await load(f, session(1, 's', { runtimeState: 'running', activeTurnId: 'turn' }), page([event(1, 's', { kind: 'session.runtime.changed', state: 'idle', reason: null })]))
  const queue = [{ commandId: 'c', messageId: 'm', content: 'queued', position: null }]
  const metadata = session(1, 's', { runtimeState: 'unavailable', queuedMessages: queue, freshness: freshness(1, 's', 'offline') })
  f.watches[0].options.onInvalidate()
  await load(f, metadata, { ...page([], 1), freshness: freshness(1, 's', 'offline') })
  const s = f.controller.getSnapshot()
  assert.equal(s.session.runtimeState, 'unavailable')
  assert.equal(s.session.queuedMessages[0].content, 'queued')
  assert.equal(s.projection.runtime.state, 'idle')
  assert.deepEqual(s.projection.queuedMessages, [])
  assert.equal(s.session.freshness.status, 'offline')
  assert.equal(s.freshness.status, 'offline')
  assert.equal(s.needsRefresh, false) // Up-to-date HTTP cursor is NOT a synced Worker claim.
  queue[0].content = 'mutated'
  assert.equal(s.session.queuedMessages[0].content, 'queued')
  assert.ok(Object.isFrozen(s.session.queuedMessages[0]))
})

test('history errors are atomic, retain prior projection and recover explicitly from validated cursor', async t => {
  for (const [name, bad, code] of [
    ['regression', page([], 0), 'history-regression'],
    ['gap', page([event(3)], 3), 'invalid-data'],
    ['wrong-session', page([event(2, 'other')], 2), 'wrong-session'],
    ['wrong-freshness', page([event(2)], 2, null, 'other'), 'invalid-data'],
    ['malformed', page([event(2), event(3, 's', { kind: 'tool.started' })], 3), 'invalid-event'],
    ['bad-next', page([event(2)], 2, 2), 'invalid-data'],
    ['network', new ApiError('private body', undefined, 'network'), 'request-failed'],
  ]) await t.test(name, async t => {
    const f = fixture(t)
    await load(f, session(1), page([event(1)]))
    const prior = f.controller.getSnapshot().projection
    f.controller.refresh(); await settle(); f.reads[1].resolve(session(2)); await settle()
    if (bad instanceof Error) f.histories[1].reject(bad); else f.histories[1].resolve(bad)
    await settle()
    assert.equal(f.controller.getSnapshot().status, 'error')
    assert.equal(f.controller.getSnapshot().error.code, code)
    assert.equal(f.controller.getSnapshot().projection, prior)
    assert.equal(f.controller.getSnapshot().freshness.contiguousSeq, 1)
    assert.equal(f.watches[0].options.fromSeq(), 2)
    assert.equal(f.reads.length, 2)
    assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes('private body'))
    f.controller.retry(); await settle(); f.reads[2].resolve(session(2)); await settle()
    assert.equal(f.histories[2].fromSeq, 2)
    f.histories[2].resolve(page([event(2)])); await settle()
    assert.equal(f.controller.getSnapshot().status, 'ready')
    assert.equal(f.watches.length, 1)
  })
})

test('previously observed page frontier cannot regress even while its events await catch-up', async t => {
  const f = fixture(t)
  await load(f, session(), page([], 2))
  f.controller.refresh()
  await load(f, session(1), page([event(1)], 1))
  assert.equal(f.controller.getSnapshot().error.code, 'history-regression')
  assert.equal(f.controller.getSnapshot().projection.lastAppliedSeq, 0)
})

test('session fixed identity, read permission, deletion and freshness are validated before history', async t => {
  for (const [extra, code, terminal] of [
    [{ id: 'other' }, 'scope-mismatch', true],
    [{ projectId: 'other' }, 'scope-mismatch', true],
    [{ taskId: 'other' }, 'scope-mismatch', true],
    [{ taskId: null }, 'scope-mismatch', true],
    [{ access: { canRead: false } }, 'permission-denied', true],
    [{ deletedAt: '2026-06-01T00:00:00Z' }, 'session-unavailable', true],
    [{ freshness: freshness(0, 'other') }, 'invalid-data', false],
    [{ freshness: { ...freshness(), contiguousSeq: -1 } }, 'invalid-data', false],
    [{ freshness: { ...freshness(), status: 'imaginary' } }, 'invalid-data', false],
  ]) await t.test(code + JSON.stringify(extra), async t => {
    const f = fixture(t)
    await settle(); f.reads[0].resolve(session(0, 's', extra)); await settle()
    assert.equal(f.histories.length, 0)
    assert.equal(f.controller.getSnapshot().error.code, code)
    assert.equal(f.controller.getSnapshot().status, terminal ? 'blocked' : 'error')
    if (terminal) {
      assert.equal(f.watches[0].disposals, 1)
      f.controller.retry(); f.controller.refresh(); await settle()
      assert.equal(f.reads.length, 1)
    }
  })
})

test('permission loss while a history response is pending scrubs retained data and prevents late disclosure', async t => {
  const f = fixture(t)
  await load(f, session(1), page([event(1)]))
  let notifications = 0
  f.controller.subscribe(() => { notifications++ })
  f.controller.refresh(); await settle(); f.reads[1].resolve(session(2)); await settle()
  f.watches[0].reject(new ApiError('no longer allowed', 403)); await settle()
  assert.equal(f.controller.getSnapshot().status, 'blocked')
  assert.equal(f.controller.getSnapshot().session, null)
  assert.equal(f.controller.getSnapshot().projection.lastAppliedSeq, 0)
  assert.equal(f.histories[1].signal.aborted, true)
  const count = notifications
  f.histories[1].resolve(page([event(2)])); f.watches[0].options.onInvalidate(); await settle()
  assert.equal(notifications, count)
  assert.equal(f.controller.getSnapshot().projection.lastAppliedSeq, 0)
})

test('HTTP authorization failures and metadata permission revocation are terminal and scrub old history', async t => {
  for (const mode of ['metadata', 'history401', 'session403']) await t.test(mode, async t => {
    const f = fixture(t)
    await load(f, session(1), page([event(1)]))
    f.controller.refresh(); await settle()
    if (mode === 'metadata') f.reads[1].resolve(session(1, 's', { access: { canRead: false } }))
    else if (mode === 'session403') f.reads[1].reject(new ApiError('forbidden', 403))
    else { f.reads[1].resolve(session(1)); await settle(); f.histories[1].reject(new ApiError('expired', 401)) }
    await settle()
    assert.equal(f.controller.getSnapshot().status, 'blocked')
    assert.equal(f.controller.getSnapshot().projection.lastAppliedSeq, 0)
    assert.equal(f.controller.getSnapshot().session, null)
    assert.equal(f.watches[0].disposals, 1)
  })
})

test('account/team/task scope replacement disposes old controller, suppresses late reads and callbacks', async t => {
  for (const pending of ['metadata', 'history']) await t.test(pending, async t => {
    const input = scope(), old = fixture(t, { identity: input })
    input.accountId = 'mutated'
    assert.equal(old.controller.getSnapshot().scope.accountId, 'account')
    await settle()
    if (pending === 'history') { old.reads[0].resolve(session()); await settle() }
    let calls = 0
    old.controller.subscribe(() => calls++)
    old.controller.dispose(); old.controller.dispose()
    const next = fixture(t, { identity: scope({ accountId: 'next', teamId: 'team2', taskId: 'task2' }) })
    await load(next, session(1, 's', { taskId: 'task2' }), page([event(1)]))
    if (pending === 'history') old.histories[0].resolve(page([event(1)]))
    else old.reads[0].resolve(session())
    old.watches[0].options.onInvalidate(); old.controller.retry(); old.controller.refresh(); await settle()
    assert.equal(calls, 0)
    assert.equal(old.watches[0].disposals, 1)
    assert.equal(old.reads[0].signal.aborted, true)
    assert.equal(old.controller.getSnapshot().status, 'disposed')
    assert.equal(old.controller.getSnapshot().session, null)
    assert.equal(old.controller.getSnapshot().projection.timeline.length, 0)
    assert.equal(next.controller.getSnapshot().projection.timeline.length, 1)
  })
})

test('independent Sessions maintain distinct cursors and lifetimes', async t => {
  const a = fixture(t), b = fixture(t, { identity: scope({ sessionId: 'b' }) })
  await load(a, session(2), page([event(1), event(2)]))
  await load(b, session(1, 'b'), page([event(1, 'b')], 1, null, 'b'))
  assert.equal(a.watches[0].options.fromSeq(), 3)
  assert.equal(b.watches[0].options.fromSeq(), 2)
  a.controller.dispose()
  b.watches[0].options.onInvalidate()
  await load(b, session(2, 'b'), page([event(2, 'b')], 2, null, 'b'))
  assert.equal(b.controller.getSnapshot().projection.lastAppliedSeq, 2)
  assert.equal(b.watches[0].disposals, 0)
})

test('watch rejection is observed immediately, does not erase valid history and only explicit retry restarts it', async t => {
  const f = fixture(t, { watchError: new ApiError('connection failed', undefined, 'network') })
  await load(f)
  assert.equal(f.controller.getSnapshot().subscription, 'error')
  assert.equal(f.controller.getSnapshot().subscriptionError.code, 'request-failed')
  assert.equal(f.controller.getSnapshot().status, 'ready')
  assert.equal(f.watches[0].disposals, 1)
  f.controller.refresh(); await load(f)
  assert.equal(f.watches.length, 1)
  f.controller.retry(); await settle()
  assert.equal(f.watches.length, 2)
  f.watches[0].options.onInvalidate(); await settle()
  assert.equal(f.reads.length, 3)
})

test('watch completion is a terminal closed state, supports manual retry and ignores obsolete callbacks', async t => {
  const f = fixture(t)
  await load(f)
  f.watches[0].resolve(); await settle()
  assert.equal(f.controller.getSnapshot().subscription, 'closed')
  assert.equal(f.watches[0].disposals, 1)
  f.watches[0].options.onInvalidate(); await settle()
  assert.equal(f.reads.length, 1)
  f.controller.retry(); await load(f)
  assert.equal(f.watches.length, 2)
  assert.equal(f.controller.getSnapshot().subscription, 'watching')
})

test('immediately rejected authorization watch prevents history and late metadata disclosure', async t => {
  const f = fixture(t, { watchError: new ApiError('expired', 401) })
  await settle()
  assert.equal(f.controller.getSnapshot().status, 'blocked')
  f.reads[0]?.resolve(session(1)); await settle()
  assert.equal(f.histories.length, 0)
  assert.equal(f.controller.getSnapshot().session, null)
})

test('invalidation during failed request is not lost, but failures without triggers never auto-retry', async t => {
  const f = fixture(t)
  await settle()
  f.watches[0].options.onInvalidate()
  f.reads[0].reject(new ApiError('network', undefined, 'network')); await settle()
  assert.equal(f.reads.length, 2)
  f.reads[1].resolve(session()); await settle()
  f.watches[0].options.onInvalidate()
  f.histories[0].reject(new ApiError('network', undefined, 'network')); await settle()
  assert.equal(f.reads.length, 3)
  f.reads[2].reject(new ApiError('network', undefined, 'network')); await settle()
  assert.equal(f.reads.length, 3)
  assert.equal(f.controller.getSnapshot().status, 'error')
})

test('continuous invalidations and failing reads are bounded by the same finite drain budget', async t => {
  const f = fixture(t, { options: { maxPagesPerRefresh: 2 } })
  await settle()
  for (let i = 0; i < 2; i++) {
    f.watches[0].options.onInvalidate()
    f.reads[i].reject(new Error('failed')); await settle()
  }
  assert.equal(f.reads.length, 2)
  assert.equal(f.controller.getSnapshot().needsRefresh, true)
  f.controller.retry(); await load(f)
  assert.equal(f.controller.getSnapshot().status, 'ready')
})

test('observer reentrancy cannot lose refresh at final publication and exceptions cannot fail reads', async t => {
  const f = fixture(t)
  let refreshOnce = true
  f.controller.subscribe(() => { throw Error('observer bug') })
  f.controller.subscribe(() => {
    if (f.controller.getSnapshot().status === 'ready' && refreshOnce) { refreshOnce = false; f.controller.refresh() }
  })
  await load(f)
  assert.equal(f.reads.length, 2)
  await load(f)
  assert.equal(f.controller.getSnapshot().status, 'ready')
  assert.equal(f.controller.getSnapshot().error, null)
})

test('dispose inside a notification prevents remaining callbacks and any network work', async () => {
  let reads = 0, callbacks = 0
  const c = createConversationController(scope(), {
    getSession() { reads++; return Promise.resolve(session()) },
    sessionHistory() { throw Error('must not run') },
    watchSession() { throw Error('must not run') },
  })
  c.subscribe(() => c.dispose())
  c.subscribe(() => callbacks++)
  await settle()
  assert.equal(reads, 0)
  assert.equal(callbacks, 0)
  assert.equal(c.getSnapshot().status, 'disposed')
})

test('synchronous watch errors are observable without unhandled promise rejection', async () => {
  const c = createConversationController(scope(), {
    getSession: async () => session(), sessionHistory: async () => page(),
    watchSession() { throw new ApiError('network', undefined, 'network') },
  })
  await settle()
  assert.equal(c.getSnapshot().subscription, 'error')
  assert.equal(c.getSnapshot().status, 'ready')
  c.dispose()
})

test('invalid immutable scope and pagination bounds fail synchronously without touching port', () => {
  for (const key of Object.keys(scope())) assert.throws(() => createConversationController(scope({ [key]: '' }), {}), TypeError)
  for (const options of [{ pageSize: 0 }, { pageSize: 1001 }, { maxPagesPerRefresh: 0 }, { maxPagesPerRefresh: 101 }]) assert.throws(() => createConversationController(scope(), {}, options), RangeError)
})

test('metadata regression retains honest last metadata and explicit retry can recover', async t => {
  const f = fixture(t)
  await load(f, session(2, 's', { runtimeState: 'running' }), page([event(1), event(2)]))
  f.controller.refresh(); await settle()
  f.reads[1].resolve(session(1, 's', { runtimeState: 'idle' })); await settle()
  assert.equal(f.controller.getSnapshot().error.code, 'session-regression')
  assert.equal(f.controller.getSnapshot().session.runtimeState, 'running')
  assert.equal(f.histories.length, 1)
  f.controller.retry(); await load(f, session(2), page([], 2))
  assert.equal(f.controller.getSnapshot().status, 'ready')
})

test('continuous successful invalidations share the pagination budget, with no concurrent reads', async t => {
  const f = fixture(t, { options: { maxPagesPerRefresh: 2 } })
  await settle()
  for (let i = 0; i < 2; i++) {
    assert.equal(f.reads.length, i + 1)
    f.reads[i].resolve(session(i)); await settle()
    assert.equal(f.histories.length, i + 1)
    f.watches[0].options.onInvalidate()
    f.histories[i].resolve(page(i ? [event(1)] : [], i)); await settle()
  }
  assert.equal(f.reads.length, 2)
  assert.equal(f.controller.getSnapshot().needsRefresh, true)
  f.controller.refresh(); await load(f, session(1), page([], 1))
  assert.equal(f.controller.getSnapshot().needsRefresh, false)
})

test('late rejected reads and watch done after disposal are handled without publication', async () => {
  const metadata = deferred(), subscription = deferred()
  let calls = 0, disposals = 0
  const c = createConversationController(scope(), {
    getSession: () => metadata.promise,
    sessionHistory: async () => page(),
    watchSession: () => ({ done: subscription.promise, dispose: () => { disposals++ } }),
  })
  await settle()
  c.subscribe(() => calls++)
  c.dispose()
  metadata.reject(new ApiError('late secret', 403))
  subscription.reject(new ApiError('late secret', 401))
  await settle()
  assert.equal(calls, 0)
  assert.equal(disposals, 1)
  assert.equal(c.getSnapshot().status, 'disposed')
  assert.ok(!JSON.stringify(c.getSnapshot()).includes('secret'))
})

test('unsubscribe is effective even during delivery and snapshots retain prior immutable facts', async t => {
  const f = fixture(t)
  let removedCalls = 0, remove
  f.controller.subscribe(() => remove())
  remove = f.controller.subscribe(() => removedCalls++)
  await load(f, session(1), page([event(1)]))
  const prior = f.controller.getSnapshot()
  f.controller.refresh(); await load(f, session(2), page([event(2)]))
  assert.equal(removedCalls, 0)
  assert.equal(prior.projection.lastAppliedSeq, 1)
  assert.equal(f.controller.getSnapshot().projection.lastAppliedSeq, 2)
  assert.ok(Object.isFrozen(prior))
  assert.ok(Object.isFrozen(prior.freshness))
  assert.ok(Object.isFrozen(prior.scope))
})

test('synchronous subscription invalidation cannot start a second concurrent metadata drain', async () => {
  const reads = [], histories = [], done = deferred()
  const c = createConversationController(scope(), {
    watchSession(id, options) { options.onInvalidate(); return { done: done.promise, dispose: done.resolve } },
    getSession() { const d = deferred(); reads.push(d); return d.promise },
    sessionHistory() { const d = deferred(); histories.push(d); return d.promise },
  })
  try {
    await settle()
    assert.equal(reads.length, 1)
    reads[0].resolve(session()); await settle()
    assert.equal(histories.length, 1)
    histories[0].resolve(page()); await settle()
    assert.equal(reads.length, 1)
    assert.equal(c.getSnapshot().status, 'ready')
  } finally { c.dispose() }
})
