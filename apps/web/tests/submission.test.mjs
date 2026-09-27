import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SubmissionController } from '../src/features/sessions/submission.ts'
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const ack = body => ({ ...body, status: 'accepted' })
test('uncertain 5xx retains identity across view subscriptions and same-text new draft survives confirmation', async () => {
  const bodies = []; let count = 0
  const controller = new SubmissionController({ send: async (_, body) => { bodies.push(body); if (!count++) throw { status: 502 }; return ack(body) }, command: async () => ({ status: 'accepted' }) }, 's')
  controller.edit('hello'); await controller.send()
  const unsub = controller.subscribe(() => {}); unsub()
  assert.equal(controller.state.draft, 'hello')
  await controller.send(); assert.equal(bodies[0].commandId, bodies[1].commandId)
  controller.edit('hello'); controller.confirm([bodies[0].messageId]); assert.equal(controller.state.draft, 'hello')
  controller.dispose()
})
test('late receipt cannot clear newer submission identity or replace newer draft', async () => {
  const old = deferred(); const next = deferred(); let calls = 0
  const controller = new SubmissionController({ send: async (_, body) => ack(body), command: () => ++calls === 1 ? old.promise : next.promise }, 's')
  controller.edit('A'); const first = controller.send(); await new Promise(resolve => setImmediate(resolve))
  controller.edit('B'); const second = controller.send(); await new Promise(resolve => setImmediate(resolve))
  const identity = controller.state.attempt.commandId
  controller.edit('new draft'); old.resolve({ status: 'rejected' }); await first
  assert.equal(controller.state.attempt.commandId, identity); assert.equal(controller.state.draft, 'new draft')
  next.resolve({ status: 'accepted' }); await second; controller.dispose()
})
test('dispose aborts HTTP without claiming server-side retraction and ignores late response', async () => {
  const response = deferred(); let signal
  const controller = new SubmissionController({ send: (_, body, s) => { signal = s; return response.promise }, command: async () => ({ status: 'accepted' }) }, 's')
  controller.edit('sensitive'); const send = controller.send(); controller.dispose()
  assert.equal(signal.aborted, true); response.resolve({}); await send
  assert.equal(controller.state.draft, ''); assert.equal(controller.state.attempt, null)
})

test('optimistic echo survives reconnect, deduplicates retry and yields to Journal exactly once', async () => {
 const controller = new SubmissionController({ send: async () => { throw { status: 504 } }, command: async () => ({ status: 'pending' }) }, 's')
 controller.edit('recoverable'); await controller.send()
 const id = controller.state.echoes[0].messageId
 await controller.send()
 assert.equal(controller.state.echoes.length, 1); assert.equal(controller.state.echoes[0].messageId, id)
 controller.confirm([id]); controller.confirm([id])
 assert.equal(controller.state.echoes.length, 0); assert.equal(controller.state.draft, 'recoverable')
 controller.dispose()
})

test('page refresh starts without speculative messages; authoritative Journal supplies saved history', () => {
 const api = { send: async () => ({}), command: async () => ({}) }
 const before = new SubmissionController(api, 's'); before.edit('unsubmitted private input'); before.dispose()
 const after = new SubmissionController(api, 's')
 assert.equal(after.state.draft, ''); assert.deepEqual(after.state.echoes, [])
 after.confirm(['journal-message']); assert.deepEqual(after.state.echoes, [])
 after.dispose()
})

for (const outcome of ['ack', 'timeout', 'receipt-error']) test(`Journal confirmation is terminal before late ${outcome}`, async () => {
 const held = deferred(); let body
 const controller = new SubmissionController({ send: (_, value) => { body = value; return outcome === 'receipt-error' ? Promise.resolve(ack(value)) : held.promise }, command: () => held.promise }, 's')
 controller.edit('hello'); const pending = controller.send()
 await new Promise(resolve => setImmediate(resolve))
 controller.edit('new draft'); controller.confirm([body.messageId])
 if (outcome === 'ack') held.resolve(ack(body)); else held.reject({status:504})
 await pending
 assert.equal(controller.state.draft, 'new draft'); assert.equal(controller.state.attempt, null)
 assert.equal(controller.state.pending, false); assert.equal(controller.state.error, ''); assert.equal(controller.state.receipt, null)
 controller.dispose()
})
test('synchronous send throw leaves editor intact without a speculative completion', async () => {
 const controller = new SubmissionController({ send: () => { throw new Error('sync failure') }, command: async () => ({}) }, 's')
 controller.edit('keep text'); await controller.send()
 assert.equal(controller.state.draft,'keep text'); assert.equal(controller.state.pending,false)
 assert.equal(controller.state.attempt,null); assert.deepEqual(controller.state.echoes,[])
 assert.equal(controller.state.error,'sync failure'); controller.dispose()
})

test('edit prefill keeps Journal immutable and marks the next send as a new message', async () => {
 const bodies = []; let id = 0
 const controller = new SubmissionController({ send: async (_, body) => { bodies.push(body); return ack(body) }, command: async () => ({ status: 'accepted' }) }, 's', () => `id-${++id}`)
 controller.prefillForEdit('original text')
 assert.equal(controller.state.draft, 'original text')
 assert.equal(controller.state.draftNotice, '\u7f16\u8f91\u91cd\u53d1\u5c06\u4f5c\u4e3a\u65b0\u6d88\u606f\u53d1\u9001\uff0c\u5bf9\u8bdd\u5386\u53f2\u4e0d\u4f1a\u6539\u5199\u3002')
 controller.edit('edited text')
 assert.equal(controller.state.draftNotice, '\u7f16\u8f91\u91cd\u53d1\u5c06\u4f5c\u4e3a\u65b0\u6d88\u606f\u53d1\u9001\uff0c\u5bf9\u8bdd\u5386\u53f2\u4e0d\u4f1a\u6539\u5199\u3002')
 await controller.send()
 assert.equal(bodies[0].content, 'edited text')
 assert.equal(bodies[0].messageId, 'id-2')
 controller.dispose()
})

test('failed retry reuses uncertain request identity while Journal retry sends a new message', async () => {
 const bodies = []; let id = 0; let fail = true
 const controller = new SubmissionController({ send: async (_, body) => { bodies.push(body); if (fail) throw { status: 504 }; return ack(body) }, command: async () => ({ status: 'accepted' }) }, 's', () => `id-${++id}`)
 controller.edit('failed text'); await controller.send()
 const failedId = controller.state.attempt.messageId
 fail = false; await controller.retryAttempt(failedId)
 assert.equal(bodies[1].messageId, failedId)
 await controller.resendAsNew('journal failure text')
 assert.notEqual(bodies[2].messageId, failedId)
 assert.equal(bodies[2].content, 'journal failure text')
 controller.dispose()
})
