import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EventSeq, SessionBinding, SessionId } from '@wemux/domain'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

// Port readers must never expose uncommitted sequence numbers to the transport.
test('public reads wait for transaction rollback', async () => {
  const store = new SqliteWorkerStore(':memory:')
  const id = 'session' as SessionId
  const binding = JSON.parse('{"workspaceId":"workspace","agent":{"workerId":"worker","agentKey":"test"},"modelId":"test"}') as SessionBinding
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const transaction = store.transaction(async tx => {
      await tx.sessions.createSession(id, binding)
      entered()
      await gate
      throw new Error('abort')
    })
    const rejection = assert.rejects(transaction, /abort/)
    await ready
    let readFinished = false
    const read = store.journal.read({ sessionId: id, fromSeq: 1 as EventSeq, limit: 100 }).then(page => { readFinished = true; return page })
    await Promise.resolve()
    assert.equal(readFinished, false)
    release()
    await rejection
    assert.deepEqual((await read).events, [])
    assert.equal(await store.sessions.get(id), null)
  } finally { store.close() }
})
