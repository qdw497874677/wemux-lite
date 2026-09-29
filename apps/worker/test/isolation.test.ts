import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventSeq, SessionBinding, SessionId } from '@wemux/domain'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

// Port readers must never expose uncommitted sequence numbers to the transport.
test('旧 Worker Session 缺省为 local，未知模式不能创建或落盘', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-storage-mode-'))
  const path = join(home, 'worker.sqlite')
  const store = new SqliteWorkerStore(path)
  const binding = JSON.parse('{"workspaceId":"workspace","agent":{"workerId":"worker","agentKey":"test"},"modelId":"test"}') as SessionBinding
  try {
    await assert.rejects(store.transaction(tx => tx.sessions.createSession('unsupported' as SessionId, binding, 'replicated')), /storage mode is not available/)
    assert.equal(await store.sessions.get('unsupported' as SessionId), null)
    await store.transaction(tx => tx.sessions.createSession('local' as SessionId, binding))
    assert.equal((await store.sessions.get('local' as SessionId))?.storageMode, 'local')
    assert.equal((await store.listSessions())[0]?.storageMode, 'local')
    // 模拟升级前 Worker 写入的旧文档；重启后无需迁移也可读。
    store.close()
    const db = new DatabaseSync(path)
    db.prepare('INSERT INTO documents(bucket,id,body) VALUES(?,?,?)').run('sessions', 'legacy', JSON.stringify({ sessionId: 'legacy', binding, runtimeState: 'idle', activeTurnId: null, nativeSession: null, updatedAt: '2026-01-01T00:00:00Z' }))
    db.close()
    const restarted = new SqliteWorkerStore(path)
    try {
      assert.equal((await restarted.sessions.get('legacy' as SessionId))?.storageMode, 'local')
      assert.equal((await restarted.listSessions()).find(session => session.sessionId === 'legacy')?.storageMode, 'local')
    } finally { restarted.close() }
  } finally { await rm(home, { recursive: true, force: true }) }
})

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
