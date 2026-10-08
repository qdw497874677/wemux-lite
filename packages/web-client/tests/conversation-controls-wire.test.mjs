import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient, ApiError } from '../src/index.ts'
const account = { username: 'owner', teamId: 'team', csrfToken: 'csrf', email: null, instanceAdministrator: false }
const make = fetcher => createClusterClient(account, () => {}, { origin: 'http://controls.test', fetcher })
const contract = e => e instanceof ApiError && e.kind === 'contract'
test('queue cancel and explicit Turn stop use escaped targets and exact caller bodies, admission only', async () => {
  const calls = [], api = make(async (url, init) => { calls.push({ url, init }); return Response.json({ commandId: JSON.parse(init.body).commandId, outcome: 'cancelled' }, { status: 202 }) })
  assert.deepEqual(await api.cancelQueuedMessage('s/x', 'enqueue/x', { commandId: 'cancel', messageId: 'not-target' }), { commandId: 'cancel' })
  assert.deepEqual(await api.stopTurn('s/x', { commandId: 'stop', turnId: 'turn/x', target: 'ignored' }), { commandId: 'stop' })
  assert.deepEqual(calls.map(c => c.url.pathname), ['/api/sessions/s%2Fx/messages/enqueue%2Fx/cancel', '/api/sessions/s%2Fx/turn/stop'])
  assert.deepEqual(calls.map(c => JSON.parse(c.init.body)), [{ commandId: 'cancel' }, { commandId: 'stop', turnId: 'turn/x' }])
  for (const c of calls) { assert.equal(c.init.method, 'POST'); assert.equal(c.url.searchParams.get('teamId'), 'team'); assert.equal(c.init.headers['X-CSRF-Token'], 'csrf') }
})
test('control receipt mismatch and malformed bodies fail closed with bounded explicit IDs', async () => {
  for (const receipt of [null, {}, { commandId: 'wrong' }, { commandId: 2 }]) {
    const api = make(async () => Response.json(receipt)); await assert.rejects(api.stopTurn('s', { commandId: 'c', turnId: 't' }), contract)
    await assert.rejects(api.cancelQueuedMessage('s', 'enqueue', { commandId: 'c' }), contract)
  }
  let calls = 0; const api = make(async () => { calls++; return Response.json({ commandId: 'c' }) })
  for (const id of ['', ' ', 'x'.repeat(201), 'x\0']) {
    await assert.rejects(api.stopTurn(id, { commandId: 'c', turnId: 't' }), contract)
    await assert.rejects(api.stopTurn('s', { commandId: id, turnId: 't' }), contract)
    await assert.rejects(api.stopTurn('s', { commandId: 'c', turnId: id }), contract)
    await assert.rejects(api.cancelQueuedMessage('s', id, { commandId: 'c' }), contract)
  }
  await assert.rejects(api.stopTurn('s', { commandId: 'c' }), contract); assert.equal(calls, 0)
})
test('approval sends only immutable explicit identity and validates admission', async () => {
  const calls = [], api = make(async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ commandId: 'c' }, { status: 202 }) })
  assert.deepEqual(await api.resolveApproval('s/x', 'a/x', { commandId: 'c', turnId: 't', decision: 'deny' }), { commandId: 'c' })
  assert.equal(calls[0].url.pathname, '/api/sessions/s%2Fx/runtime/approvals/a%2Fx')
  assert.deepEqual(calls[0].body, { commandId: 'c', turnId: 't', decision: 'deny' })
  for (const body of [{ commandId: 'c', decision: 'approve' }, { commandId: 'c', turnId: 't', decision: 'yes' }]) await assert.rejects(api.resolveApproval('s', 'a', body), contract)
  assert.equal(calls.length, 1)
  await assert.rejects(make(async () => Response.json({ commandId: 'other' })).resolveApproval('s', 'a', { commandId: 'c', turnId: 't', decision: 'approve' }), contract)
})
test('model selection freezes exact wire body through CSRF refresh and validates admission', async () => {
  let release, entered; const gate = new Promise(r => { release = r }), waiting = new Promise(r => { entered = r }), calls = []
  const api = make(async (url, init) => {
    if (url.pathname === '/api/auth/me') { entered(); await gate; return Response.json({ csrfToken: 'new' }) }
    calls.push({ path: url.pathname, body: JSON.parse(init.body) })
    return calls.length === 1 ? Response.json({}, { status: 403 }) : Response.json({ commandId: 'c' }, { status: 202 })
  })
  const body = { commandId: 'c', modelId: 'provider::next' }, request = api.selectModel('s/x', body)
  await waiting; body.modelId = 'other'; release()
  assert.deepEqual(await request, { commandId: 'c' })
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ path: '/api/sessions/s%2Fx/runtime/commands', body: { commandId: 'c', name: 'set_model', arguments: { modelId: 'provider::next' } } })))
  for (const modelId of ['', ' ', 'x\0', 'x'.repeat(201), null]) await assert.rejects(api.selectModel('s', { commandId: 'c', modelId }), contract)
  assert.equal(calls.length, 2)
  await assert.rejects(make(async () => Response.json({ commandId: 'other' })).selectModel('s', { commandId: 'c', modelId: 'next' }), contract)
})

test('both control bodies remain unchanged while CSRF refresh is pending', async () => {
  for (const operation of ['cancel', 'stop']) {
    let release, refreshed; const waiting = new Promise(r => { refreshed = r }); const gate = new Promise(r => { release = r }); const calls = []
    const api = make(async (url, init) => {
      if (url.pathname === '/api/auth/me') { refreshed(); await gate; return Response.json({ csrfToken: 'fresh' }) }
      calls.push(JSON.parse(init.body)); return calls.length === 1 ? Response.json({}, { status: 403 }) : Response.json({ commandId: 'c' })
    })
    const body = { commandId: 'c', turnId: 'turn-one' }
    const p = operation === 'cancel' ? api.cancelQueuedMessage('s', 'enqueue', body) : api.stopTurn('s', body)
    await waiting; body.commandId = 'changed'; body.turnId = 'turn-two'; release(); assert.deepEqual(await p, { commandId: 'c' })
    assert.deepEqual(calls, operation === 'cancel' ? [{ commandId: 'c' }, { commandId: 'c' }] : [{ commandId: 'c', turnId: 'turn-one' }, { commandId: 'c', turnId: 'turn-one' }])
  }
})
