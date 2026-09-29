import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterJournal, createLocalJournal, normalizeLocalJournalPage } from '../src/hosts/session-journal.ts'

const event = seq => ({ sessionId: 'local-session', seq, occurredAt: new Date().toISOString(), payload: { kind: 'session.runtime.changed', state: 'idle', reason: null } })

test('local journal uses forward cursor, synced freshness and rejects gaps/incorrect server cursors', async () => {
  const calls = []
  const journal = createLocalJournal(async (url, options) => {
    calls.push({ url, options })
    return Response.json({ events: [event(1), event(2)], throughSeq: 2, hasMore: false })
  })
  const page = await journal.events('local-session', 0)
  assert.equal(calls[0].url, '/api/local/workbench/sessions/local-session/journal?fromSeq=1&limit=500')
  assert.equal(calls[0].options.credentials, 'same-origin')
  assert.equal(page.freshness.status, 'synced')
  assert.equal(page.throughSeq, 2)
  assert.throws(() => normalizeLocalJournalPage({ events: [event(2)], throughSeq: 2, hasMore: false }, 0), /gap/)
  assert.throws(() => normalizeLocalJournalPage({ events: [event(1)], throughSeq: 0, hasMore: false }, 0), /gap/)
  assert.deepEqual(normalizeLocalJournalPage({ events: [], throughSeq: 0, hasMore: false }, 0).events, [])
})

test('local journal SSE replays from the next sequence and notifies Surface on streamed events', async () => {
  const calls = []
  let close
  const stream = new ReadableStream({ start(controller) { close = controller } })
  const journal = createLocalJournal(async (url, options) => {
    calls.push({ url, options })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  const changes = []
  const states = []
  const stop = journal.watch('local-session', 4, () => changes.push('changed'), value => states.push(value))
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls[0].url, '/api/local/workbench/sessions/local-session/events?fromSeq=5')
    assert.deepEqual(states, ['live'])
    close.enqueue(new TextEncoder().encode('id: 5\nevent: journal\ndata: {"seq":5}\n\n'))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(changes.length, 2, 'connect and journal event each trigger a history fetch')
  } finally { stop(); await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.equal(calls.length, 1, 'unmount must not reconnect')
})

test('SSE reconnect cannot advance the verified journal cursor on a forged id', async () => {
  const requests = []
  let streamController
  const journal = createLocalJournal(async (url) => {
    requests.push(url)
    return new Response(new ReadableStream({ start(controller) { streamController = controller } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const stop = journal.watch('local-session', 4, () => {}, () => {})
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    streamController.enqueue(new TextEncoder().encode('id: 9999\nevent: journal\ndata: {"seq":9999}\n\n'))
    streamController.close()
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(requests.length, 2)
    assert.equal(requests[1], '/api/local/workbench/sessions/local-session/events?fromSeq=5')
  } finally { stop() }
})

test('cluster Adapter delegates the same journal Interface without rewriting server freshness', async () => {
  const page = { events: [event(1)], throughSeq: 1, hasMore: false, freshness: { status: 'gap' } }
  const api = { events: async () => page, watch: () => () => {} }
  assert.equal(await createClusterJournal(api).events('s', 0), page)
})

test('local journal uses Worker cookie scope and signals unauthorized without cluster auth', async () => {
  let expired = 0
  const journal = createLocalJournal(async () => new Response('', { status: 401 }), () => expired++)
  await assert.rejects(journal.events('s', 0), /HTTP 401/)
  assert.equal(expired, 1)
})
