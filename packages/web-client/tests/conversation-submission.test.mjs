import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationSubmission, ApiError } from '@wemux/web-client'

const scope = { host: 'http://submission.test', accountId: 'owner', teamId: 'team', projectId: 'project', taskId: 'task', sessionId: 'session' }
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function memory() { const map = new Map(); return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value) } } }
const receipt = (body, status = 'pending') => ({ commandId: body.commandId, messageId: body.messageId, status })
function fixture(options = {}) {
  const storage = options.storage ?? memory(), calls = []; let ids = 0
  const create = (extra = {}, givenScope = scope) => createConversationSubmission(givenScope, {
    storage: () => storage, mint: () => `id-${++ids}`,
    send: async (sessionId, body, signal) => { calls.push({ sessionId, body, signal }); return receipt(body) }, ...extra,
  })
  return { storage, calls, create, ids: () => ids }
}

test('persist exact full identity before send, reload without sending, explicit retry reuses immutable body', async () => {
  const f = fixture(); let first, persistedAtSend, frozenAtSend, mutationError
  const a = f.create({ send: async (_id, body) => {
    first = body
    persistedAtSend = f.storage.getItem(a.key)
    frozenAtSend = Object.isFrozen(body)
    try { body.content = 'changed' } catch (error) { mutationError = error }
    throw Error('lost after commit')
  } })
  a.load(); assert.equal(a.getSnapshot().status, 'ready')
  assert.equal(a.edit('  原文\n你好  '), true)
  await a.submit()
  // Outside the sender: the controller intentionally catches sender failures.
  assert.deepEqual(JSON.parse(persistedAtSend).intent.body, first)
  assert.equal(frozenAtSend, true)
  assert.ok(mutationError instanceof TypeError)
  assert.equal(first.content, '  原文\n你好  ')
  assert.equal(a.getSnapshot().status, 'uncertain')
  assert.equal(a.getSnapshot().draft, first.content)
  a.dispose()
  const b = f.create(); b.load()
  assert.equal(b.getSnapshot().status, 'uncertain'); assert.equal(f.calls.length, 0)
  await b.submit() // not an implicit retry
  assert.equal(f.calls.length, 0); assert.equal(f.ids(), 2)
  await b.retry()
  assert.deepEqual(f.calls[0].body, first); assert.equal(f.ids(), 2)
  assert.equal(b.getSnapshot().status, 'admitted'); assert.equal(b.getSnapshot().admission.status, 'pending')
  assert.equal(b.getSnapshot().draft, '')
  const c = f.create(); c.load()
  assert.equal(c.getSnapshot().admission.status, 'pending'); assert.equal(f.calls.length, 1)
  await c.retry(); assert.equal(f.calls.length, 1)
  c.edit('next'); await c.submit()
  assert.equal(f.calls.length, 2); assert.notEqual(f.calls[1].body.commandId, first.commandId)
})

test('duplicate clicks, concurrent instances and storage/mint/send/listener reentrancy share one intent and release flight', async () => {
  const f = fixture(), hold = deferred(); let a, b, nested = [], reentered = false, minted = 0
  const originalGet = f.storage.getItem
  f.storage.getItem = key => {
    if (a && !reentered) { reentered = true; nested.push(b.submit()); nested.push(a.submit()) }
    return originalGet(key)
  }
  a = f.create({ mint: () => { nested.push(b.submit()); return `mint-${++minted}` }, send: async (_id, body) => {
    f.calls.push(body); nested.push(a.submit()); return hold.promise
  } })
  b = f.create()
  // Avoid intentional storage reentry until send has installed coordination.
  reentered = true; a.edit('first'); reentered = false
  let listenerRan = false
  a.subscribe(() => { if (!listenerRan && a.getSnapshot().status === 'sending') { listenerRan = true; nested.push(b.submit()) } })
  const pending = [a.submit(), a.submit(), b.submit()]
  await tick(); assert.equal(f.calls.length, 1); assert.equal(minted, 2)
  hold.resolve(receipt(f.calls[0])); await Promise.all([...pending, ...nested])
  assert.equal(a.getSnapshot().status, 'admitted'); assert.equal(b.getSnapshot().status, 'admitted')
  b.edit('second'); await b.submit()
  assert.equal(f.calls.length, 2)
})

test('newer draft edits including ABA and another instance survive late admission and reload', async () => {
  for (const content of ['new draft', 'first']) {
    const f = fixture(), hold = deferred(), a = f.create({ send: async (_id, body) => { f.calls.push(body); return hold.promise } }), b = f.create()
    a.edit('first'); const pending = a.submit(); await tick()
    b.load(); b.edit('temporary'); b.edit(content)
    hold.resolve(receipt(f.calls[0])); await pending
    assert.equal(a.getSnapshot().draft, content)
    const c = f.create(); c.load(); assert.equal(c.getSnapshot().draft, content)
  }
})

test('invalid/mismatched receipts and every thrown HTTP outcome preserve exact intent without polling', async () => {
  for (const result of [null, {}, { commandId: 'wrong', messageId: 'id-2', status: 'pending' }, { commandId: 'id-1', messageId: 'wrong', status: 'accepted' }, { commandId: 'id-1', messageId: 'id-2', status: 'success' }, ...[400, 401, 403, 404, 409, 413, 500, 503].map(status => new ApiError('secret', status)), Error('network')]) {
    const f = fixture(); let sends = 0
    const a = f.create({ send: async () => { sends++; if (result instanceof Error) throw result; return result } })
    a.edit('intent'); await a.submit()
    assert.equal(a.getSnapshot().status, 'uncertain'); assert.equal(a.getSnapshot().intent.receipt, null)
    assert.ok(!a.getSnapshot().error.includes('secret')); await a.submit(); assert.equal(sends, 1)
    const b = f.create(); b.load(); await b.retry(); assert.equal(f.calls.length, 1); assert.equal(f.ids(), 2)
  }
})

test('validated POST command rejection is authoritative admission status, not HTTP rejection or Turn success', async () => {
  for (const status of ['pending', 'accepted', 'rejected', 'completed', 'failed', 'cancelled']) {
    const f = fixture(), a = f.create({ send: async (_id, body) => receipt(body, status) })
    a.edit('message'); await a.submit()
    assert.equal(a.getSnapshot().status, 'admitted'); assert.equal(a.getSnapshot().admission.status, status)
    assert.deepEqual(Object.keys(a.getSnapshot().admission), ['commandId', 'messageId', 'status'])
    assert.equal(a.getSnapshot().intent.receipt.status, status)
  }
})

test('missing/denied/corrupt/oversize storage fails closed and preserves raw intent', async () => {
  for (const raw of ['{', '{}', 'null', 'x'.repeat(1300001)]) {
    const f = fixture(), a = f.create(); f.storage.setItem(a.key, raw)
    a.load(); assert.equal(a.getSnapshot().status, 'blocked')
    assert.equal(a.edit('replacement'), false); await a.submit(); await a.retry()
    assert.equal(f.calls.length, 0); assert.equal(f.storage.getItem(a.key), raw); assert.equal(f.ids(), 0)
  }
  for (const storage of [undefined, null, {}, { getItem() { throw Error('denied') }, setItem() {} }]) {
    let sends = 0
    const a = createConversationSubmission(scope, { storage: () => storage, send: async () => { sends++ } })
    a.load(); assert.equal(a.edit('new'), false); await a.submit(); await a.retry(); assert.equal(sends, 0)
  }
  let sends = 0, reads = 0
  const a = createConversationSubmission(scope, { storage: () => { reads++; throw Error('denied') }, send: async () => { sends++ } })
  assert.equal(reads, 0); a.load(); await a.submit(); assert.equal(sends, 0)
})

test('bounded schema rejects invalid scope/body/revision/receipt and unknown fields without overwriting', async () => {
  const seed = fixture(), a = seed.create({ send: async () => { throw Error('lost') } })
  a.edit('original'); await a.submit(); const raw = seed.storage.getItem(a.key)
  const changes = [v => v.version = 2, v => v.scopeKey = 'foreign', v => v.extra = true,
    v => v.draft.revision = -1, v => v.draft.content = 'x'.repeat(100001), v => v.draft.content = '\0',
    v => v.intent.body.commandId = '', v => v.intent.body.messageId = 'x'.repeat(201), v => v.intent.body.requestId = 'create-session',
    v => v.intent.body.content = ' ', v => v.intent.draftRevision = 99, v => v.intent.receipt = { commandId: 'foreign', messageId: 'id-2', status: 'pending' }]
  for (const change of changes) {
    const f = fixture(), b = f.create(), value = JSON.parse(raw); change(value); const invalid = JSON.stringify(value)
    f.storage.setItem(b.key, invalid); b.load(); await b.submit(); assert.equal(b.getSnapshot().status, 'blocked')
    assert.equal(f.storage.getItem(b.key), invalid); assert.equal(f.calls.length, 0)
  }
  assert.throws(() => createConversationSubmission({ ...scope, host: 'file:///tmp/test' }, {}))
  assert.throws(() => createConversationSubmission({ ...scope, accountId: '' }, {}))
})

test('write denial, dropped writes and failed read-back prevent send; settlement failure retains useful receipt', async () => {
  for (const failure of ['throw', 'drop', 'readback']) {
    const f = fixture(), a = f.create(); a.edit('saved draft')
    const before = f.storage.getItem(a.key), set = f.storage.setItem; let changed = false
    f.storage.setItem = (k, v) => { if (failure === 'throw') throw Error('quota'); if (failure === 'readback') { set(k, v); changed = true } }
    const get = f.storage.getItem; f.storage.getItem = k => { if (changed) throw Error('denied after write'); return get(k) }
    await a.submit(); assert.equal(f.calls.length, 0)
    assert.ok(a.getSnapshot().intent); assert.equal(a.getSnapshot().intent.body.content, 'saved draft')
    if (failure !== 'readback') assert.equal(get(a.key), before)
  }
  const f = fixture(), a = f.create({ send: async (_id, body) => { f.storage.setItem = () => { throw Error('quota') }; return receipt(body, 'accepted') } })
  a.edit('original'); await a.submit()
  assert.equal(a.getSnapshot().status, 'uncertain'); assert.equal(a.getSnapshot().intent.receipt, null)
  assert.equal(a.getSnapshot().admission.status, 'accepted'); assert.match(a.getSnapshot().error, /无法保存确认状态/)
})

test('stale persisted intent deletion or replacement cannot be erased, retried as new, or implicitly submitted', async () => {
  for (const replacement of [null, 'different']) {
    const f = fixture(), hold = deferred(), a = f.create({ send: async (_id, body) => { f.calls.push(body); return hold.promise } })
    a.edit('original'); const pending = a.submit(); await tick()
    let raw = null
    if (replacement) { const data = JSON.parse(f.storage.getItem(a.key)); data.intent.body.commandId = 'new-command'; data.intent.body.content = 'different'; raw = JSON.stringify(data); f.storage.setItem(a.key, raw) }
    else f.storage.map.delete(a.key)
    hold.resolve(receipt(f.calls[0])); await pending
    assert.equal(f.storage.getItem(a.key), raw); assert.equal(a.getSnapshot().status, 'uncertain')
    await a.retry(); await a.submit(); assert.equal(f.calls.length, 1); assert.equal(f.ids(), 2)
    assert.equal(f.storage.getItem(a.key), raw)
  }
  const f = fixture(), a = f.create({ send: async () => { throw Error('lost') } }); a.edit('original'); await a.submit()
  const b = f.create(); b.load(); f.storage.map.delete(b.key); await b.retry()
  assert.equal(f.calls.length, 0); assert.equal(f.ids(), 2); assert.match(b.getSnapshot().error, /消失|变化/)
})

test('host/account/team/project/task/session scope is frozen and storage cannot leak between scopes', async () => {
  const f = fixture(), mutable = { ...scope }, a = f.create({}, mutable)
  mutable.accountId = 'other'; mutable.sessionId = 'other'
  a.edit('secret draft')
  assert.equal(a.getSnapshot().scope.accountId, scope.accountId); assert.ok(Object.isFrozen(a.getSnapshot().scope))
  for (const key of Object.keys(scope)) {
    const b = f.create({}, { ...scope, [key]: key === 'host' ? 'https://elsewhere.test' : 'different' })
    b.load(); assert.equal(b.getSnapshot().draft, ''); assert.equal(b.getSnapshot().intent, null); assert.notEqual(b.key, a.key)
  }
  const sameOrigin = f.create({}, { ...scope, host: `${scope.host}/next/` }); sameOrigin.load()
  assert.equal(sameOrigin.getSnapshot().draft, 'secret draft')
})

test('disposal aborts observation, suppresses callbacks/late settlement, keeps uncertainty and releases flight', async () => {
  const f = fixture(), hold = deferred(); let signal, sent, calls = 0
  const a = f.create({ send: async (_id, body, s) => { signal = s; sent = body; return hold.promise } })
  a.subscribe(() => { calls++ }); a.edit('original'); const pending = a.submit(); await tick()
  const raw = f.storage.getItem(a.key); a.dispose(); const stable = calls, snapshot = a.getSnapshot()
  await pending; assert.equal(signal.aborted, true); assert.equal(f.storage.getItem(a.key), raw)
  const b = f.create(); b.load(); assert.equal(b.getSnapshot().status, 'uncertain'); await b.retry()
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].body, sent)
  const settled = f.storage.getItem(a.key); hold.resolve(receipt(sent, 'completed')); await tick()
  assert.equal(f.storage.getItem(a.key), settled); assert.equal(calls, stable); assert.equal(a.getSnapshot(), snapshot)
  assert.equal(snapshot.draft, ''); assert.equal(snapshot.intent, null)
  a.load(); a.edit('ignored'); await a.submit(); await a.retry(); assert.equal(f.calls.length, 1)
})

test('observer failures do not alter admission; observer storage replacement before send stops dispatch', async () => {
  const f = fixture(), a = f.create(); a.subscribe(() => { throw Error('observer') }); a.edit('hello'); await a.submit()
  assert.equal(a.getSnapshot().status, 'admitted')
  const b = f.create(); b.edit('next')
  b.subscribe(() => { if (b.getSnapshot().status === 'sending') f.storage.map.delete(b.key) })
  await b.submit(); assert.equal(f.calls.length, 1); assert.match(b.getSnapshot().error, /消失|变化/)
})

test('draft validation rejects byte overflow without overwriting prior draft or sending', async () => {
  const f = fixture(), a = f.create(); a.edit('saved')
  for (const bad of ['x'.repeat(100001), '\0', '中'.repeat(70000)]) { assert.equal(a.edit(bad), false); assert.equal(a.getSnapshot().draft, 'saved') }
  a.edit('   '); await a.submit(); assert.equal(f.calls.length, 0)
})

test('failed draft persistence does not replace the prior draft or unresolved message', async () => {
  const f = fixture(), a = f.create({ send: async () => { throw Error('lost') } })
  a.edit('original'); await a.submit(); const before = f.storage.getItem(a.key)
  f.storage.setItem = () => { throw Error('quota') }
  assert.equal(a.edit('unsaved edit'), false)
  assert.equal(f.storage.getItem(a.key), before); assert.equal(a.getSnapshot().draft, 'original')
  assert.equal(a.getSnapshot().intent.body.content, 'original')
})

test('same body with replaced persisted draft revision cannot be settled by an old request', async () => {
  const f = fixture(), hold = deferred(), a = f.create({ send: async (_id, body) => { f.calls.push(body); return hold.promise } })
  a.edit('original'); const pending = a.submit(); await tick()
  const value = JSON.parse(f.storage.getItem(a.key)); value.draft.revision++; value.intent.draftRevision++
  const replaced = JSON.stringify(value); f.storage.setItem(a.key, replaced)
  hold.resolve(receipt(f.calls[0])); await pending
  assert.equal(f.storage.getItem(a.key), replaced); assert.equal(a.getSnapshot().status, 'uncertain')
  await a.retry(); assert.equal(f.calls.length, 1)
})

test('disposal from sending observer prevents dispatch but preserves persisted identity for explicit recovery', async () => {
  const f = fixture(), a = f.create()
  a.edit('message'); a.subscribe(() => { if (a.getSnapshot().status === 'sending') a.dispose() })
  await a.submit(); assert.equal(f.calls.length, 0)
  const b = f.create(); b.load(); assert.equal(b.getSnapshot().status, 'uncertain')
  await b.retry(); assert.equal(f.calls.length, 1); assert.equal(f.ids(), 2)
})

for (const operation of ['load', 'edit', 'failed retry']) test(`known admission survives ${operation} without claiming durable settlement`, async () => {
  const f = fixture(); let sends = 0, denySettlement = true
  const set = f.storage.setItem
  f.storage.setItem = (key, raw) => { if (denySettlement && JSON.parse(raw).intent?.receipt) throw Error('quota'); set(key, raw) }
  const a = f.create({ send: async (_id, body) => { sends++; if (sends > 1) throw Error('retry unavailable'); return receipt(body, 'accepted') } })
  a.edit('original'); await a.submit()
  const original = a.getSnapshot().intent
  assert.equal(a.getSnapshot().admission.status, 'accepted')
  if (operation === 'load') a.load()
  if (operation === 'edit') assert.equal(a.edit('new draft'), true)
  if (operation === 'failed retry') await a.retry()
  assert.equal(a.getSnapshot().admission?.status, 'accepted')
  assert.match(a.getSnapshot().error, /已收到.*无法保存确认状态/)
  assert.doesNotMatch(a.getSnapshot().error, /可能已经提交|接收结果尚未确认/)
  assert.equal(a.getSnapshot().intent.receipt, null)
  assert.deepEqual(a.getSnapshot().intent, original)
  assert.notEqual(a.getSnapshot().status, 'admitted')
  assert.equal(JSON.parse(f.storage.getItem(a.key)).intent.receipt, null)
  const count = sends; await a.submit(); assert.equal(sends, count); assert.equal(f.ids(), 2)
  assert.equal(a.getSnapshot().admission?.status, 'accepted')
  assert.match(a.getSnapshot().error, /已收到.*无法保存确认状态/)
  if (operation === 'edit') assert.equal(a.getSnapshot().draft, 'new draft')
  denySettlement = false
})

test('retained admission belongs to exact body and revision, never to replacement or disposed instances', async () => {
  for (const change of ['commandId', 'messageId', 'content', 'draftRevision']) {
    const f = fixture(); const set = f.storage.setItem
    f.storage.setItem = (key, raw) => { if (JSON.parse(raw).intent?.receipt) throw Error('quota'); set(key, raw) }
    const a = f.create({ send: async (_id, body) => receipt(body, 'accepted') })
    a.edit('original'); await a.submit(); a.load()
    assert.equal(a.getSnapshot().admission?.status, 'accepted')
    const value = JSON.parse(f.storage.getItem(a.key))
    if (change === 'draftRevision') { value.draft.revision++; value.intent.draftRevision++ }
    else value.intent.body[change] = `different-${change}`
    const replacement = JSON.stringify(value); set(a.key, replacement)
    a.load(); await a.retry()
    assert.equal(f.storage.getItem(a.key), replacement)
    assert.equal(a.getSnapshot().intent.body.content, 'original') // stale instance stays blocked on its old identity
    const b = f.create(); b.load(); assert.equal(b.getSnapshot().admission, null)
    a.dispose(); assert.equal(a.getSnapshot().admission, null)
    a.load(); await a.retry(); assert.equal(a.getSnapshot().admission, null)
  }
})

test('successful recovery clears warning but next intent cannot inherit the retained admission', async () => {
  const f = fixture(), set = f.storage.setItem; let deny = true, count = 0
  f.storage.setItem = (key, raw) => { if (deny && JSON.parse(raw).intent?.receipt) throw Error('quota'); set(key, raw) }
  const a = f.create({ send: async (_id, body) => { if (++count > 2) throw Error('lost new intent'); return receipt(body, 'accepted') } })
  a.edit('original'); await a.submit(); a.edit('newer draft')
  assert.equal(a.getSnapshot().admission?.status, 'accepted')
  deny = false; await a.retry()
  assert.equal(a.getSnapshot().status, 'admitted'); assert.equal(a.getSnapshot().error, null)
  assert.equal(a.getSnapshot().draft, 'newer draft')
  await a.submit(); assert.equal(a.getSnapshot().admission, null)
  assert.equal(a.getSnapshot().intent.body.content, 'newer draft')
  assert.equal(a.getSnapshot().status, 'uncertain')
})

test('old flight receipt cannot attach to replacement loaded by a settlement callback', async () => {
  const f = fixture(), set = f.storage.setItem; let a, replacement
  a = f.create({ send: async (_id, body) => receipt(body, 'accepted') })
  f.storage.setItem = (key, raw) => {
    const v = JSON.parse(raw)
    if (v.intent?.receipt) {
      set(key, raw); a.load() // observe old durable settlement before explicit replacement
      v.intent.body.commandId = 'replacement-command'; v.intent.receipt = null
      v.draft.revision++; v.intent.draftRevision = v.draft.revision
      replacement = JSON.stringify(v); set(key, replacement)
    } else set(key, raw)
  }
  a.edit('original'); await a.submit()
  // Read-back failure does not authorize attaching the old receipt to a different intent.
  assert.equal(f.storage.getItem(a.key), replacement)
  const b = f.create(); b.load(); assert.equal(b.getSnapshot().admission, null)
  if (a.getSnapshot().intent?.body.commandId === 'replacement-command') assert.equal(a.getSnapshot().admission, null)
})

test('failed persistence of a new intent cannot expose the previous admission on that new identity', async () => {
  const f = fixture(), a = f.create()
  a.edit('first'); await a.submit()
  const previousId = a.getSnapshot().intent.body.commandId
  a.edit('second'); f.storage.setItem = () => { throw Error('quota') }
  await a.submit()
  assert.notEqual(a.getSnapshot().intent.body.commandId, previousId)
  assert.equal(a.getSnapshot().intent.body.content, 'second')
  assert.equal(a.getSnapshot().admission, null)
  assert.equal(f.calls.length, 1)
})

test('concurrent unloaded joiner retains the validated receipt for its exact unresolved flight', async () => {
  const f = fixture(), set = f.storage.setItem, hold = deferred(); let sent
  f.storage.setItem = (key, raw) => { if (JSON.parse(raw).intent?.receipt) throw Error('quota'); set(key, raw) }
  const a = f.create({ send: async (_id, body) => { sent = body; return hold.promise } }), b = f.create()
  a.edit('original'); const first = a.submit(), joined = b.submit()
  await tick(); hold.resolve(receipt(sent, 'accepted')); await Promise.all([first, joined])
  for (const controller of [a, b]) {
    controller.load(); controller.edit('new draft')
    assert.equal(controller.getSnapshot().admission?.status, 'accepted')
    assert.equal(controller.getSnapshot().intent.receipt, null)
    assert.match(controller.getSnapshot().error, /已收到.*无法保存确认状态/)
  }
  assert.equal(f.ids(), 2)
})

test('loaded settled joiner adopts new flight admission through load edit and failed retry without extra sends', async () => {
  const f = fixture(), set = f.storage.setItem, hold = deferred(); let sends = 0, secondBody, deny = false
  f.storage.setItem = (key, raw) => { if (deny && JSON.parse(raw).intent?.receipt) throw Error('quota'); set(key, raw) }
  const a = f.create({ send: async (_id, body) => { sends++; if (sends === 1) return receipt(body); secondBody = body; return hold.promise } })
  const b = f.create({ send: async () => { sends++; throw Error('retry failed') } })
  a.edit('first'); await a.submit(); b.load()
  assert.equal(b.getSnapshot().intent.receipt.status, 'pending')
  a.edit('second'); deny = true
  const sending = a.submit(); await tick(); const joining = b.submit()
  hold.resolve(receipt(secondBody, 'accepted')); await Promise.all([sending, joining])
  const check = () => {
    assert.deepEqual(b.getSnapshot().admission, receipt(secondBody, 'accepted'))
    assert.deepEqual(b.getSnapshot().intent.body, secondBody)
    assert.equal(b.getSnapshot().intent.receipt, null)
    assert.match(b.getSnapshot().error, /已收到.*无法保存确认状态/)
  }
  check(); b.load(); check(); assert.equal(b.edit('new draft'), true); check()
  await b.submit(); check(); assert.equal(sends, 2)
  await b.retry(); check(); assert.equal(sends, 3)
  assert.equal(b.getSnapshot().draft, 'new draft'); assert.equal(f.ids(), 4)
  assert.equal(JSON.parse(f.storage.getItem(b.key)).intent.receipt, null)
})

for (const problem of ['invalid', 'save', 'storage', 'lost', 'replaced']) test(`known admission preserves actionable ${problem} error without claiming durable identity`, async () => {
  const f = fixture(), set = f.storage.setItem; let sends = 0
  f.storage.setItem = (key, raw) => { if (JSON.parse(raw).intent?.receipt) throw Error('quota'); set(key, raw) }
  const a = f.create({ send: async (_id, body) => { sends++; return receipt(body, 'accepted') } })
  a.edit('original'); await a.submit()
  const admission = a.getSnapshot().admission, original = a.getSnapshot().intent
  let expected
  if (problem === 'invalid') { assert.equal(a.edit('\0'), false); expected = /不能含 NUL/ }
  if (problem === 'save') { f.storage.setItem = () => { throw Error('quota') }; assert.equal(a.edit('new draft'), false); expected = /无法确认会话内容已保存/ }
  if (problem === 'storage') { f.storage.getItem = () => { throw Error('denied') }; a.load(); expected = /无法读取或验证会话存储/ }
  if (problem === 'lost') { f.storage.map.delete(a.key); a.load(); expected = /原请求已消失或发生变化/ }
  if (problem === 'replaced') { const value = JSON.parse(f.storage.getItem(a.key)); value.intent.body.commandId = 'replacement'; set(a.key, JSON.stringify(value)); a.load(); expected = /原请求已消失或发生变化/ }
  assert.match(a.getSnapshot().error, expected)
  assert.doesNotMatch(a.getSnapshot().error, /原身份仍保留/)
  assert.deepEqual(a.getSnapshot().admission, admission)
  assert.deepEqual(a.getSnapshot().intent, original)
  assert.equal(a.getSnapshot().draft, 'original')
  if (['storage', 'lost', 'replaced'].includes(problem)) {
    await a.retry(); assert.match(a.getSnapshot().error, expected)
    await a.submit(); assert.match(a.getSnapshot().error, expected)
    assert.equal(sends, 1); assert.equal(f.ids(), 2)
    if (problem === 'replaced') { const b = f.create(); b.load(); assert.equal(b.getSnapshot().admission, null) }
  }
})

test('loaded joiner never associates a new flight receipt with unrelated persisted body or revision', async () => {
  for (const field of ['commandId', 'messageId', 'content', 'draftRevision']) {
    const f = fixture(), set = f.storage.setItem, hold = deferred(); let second, count = 0
    const a = f.create({ send: async (_id, body) => { if (++count === 1) return receipt(body); second = body; return hold.promise } }), b = f.create()
    a.edit('first'); await a.submit(); b.load(); a.edit('second')
    const flight = a.submit(); await tick(); const joined = b.submit()
    const changed = JSON.parse(f.storage.getItem(a.key))
    if (field === 'draftRevision') { changed.draft.revision++; changed.intent.draftRevision++ }
    else changed.intent.body[field] = `replacement-${field}`
    const raw = JSON.stringify(changed); set(a.key, raw)
    hold.resolve(receipt(second, 'accepted')); await Promise.all([flight, joined])
    assert.equal(f.storage.getItem(a.key), raw)
    assert.deepEqual(b.getSnapshot().intent, changed.intent)
    assert.equal(b.getSnapshot().admission, null)
    assert.match(b.getSnapshot().error, /原请求已消失或发生变化/)
    assert.doesNotMatch(b.getSnapshot().error, /已收到消息接收回执/)
    assert.equal(count, 2); assert.equal(f.ids(), 4)
  }
})
