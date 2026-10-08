import test from 'node:test'
import assert from 'node:assert/strict'
import * as fixture from './abort-race-fixture.mjs'
import { expectedAcceptanceAbort } from './acceptance-diagnostics.mjs'

const { runAbortRaceFixture } = fixture

for (let failures = 0; failures < 16; failures++) {
  test(`abort fixture cleanup attempts every step and retains errors (failure mask ${failures})`, async () => {
    const steps = ['scenario', 'write-evidence', 'close-browser', 'close-server']
    const calls = []
    const errors = steps.map(step => new Error(step))
    const expectedErrors = errors.filter((_, index) => failures & (1 << index))
    const action = index => async () => {
      calls.push(steps[index])
      if (failures & (1 << index)) throw errors[index]
      return 'scenario result'
    }
    const result = fixture.runWithAbortFixtureCleanup(action(0), [action(1), action(2), action(3)])
    if (!expectedErrors.length) assert.equal(await result, 'scenario result')
    else await assert.rejects(result, error => {
      if (expectedErrors.length === 1) assert.equal(error, expectedErrors[0])
      else {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.cause, expectedErrors[0])
        assert.deepEqual(error.errors, expectedErrors)
      }
      return true
    })
    assert.deepEqual(calls, steps)
  })
}

test('abort fixture cleanup handles synchronous throws and missing resources', async () => {
  const scenarioError = new Error('scenario')
  const closeError = new Error('server close')
  let serverClosed = false
  await assert.rejects(fixture.runWithAbortFixtureCleanup(() => { throw scenarioError }, [
    () => undefined, // Browser acquisition failed; there is nothing to close.
    () => { serverClosed = true; throw closeError },
  ]), error => {
    assert.equal(error.cause, scenarioError)
    assert.deepEqual(error.errors, [scenarioError, closeError])
    return true
  })
  assert.equal(serverClosed, true)
})

const configured = !!(process.env.PLAYWRIGHT_CORE_PATH && process.env.PLAYWRIGHT_CHROMIUM_PATH)
test('credential-free Chromium: exact request joins prove cancellation mechanisms, not acceptance', { skip: configured ? false : 'Explicit local Chromium configuration required', timeout: 60000 }, async () => {
  const result = await runAbortRaceFixture()
  const events = result.events
  function one(requestId, source, event) {
    const matches = events.filter(e => e.requestId === requestId && e.source === source && e.event === event)
    assert.equal(matches.length, 1, `${requestId}: ${source}/${event} exact join`)
    return matches[0]
  }
  for (const id of result.cancelled) {
    one(id, 'document', 'fetch-start'); one(id, 'browser', 'request'); one(id, 'server', 'received')
    const signal = one(id, 'document', 'signal-abort')
    const close = one(id, 'server', 'closed')
    one(id, 'browser', 'failed')
    assert.equal(close.ended, false, `${id}: server response not completed`)
    assert.equal(signal.reason, 'AbortError')
    const browserResponse = events.find(e => e.requestId === id && e.source === 'browser' && e.event === 'response')
    assert.equal(expectedAcceptanceAbort({ method: 'GET', path: one(id, 'server', 'received').path, status: browserResponse?.status, contentType: browserResponse?.contentType, aborted: true, startEpoch: 0 }), false, `${id}: mechanism is not a waiver`)
  }
  for (const scenario of ['sse', 'scope']) {
    for (const kind of ['project', 'session']) {
      const id = result.ids[scenario][kind]
      assert.equal(one(id, 'browser', 'response').status, 200)
      assert.equal(one(id, 'server', 'headers').status, 200)
      const action = events.find(e => e.source === 'document' && e.event === (scenario === 'sse' ? 'unsubscribe' : 'unauthorized-response'))
      assert.ok(action.documentSeq < one(id, 'document', 'signal-abort').documentSeq)
    }
  }
  assert.equal(one(result.ids.unauthorized, 'document', 'fetch-response').status, 401)
  assert.equal(one(result.ids.unauthorized, 'browser', 'response').status, 401)
  assert.equal(one(result.ids.unauthorized, 'server', 'headers').status, 401)
  assert.ok(one(result.ids.unauthorized, 'document', 'fetch-response').documentSeq < one(result.ids.unauthorized, 'document', 'signal-abort').documentSeq)
  const query = result.ids.query
  assert.ok(events.some(e => e.source === 'document' && e.event === 'query-cancel-call'))
  for (const id of query) {
    assert.ok(events.find(e => e.event === 'query-cancel-call').documentSeq < one(id, 'document', 'signal-abort').documentSeq)
    assert.equal(events.some(e => e.requestId === id && e.source === 'server' && e.event === 'headers'), false)
  }
  const late = one(result.ids.late, 'browser', 'request')
  const intent = events.find(e => e.event === 'navigation-start')
  const commit = events.find(e => e.event === 'main-frame-confirmed')
  assert.ok(intent.seq < late.seq && late.seq < commit.seq)
  assert.equal(late.startEpoch, 0)
  const failure = one(result.ids.late, 'browser', 'failed')
  assert.equal(failure.navigation?.requestWasPending ?? false, false)
  assert.equal(one(result.ids.late, 'document', 'fetch-start').documentId, 'old-document')
  assert.ok(one(result.ids.late, 'document', 'signal-abort').seq < commit.seq)
  const drop = result.ids.drop
  one(drop, 'browser', 'failed')
  assert.ok(events.some(e => e.requestId === drop && e.source === 'server' && e.event === 'socket-destroy')) // Chromium may retry the same GET on another socket.
  assert.equal(events.some(e => e.requestId === drop && e.event === 'signal-abort'), false)
  for (const id of [result.ids.http500, result.ids.private401]) {
    assert.ok([500, 401].includes(one(id, 'browser', 'response').status))
    one(id, 'browser', 'finished')
    assert.equal(events.some(e => e.requestId === id && e.event === 'signal-abort'), false)
  }
  assert.equal(result.externalRequests, 0)
  assert.equal(result.nonGetRequests, 0)
})

test('abort-race counterexamples remain unexpected even with confirmed navigation and identity evidence', () => {
  for (const [path, status, aborted] of [['/api/workers', 401, true], ['/api/projects/p/events', 500, true], ['/api/projects', undefined, true], ['/favicon.ico', 200, true], ['/api/projects', 200, false]]) {
    assert.equal(expectedAcceptanceAbort({ method: 'GET', path, status, contentType: 'text/event-stream', aborted, startEpoch: 0, navigation: { confirmed: true, requestWasPending: true, method: 'reload', fromEpoch: 0, toEpoch: 1 }, identity: { confirmed: true, reason: 'revoked-current-login' } }), false)
  }
})
