import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { observeAcceptanceNavigation } from './acceptance-navigation.mjs'
import { expectedAcceptanceAbort } from './acceptance-diagnostics.mjs'

function fixture() {
  const page = new EventEmitter(), frame = {}, commits = []
  page.mainFrame = () => frame
  for (const method of ['goto', 'reload', 'goBack']) page[method] = () => new Promise((resolve, reject) => commits.push({ resolve, reject }))
  const events = [], observer = observeAcceptanceNavigation(page, event => events.push(event))
  return { page, frame, commits, events, observer }
}
const stream = { method: 'GET', path: '/api/sessions/s1/stream', status: 200, contentType: 'text/event-stream', aborted: true, startEpoch: 0 }

test('pending SSE failure before main-frame confirmation is classified after that navigation settles', async () => {
  const { page, frame, commits, observer } = fixture()
  const request = {}; page.emit('request', request)
  const moving = observer.navigate('reload')
  let expected = false
  observer.failure(request, navigation => { expected = expectedAcceptanceAbort({ ...stream, navigation }) })
  assert.equal(expected, false, 'no expectation before confirmation')
  page.emit('framenavigated', frame)
  commits[0].resolve(); await moving
  assert.equal(expected, true)
})

test('a late failure keeps the original pending-request navigation, not a later page snapshot', async () => {
  const { page, frame, commits, observer } = fixture()
  const request = {}; page.emit('request', request)
  const first = observer.navigate('goto')
  page.emit('framenavigated', frame); commits[0].resolve(); await first
  const second = observer.navigate('reload')
  let evidence
  observer.failure(request, navigation => { evidence = navigation })
  page.emit('framenavigated', frame); commits[1].resolve(); await second
  assert.equal(evidence.fromEpoch, 0)
  assert.equal(evidence.toEpoch, 1)
  assert.equal(expectedAcceptanceAbort({ ...stream, navigation: evidence }), true)
})

test('subframe confirmation and navigation rejection cannot excuse a cancellation', async () => {
  const { page, commits, observer } = fixture()
  const request = {}; page.emit('request', request)
  const moving = observer.navigate('reload')
  let expected = false, calls = 0
  observer.failure(request, navigation => { calls++; expected = expectedAcceptanceAbort({ ...stream, navigation }) })
  page.emit('framenavigated', {})
  commits[0].reject(new Error('fixture navigation rejected'))
  await assert.rejects(moving)
  assert.equal(calls, 1)
  assert.equal(expected, false)
})

test('requests started after navigation begins do not inherit its pending-request proof', async () => {
  const { page, frame, commits, observer } = fixture()
  const moving = observer.navigate('goto')
  const request = {}; page.emit('request', request)
  let expected
  observer.failure(request, navigation => { expected = expectedAcceptanceAbort({ ...stream, startEpoch: observer.startEpoch(request), navigation }) })
  page.emit('framenavigated', frame); commits[0].resolve(); await moving
  assert.equal(expected, false)
})

test('a finished request is not captured as pending by subsequent navigation', async () => {
  const { page, frame, commits, observer } = fixture()
  const request = {}; page.emit('request', request); page.emit('requestfinished', request)
  const moving = observer.navigate('goBack')
  assert.equal(observer.snapshot(request)?.requestWasPending, false)
  page.emit('framenavigated', frame); commits[0].resolve(); await moving
})

test('no-navigation failures are immediately reported as unexpected', () => {
  const { page, observer } = fixture()
  const request = {}; page.emit('request', request)
  let calls = 0
  observer.failure(request, navigation => { calls++; assert.equal(expectedAcceptanceAbort({ ...stream, navigation }), false) })
  assert.equal(calls, 1)
})

test('main-frame commit followed by failed navigation remains unexpected', async () => {
  const { page, frame, commits, observer } = fixture()
  const request = {}; page.emit('request', request)
  const moving = observer.navigate('reload')
  let expected
  observer.failure(request, navigation => { expected = expectedAcceptanceAbort({ ...stream, navigation }) })
  page.emit('framenavigated', frame)
  commits[0].reject(new Error('fixture navigation rejected after commit'))
  await assert.rejects(moving)
  assert.equal(expected, false)
})

test('navigation intent does not relabel old-document requests before main-frame commit', async () => {
  const { page, frame, commits, observer } = fixture()
  const moving = observer.navigate('reload')
  const oldDocumentRequest = {}; page.emit('request', oldDocumentRequest)
  assert.equal(observer.startEpoch(oldDocumentRequest), 0)
  page.emit('framenavigated', frame)
  const newDocumentRequest = {}; page.emit('request', newDocumentRequest)
  assert.equal(observer.startEpoch(newDocumentRequest), 1)
  commits[0].resolve(); await moving
  // Better attribution is not evidence that either request was pending at intent.
  for (const request of [oldDocumentRequest, newDocumentRequest]) {
    observer.failure(request, navigation => assert.equal(expectedAcceptanceAbort({ ...stream, startEpoch: observer.startEpoch(request), navigation }), false))
  }
})

test('rejected navigation without commit leaves the document epoch unchanged', async () => {
  const { commits, observer } = fixture()
  const moving = observer.navigate('reload')
  commits[0].reject(new Error('fixture navigation rejected'))
  await assert.rejects(moving)
  assert.equal(observer.epoch(), 0)
})
