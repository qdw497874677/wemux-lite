import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId, Timestamp } from '@wemux/domain'
import { MemorySessionStore, type AgentEvent } from '../src/index.js'

const key = { appName: 'wemux', userId: 'local', sessionId: 'session-1' as SessionId }
const at = '2026-01-01T00:00:00.000Z' as Timestamp

function event(id: string, options: Partial<AgentEvent> = {}): AgentEvent {
  return { id, invocationId: 'invocation-1', author: 'agent', actions: {}, timestamp: at, ...options }
}

test('partial events stream without entering persistent session history', async () => {
  const store = new MemorySessionStore()
  const session = await store.getOrCreate(key)
  const partial = event('partial', { partial: true })
  assert.equal(await store.appendEvent({ session, event: partial }), partial)
  assert.deepEqual((await store.get(key))?.events, [])
})

test('non-partial events append idempotently and apply state delta', async () => {
  const store = new MemorySessionStore()
  const session = await store.getOrCreate({ ...key, state: { existing: true } })
  await store.appendEvent({ session, event: event('final', { actions: { stateDelta: { answer: 42 } } }) })
  const current = await store.get(key)
  assert.deepEqual(current?.state, { existing: true, answer: 42 })
  assert.equal(current?.events.length, 1)

  await store.appendEvent({ session: current!, event: event('final', { author: 'replacement', actions: {} }) })
  const replaced = await store.get(key)
  assert.equal(replaced?.events.length, 1)
  assert.equal(replaced?.events[0]?.author, 'replacement')
})
