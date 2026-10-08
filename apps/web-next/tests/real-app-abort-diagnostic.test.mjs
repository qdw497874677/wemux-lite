import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runRealAppAbortDiagnostic } from './real-app-abort-diagnostic.mjs'
import { withRealAppAbortEvidence } from './real-app-abort-evidence.mjs'

function one(result, id, source, event) {
  const matches = result.events.filter(item => item.id === id && item.source === source && item.event === event)
  assert.equal(matches.length, 1, `${id}: exact ${source}/${event} identity`)
  return matches[0]
}
function verify(result, aborted) {
  assert.equal(result.actualAppMounted, true)
  assert.deepEqual(result.violations, [])
  const id = result.target
  const start = one(result, id, 'document', 'fetch-start')
  assert.equal(start.hasSignal, true)
  assert.equal(start.alreadyAborted, false)
  const received = one(result, id, 'server', 'received')
  assert.equal(received.path, '/api/sessions/local-session/events')
  assert.equal(received.method, 'GET')
  const gate = one(result, id, 'server', 'gate-held')
  const route = one(result, id, 'driver', 'route-click')
  const signal = one(result, id, 'document', 'signal-abort')
  assert.ok(received.sequence < gate.sequence && gate.sequence < route.sequence)
  assert.ok(route.sequence < signal.sequence)
  assert.equal(signal.reason, 'AbortError')
  assert.equal(signal.path, '/projects')
  const close = one(result, id, 'server', 'closed')
  assert.equal(close.ended, !aborted)
  assert.equal(close.headersSent, !aborted)
  const request = one(result, id, 'browser', 'request')
  const terminal = one(result, id, 'browser', aborted ? 'failed' : 'finished')
  assert.equal(request.browserId, terminal.browserId)
  if (aborted) {
    assert.equal(terminal.reason, 'net::ERR_ABORTED')
    assert.equal(terminal.status, null)
    assert.equal(result.events.some(e => e.id === id && e.source === 'browser' && e.event === 'response'), false)
    assert.equal(one(result, id, 'document', 'fetch-rejected').signalAborted, true)
  } else {
    assert.equal(one(result, id, 'browser', 'response').status, 200)
    assert.ok(terminal.sequence < route.sequence)
    assert.equal(result.events.some(e => e.id === id && e.event === 'failed'), false)
  }
  const favicon = result.faviconId
  const response = one(result, favicon, 'browser', 'response')
  assert.equal(response.status, 200)
  assert.match(response.contentType, /^image\/svg\+xml/)
  assert.equal(one(result, favicon, 'browser', 'finished').browserId, response.browserId)
  assert.equal(result.events.some(e => e.id === favicon && e.event === 'failed'), false)
  assert.equal(one(result, favicon, 'server', 'closed').ended, true)
  // Native icon requests remain separately identifiable (not conflated with fetch).
  const native = result.events.filter(e => e.id === 'favicon' && e.source === 'browser')
  assert.ok(native.some(e => e.event === 'response' && e.status === 200))
  assert.ok(native.some(e => e.event === 'finished'))
  assert.equal(native.some(e => e.event === 'failed'), false)
}

test('real App held history read: no-abort regression oracle is RED on exact browser symptom', { timeout: 60000 }, () => withRealAppAbortEvidence(async evidence => {
  await assert.rejects(runRealAppAbortDiagnostic({ evidence, assertNoAbort: true }), /RED: real App route cleanup produced net::ERR_ABORTED/)
  const result = JSON.parse(await readFile(`${evidence}/result.json`, 'utf8'))
  assert.equal(result.passed, false)
  verify(result, true)
}))

test('real App completed history read: same route cleanup is GREEN without a network abort', { timeout: 60000 }, () => withRealAppAbortEvidence(async evidence => {
  const result = await runRealAppAbortDiagnostic({ evidence, releaseBeforeNavigation: true, assertNoAbort: true })
  assert.equal(result.passed, true)
  verify(result, false)
}))
