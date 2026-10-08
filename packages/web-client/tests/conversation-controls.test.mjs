import test from 'node:test'
import assert from 'node:assert/strict'
import * as client from '../src/index.ts'
import { ApiError } from '../src/errors.ts'

const scope = { host: 'http://controls.test', accountId: 'a', teamId: 'team', projectId: 'p', taskId: 'task', sessionId: 's' }
const cancel = (commandId = 'cancel') => ({ operation: 'cancel-queued', submissionCommandId: 'enqueue', body: { commandId } })
const stop = (commandId = 'stop') => ({ operation: 'stop-turn', body: { commandId, turnId: 'turn-one' } })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture(overrides = {}) {
  const values = new Map(), calls = [], lifetime = new AbortController()
  let denied = false, readFailure = false, writeFailure = false
  const storage = { removeItem(k) { if (writeFailure) throw Error('quota'); values.delete(k) }, getItem(k) { if (readFailure) throw Error('denied'); return values.get(k) ?? null }, setItem(k, v) { if (writeFailure) throw Error('quota'); values.set(k, v) } }
  const port = { scope, signal: lifetime.signal, assertCurrent() { if (denied) throw Error('permission lost') },
    async cancelQueuedMessage(s, target, body) { calls.push({ s, target, body }); return { commandId: body.commandId } },
    async stopTurn(s, body) { calls.push({ s, body }); return { commandId: body.commandId } }, ...overrides }
  const make = (p = port, sc = scope) => client.createConversationControls(sc, { storage: () => storage, port: p })
  return { storage, values, calls, port, make, lifetime, deny: () => { denied = true }, failRead: v => { readFailure = v }, failWrite: v => { writeFailure = v } }
}

test('approval identity and decision survive response loss, reopen and explicit retry', async () => {
  const calls = []
  const f = fixture({ async resolveApproval(s, target, body) { calls.push({ s, target, body }); if (calls.length === 1) throw Error('lost'); return { commandId: body.commandId } } })
  const a = f.make(); a.load()
  const intent = { operation: 'resolve-approval', approvalId: 'a', body: { commandId: 'approval-c', turnId: 't', decision: 'deny' } }
  const request = a.submit(intent); intent.body.decision = 'approve'; intent.body.turnId = 'other'; await request
  assert.equal(a.getSnapshot().status, 'uncertain'); a.dispose()
  const b = f.make(); b.load(); await tick(); assert.equal(calls.length, 1)
  await b.submit(stop()); assert.equal(calls.length, 1)
  await b.retry(); assert.equal(b.getSnapshot().status, 'admitted')
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ s: 's', target: 'a', body: { commandId: 'approval-c', turnId: 't', decision: 'deny' } })))
})

test('model selection persists exact target through lost admission, reopen and explicit retry', async () => {
  const calls = [], f = fixture({ async selectModel(s, body) { calls.push({ s, body }); if (calls.length === 1) throw Error('lost'); return { commandId: body.commandId } } })
  const a = f.make(); a.load()
  const intent = { operation: 'select-model', body: { commandId: 'model-c', modelId: 'next' } }
  const pending = a.submit(intent); intent.body.modelId = 'different'; await pending
  assert.equal(a.getSnapshot().status, 'uncertain'); a.dispose()
  const b = f.make(); b.load(); await tick(); assert.equal(calls.length, 1)
  await b.submit(stop()); assert.equal(calls.length, 1)
  await b.retry(); assert.equal(b.getSnapshot().status, 'admitted')
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ s: 's', body: { commandId: 'model-c', modelId: 'next' } })))
})

test('definitive model non-admission requires explicit release before other controls', async () => {
  const f = fixture({ async selectModel() { throw new ApiError('Model unavailable', 409, undefined, 'model_not_admitted') } }), c = f.make(); c.load()
  await c.submit({ operation: 'select-model', body: { commandId: 'model', modelId: 'withdrawn' } })
  assert.equal(c.getSnapshot().status, 'rejected'); assert.match(c.getSnapshot().error, /未接收/)
  const saved = f.values.get(c.key); await c.submit(stop()); assert.equal(f.calls.length, 0)
  c.load(); assert.equal(c.getSnapshot().status, 'rejected')
  c.releaseRejected(); assert.equal(c.getSnapshot().status, 'ready'); assert.equal(f.values.has(c.key), false)
  await c.submit(stop()); assert.equal(f.calls.length, 1)
  const foreign = fixture(); foreign.values.set(c.key, saved)
  const reopened = foreign.make(); reopened.load(); assert.equal(reopened.getSnapshot().status, 'uncertain')
  reopened.releaseRejected(); assert.equal(foreign.values.get(c.key), saved, 'persisted intent is not proof of rejection in a new identity lifetime')
})

test('ambiguous model errors and other operations cannot release a pending intent', async () => {
  for (const error of [Error('lost'), new ApiError('Model unavailable', 409), new ApiError('failure', 500, undefined, 'model_not_admitted')]) {
    const f = fixture({ async selectModel() { throw error } }), c = f.make(); c.load()
    await c.submit({ operation: 'select-model', body: { commandId: 'model', modelId: 'next' } })
    assert.equal(c.getSnapshot().status, 'uncertain'); const saved = f.values.get(c.key)
    c.releaseRejected(); assert.equal(f.values.get(c.key), saved); await c.submit(stop()); assert.equal(f.calls.length, 0)
  }
  const f = fixture({ async stopTurn() { throw new ApiError('bad', 409, undefined, 'model_not_admitted') } }), c = f.make(); c.load(); await c.submit(stop())
  assert.equal(c.getSnapshot().status, 'uncertain')
})

test('rejection release rechecks authority, durable identity and storage success', async () => {
  for (const mode of ['authority', 'storage', 'changed', 'aborted']) {
    const f = fixture({ async selectModel() { throw new ApiError('gone', 409, undefined, 'model_not_admitted') } }), c = f.make(); c.load()
    await c.submit({ operation: 'select-model', body: { commandId: 'model', modelId: 'gone' } })
    if (mode === 'authority') f.deny()
    if (mode === 'storage') f.failWrite(true)
    if (mode === 'aborted') f.lifetime.abort()
    if (mode === 'changed') f.values.set(c.key, f.values.get(c.key).replace('gone', 'other'))
    const saved = f.values.get(c.key); c.releaseRejected()
    assert.equal(c.getSnapshot().status, 'blocked'); assert.equal(f.values.get(c.key), saved)
  }
})

test('controls persist exact immutable intent before dispatch; receipt is admission only', async () => {
  const f = fixture(), c = f.make(); c.load()
  const body = cancel()
  f.port.cancelQueuedMessage = async (s, target, sent) => { assert.deepEqual(JSON.parse(f.values.get(c.key)).intent, body); return { commandId: sent.commandId, status: 'cancelled' } }
  await c.submit(body)
  const snap = c.getSnapshot()
  assert.equal(snap.status, 'admitted'); assert.deepEqual(snap.admission, { commandId: 'cancel' })
  assert.ok(Object.isFrozen(snap)); assert.ok(Object.isFrozen(snap.scope)); assert.ok(Object.isFrozen(snap.intent.body))
  assert.equal('outcome' in snap, false)
})

test('duplicate clicks and explicit same-port remount retries join, each observer settles', async () => {
  const wait = deferred(), f = fixture({ cancelQueuedMessage: async () => { f.calls.push(1); return wait.promise } })
  const a = f.make(); a.load(); const first = a.submit(cancel()); const duplicate = a.submit(cancel())
  const b = f.make(); b.load(); assert.equal(f.calls.length, 0, 'dispatch is deferred but persistence is synchronous')
  const joined = b.retry(); await tick(); assert.equal(f.calls.length, 1)
  wait.resolve({ commandId: 'cancel' }); await Promise.all([first, duplicate, joined])
  assert.equal(a.getSnapshot().status, 'admitted'); assert.equal(b.getSnapshot().status, 'admitted')
})

test('response lost after commit retains exact identity across reopen and explicit retry, including 4xx', async () => {
  let committed = null, attempts = 0
  const f = fixture({ stopTurn: async (s, body) => { attempts++; if (committed) assert.deepEqual(body, committed); committed = { ...body }; if (attempts === 1) throw new client.ApiError('lost after commit', 409); return { commandId: body.commandId } } })
  const a = f.make(); a.load(); await a.submit(stop()); assert.equal(a.getSnapshot().status, 'uncertain'); a.dispose()
  const b = f.make(); b.load(); await tick(); assert.equal(attempts, 1)
  await b.submit(cancel('replacement')); assert.equal(attempts, 1)
  await b.retry(); assert.equal(attempts, 2); assert.equal(b.getSnapshot().intent.body.turnId, 'turn-one')
})

test('stop target and caller objects are frozen before async dispatch, next Turn is never substituted', async () => {
  const wait = deferred(), f = fixture({ stopTurn: async (s, body) => { await wait.promise; f.calls.push(body); return { commandId: body.commandId } } })
  const sc = { ...scope }, c = f.make(f.port, sc); c.load(); const intent = stop(), p = c.submit(intent)
  intent.body.turnId = 'turn-two'; intent.body.commandId = 'other'; sc.sessionId = 'other-session'
  wait.resolve(); await p
  assert.deepEqual(f.calls, [{ commandId: 'stop', turnId: 'turn-one' }]); assert.equal(c.getSnapshot().scope.sessionId, 's')
})

for (const replacement of [null, 'corrupt', JSON.stringify({ version: 1, intent: stop('other') })]) {
  test(`stale instance refuses missing/replaced/corrupt durable identity: ${replacement}`, async () => {
    const f = fixture({ cancelQueuedMessage: async () => { throw Error('lost') } }), c = f.make(); c.load(); await c.submit(cancel())
    if (replacement === null) f.values.delete(c.key); else f.values.set(c.key, replacement)
    const before = f.values.get(c.key); await c.retry(); await c.submit(stop()); c.load()
    assert.equal(c.getSnapshot().status, 'blocked'); assert.equal(f.values.get(c.key), before)
  })
}

test('admitted stale instance cannot replace a newer admitted intent or missing storage', async () => {
  const f = fixture(), a = f.make(); a.load(); await a.submit(cancel())
  const b = f.make(); b.load(); await b.submit(stop()); const saved = f.values.get(a.key)
  await a.submit(cancel('stale')); assert.equal(a.getSnapshot().status, 'blocked'); assert.equal(f.values.get(a.key), saved)
  f.values.delete(b.key); await b.submit(cancel('missing')); assert.equal(f.values.has(b.key), false)
})

test('storage getter/read/write failures and corruption fail closed without dispatch', async () => {
  for (const mode of ['getter', 'read', 'write', 'corrupt']) {
    const f = fixture(), c = mode === 'getter' ? client.createConversationControls(scope, { storage: () => { throw Error('disabled') }, port: f.port }) : f.make()
    if (mode === 'read') f.failRead(true)
    if (mode === 'write') f.failWrite(true)
    if (mode === 'corrupt') f.values.set(c.key, '{}')
    c.load(); await c.submit(cancel()); assert.equal(c.getSnapshot().status, 'blocked'); assert.equal(f.calls.length, 0)
  }
})

test('settlement persistence failure retains memory receipt but cannot authorize replacement', async () => {
  const f = fixture({ cancelQueuedMessage: async () => { f.failWrite(true); return { commandId: 'cancel' } } }), c = f.make(); c.load(); await c.submit(cancel())
  assert.deepEqual(c.getSnapshot().admission, { commandId: 'cancel' }); assert.equal(c.getSnapshot().status, 'blocked')
  f.failWrite(false); await c.submit(stop()); assert.equal(c.getSnapshot().intent.body.commandId, 'cancel')
  f.port.cancelQueuedMessage = async () => ({ commandId: 'cancel' }); await c.retry(); assert.equal(c.getSnapshot().status, 'admitted')
})

test('settlement read failure or changed identity never overwrites storage', async () => {
  for (const mode of ['read', 'replace', 'missing']) {
    const wait = deferred(), f = fixture({ stopTurn: async () => wait.promise }), c = f.make(); c.load(); const p = c.submit(stop()); await tick()
    if (mode === 'read') f.failRead(true)
    if (mode === 'replace') f.values.set(c.key, 'replacement')
    if (mode === 'missing') f.values.delete(c.key)
    const saved = f.values.get(c.key); wait.resolve({ commandId: 'stop' }); await p
    assert.equal(c.getSnapshot().status, 'blocked'); assert.equal(f.values.get(c.key), saved)
  }
})

test('permission loss blocks new and retry dispatch; persisted intent stays recoverable', async () => {
  for (const retry of [false, true]) {
    const f = fixture({ stopTurn: async () => { f.calls.push(1); throw Error('lost') } }), c = f.make(); c.load()
    if (retry) await c.submit(stop())
    f.deny(); const before = f.calls.length; await (retry ? c.retry() : c.submit(stop()))
    assert.equal(f.calls.length, before); assert.notEqual(c.getSnapshot().status, 'admitted')
    assert.equal(c.getSnapshot().intent.body.turnId, 'turn-one')
  }
})

test('disposal ends local observation without aborting remote flight or a remount joiner', async () => {
  const wait = deferred(), f = fixture({ stopTurn: async () => wait.promise }), a = f.make(); a.load(); const p = a.submit(stop())
  const b = f.make(); b.load(); const q = b.retry(); a.dispose(); await p
  assert.equal(a.getSnapshot().status, 'disposed'); wait.resolve({ commandId: 'stop' }); await q
  assert.equal(b.getSnapshot().status, 'admitted')
})

test('different authenticated port cannot join old flight or use its receipt to replace intent', async () => {
  const wait = deferred(), f = fixture({ stopTurn: async () => wait.promise }), a = f.make(); a.load(); const p = a.submit(stop())
  const next = { ...f.port, stopTurn: async (s, body) => { f.calls.push(body); return { commandId: body.commandId } } }
  const b = f.make(next); b.load(); await b.retry(); assert.equal(f.calls.length, 0)
  wait.resolve({ commandId: 'stop' }); await p; b.load(); assert.notEqual(b.getSnapshot().status, 'admitted')
  await b.submit(cancel('new')); assert.equal(f.calls.length, 0)
  await b.retry(); assert.equal(f.calls.length, 1); assert.equal(b.getSnapshot().status, 'admitted')
})

test('expired authenticated port cannot settle a late receipt; scope mismatches are rejected', async () => {
  const wait = deferred(), f = fixture({ stopTurn: async () => wait.promise }), c = f.make(); c.load(); const p = c.submit(stop()); await tick()
  f.lifetime.abort(); wait.resolve({ commandId: 'stop' }); await p; assert.notEqual(c.getSnapshot().status, 'admitted')
  for (const field of ['host', 'accountId', 'teamId', 'projectId', 'taskId', 'sessionId']) {
    const changed = { ...scope, [field]: field === 'host' ? 'http://other.test' : 'other' }
    assert.throws(() => f.make(f.port, changed))
  }
})

test('malformed receipts preserve unresolved original; invalid identities never dispatch', async () => {
  for (const receipt of [{}, null, { commandId: 'other' }, { commandId: 3 }]) {
    const f = fixture({ stopTurn: async () => receipt }), c = f.make(); c.load(); await c.submit(stop())
    assert.equal(c.getSnapshot().status, 'uncertain'); assert.equal(c.getSnapshot().admission, null)
  }
  for (const value of ['', ' ', 'x'.repeat(201), 'x\0']) {
    const f = fixture(), c = f.make(); c.load(); await c.submit(stop(value)); assert.equal(f.calls.length, 0)
  }
})

test('one unresolved scope serializes queue cancel and Turn stop, without hidden cancellation', async () => {
  const wait = deferred(), f = fixture({ cancelQueuedMessage: async () => wait.promise }), c = f.make(); c.load(); const p = c.submit(cancel())
  await c.submit(stop()); assert.equal(c.getSnapshot().intent.operation, 'cancel-queued')
  wait.resolve({ commandId: 'cancel' }); await p; await c.submit(stop()); assert.equal(c.getSnapshot().intent.operation, 'stop-turn')
})

test('synchronous observers cannot race flight installation into a duplicate dispatch', async () => {
  const wait = deferred(), f = fixture({ stopTurn: async () => { f.calls.push(1); return wait.promise } }), c = f.make(); c.load()
  let joined, once = false
  c.subscribe(() => { if (!once && c.getSnapshot().intent) { once = true; joined = c.retry() } })
  const first = c.submit(stop()); await tick(); assert.equal(f.calls.length, 1)
  wait.resolve({ commandId: 'stop' }); await Promise.all([first, joined]); assert.equal(c.getSnapshot().status, 'admitted')
})

test('each joiner checks its current stored identity before adopting the shared result', async () => {
  const wait = deferred(), f = fixture({ stopTurn: async () => wait.promise }), a = f.make(); a.load(); const p = a.submit(stop())
  const b = f.make(); b.load(); const q = b.retry()
  a.subscribe(() => { if (a.getSnapshot().status === 'admitted') f.values.delete(a.key) })
  wait.resolve({ commandId: 'stop' }); await Promise.all([p, q]); assert.equal(b.getSnapshot().status, 'blocked')
})

test('reopen on a new authenticated client replays unresolved exact body, without auto-send', async () => {
  const f = fixture({ stopTurn: async () => { throw Error('lost') } }), a = f.make(); a.load(); await a.submit(stop()); a.dispose()
  const next = { ...f.port, signal: new AbortController().signal, stopTurn: async (s, body) => { f.calls.push(body); return { commandId: body.commandId } } }
  const b = f.make(next); b.load(); await tick(); assert.equal(f.calls.length, 0)
  await b.retry(); assert.deepEqual(f.calls, [{ commandId: 'stop', turnId: 'turn-one' }])
})

test('valid replaced stored intent stays untouched and nonpersistent writes cannot dispatch', async () => {
  const f = fixture({ stopTurn: async () => { throw Error('lost') } }), c = f.make(); c.load(); await c.submit(stop())
  const replacement = JSON.parse(f.values.get(c.key)); replacement.intent = stop('replacement')
  const raw = JSON.stringify(replacement); f.values.set(c.key, raw); await c.retry(); await c.submit(cancel())
  assert.equal(f.values.get(c.key), raw); assert.equal(c.getSnapshot().status, 'blocked')
  const g = fixture(); g.storage.setItem = () => {}; const d = g.make(); d.load(); await d.submit(cancel())
  assert.equal(g.calls.length, 0); assert.equal(d.getSnapshot().status, 'blocked')
})

test('all scope partitions are independent and storage access is lazy', async () => {
  let accesses = 0
  const f = fixture(), c = client.createConversationControls(scope, { storage: () => { accesses++; return f.storage }, port: f.port })
  assert.equal(accesses, 0); c.load(); assert.equal(accesses, 1)
  for (const field of ['host', 'accountId', 'teamId', 'projectId', 'taskId', 'sessionId']) {
    const changed = { ...scope, [field]: field === 'host' ? 'http://other.test' : 'other' }
    const d = f.make({ ...f.port, scope: changed }, changed); d.load(); assert.notEqual(c.key, d.key); assert.equal(d.getSnapshot().intent, null)
  }
})

test('aborted port cannot let an old late receipt authorize a new client intent', async () => {
  const wait = deferred(), f = fixture({ stopTurn: async () => wait.promise }), a = f.make(); a.load(); const p = a.submit(stop()); await tick()
  f.lifetime.abort()
  const next = { ...f.port, signal: new AbortController().signal, stopTurn: async (s, body) => { f.calls.push(body); return { commandId: body.commandId } } }
  const b = f.make(next); b.load(); wait.resolve({ commandId: 'stop' }); await p
  await b.submit(cancel()); assert.equal(f.calls.length, 0); await b.retry(); assert.equal(b.getSnapshot().status, 'admitted')
})

test('joiners independently retain validated receipts when durable settlement fails', async () => {
  const wait = deferred(), f = fixture({ stopTurn: async () => wait.promise }), a = f.make(); a.load(); const p = a.submit(stop())
  const b = f.make(); b.load(); const q = b.retry(); await tick(); f.failWrite(true)
  wait.resolve({ commandId: 'stop' }); await Promise.all([p, q])
  for (const c of [a, b]) { assert.equal(c.getSnapshot().status, 'blocked'); assert.deepEqual(c.getSnapshot().admission, { commandId: 'stop' }) }
  f.failWrite(false); await b.submit(cancel()); assert.equal(b.getSnapshot().intent.operation, 'stop-turn')
})

test('write commits then throws retains attempted identity and cannot mint over changed storage', async () => {
  const f = fixture(), normal = f.storage.setItem.bind(f.storage)
  f.storage.setItem = (key, raw) => { normal(key, raw); throw Error('after commit') }
  const c = f.make(); c.load(); await c.submit(stop()); assert.equal(f.calls.length, 0)
  assert.equal(c.getSnapshot().intent.body.commandId, 'stop'); f.storage.setItem = normal
  f.values.delete(c.key); await c.submit(cancel()); assert.equal(f.values.has(c.key), false)
})

test('failed next-intent persistence cannot attach the previous admission to the new intent', async () => {
  const f = fixture(), c = f.make(); c.load(); await c.submit(cancel()); f.failWrite(true); await c.submit(stop())
  assert.equal(c.getSnapshot().intent.body.commandId, 'stop'); assert.equal(c.getSnapshot().admission, null)
})

test('an empty loaded stale view cannot replace another remount newly settled identity', async () => {
  const f = fixture(), a = f.make(), b = f.make(); a.load(); b.load(); await b.submit(stop())
  const raw = f.values.get(a.key); await a.submit(cancel()); assert.equal(a.getSnapshot().status, 'blocked'); assert.equal(f.values.get(a.key), raw)
})
